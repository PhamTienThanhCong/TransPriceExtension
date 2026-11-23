/*
 * TransPrice content script — entry point (loaded last: currency-data.js, parser.js, scanner.js, render.js, content.js).
 *
 * docs/ARCHITECTURE.md §6.1 + §5: GET_STATE → page context → scan (time-sliced) + MutationObserver; reacts to
 * settings / rates changes (chrome.storage.onChanged); answers GET_PAGE_INFO and RESCAN; reports the converted
 * count (throttled REPORT_COUNT). Never throws into the page; when the extension context disappears (extension
 * reloaded / removed while the tab stays open) it restores the page and goes quiet.
 */
(() => {
  'use strict';

  const NS = globalThis.__transprice;
  if (!NS || NS.loaded || typeof NS.createScanner !== 'function' || typeof NS.createRenderer !== 'function') return;
  const P = globalThis.TransPriceParser;
  const CUR = globalThis.TransPriceCurrencies;
  if (!P || !CUR || typeof document === 'undefined' || !document.documentElement) return;
  NS.loaded = true;

  const { MSG, LIMITS, DEFAULT_SETTINGS, REPORT_THROTTLE_MS, SAMPLE_CHARS } = NS.C;
  const U = NS.util;

  const hostname = (() => {
    try {
      return location.hostname || '';
    } catch {
      return '';
    }
  })();

  let dead = false;
  let settings = { ...DEFAULT_SETTINGS };
  let rates = null;
  let ctx = null;
  let active = false;
  let env = null;
  let fingerprint = '';
  let stateSeq = 0;

  /* ------------------------------------------------------------------ */
  /* Extension context                                                   */
  /* ------------------------------------------------------------------ */

  function alive() {
    if (dead) return false;
    try {
      return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  const listeners = [];
  function on(target, fn) {
    try {
      target.addListener(fn);
      listeners.push(() => target.removeListener(fn));
    } catch {
      /* API missing */
    }
  }

  /** The extension went away: put the page back and stop everything, silently. */
  function teardown() {
    if (dead) return;
    dead = true;
    try {
      scanner.stop();
      scanner.restoreAll();
    } catch {
      /* ignore */
    }
    report.cancel();
    for (const off of listeners.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Message to the background → resolves with the envelope's data, rejects on errors. Never throws synchronously.
   * @param {string} type @param {object} [payload]
   */
  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!alive()) {
        teardown();
        reject(new Error('CONTEXT_INVALIDATED'));
        return;
      }
      const done = (res) => {
        let lastError = null;
        try {
          lastError = chrome.runtime.lastError;
        } catch {
          /* ignore */
        }
        if (lastError) {
          if (/context invalidated/i.test(String(lastError.message)) || !alive()) teardown();
          reject(new Error(String(lastError.message || 'runtime error')));
        } else if (!res || typeof res !== 'object') reject(new Error('No response'));
        else if (res.ok === false) reject(Object.assign(new Error(res.error?.message || 'error'), { code: res.error?.code }));
        else resolve(res);
      };
      try {
        const maybe = chrome.runtime.sendMessage({ type, ...payload }, done);
        if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {}); // promise flavour: errors go to `done`
      } catch (err) {
        if (/context invalidated/i.test(String(err && err.message)) || !alive()) teardown();
        reject(err);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scanner + renderer                                                  */
  /* ------------------------------------------------------------------ */

  let lastReported = -1;
  const report = U.createThrottle((count) => {
    if (count === lastReported || dead) return;
    lastReported = count;
    send(MSG.REPORT_COUNT, { count }).catch(() => {});
  }, REPORT_THROTTLE_MS);

  const renderer = NS.createRenderer({ parser: P, doc: document });
  const scanner = NS.createScanner({
    parser: P,
    render: renderer,
    doc: document,
    getEnv: () => env,
    onCount: (n) => report(n),
    isAlive: alive,
    onDead: teardown,
    tokens: Array.isArray(CUR.TOKENS) ? CUR.TOKENS.map((t) => t && t.token) : [],
    ambiguous: CUR.AMBIGUOUS,
  });

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /** Title + the first ~3 000 characters of visible-ish body text, without building body.textContent. */
  function sampleText() {
    let out = '';
    try {
      out = `${document.title || ''} `;
      const body = document.body;
      if (!body) return out;
      const w = document.createTreeWalker(body, 0x1 | 0x4, {
        acceptNode: (n) => (n.nodeType === 3 ? 1 : U.isRejectedTag(n.localName) ? 2 : 3),
      });
      for (let t = w.nextNode(); t && out.length < SAMPLE_CHARS; t = w.nextNode()) {
        const v = t.nodeValue.trim();
        if (v) out += `${v} `;
      }
    } catch {
      /* ignore */
    }
    return out.slice(0, SAMPLE_CHARS);
  }

  const validRates = (r) => !!(r && typeof r === 'object' && r.rates && typeof r.rates === 'object');

  function homeOf(st) {
    if (st.homeCurrency && CUR.CURRENCIES && CUR.CURRENCIES[st.homeCurrency]) return st.homeCurrency;
    try {
      return CUR.guessHomeCurrency([...(navigator.languages || []), navigator.language].filter(Boolean));
    } catch {
      return 'USD';
    }
  }

  function preferredLocales() {
    try {
      return [...(navigator.languages || []), navigator.language].filter(Boolean);
    } catch {
      return [];
    }
  }

  let sample = null;

  /** Apply settings + rates: recompute context / env and restart or refresh the scan as needed. */
  function applyState(nextSettings, nextRates) {
    if (dead) return;
    settings = { ...DEFAULT_SETTINGS, ...(nextSettings && typeof nextSettings === 'object' ? nextSettings : {}) };
    const ratesChanged = validRates(nextRates) && (!rates || nextRates.date !== rates.date || nextRates.fetchedAt !== rates.fetchedAt || nextRates.source !== rates.source);
    if (validRates(nextRates)) rates = nextRates;
    const home = homeOf(settings);
    const nextActive = !!settings.enabled && !U.isSiteMatch(hostname, settings.disabledSites) && !!rates && !!document.body;

    if (nextActive) {
      if (sample === null) sample = sampleText();
      let lang = '';
      try {
        lang = document.documentElement.lang || '';
      } catch {
        /* ignore */
      }
      ctx = P.resolveContext({ hostname, lang, sampleText: sample, settings });
    }
    const nextFingerprint = JSON.stringify(
      nextActive
        ? [true, home, settings.displayMode, !!settings.compact, !!settings.highlight, ctx && [ctx.dollar, ctx.yen, ctx.kr, ctx.decimal]]
        : [false],
    );

    env = nextActive
      ? {
          ctx,
          home,
          rates,
          mode: settings.displayMode === 'append' ? 'append' : 'replace',
          compact: !!settings.compact,
          highlight: !!settings.highlight,
          locale: CUR.localeFor(home, preferredLocales()),
          max: LIMITS.MAX_PRICES_PER_PAGE,
        }
      : null;

    if (nextFingerprint !== fingerprint || nextActive !== active) {
      fingerprint = nextFingerprint;
      active = nextActive;
      restart();
    } else if (active && ratesChanged) {
      scanner.refreshValues();
    }
  }

  /** Restore the page, then (if active) scan it again from scratch. */
  function restart() {
    scanner.stop();
    scanner.restoreAll();
    if (active && document.body) scanner.start(document.body);
    else report(0);
  }

  /** GET_STATE → applyState. `force` = restore + full rescan even if nothing relevant changed (RESCAN). */
  async function loadState(force = false) {
    const seq = ++stateSeq;
    let res = null;
    for (let attempt = 0; attempt < 3 && !res && !dead; attempt++) {
      try {
        res = await send(MSG.GET_STATE);
      } catch {
        if (dead) return;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // service worker may still be starting
      }
    }
    if (dead || seq !== stateSeq) return;
    if (force) fingerprint = '';
    if (!res) {
      if (force) applyState(settings, rates); // background unreachable: rescan with what we have
      return;
    }
    try {
      applyState(res.settings, res.rates);
    } catch (err) {
      console.debug('[TransPrice] apply state failed', err);
    }
  }

  let reloadTimer = 0;
  function onStorageChanged(changes, area) {
    try {
      if (!alive()) {
        teardown();
        return;
      }
      if (area === 'sync' && changes && changes.settings) {
        // Re-ask the background: it validates the raw value and guesses an empty homeCurrency.
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          loadState().catch(() => {});
        }, 30);
      } else if (area === 'local' && changes && changes.rates && validRates(changes.rates.newValue)) {
        applyState(settings, changes.rates.newValue);
      }
    } catch {
      /* never throw into the page */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Messages from the popup                                             */
  /* ------------------------------------------------------------------ */

  function pageInfo() {
    const info = active ? scanner.pageInfo(ctx) : { count: 0, currencies: {}, ambiguous: [] };
    return { hostname: U.normalizeHost(hostname), active, count: info.count, currencies: info.currencies, ambiguous: info.ambiguous };
  }

  async function rescan() {
    await loadState(true);
    return active ? scanner.whenIdle() : 0;
  }

  function onMessage(msg, _sender, sendResponse) {
    try {
      if (!msg || typeof msg.type !== 'string') return false;
      if (msg.type === MSG.GET_PAGE_INFO) {
        sendResponse({ ok: true, ...pageInfo() });
        return false;
      }
      if (msg.type === MSG.RESCAN) {
        rescan().then(
          (count) => sendResponse({ ok: true, count: typeof count === 'number' ? count : 0 }),
          (err) => sendResponse({ ok: false, error: { code: 'UNKNOWN', message: String((err && err.message) || err) } }),
        );
        return true;
      }
    } catch (err) {
      try {
        sendResponse({ ok: false, error: { code: 'UNKNOWN', message: String((err && err.message) || err) } });
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  try {
    if (!alive()) return;
    on(chrome.runtime.onMessage, onMessage);
    if (chrome.storage && chrome.storage.onChanged) on(chrome.storage.onChanged, onStorageChanged);
    const boot = () => loadState().catch(() => {});
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  } catch (err) {
    console.debug('[TransPrice] start failed', err);
  }

  /** Dev harness / tests only (isolated world: invisible to real pages). */
  NS.debug = Object.freeze({ pageInfo, rescan, env: () => env, records: () => scanner._records(), badgeInfo: (host) => renderer.badgeInfo(host) });
})();
