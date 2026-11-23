/*
 * TransPrice content script — renderer (loaded after scanner.js, before content.js).
 *
 * docs/ARCHITECTURE.md §6.3. Turns the scanner's records into page changes and undoes them:
 *   - one <transprice-badge> per element record, closed shadow root, styles from one shared constructed sheet;
 *   - replace mode: the price pieces (`rec.parts`) are hidden — elements via [data-transprice-hidden] + one global
 *     style tag, bare text nodes by rewriting nodeValue to '' (original kept in rec.texts) — and the badge is
 *     inserted right after the last piece, INSIDE the price's own container, so it inherits the page's font,
 *     colour and size (and stays inside links / table cells / flex rows); inline prices are rewritten in place;
 *   - append mode: nothing is hidden, the badge ("≈ 730.373 ₫", smaller, muted) follows the price;
 *   - never splits, moves or removes page text nodes; restore puts every byte back.
 *
 * NS.renderUtil holds the PURE text helpers (unit-tested in Node: tests/content/).
 */
(() => {
  'use strict';

  const NS = globalThis.__transprice;
  if (!NS || NS.loaded) return;

  const HIDDEN_ATTR = 'data-transprice-hidden';
  const PARTS_ATTR = 'data-transprice-parts';
  const HIDDEN_CSS = `[${HIDDEN_ATTR}]{display:none!important}`;

  /* ------------------------------------------------------------------ */
  /* Pure helpers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Join two formatted amounts into a range, sharing a common trailing currency part:
   *   ('38.650 ₫', '77.300 ₫') → '38.650 – 77.300 ₫'      ('$1.20', '$3.40') → '$1.20 – $3.40'
   */
  function joinRange(a, b) {
    const x = String(a);
    const y = String(b);
    let s = 0;
    while (s < x.length && s < y.length && x[x.length - 1 - s] === y[y.length - 1 - s] && !/\d/.test(x[x.length - 1 - s])) s++;
    const suffix = x.slice(x.length - s);
    if (s > 0 && /[^\s  ]/.test(suffix)) return `${x.slice(0, x.length - s).trimEnd()} – ${y}`;
    return `${x} – ${y}`;
  }

  /**
   * Replace each match's [start, end) in `original` with its replacement (inline replace mode).
   * @param {string} original @param {Array<{start: number, end: number}>} matches @param {string[]} replacements
   */
  function rewriteText(original, matches, replacements) {
    const order = matches.map((m, i) => ({ m, r: replacements[i] })).sort((p, q) => p.m.start - q.m.start);
    let out = '';
    let pos = 0;
    for (const { m, r } of order) {
      if (m.start < pos) continue; // overlapping (should not happen) → keep the first
      out += original.slice(pos, m.start) + r;
      pos = m.end;
    }
    return out + original.slice(pos);
  }

  /** Leading / trailing whitespace of a text. */
  function edges(text) {
    const s = String(text);
    const lead = /^\s*/.exec(s)[0];
    const trail = lead.length === s.length ? '' : /\s*$/.exec(s)[0];
    return { lead, trail };
  }

  /**
   * Badge text: replace → the converted amount; append → '≈ amount' (inline append lists every conversion).
   * @param {'element'|'inline'} kind @param {'replace'|'append'} mode @param {string[]} texts
   */
  function badgeText(kind, mode, texts) {
    if (mode === 'append' || kind === 'inline') return `≈ ${texts.join(' · ')}`;
    return texts[0] || '';
  }

  /**
   * Hover title (language-neutral): '¥189 → 730.373 ₫ · 1 CNY = 3.865 ₫ · 2026-11-22'.
   * @param {Array<{raw: string, text: string}>} items @param {string[]} rateLines @param {string} [date]
   */
  function titleText(items, rateLines, date) {
    return [...items.map((i) => `${String(i.raw).trim()} → ${i.text}`), ...rateLines, date || '']
      .filter(Boolean)
      .join(' · ');
  }

  /**
   * Plan the text writes of an element record (PURE) — used on first render and on every in-place refresh.
   * For each text piece, `original` = the page's value (`current`, unless it still equals what we wrote: then
   * the remembered original); replace mode empties it (the first piece keeps its leading whitespace, the last
   * piece's trailing whitespace moves into the badge); append mode writes nothing.
   * @param {Array<{isText: boolean, current?: string, entry?: {original: string, written: string}}>} pieces
   * @param {'replace'|'append'} mode
   * @returns {{texts: Array<{original: string, written: string} | null>, trailSpace: boolean, gap0: boolean}}
   */
  function planParts(pieces, mode) {
    const append = mode === 'append';
    const last = pieces.length - 1;
    let trailSpace = false;
    let gap0 = false;
    const texts = pieces.map((p, i) => {
      if (!p.isText) return null;
      const cur = String(p.current == null ? '' : p.current);
      const original = p.entry && cur === p.entry.written ? p.entry.original : cur;
      const e = edges(original);
      if (i === last && e.trail) {
        trailSpace = true;
        if (append) gap0 = true;
      }
      return { original, written: append ? original : i === 0 ? e.lead : '' };
    });
    return { texts, trailSpace, gap0 };
  }

  NS.renderUtil = Object.freeze({ joinRange, rewriteText, edges, badgeText, titleText, planParts });

  /* ------------------------------------------------------------------ */
  /* Badge styles (self-contained: no tokens.css on web pages)           */
  /* ------------------------------------------------------------------ */

  // :host !important beats page rules (inner context wins for important declarations). Everything else inherits
  // from the page so a replaced price looks native; tints mix with currentColor so dark pages stay readable.
  const BADGE_CSS = `
:host{display:inline!important;}
.v{white-space:nowrap;}
.hl{text-decoration-line:underline;text-decoration-style:dotted;text-decoration-thickness:1px;text-underline-offset:.2em;
  text-decoration-color:color-mix(in srgb,#F59E0B 75%,currentColor);
  background-color:color-mix(in srgb,#F59E0B 14%,transparent);border-radius:.2em;
  padding:0 .1em;margin:0 -.1em;-webkit-box-decoration-break:clone;box-decoration-break:clone;}
.ap{font-size:.82em;font-weight:normal;margin-left:.35em;padding:0 .3em;border-radius:.35em;opacity:.85;
  background-color:color-mix(in srgb,currentColor 7%,transparent);}
.ap.hl{background-color:color-mix(in srgb,#F59E0B 16%,transparent);margin-right:0;}
.ap.g0{margin-left:0;}
`;

  /* ------------------------------------------------------------------ */
  /* Renderer                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{parser: object, doc?: Document}} deps   parser = TransPriceParser (formatMoney, rateText)
   */
  NS.createRenderer = function createRenderer(deps) {
    const parser = deps.parser;
    const doc = deps.doc || document;
    let sheet; // CSSStyleSheet | null (fallback: a <style> per badge) — created lazily
    const badgeParts = new WeakMap(); // host → { span, tail }
    const hiddenStyles = new Map(); // Document | ShadowRoot → <style>

    function getSheet() {
      if (sheet !== undefined) return sheet;
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(BADGE_CSS);
      } catch {
        sheet = null;
      }
      return sheet;
    }

    function ensureHiddenStyle(node) {
      const root = (node.getRootNode && node.getRootNode()) || doc;
      const existing = hiddenStyles.get(root);
      if (existing && existing.isConnected) return;
      const st = doc.createElement('style');
      st.setAttribute('data-transprice-ignore', '');
      st.textContent = HIDDEN_CSS;
      if (root.nodeType === 9) (root.head || root.documentElement).appendChild(st);
      else root.appendChild(st);
      hiddenStyles.set(root, st);
    }

    function makeBadge() {
      const host = doc.createElement('transprice-badge');
      host.setAttribute('translate', 'no');
      const span = doc.createElement('span');
      const tail = doc.createTextNode('');
      let root = null;
      try {
        root = host.attachShadow({ mode: 'closed' });
      } catch {
        root = null;
      }
      if (root) {
        const s = getSheet();
        let adopted = false;
        if (s) {
          try {
            root.adoptedStyleSheets = [s];
            adopted = true;
          } catch {
            adopted = false;
          }
        }
        if (!adopted) {
          const st = doc.createElement('style');
          st.textContent = BADGE_CSS;
          root.appendChild(st);
        }
        root.append(span, tail);
      } else {
        host.append(span, tail); // no shadow DOM (should not happen): still readable, scanner skips our tag
      }
      badgeParts.set(host, { span, tail });
      return host;
    }

    function fillBadge(host, text, title, { append, highlight, gap0, trailSpace }) {
      const p = badgeParts.get(host);
      if (!p) return;
      p.span.className = `v${highlight ? ' hl' : ''}${append ? ' ap' : ''}${gap0 ? ' g0' : ''}`;
      p.span.textContent = text;
      p.span.title = title;
      p.tail.nodeValue = trailSpace ? ' ' : '';
    }

    const insertAfter = (ref, node) => ref.parentNode.insertBefore(node, ref.nextSibling);

    function format(value, env) {
      return parser.formatMoney(value, env.home, { locale: env.locale, compact: !!env.compact });
    }

    function itemsOf(rec, env) {
      return rec.matches.map((m) => ({
        raw: m.raw,
        text: m.valueMax != null ? joinRange(format(m.value, env), format(m.valueMax, env)) : format(m.value, env),
      }));
    }

    function titleOf(rec, items, env) {
      const lines = [];
      for (const cur of new Set(rec.matches.map((m) => m.currency))) {
        try {
          const line = parser.rateText(cur, env.home, env.rates, { locale: env.locale });
          if (line) lines.push(line);
        } catch {
          /* rate line is optional */
        }
      }
      return titleText(items, lines, env.rates && env.rates.date);
    }

    /* ---------- font of split prices ---------- */

    const digitCount = (s) => (String(s).match(/[0-9]/g) || []).length;

    /** Element holding the main digits of a split price (Taobao `priceInt`, Amazon `a-price-whole`). */
    function mainDigitsElement(rec) {
      let best = null;
      let bestCount = 0;
      for (const p of rec.parts) {
        if (p.nodeType !== 1) continue;
        const w = doc.createTreeWalker(p, 0x4);
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          const c = digitCount(t.nodeValue);
          if (c > bestCount) {
            bestCount = c;
            best = t.parentElement;
          }
        }
      }
      return best;
    }

    /**
     * Phase 1 of a batch (reads only, before any write → one style recalc): for split prices, copy the main digits'
     * font size / weight / colour onto the badge so "¥43.65" in a big orange `priceInt` becomes a big orange badge.
     */
    function prepare(batch, env) {
      if (typeof getComputedStyle !== 'function') return;
      for (const rec of batch) {
        rec.font = null;
        if (rec.kind !== 'element' || !rec.parts.some((p) => p.nodeType === 1)) continue;
        const main = mainDigitsElement(rec);
        const box = rec.container;
        if (!main || main === box || box.nodeType !== 1) continue;
        try {
          const a = getComputedStyle(main);
          const b = getComputedStyle(box);
          const font = {};
          if (a.color !== b.color) font.color = a.color;
          if (env.mode !== 'append') {
            if (a.fontSize !== b.fontSize) font['font-size'] = a.fontSize;
            if (a.fontWeight !== b.fontWeight) font['font-weight'] = a.fontWeight;
            if (a.fontFamily !== b.fontFamily) font['font-family'] = a.fontFamily;
            if (a.fontStyle !== b.fontStyle) font['font-style'] = a.fontStyle;
          }
          if (Object.keys(font).length) rec.font = font;
        } catch {
          rec.font = null;
        }
      }
    }

    /* ---------- apply / update / undo ---------- */

    /** Write one record into the page. */
    function apply(rec, env) {
      const append = env.mode === 'append';
      const highlight = !!env.highlight;
      const items = itemsOf(rec, env);
      const title = titleOf(rec, items, env);
      const texts = items.map((i) => i.text);
      rec.texts = new Map();
      rec.hidden = [];
      rec.badge = null;
      rec.mode = env.mode;
      rec.highlight = highlight;

      if (rec.kind === 'inline') {
        const node = rec.node;
        const original = node.nodeValue;
        if (!append) {
          const written = rewriteText(original, rec.matches, texts);
          rec.texts.set(node, { original, written });
          node.nodeValue = written;
          return;
        }
        rec.texts.set(node, { original, written: original });
        const trail = !!edges(original).trail;
        rec.badge = makeBadge();
        fillBadge(rec.badge, badgeText('inline', 'append', texts), title, { append: true, highlight, gap0: trail, trailSpace: trail });
        insertAfter(node, rec.badge);
        return;
      }

      const plan = writeParts(rec);
      rec.badge = makeBadge();
      if (rec.font) for (const [k, v] of Object.entries(rec.font)) rec.badge.style.setProperty(k, v);
      describeParts(rec);
      fillBadge(rec.badge, badgeText('element', env.mode, texts), title, { append, highlight, gap0: plan.gap0, trailSpace: plan.trailSpace });
      insertAfter(rec.parts[rec.parts.length - 1], rec.badge);
    }

    /** Write an element record's pieces (hide elements / empty text in replace mode) from planParts(). */
    function writeParts(rec) {
      const append = rec.mode === 'append';
      const pieces = rec.parts.map((p) =>
        p.nodeType === 3 ? { isText: true, current: p.nodeValue, entry: rec.texts.get(p) } : { isText: false },
      );
      const plan = planParts(pieces, rec.mode);
      let hid = false;
      rec.parts.forEach((p, i) => {
        const t = plan.texts[i];
        if (t) {
          rec.texts.set(p, t);
          if (p.nodeValue !== t.written) p.nodeValue = t.written;
        } else if (!append && p.nodeType === 1) {
          if (!p.hasAttribute(HIDDEN_ATTR)) p.setAttribute(HIDDEN_ATTR, '');
          if (!rec.hidden.includes(p)) rec.hidden.push(p);
          hid = true;
        }
      });
      if (hid) ensureHiddenStyle(rec.container);
      return plan;
    }

    /**
     * Pages that clone converted markup (carousel loops…) copy hidden pieces + blanked text but not our closed
     * shadow root: describe the pieces on the host so repairClone() can put a copy back (null = hidden element).
     */
    function describeParts(rec) {
      if (rec.mode === 'append' || !rec.badge) return;
      rec.badge.setAttribute(PARTS_ATTR, JSON.stringify(rec.parts.map((p) => (p.nodeType === 3 ? rec.texts.get(p).original : null))));
    }

    /** Is `host` a badge this renderer created (a page-made clone has no shadow parts)? */
    const isOwnBadge = (host) => badgeParts.has(host);

    /** Text + title a badge displays (closed shadow root → tests / dev harness only, via NS.debug). */
    const badgeInfo = (host) => {
      const p = badgeParts.get(host);
      return p ? { text: p.span.textContent, title: p.span.title } : null;
    };

    /**
     * Undo a CLONED badge (page copied our DOM): un-hide / refill the pieces right before it, then drop it.
     * Pieces are matched backwards from the badge (the badge always follows its last piece); stops at the first
     * node that does not fit the description.
     */
    function repairClone(host) {
      let info = null;
      try {
        info = JSON.parse(host.getAttribute(PARTS_ATTR) || 'null');
      } catch {
        info = null;
      }
      if (Array.isArray(info)) {
        let n = host.previousSibling;
        for (let i = info.length - 1; i >= 0 && n; i--, n = n.previousSibling) {
          if (info[i] === null && n.nodeType === 1) n.removeAttribute(HIDDEN_ATTR);
          else if (typeof info[i] === 'string' && n.nodeType === 3) {
            if (!n.nodeValue.trim()) n.nodeValue = info[i];
          } else break;
        }
      }
      host.remove();
    }

    /**
     * Update a rendered record IN PLACE after its matches changed — the page rewrote its text (scanner fast path)
     * or the rates changed. Same badge element; text the page rewrote becomes the new original and is emptied
     * again (replace mode); inline text is re-composed from the page's new value (`rec.matches` offsets refer to it).
     */
    function refresh(rec, env) {
      const items = itemsOf(rec, env);
      const title = titleOf(rec, items, env);
      const texts = items.map((i) => i.text);
      const append = rec.mode === 'append';
      const highlight = !!rec.highlight;
      if (rec.kind === 'inline') {
        const node = rec.node;
        const entry = rec.texts.get(node);
        const original = entry && node.nodeValue === entry.written ? entry.original : node.nodeValue;
        const written = append ? original : rewriteText(original, rec.matches, texts);
        rec.texts.set(node, { original, written });
        if (node.nodeValue !== written) node.nodeValue = written;
        if (append && rec.badge) {
          const trail = !!edges(original).trail;
          fillBadge(rec.badge, badgeText('inline', 'append', texts), title, { append: true, highlight, gap0: trail, trailSpace: trail });
        }
        return;
      }
      const plan = writeParts(rec);
      describeParts(rec);
      if (rec.badge) fillBadge(rec.badge, badgeText('element', rec.mode, texts), title, { append, highlight, gap0: plan.gap0, trailSpace: plan.trailSpace });
    }

    /** Undo one record. Text the page changed since we wrote it is left alone (the page's value wins). */
    function undo(rec) {
      if (rec.badge) {
        rec.badge.remove();
        rec.badge = null;
      }
      if (rec.hidden) for (const el of rec.hidden) el.removeAttribute(HIDDEN_ATTR);
      rec.hidden = [];
      if (rec.texts) {
        for (const [node, t] of rec.texts) {
          if (t.written !== t.original && node.nodeValue === t.written) node.nodeValue = t.original;
        }
      }
      rec.texts = new Map();
    }

    /** Final sweep after every record was undone: global styles + any straggler badge / hidden mark. */
    function restoreAll(root = doc) {
      for (const st of hiddenStyles.values()) st.remove();
      hiddenStyles.clear();
      try {
        for (const b of root.querySelectorAll('transprice-badge')) {
          if (isOwnBadge(b)) b.remove();
          else repairClone(b);
        }
        for (const el of root.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
      } catch {
        /* detached / exotic document */
      }
    }

    return { prepare, apply, refresh, update: refresh, undo, restoreAll, isOwnBadge, repairClone, badgeInfo };
  };
})();
