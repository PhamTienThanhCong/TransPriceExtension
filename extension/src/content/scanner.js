/*
 * TransPrice content script — scanner (loaded after currency-data.js + parser.js, before render.js + content.js).
 *
 * Content scripts are CLASSIC scripts: every TransPrice content file shares ONE namespace object,
 * `globalThis.__transprice` (the isolated world's global, invisible to the page). This file adds:
 *   - NS.C          constants mirrored from src/shared/constants.js (KEEP IN SYNC — classic scripts can't import)
 *   - NS.util       PURE helpers (no DOM at load time) — unit-tested in Node (tests/content/)
 *   - NS.createScanner(deps)   the DOM scanner: candidates, split prices, records, MutationObserver, time slicing
 *
 * docs/ARCHITECTURE.md §6.2 + §6.4. The scanner never formats or writes badges itself: it hands "records" to the
 * renderer (render.js) and keeps the registry needed to undo them (restoreAll) and to react to page changes.
 *
 * Record = one converted spot on the page:
 *   { kind: 'element', container, parts: Node[], matches: [m] }   a whole price (single text node, or a split price
 *        whose pieces are `parts` — the top-most nodes covering it under `container`)
 *   { kind: 'inline', node: Text, matches: [m, …] }               price(s) inside a longer text node
 * The renderer adds `badge`, `hidden` (elements it hid) and `texts` (Map<Text, {original, written}>).
 */
(() => {
  'use strict';

  const NS = (globalThis.__transprice = globalThis.__transprice || {});
  if (NS.loaded) return; // injected twice: the running instance owns the page

  /* ------------------------------------------------------------------ */
  /* Constants — mirror of src/shared/constants.js. KEEP IN SYNC.        */
  /* ------------------------------------------------------------------ */

  const MSG = Object.freeze({
    GET_STATE: 'get-state', //         content → bg   {}          → { settings, rates }
    REPORT_COUNT: 'report-count', //   content → bg   { count }   → {}
    GET_PAGE_INFO: 'get-page-info', // popup → content {}         → { hostname, active, count, currencies, ambiguous }
    RESCAN: 'rescan', //               popup → content {}         → { count }
  });

  const LIMITS = Object.freeze({
    MAX_PRICES_PER_PAGE: 3000,
    CLUSTER_MAX_CHARS: 64,
    CLUSTER_MAX_DEPTH: 4,
    SCAN_DEBOUNCE_MS: 150,
    SCAN_BUDGET_MS: 12,
  });

  /** Subset of DEFAULT_SETTINGS the content script reads (fallback if GET_STATE omits a field). */
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    homeCurrency: '',
    displayMode: 'replace',
    compact: false,
    highlight: true,
    defaultDollar: 'USD',
    defaultYen: 'CNY',
    disabledSites: Object.freeze([]),
    siteCurrency: Object.freeze({}),
  });

  NS.C = Object.freeze({
    MSG,
    LIMITS,
    DEFAULT_SETTINGS,
    REPORT_THROTTLE_MS: 500, //   ≤ 1 REPORT_COUNT per 500 ms (§6.4)
    MAX_TEXT_LENGTH: 20000, //    text nodes longer than this are not searched (minified data dumped as text …)
    SAMPLE_CHARS: 3000, //        resolveContext() sample size (§6.1)
  });

  /* ------------------------------------------------------------------ */
  /* Pure helpers                                                        */
  /* ------------------------------------------------------------------ */

  /** Subtrees never scanned (§6.2). `transprice-badge` = our own nodes. */
  const REJECT_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'code', 'pre', 'kbd',
    'samp', 'svg', 'math', 'iframe', 'canvas', 'object', 'embed', 'video', 'audio', 'head', 'title',
    'transprice-badge',
  ]);

  /**
   * Structural / line-breaking tags: a split price never spans one (climb + fragment runs stop there).
   * `div` is deliberately NOT here: shops build inline price pieces out of divs inside flex rows
   * (Taobao `priceInt` divs); the whole-text `parsePrice` check is what keeps clustering safe.
   */
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd', 'details', 'dialog', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
    'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
    'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);

  /**
   * Screen-reader-only copies of a price (Amazon's `.a-offscreen` duplicates every split price). They are
   * invisible, so converting them would only add a second visible badge next to the visible split price.
   */
  const SR_ONLY_CLASSES = Object.freeze([
    'a-offscreen', 'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screenreader-only',
    'u-hidden-visually', 'sr-text',
  ]);
  const SR_ONLY_RE = new RegExp(`(?:^|\\s)(?:${SR_ONLY_CLASSES.join('|')})(?:\\s|$)`);

  /** Same subtrees as a CSS selector, for `closest()` on mutation roots. */
  const REJECT_SELECTOR = [
    ...[...REJECT_TAGS],
    '[data-transprice-ignore]',
    '[contenteditable]:not([contenteditable="false"])',
    ...SR_ONLY_CLASSES.map((c) => `.${c}`),
  ].join(',');

  const isBlockTag = (name) => BLOCK_TAGS.has(String(name || '').toLowerCase());
  const isRejectedTag = (name) => REJECT_TAGS.has(String(name || '').toLowerCase());
  const isSrOnlyClass = (cls) => typeof cls === 'string' && cls !== '' && SR_ONLY_RE.test(cls);

  const DIGIT_RE = /[0-9０-９]/;
  const isDigit = (ch) => !!ch && DIGIT_RE.test(ch);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  /** Fallback when TransPriceCurrencies.TOKENS is unavailable: the common symbols + any 3-letter code. */
  const FALLBACK_TOKEN_RE = /US\$|CN¥|[A-Z]{3}|[$＄¥￥€£₫₩₹฿₱₺₽元円]/g;

  /**
   * Build `strip(text)` that removes every currency token (longest first: 'US$' before '$').
   * @param {string[]} [tokens] e.g. TransPriceCurrencies.TOKENS.map((t) => t.token)
   * @returns {(text: string) => string}
   */
  function makeTokenStripper(tokens) {
    const list = [...new Set((Array.isArray(tokens) ? tokens : []).filter((t) => typeof t === 'string' && t))];
    if (!list.length) return (s) => String(s).replace(FALLBACK_TOKEN_RE, '');
    list.sort((a, b) => b.length - a.length);
    const re = new RegExp(list.map(escapeRe).join('|'), 'g');
    return (s) => String(s).replace(re, '');
  }

  const NUMERIC_REST_RE = /^[0-9０-９.,'’\s   ]*$/;

  /**
   * Is this text node a possible piece of a split price (ARCHITECTURE §6.2 "fragment runs")?
   * True for whitespace-only text, or text made only of digits, separators (. , ' ’ space NBSP U+202F U+2009),
   * currency tokens and multipliers (万 萬 亿 億 千 anywhere; k K M only right after a digit).
   *   '¥' '43' '.65' '1,299' 'USD' '1.5万' '  '  → true      '5 people bought' '5人付款' 'Same style' 'KM' → false
   * @param {string} text
   * @param {(s: string) => string} [stripTokens] removes currency tokens (see makeTokenStripper)
   */
  function isFragment(text, stripTokens) {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return true;
    let rest = typeof stripTokens === 'function' ? stripTokens(t) : t.replace(FALLBACK_TOKEN_RE, '');
    rest = rest.replace(/([0-9０-９])\s?[kKM](?![A-Za-z])/g, '$1').replace(/[万萬亿億千]/g, '');
    return NUMERIC_REST_RE.test(rest);
  }

  const trimmed = (texts, i) => String(texts[i] == null ? '' : texts[i]).trim();
  /** `<sup>99</sup>` right after an integer = cents ("$12⁹⁹"). */
  const isSupCents = (texts, sup, i) => !!(sup && sup[i]) && /^[0-9]{2}$/.test(trimmed(texts, i));

  /**
   * Group the contiguous run of price fragments around the token node `k` (PURE — the DOM side collects the
   * text nodes in document order around the token node, see collectAround()).
   *
   * Rules: only fragments (isFragment); stop at `breaks[x]` (hard boundary BEFORE item x: block element, owned
   * node …), at `used[x]` (already part of a converted price), at `maxChars` (trimmed text), and where a number
   * would continue across a node boundary digit→digit ('.65' | '5' is a price followed by a sales counter, never
   * '43.655') — except `<sup>` cents. Whitespace-only items are transparent and trimmed off both ends.
   *
   * @param {string[]} texts   text node values in document order
   * @param {number} k         index of the token-bearing node
   * @param {{breaks?: boolean[], used?: boolean[], sup?: boolean[], isFragment?: (t: string) => boolean, maxChars?: number}} [opts]
   * @returns {[number, number] | null} inclusive [first, last] indexes of the run
   */
  function groupRun(texts, k, opts = {}) {
    const { breaks = [], used = [], sup = [], maxChars = LIMITS.CLUSTER_MAX_CHARS } = opts;
    const frag = typeof opts.isFragment === 'function' ? opts.isFragment : (t) => isFragment(t);
    const n = Array.isArray(texts) ? texts.length : 0;
    if (!(k >= 0 && k < n) || used[k] || !frag(texts[k])) return null;
    const own = trimmed(texts, k);
    let chars = own.length;
    let first = k;
    let last = k;
    let headIdx = own ? k : -1; // first / last non-blank item of the run so far
    let tailIdx = headIdx;

    for (let x = k + 1; x < n; x++) {
      if (breaks[x] || used[x] || !frag(texts[x])) break;
      const t = trimmed(texts, x);
      if (t) {
        const prev = tailIdx >= 0 ? trimmed(texts, tailIdx) : '';
        if (isDigit(prev.slice(-1)) && isDigit(t[0]) && !isSupCents(texts, sup, x)) break;
        if (chars + t.length > maxChars) break;
        chars += t.length;
        tailIdx = x;
        if (headIdx < 0) headIdx = x;
      }
      last = x;
    }
    for (let x = k - 1; x >= 0; x--) {
      if (breaks[x + 1] || used[x] || !frag(texts[x])) break;
      const t = trimmed(texts, x);
      if (t) {
        const next = headIdx >= 0 ? trimmed(texts, headIdx) : '';
        if (isDigit(t.slice(-1)) && isDigit(next[0]) && !isSupCents(texts, sup, headIdx)) break;
        if (chars + t.length > maxChars) break;
        chars += t.length;
        headIdx = x;
        if (tailIdx < 0) tailIdx = x;
      }
      first = x;
    }
    while (first < k && !trimmed(texts, first)) first++;
    while (last > k && !trimmed(texts, last)) last--;
    return [first, last];
  }

  /**
   * Candidate windows [a, b] inside a run [first, last] that contain `k`: most pieces first, then token-first
   * (reaching further right: '5' '¥' '43' → '¥43', not '5¥'; suffix-only tokens like 元 still work because the
   * parser rejects them in prefix position), then leftmost. The full run is tried first; smaller windows rescue
   * runs like '¥43.65' + ' ' + '¥59' (price + old price). Windows never start or end on a whitespace-only item.
   * @returns {Array<[number, number]>}
   */
  function runWindows(texts, first, last, k) {
    const out = [];
    for (let a = first; a <= k; a++) {
      if (a !== k && !trimmed(texts, a)) continue;
      for (let b = k; b <= last; b++) {
        if (b !== k && !trimmed(texts, b)) continue;
        let pieces = 0;
        for (let x = a; x <= b; x++) if (trimmed(texts, x)) pieces++;
        out.push([a, b, pieces]);
      }
    }
    out.sort((p, q) => q[2] - p[2] || q[1] - p[1] || p[0] - q[0]);
    return out.map(([a, b]) => [a, b]);
  }

  /**
   * Text of run items a..b as one price string: each piece trimmed, whitespace-only pieces dropped,
   * `<sup>` cents get their missing decimal point ('$' '12' sup'99' → '$12.99').
   */
  function joinRun(texts, a, b, sup) {
    let out = '';
    for (let x = a; x <= b; x++) {
      const t = trimmed(texts, x);
      if (!t) continue;
      if (isSupCents(texts, sup, x) && isDigit(out.slice(-1)) && !/[.,]\d*$/.test(out)) out += '.';
      out += t;
    }
    return out;
  }

  /** Does match `m` cover the whole of `text` (ignoring surrounding whitespace)? */
  const coversWhole = (text, m) =>
    !!m && String(text).slice(0, m.start).trim() === '' && String(text).slice(m.end).trim() === '';

  /** Lowercase hostname without a leading `www.` (same rule as storage.js normalizeHostname). */
  const normalizeHost = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

  /** Exact host or any subdomain of a listed host (same rule as storage.js isSiteMatch). */
  function isSiteMatch(hostname, list) {
    const host = normalizeHost(hostname);
    if (!host || !Array.isArray(list)) return false;
    return list.some((rule) => {
      const r = normalizeHost(rule);
      return !!r && (host === r || host.endsWith(`.${r}`));
    });
  }

  /**
   * Throttle with a guaranteed trailing call carrying the latest arguments (≤ 1 call per `ms`).
   * @param {Function} fn @param {number} ms
   * @param {{setTimeout?: Function, clearTimeout?: Function, now?: () => number}} [timers] injectable for tests
   */
  function createThrottle(fn, ms, timers = {}) {
    const st = timers.setTimeout || ((f, d) => setTimeout(f, d));
    const ct = timers.clearTimeout || ((id) => clearTimeout(id));
    const now = timers.now || (() => Date.now());
    let last = -Infinity;
    let timer = null;
    let args = null;
    const fire = () => {
      timer = null;
      last = now();
      const a = args;
      args = null;
      fn(...a);
    };
    const call = (...a) => {
      args = a;
      if (timer !== null) return;
      const wait = last + ms - now();
      if (wait <= 0) fire();
      else timer = st(fire, wait);
    };
    call.cancel = () => {
      if (timer !== null) ct(timer);
      timer = null;
      args = null;
    };
    return call;
  }

  /**
   * Keep only roots that are not inside another root of the set (mutation batches add parents and children).
   * @template T @param {Iterable<T>} roots @param {(n: T) => T | null} parentOf
   * @returns {T[]}
   */
  function pruneRoots(roots, parentOf) {
    const set = new Set(roots);
    const out = [];
    for (const r of set) {
      let inside = false;
      for (let p = parentOf(r); p; p = parentOf(p)) {
        if (set.has(p)) {
          inside = true;
          break;
        }
      }
      if (!inside) out.push(r);
    }
    return out;
  }

  const DEFAULT_AMBIGUOUS = Object.freeze({ dollar: Object.freeze(['$', '＄']), yen: Object.freeze(['¥', '￥']) });

  /** 'dollar' | 'yen' | null for a token as written ('¥' → 'yen'). */
  function symbolOf(token, ambiguous = DEFAULT_AMBIGUOUS) {
    for (const sym of Object.keys(ambiguous)) if (ambiguous[sym].includes(token)) return sym;
    return null;
  }

  /**
   * Page info for GET_PAGE_INFO (§5). Ambiguity counts include matches skipped because they resolved to the home
   * currency: a Chinese shop misread as JPY by a JPY user converts nothing, but the popup must still offer
   * "¥ on this site means [CNY ▾]".
   * @param {Iterable<{currency: string, token: string, ambiguous?: boolean}>} converted
   * @param {Iterable<{currency: string, token: string, ambiguous?: boolean}>} skipped
   * @param {{reasons?: Record<string, string>, dollar?: string, yen?: string} | null} ctx
   * @returns {{count: number, currencies: Record<string, number>, ambiguous: Array<{symbol, token, currency, reason, count}>}}
   */
  function aggregatePageInfo(converted, skipped, ctx, ambiguousMap = DEFAULT_AMBIGUOUS) {
    const currencies = {};
    let count = 0;
    const amb = new Map();
    const note = (m) => {
      if (!m || !m.ambiguous) return;
      const symbol = symbolOf(m.token, ambiguousMap);
      if (!symbol) return;
      let e = amb.get(symbol);
      if (!e) {
        e = { symbol, currency: (ctx && ctx[symbol]) || m.currency, reason: (ctx && ctx.reasons && ctx.reasons[symbol]) || 'default', count: 0, tokens: new Map() };
        amb.set(symbol, e);
      }
      e.count++;
      e.tokens.set(m.token, (e.tokens.get(m.token) || 0) + 1);
    };
    for (const m of converted) {
      count++;
      currencies[m.currency] = (currencies[m.currency] || 0) + 1;
      note(m);
    }
    for (const m of skipped) note(m);
    const ambiguous = [...amb.values()].map((e) => {
      const token = [...e.tokens.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { symbol: e.symbol, token, currency: e.currency, reason: e.reason, count: e.count };
    });
    return { count, currencies, ambiguous };
  }

  /**
   * The page's own value of a text node we may have rewritten: `current`, unless it still equals what we wrote
   * (then the original we remembered). `entry` = { original, written } or undefined (never written).
   */
  const pageValue = (current, entry) => (entry && current === entry.written ? entry.original : current);

  /**
   * Fast-path decision for a converted record whose nodes the page just touched (§6.4) — PURE.
   * Runs synchronously inside the MutationObserver callback (a microtask → before the next paint), so a
   * React-style rewrite never shows the new original next to the stale badge.
   * @param {{dead?: boolean, partsConnected: boolean, badgeConnected: boolean, pageChanged: boolean}} s
   * @returns {'none'|'refresh'|'redetect'}
   *   none     — nothing of ours changed (echo of our own write, identical re-render, already dropped)
   *   refresh  — same nodes, new text → re-parse, update the badge and re-empty the text IN PLACE (same badge)
   *   redetect — a piece or the badge was removed/replaced → drop the record and convert its container again
   */
  function touchAction(s) {
    if (!s || s.dead) return 'none';
    if (!s.partsConnected || !s.badgeConnected) return 'redetect';
    return s.pageChanged ? 'refresh' : 'none';
  }

  NS.util = Object.freeze({
    pageValue,
    touchAction,
    REJECT_TAGS,
    BLOCK_TAGS,
    SR_ONLY_CLASSES,
    REJECT_SELECTOR,
    isBlockTag,
    isRejectedTag,
    isSrOnlyClass,
    makeTokenStripper,
    isFragment,
    groupRun,
    runWindows,
    joinRun,
    coversWhole,
    normalizeHost,
    isSiteMatch,
    createThrottle,
    pruneRoots,
    symbolOf,
    aggregatePageInfo,
  });

  /* ------------------------------------------------------------------ */
  /* DOM scanner                                                         */
  /* ------------------------------------------------------------------ */

  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const FRAGMENT_NODE = 11; // ShadowRoot
  const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;
  const FILTER_SKIP = 3;
  const HIDDEN_ATTR = 'data-transprice-hidden';
  const MAX_SIDE_NODES = 8; // text nodes collected on each side of a token node for fragment runs
  const OWNER_CLIMB = 8; // ancestors checked when looking for the record owning a node
  const FAST_BUDGET_MS = 8; // synchronous fast path per MutationObserver callback; the rest goes to the batch path
  const FAST_RESCAN_CHARS = 1000; // containers re-converted synchronously only up to this much text

  /**
   * Create the page scanner.
   * @param {object} deps
   * @param {object} deps.parser        TransPriceParser (§4.2)
   * @param {object} deps.render        renderer from NS.createRenderer (render.js)
   * @param {() => object|null} deps.getEnv   current env: { ctx, home, rates, mode, compact, highlight, locale, max }
   * @param {(count: number) => void} [deps.onCount]   called after every change of the converted count
   * @param {() => boolean} [deps.isAlive]             false once the extension context is gone
   * @param {() => void} [deps.onDead]                 called (once) when isAlive() turns false
   * @param {string[]} [deps.tokens]                   currency tokens (TransPriceCurrencies.TOKENS[].token)
   * @param {object} [deps.ambiguous]                  TransPriceCurrencies.AMBIGUOUS
   * @param {Document} [deps.doc]
   */
  NS.createScanner = function createScanner(deps) {
    const { parser, render } = deps;
    const doc = deps.doc || document;
    const getEnv = deps.getEnv;
    const onCount = deps.onCount || (() => {});
    const isAlive = deps.isAlive || (() => true);
    const onDead = deps.onDead || (() => {});
    const ambiguousMap = deps.ambiguous || DEFAULT_AMBIGUOUS;
    const stripTokens = makeTokenStripper(deps.tokens);
    const fragment = (t) => isFragment(t, stripTokens);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const idle =
      typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 100 })
        : (fn) => setTimeout(fn, 0);

    /** @type {Set<object>} */
    const records = new Set();
    /** Node (text part, element part, inline text node, badge) → its record. */
    let ownerOf = new WeakMap();
    /** Text node → nodeValue when last examined (unchanged nodes are skipped on rescans). */
    let seenText = new WeakMap();
    /** Node → home-currency matches skipped there (only for the popup's ambiguity info). */
    const skipped = new Map();
    let total = 0;
    let running = false;

    let queue = [];
    let cursor = null; // { root, walker }
    let sliceScheduled = false;
    let pending = []; // records detected but not rendered yet
    let idleWaiters = [];

    const observer = typeof MutationObserver === 'function' ? new MutationObserver(onMutations) : null;
    const OBSERVE = { childList: true, subtree: true, characterData: true };
    const observedRoots = new Set();
    let observing = false;
    let pauseDepth = 0;
    let mutTimer = 0;
    const mutRoots = new Set();
    const dirty = new Set();
    let needSweep = false;

    /* ---------------- element classification ---------------- */

    function isRejectedEl(el) {
      if (REJECT_TAGS.has(el.localName)) return true;
      if (el.hasAttribute('data-transprice-ignore')) return true;
      const ce = el.getAttribute('contenteditable');
      if (ce !== null && ce !== 'false') return true;
      return isSrOnlyClass(el.getAttribute('class'));
    }

    /** Is `node` inside a subtree we never touch (closest() is native and fast)? */
    function inRejectedContext(node) {
      if (doc.designMode === 'on') return true;
      const el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;
      if (!el) return node.nodeType !== FRAGMENT_NODE;
      try {
        return !!el.closest(REJECT_SELECTOR);
      } catch {
        return true;
      }
    }

    const scanFilter = {
      acceptNode(n) {
        if (n.nodeType === TEXT_NODE) return FILTER_ACCEPT;
        if (isRejectedEl(n) || n.hasAttribute(HIDDEN_ATTR)) return FILTER_REJECT;
        if (n.shadowRoot) addShadowRoot(n.shadowRoot);
        return FILTER_SKIP;
      },
    };

    /** Walker used around split prices: sees elements (block boundaries) and text, never rejected subtrees. */
    const localFilter = {
      acceptNode(n) {
        if (n.nodeType === TEXT_NODE) return FILTER_ACCEPT;
        return isRejectedEl(n) ? FILTER_REJECT : FILTER_ACCEPT;
      },
    };

    /* ---------------- ownership ---------------- */

    /** Record owning `node` or one of its close ancestors (hidden element parts contain the price text). */
    function ownerNear(node) {
      let x = node;
      for (let i = 0; x && i < OWNER_CLIMB; i++, x = x.parentNode) {
        const rec = ownerOf.get(x);
        if (rec) return rec;
        if (x.nodeType === FRAGMENT_NODE) break;
      }
      return null;
    }

    function register(rec) {
      records.add(rec);
      total += rec.matches.length;
      if (rec.kind === 'inline') ownerOf.set(rec.node, rec);
      else for (const p of rec.parts) ownerOf.set(p, rec);
      rec.sig = recordText(rec); // the page text this record converts (fast path compares against it)
      pending.push(rec);
    }

    /**
     * The page's current text for a record (our own rewrites undone): the inline node's value, or the joined
     * pieces of an element record. null if a hidden piece now holds a converted node (structure changed).
     */
    function recordText(rec) {
      if (rec.kind === 'inline') return pageValue(rec.node.nodeValue, rec.texts && rec.texts.get(rec.node));
      const texts = [];
      const sup = [];
      for (const p of rec.parts) {
        if (p.nodeType === TEXT_NODE) {
          texts.push(pageValue(p.nodeValue, rec.texts && rec.texts.get(p)));
          sup.push(!!p.parentNode && p.parentNode.localName === 'sup');
        } else if (p.nodeType === ELEMENT_NODE) {
          const list = textNodesOf(p);
          if (!list) return null;
          for (const t of list) {
            texts.push(t.nodeValue);
            sup.push(!!t.parentNode && t.parentNode.localName === 'sup');
          }
        }
      }
      return joinRun(texts, 0, texts.length - 1, sup);
    }

    const nodesOf = (rec) => (rec.kind === 'inline' ? [rec.node] : rec.parts);

    /** Forget a record: undo its DOM changes (keeping page-made text changes) and its ownership marks. */
    function unregister(rec) {
      if (rec.dead) return;
      rec.dead = true;
      records.delete(rec);
      total -= rec.matches.length;
      try {
        render.undo(rec);
      } catch {
        /* the page may have removed nodes under us */
      }
      const nodes = rec.kind === 'inline' ? [rec.node] : rec.parts;
      for (const n of nodes) {
        if (ownerOf.get(n) === rec) ownerOf.delete(n);
        forgetSeen(n);
      }
      if (rec.badge && ownerOf.get(rec.badge) === rec) ownerOf.delete(rec.badge);
    }

    /** Make text nodes under `node` eligible for a fresh look. */
    function forgetSeen(node) {
      if (node.nodeType === TEXT_NODE) {
        seenText.delete(node);
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;
      const w = doc.createTreeWalker(node, 0x4);
      for (let t = w.nextNode(); t; t = w.nextNode()) seenText.delete(t);
    }

    /** True while the page has not modified `node` since we wrote it (or since we looked, in append mode). */
    function isOurValue(rec, node) {
      const t = rec.texts && rec.texts.get(node);
      if (t) return node.nodeValue === t.written;
      return true; // not written yet (pending render)
    }

    /* ---------------- conversion of matches ---------------- */

    /**
     * Annotate matches with converted values; returns those to convert. Home-currency matches are remembered
     * (for ambiguity info) and dropped, as are currencies without a rate.
     */
    function convertMatches(matches, env, anchor) {
      const out = [];
      const skip = [];
      for (const m of matches) {
        if (!m || !m.currency) continue;
        if (m.currency === env.home) {
          if (m.ambiguous) skip.push({ currency: m.currency, token: m.token, ambiguous: true });
          continue;
        }
        const value = parser.convert(m.amount, m.currency, env.home, env.rates);
        if (value == null || !Number.isFinite(value)) continue;
        let valueMax = null;
        if (m.amountMax != null) {
          valueMax = parser.convert(m.amountMax, m.currency, env.home, env.rates);
          if (valueMax == null || !Number.isFinite(valueMax)) continue;
        }
        out.push({ ...m, value, valueMax });
      }
      if (skip.length) skipped.set(anchor, skip);
      else skipped.delete(anchor);
      return out;
    }

    /* ---------------- candidates ---------------- */

    function processText(node, env) {
      const v = node.nodeValue;
      if (!v || v.length > NS.C.MAX_TEXT_LENGTH) return;
      const own = ownerOf.get(node);
      if (own) {
        if (isOurValue(own, node)) return;
        unregister(own); // the page rewrote a node we converted → drop it, look again below
      }
      if (seenText.get(node) === v) return;
      seenText.set(node, v);
      if (!parser.hasToken(v)) return;
      const parent = node.parentNode;
      if (!parent || (parent.nodeType !== ELEMENT_NODE && parent.nodeType !== FRAGMENT_NODE)) return;
      if (ownerNear(parent)) return; // inside a hidden piece of a converted split price
      if (total >= env.max) return;

      const matches = parser.quickTest(v) ? parser.findPrices(v, env.ctx) || [] : [];
      if (matches.length === 1 && coversWhole(v, matches[0])) {
        // A whole price… unless it is the head of a split one ('¥43' + '.65').
        const run = findRun(node, env, matches[0]);
        if (run) addElement(run.container, run.nodes, run.match, env);
        else addElement(parent, [node], matches[0], env);
        return;
      }
      if (matches.length) {
        addInline(node, matches, env);
        return;
      }
      // Token without a number of its own: a split price ('¥' '43' '.65').
      const hit = climb(node, env) || findRun(node, env, null);
      if (hit) addElement(hit.container, hit.nodes, hit.match, env);
    }

    function addElement(container, runNodes, match, env) {
      const [m] = convertMatches([match], env, runNodes[0]);
      if (!m || total + 1 > env.max) return;
      const parts = coverParts(runNodes, container);
      if (!parts.length || parts.some((p) => ownerOf.has(p))) return;
      register({ kind: 'element', container, parts, matches: [m] });
    }

    function addInline(node, matches, env) {
      const list = convertMatches(matches, env, node);
      if (!list.length || total + list.length > env.max) return;
      register({ kind: 'inline', node, container: node.parentNode, matches: list });
    }

    /* ---------------- split prices: 1) ancestor climb ---------------- */

    /** Text length of `el` with an early exit above `max` (textContent would build the whole string). */
    function textLengthWithin(el, max) {
      const w = doc.createTreeWalker(el, 0x4);
      let len = 0;
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        len += t.nodeValue.length;
        if (len > max) return len;
      }
      return len;
    }

    /** Visible text nodes of a small element (skipping SR-only copies and our nodes); null if it holds owned nodes. */
    function textNodesOf(el) {
      const w = doc.createTreeWalker(el, SHOW_ELEMENT_AND_TEXT, localFilter);
      const out = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (ownerOf.has(n)) return null;
        if (n.nodeType === TEXT_NODE) out.push(n);
      }
      return out;
    }

    const supFlags = (nodes) => nodes.map((n) => !!n.parentNode && n.parentNode.localName === 'sup');

    /**
     * §6.2 climb: from a token node, the first ancestor (≤ CLUSTER_MAX_DEPTH, text ≤ CLUSTER_MAX_CHARS, no block
     * descendants) whose whole visible text parses as one price. Joining applies the same digit→digit guard as
     * fragment runs (groupRun), so '¥' '43' '.65' '5' never reads as 43.655.
     */
    function climb(node, env) {
      let el = node.parentNode;
      for (let depth = 1; el && el.nodeType === ELEMENT_NODE && depth <= LIMITS.CLUSTER_MAX_DEPTH; depth++, el = el.parentNode) {
        if (el.localName === 'body' || el.localName === 'html') return null;
        if (isRejectedEl(el) || ownerOf.has(el)) return null;
        if (textLengthWithin(el, LIMITS.CLUSTER_MAX_CHARS) > LIMITS.CLUSTER_MAX_CHARS) return null;
        if (hasBlockDescendant(el)) return null;
        const nodes = textNodesOf(el);
        if (!nodes) return null;
        const texts = nodes.map((n) => n.nodeValue);
        const k = nodes.indexOf(node);
        const sup = supFlags(nodes);
        const run = groupRun(texts, k, { sup, isFragment: () => true, maxChars: LIMITS.CLUSTER_MAX_CHARS });
        // Every non-blank piece must belong to the run, otherwise the element holds more than the price — and so
        // will every ancestor: hand over to fragment runs (Taobao's wrapper with "5 people bought" inside).
        if (!run || texts.some((t, i) => (i < run[0] || i > run[1]) && t.trim())) return null;
        const match = parser.parsePrice(joinRun(texts, run[0], run[1], sup), env.ctx);
        if (match) return { container: el, nodes: nodes.slice(run[0], run[1] + 1), match };
        if (BLOCK_TAGS.has(el.localName)) return null; // don't climb out of a cell / list item
      }
      return null;
    }

    let blockSelector = '';
    function hasBlockDescendant(el) {
      if (!blockSelector) blockSelector = [...BLOCK_TAGS].join(',');
      try {
        return !!el.querySelector(blockSelector);
      } catch {
        return true;
      }
    }

    /* ---------------- split prices: 2) fragment runs ---------------- */

    /** Ancestor at most CLUSTER_MAX_DEPTH levels up (never body/html, never past a block element). */
    function runScope(node) {
      let scope = node.parentNode;
      let el = scope;
      for (let depth = 1; el && el.nodeType === ELEMENT_NODE && depth <= LIMITS.CLUSTER_MAX_DEPTH; depth++) {
        if (el.localName === 'body' || el.localName === 'html') break;
        scope = el;
        if (BLOCK_TAGS.has(el.localName)) break;
        el = el.parentNode;
      }
      return scope;
    }

    /** Nearest block-level ancestor of `node` inside `scope` (scope itself if none). */
    function blockOf(node, scope) {
      for (let x = node.parentNode; x && x !== scope; x = x.parentNode) {
        if (x.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(x.localName)) return x;
      }
      return scope;
    }

    /**
     * Text nodes around `node` in document order inside its run scope, with boundary / owned / <sup> flags —
     * the DOM half of fragment runs; groupRun() does the deciding.
     */
    function collectAround(node) {
      const scope = runScope(node);
      if (!scope) return null;
      const home = blockOf(node, scope);
      const w = doc.createTreeWalker(scope, SHOW_ELEMENT_AND_TEXT, localFilter);
      const collect = (step) => {
        const items = [];
        let brk = false;
        w.currentNode = node;
        for (let n = step(); n && items.length < MAX_SIDE_NODES; n = step()) {
          if (n.nodeType === ELEMENT_NODE) {
            if (BLOCK_TAGS.has(n.localName) || n.localName === 'img') brk = true;
            continue;
          }
          const used = !!ownerNear(n);
          items.push({ node: n, brk: brk || blockOf(n, scope) !== home, used });
          brk = false;
          if (used || !fragment(n.nodeValue)) break;
        }
        return items;
      };
      const before = collect(() => w.previousNode()).reverse();
      const after = collect(() => w.nextNode());
      // breaks[x] = boundary before item x. Going backward, a boundary seen before reaching item i lies AFTER it.
      const nodes = [];
      const breaks = [];
      const used = [];
      for (let i = 0; i < before.length; i++) {
        nodes.push(before[i].node);
        used.push(before[i].used);
        breaks.push(false);
      }
      for (let i = 0; i < before.length; i++) if (before[i].brk) breaks[i + 1] = true;
      const k = nodes.length;
      nodes.push(node);
      used.push(false);
      if (breaks.length < k + 1) breaks.push(false);
      for (const it of after) {
        nodes.push(it.node);
        used.push(it.used);
        breaks.push(it.brk);
      }
      return { nodes, breaks: breaks.slice(0, nodes.length), used, k };
    }

    /**
     * §6.2 fragment runs. With `own` (the token node already holds a whole price) only a strictly longer price
     * counts ('¥43' + '.65'); otherwise the first window that parses wins.
     */
    function findRun(node, env, own) {
      const around = collectAround(node);
      if (!around) return null;
      const { nodes, breaks, used, k } = around;
      if (nodes.length < 2) return null;
      const texts = nodes.map((n) => n.nodeValue);
      const sup = supFlags(nodes);
      const run = groupRun(texts, k, { breaks, used, sup, isFragment: fragment, maxChars: LIMITS.CLUSTER_MAX_CHARS });
      if (!run || run[0] === run[1]) return null;
      for (const [a, b] of runWindows(texts, run[0], run[1], k)) {
        if (own && a === k && b === k) return null; // nothing longer than the node itself parses
        if (!own && a === k && b === k) continue;
        const match = parser.parsePrice(joinRun(texts, a, b, sup), env.ctx);
        if (!match) continue;
        const runNodes = nodes.slice(a, b + 1);
        return { container: commonAncestor(runNodes), nodes: runNodes, match };
      }
      return null;
    }

    function commonAncestor(nodes) {
      const chain = new Set();
      for (let x = nodes[0].parentNode; x; x = x.parentNode) chain.add(x);
      let lca = nodes[nodes.length - 1].parentNode;
      while (lca && !chain.has(lca)) lca = lca.parentNode;
      for (const n of nodes) while (lca && !lca.contains(n)) lca = lca.parentNode;
      return lca;
    }

    /**
     * Top-most nodes under `container` that cover the run and nothing else (§6.2): climb from each run node while
     * every visible non-blank text node of the parent belongs to the run.
     */
    function coverParts(runNodes, container) {
      if (runNodes.length === 1 && runNodes[0].parentNode === container) return runNodes.slice();
      const inRun = new Set(runNodes);
      const onlyRun = (el) => {
        const nodes = textNodesOf(el);
        return !!nodes && nodes.every((t) => inRun.has(t) || !t.nodeValue.trim());
      };
      const parts = [];
      const seen = new Set();
      for (const n of runNodes) {
        let top = n;
        while (top.parentNode && top.parentNode !== container && onlyRun(top.parentNode)) top = top.parentNode;
        if (!seen.has(top)) {
          seen.add(top);
          parts.push(top);
        }
      }
      return parts;
    }

    /* ---------------- time-sliced scanning ---------------- */

    function enqueue(root) {
      if (!running || !root) return;
      queue.push(root);
      kick();
    }

    function kick() {
      if (sliceScheduled || !running) return;
      sliceScheduled = true;
      idle(slice);
    }

    function startRoot(root) {
      if (!root.isConnected) return null;
      if (root.nodeType === TEXT_NODE) {
        if (inRejectedContext(root)) return null;
        return { root, walker: null, single: root };
      }
      if (root.nodeType === ELEMENT_NODE) {
        if (inRejectedContext(root) || root.hasAttribute(HIDDEN_ATTR)) return null;
        if (root.shadowRoot) addShadowRoot(root.shadowRoot);
      } else if (root.nodeType !== FRAGMENT_NODE && root.nodeType !== 9) {
        return null;
      }
      return { root, walker: doc.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT, scanFilter), single: null };
    }

    function nextCandidate() {
      for (;;) {
        if (!cursor) {
          const root = queue.shift();
          if (!root) return null;
          cursor = startRoot(root);
          continue;
        }
        if (cursor.single) {
          const n = cursor.single;
          cursor = null;
          return n;
        }
        const w = cursor.walker;
        if (w.currentNode !== cursor.root && !w.currentNode.isConnected) w.currentNode = cursor.root; // DOM moved under us
        const n = w.nextNode();
        if (n) return n;
        cursor = null;
      }
    }

    function slice() {
      sliceScheduled = false;
      if (!running) return;
      if (!isAlive()) {
        onDead();
        return;
      }
      const env = getEnv();
      if (!env) return;
      const deadline = now() + LIMITS.SCAN_BUDGET_MS;
      try {
        while (total < env.max) {
          const n = nextCandidate();
          if (!n) break;
          processText(n, env);
          if (now() > deadline) break;
        }
        if (total >= env.max) {
          queue = [];
          cursor = null;
        }
      } catch (err) {
        cursor = null; // a hostile page must never wedge the scanner
        if (typeof console !== 'undefined') console.debug('[TransPrice] scan error', err);
      }
      flush(env);
      if (cursor || queue.length) kick();
      else settle();
    }

    /** Render detected records in one batch (reads first, then writes) with the observer paused. */
    function flush(env) {
      if (!pending.length) return;
      const batch = pending.filter((r) => !r.dead);
      pending = [];
      if (!batch.length) return;
      pause();
      try {
        if (render.prepare) render.prepare(batch, env);
        for (const rec of batch) {
          try {
            render.apply(rec, env);
            if (rec.badge) ownerOf.set(rec.badge, rec);
          } catch {
            unregister(rec);
          }
        }
      } finally {
        resume();
      }
      onCount(total);
    }

    function settle() {
      if (sliceScheduled || cursor || queue.length || mutTimer || pending.length) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const fn of waiters) fn(total);
    }

    /* ---------------- mutations (§6.4) ---------------- */

    function addShadowRoot(root) {
      if (!root || observedRoots.has(root)) return;
      observedRoots.add(root);
      if (observing && observer) observer.observe(root, OBSERVE);
      enqueue(root);
    }

    function pause() {
      if (pauseDepth++ > 0 || !observer) return;
      if (observing) {
        const recs = observer.takeRecords(); // page changes queued before our writes: keep them
        if (recs.length) {
          collect(recs);
          scheduleMutations();
        }
        observer.disconnect();
      }
    }

    /** Process collected mutations after a short batch window (not reset by new records → no starvation). */
    function scheduleMutations() {
      if (!mutTimer && running && (mutRoots.size || dirty.size || needSweep)) {
        mutTimer = setTimeout(processMutations, LIMITS.SCAN_DEBOUNCE_MS);
      }
    }

    function resume() {
      if (--pauseDepth > 0 || !observer) return;
      if (observing) for (const r of observedRoots) if (r.isConnected !== false) observer.observe(r, OBSERVE);
    }

    function onMutations(list) {
      if (!running) return;
      if (!isAlive()) {
        onDead();
        return;
      }
      collect(list);
      if (dirty.size) fastPath();
      scheduleMutations();
    }

    /**
     * Converted nodes the page just rewrote are fixed SYNCHRONOUSLY, still inside the MutationObserver callback
     * (a microtask: it runs before the next paint), so the new original never shows next to a stale badge:
     * same nodes → re-parse and update the badge / re-empty the text in place; nodes replaced → re-convert the
     * (small) container right away. Only NEW subtrees wait for the debounced, time-sliced batch path.
     * Our own writes happen with the observer disconnected (pause), so they never come back here.
     */
    function fastPath() {
      const env = getEnv();
      if (!env) return;
      const deadline = now() + FAST_BUDGET_MS;
      pause();
      try {
        for (const rec of [...dirty]) {
          if (now() > deadline) break; // a mass re-render: leftovers go to the batch path (processMutations)
          dirty.delete(rec);
          if (rec.dead) continue;
          let ok = false;
          try {
            ok = refreshRecord(rec, env);
          } catch {
            ok = false;
          }
          if (ok) continue;
          const container = rec.container;
          unregister(rec);
          if (!container || !container.isConnected) {
            needSweep = true;
            continue;
          }
          forgetSeen(container);
          if (!inRejectedContext(container) && textLengthWithin(container, FAST_RESCAN_CHARS) <= FAST_RESCAN_CHARS) {
            syncScan(container, env);
          } else {
            mutRoots.add(container);
          }
        }
        flush(env); // renders what syncScan found (nested pause is fine)
      } finally {
        resume();
      }
      onCount(total);
    }

    /**
     * Re-parse a record the page touched and update it in place (same badge). Returns false when the record has
     * to be re-detected instead (pieces/badge replaced, no longer one price, now a whole price, home currency …).
     */
    function refreshRecord(rec, env) {
      const nodes = nodesOf(rec);
      const text = nodes.every((n) => n.isConnected) ? recordText(rec) : null;
      const action = touchAction({
        dead: rec.dead,
        partsConnected: text !== null,
        badgeConnected: !rec.badge || rec.badge.isConnected,
        pageChanged: text !== rec.sig,
      });
      if (action === 'none') return true;
      if (action === 'redetect' || !text || !rec.texts) return false; // (not rendered yet → let the scan decide)
      let matches;
      if (rec.kind === 'inline') {
        const found = parser.quickTest(text) ? parser.findPrices(text, env.ctx) || [] : [];
        if (!found.length || (found.length === 1 && coversWhole(text, found[0]))) return false;
        matches = convertMatches(found, env, rec.node);
      } else {
        const m = parser.parsePrice(text, env.ctx);
        const anchor = nodes.find((n) => n.nodeType === TEXT_NODE) || nodes[0];
        matches = m ? convertMatches([m], env, anchor) : [];
      }
      if (!matches.length || total - rec.matches.length + matches.length > env.max) return false;
      total += matches.length - rec.matches.length;
      rec.matches = matches;
      rec.sig = text;
      render.refresh(rec, env);
      for (const n of nodes) if (n.nodeType === TEXT_NODE) seenText.set(n, n.nodeValue);
      return true;
    }

    /** Convert `root` right now (fast path re-detection of a small container). */
    function syncScan(root, env) {
      if (root.nodeType === TEXT_NODE) {
        processText(root, env);
        return;
      }
      const w = doc.createTreeWalker(root, SHOW_ELEMENT_AND_TEXT, scanFilter);
      for (let n = w.nextNode(); n && total < env.max; n = w.nextNode()) processText(n, env);
    }

    function collect(list) {
      for (const r of list) {
        const t = r.target;
        if (r.type === 'characterData') {
          const own = ownerNear(t);
          if (own) {
            if (ownerOf.get(t) === own && isOurValue(own, t)) continue;
            dirty.add(own);
            continue;
          }
          mutRoots.add(t);
          continue;
        }
        if (r.type !== 'childList' || (t.localName === 'transprice-badge')) continue;
        const own = ownerNear(t);
        if (own && own.kind === 'element' && t !== own.container) dirty.add(own); // a hidden piece changed
        for (const n of r.removedNodes) {
          const o = ownerOf.get(n);
          if (o) dirty.add(o);
          needSweep = true;
        }
        for (const n of r.addedNodes) {
          if (n.nodeType === ELEMENT_NODE && n.localName === 'transprice-badge' && ownerOf.has(n)) continue; // ours, moved
          if (n.nodeType === TEXT_NODE || n.nodeType === ELEMENT_NODE) mutRoots.add(n);
        }
      }
    }

    function processMutations() {
      mutTimer = 0;
      if (!running) return;
      pause();
      try {
        for (const rec of dirty) {
          const container = rec.container;
          unregister(rec);
          if (container && container.isConnected) {
            forgetSeen(container);
            mutRoots.add(container);
          }
        }
        dirty.clear();
        if (needSweep) sweep();
      } finally {
        resume();
      }
      const roots = pruneRoots(mutRoots, (n) => n.parentNode);
      mutRoots.clear();
      if (roots.some((r) => r.nodeType === ELEMENT_NODE)) {
        pause();
        try {
          for (const r of roots) if (r.nodeType === ELEMENT_NODE && r.isConnected) repairClones(r);
        } finally {
          resume();
        }
      }
      for (const r of roots) enqueue(r);
      onCount(total);
      settle();
    }

    /**
     * The page inserted a copy of converted markup (cloneNode of a card / carousel slide): the copy carries our
     * hidden marks and blanked text but an empty badge (closed shadow roots are not cloned). Put it back to the
     * page's original so the normal scan converts it like any new content.
     */
    function repairClones(root) {
      if (!render.repairClone || !render.isOwnBadge) return;
      try {
        const strays = [];
        if (root.localName === 'transprice-badge') {
          if (!render.isOwnBadge(root)) strays.push(root);
        } else {
          for (const b of root.querySelectorAll('transprice-badge')) if (!render.isOwnBadge(b)) strays.push(b);
        }
        for (const b of strays) render.repairClone(b);
        if (root.hasAttribute(HIDDEN_ATTR) && !ownerOf.has(root)) root.removeAttribute(HIDDEN_ATTR);
        for (const el of root.querySelectorAll(`[${HIDDEN_ATTR}]`)) if (!ownerOf.has(el)) el.removeAttribute(HIDDEN_ATTR);
      } catch {
        /* exotic node */
      }
    }

    /** Drop records whose page nodes (or badge) disappeared; remove their orphan badges. */
    function sweep() {
      needSweep = false;
      for (const rec of [...records]) {
        const nodes = rec.kind === 'inline' ? [rec.node] : rec.parts;
        const gone = nodes.some((n) => !n.isConnected);
        const badgeGone = rec.badge && !rec.badge.isConnected;
        if (!gone && !badgeGone) continue;
        const container = rec.container;
        unregister(rec);
        if (container && container.isConnected) {
          forgetSeen(container);
          mutRoots.add(container);
        }
      }
      for (const node of [...skipped.keys()]) if (!node.isConnected) skipped.delete(node);
    }

    /* ---------------- public API ---------------- */

    /** Start scanning `root` (default document.body) and watching it for changes. */
    function start(root) {
      const r = root || doc.body;
      if (!r) return;
      running = true;
      if (observer && !observing) {
        observedRoots.add(r);
        observing = true;
        if (pauseDepth === 0) observer.observe(r, OBSERVE);
      }
      enqueue(r);
    }

    /** Stop scanning and observing (does not restore — see restoreAll). */
    function stop() {
      running = false;
      queue = [];
      cursor = null;
      if (mutTimer) clearTimeout(mutTimer);
      mutTimer = 0;
      mutRoots.clear();
      dirty.clear();
      needSweep = false;
      if (observer) {
        observer.disconnect();
        observer.takeRecords();
      }
      observing = false;
      observedRoots.clear();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const fn of waiters) fn(total);
    }

    /** Undo every conversion on the page (badges, hidden pieces, rewritten text). */
    function restoreAll() {
      pause();
      try {
        for (const rec of [...records]) unregister(rec);
        for (const rec of pending) rec.dead = true;
        pending = [];
        records.clear();
        skipped.clear();
        total = 0;
        ownerOf = new WeakMap();
        seenText = new WeakMap();
        if (render.restoreAll) render.restoreAll(doc);
      } finally {
        resume();
      }
      onCount(0);
    }

    /** Re-format every record with the current env (rates changed). Records that can't convert any more are dropped. */
    function refreshValues() {
      const env = getEnv();
      if (!env) return;
      pause();
      try {
        for (const rec of [...records]) {
          const fresh = [];
          const intact = !!rec.texts && nodesOf(rec).every((n) => n.isConnected) && recordText(rec) === rec.sig;
          for (const m of intact ? rec.matches : []) {
            const value = parser.convert(m.amount, m.currency, env.home, env.rates);
            const valueMax = m.amountMax != null ? parser.convert(m.amountMax, m.currency, env.home, env.rates) : null;
            if (value == null || (m.amountMax != null && valueMax == null)) break;
            fresh.push({ ...m, value, valueMax });
          }
          if (fresh.length !== rec.matches.length) {
            const container = rec.container;
            unregister(rec);
            if (container && container.isConnected) enqueue(container);
            continue;
          }
          rec.matches = fresh;
          try {
            render.refresh(rec, env);
          } catch {
            unregister(rec);
          }
        }
      } finally {
        resume();
      }
      onCount(total);
    }

    /** Resolves with the converted count once the queue is empty and no mutation batch is pending. */
    function whenIdle() {
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        settle();
      });
    }

    /** All converted / skipped matches → GET_PAGE_INFO fields (count, currencies, ambiguous). */
    function pageInfo(ctx) {
      const converted = [];
      for (const rec of records) for (const m of rec.matches) converted.push(m);
      const skippedList = [];
      for (const list of skipped.values()) for (const m of list) skippedList.push(m);
      return aggregatePageInfo(converted, skippedList, ctx, ambiguousMap);
    }

    return {
      start,
      stop,
      restoreAll,
      refreshValues,
      whenIdle,
      pageInfo,
      count: () => total,
      isRunning: () => running,
      /** For tests / the dev harness. */
      _records: () => [...records],
    };
  };
})();
