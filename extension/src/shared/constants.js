/**
 * TransPrice — shared constants (ES module). MANAGER-OWNED: this file is part of the team contract
 * (docs/ARCHITECTURE.md). Need a change? Ask in your report — don't edit it.
 */

export const APP_NAME = 'TransPrice';

/** Message types. Every response is an envelope: { ok: true, ...data } | { ok: false, error: { code, message } }. */
export const MSG = Object.freeze({
  // ── handled by the background service worker ──
  GET_STATE: 'get-state', //           {}                              → { settings, rates }
  REFRESH_RATES: 'refresh-rates', //   {}                              → { rates }   (force a live fetch)
  UPDATE_SETTINGS: 'update-settings', // { patch }                     → { settings }
  SET_SITE_ACTIVE: 'set-site-active', // { hostname, active }          → { settings }  (allowlist: add/remove siteKey(host) in enabledSites; all: remove/add in disabledSites)
  SET_SITE_CURRENCY: 'set-site-currency', // { hostname, symbol: 'dollar'|'yen', currency: string|null } → { settings }
  REPORT_COUNT: 'report-count', //     { count }  (content → bg, sets the per-tab toolbar badge) → {}
  OPEN_OPTIONS: 'open-options', //     { section? }                    → {}
  // ── handled by the content script (top frame) ──
  GET_PAGE_INFO: 'get-page-info', //   {}  → { hostname, siteKey, active, count, currencies: {CODE: n}, ambiguous: AmbiguityInfo[], detected?: { count, currencies } }
  RESCAN: 'rescan', //                 {}  → { count }
});

export const DISPLAY_MODES = Object.freeze(['replace', 'append']);
/** 'allowlist' (default): convert ONLY on sites the user turned on (remembered in enabledSites).
 *  'all': convert everywhere except disabledSites. */
export const SITE_MODES = Object.freeze(['allowlist', 'all']);
export const THEMES = Object.freeze(['auto', 'light', 'dark']);
export const UI_LANGUAGES = Object.freeze(['auto', 'en', 'vi']);

/** Ambiguous symbols the user can pin (globally in settings, or per site). */
export const AMBIGUOUS_SYMBOLS = Object.freeze({
  dollar: Object.freeze(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'MXN']),
  yen: Object.freeze(['CNY', 'JPY']),
});

/**
 * Settings live in chrome.storage.sync under STORAGE_KEYS.SETTINGS. Always read through getSettings()
 * (src/shared/storage.js) which merges these defaults, validates every field and fills homeCurrency
 * from the browser locale when the user never chose one.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true, //            global master switch (pause everything); per-site activation is siteMode + lists below
  homeCurrency: '', //         ISO 4217; '' = not chosen yet → guessed from the browser locale (vi → VND)
  displayMode: 'replace', //   'replace': show only the converted price (original on hover) | 'append': "¥189 ≈ 730.000 ₫"
  compact: false, //           compact numbers: "730 N ₫" / "$1.2K"
  highlight: true, //          subtle dotted underline + tint on converted prices
  defaultDollar: 'USD', //     what a bare "$" means when the page gives no hint
  defaultYen: 'CNY', //        what a bare "¥" means when the page gives no hint (Taobao/1688 users → CNY)
  siteMode: 'allowlist', //    see SITE_MODES — off everywhere until the user turns a site on
  enabledSites: Object.freeze([]), //  siteKeys turned on by the user (allowlist mode); a rule covers the host + subdomains
  disabledSites: Object.freeze([]), // siteKeys turned off by the user ('all' mode)
  siteCurrency: Object.freeze({}), //  { [hostname]: { dollar?: code, yen?: code } } per-site pins for ambiguous symbols
  theme: 'auto', //            'auto' | 'light' | 'dark' — popup, options, welcome
  uiLanguage: 'auto', //       'auto' | 'en' | 'vi' — extension pages' display language
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings', //     chrome.storage.sync
  RATES: 'rates', //           chrome.storage.local — RatesTable (see ARCHITECTURE §5)
  CONVERTER: 'converterState', // chrome.storage.local — popup quick converter { amount, from, to }
  UI_LANGUAGE: 'uiLanguage', // chrome.storage.local mirror read synchronously by i18n.js (see §8)
});

/** Live exchange-rate sources, tried in order. All free, keyless, CORS `*`. Rates are "units per 1 USD". */
export const RATE_SOURCES = Object.freeze([
  Object.freeze({ id: 'currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json' }),
  Object.freeze({ id: 'currency-api-mirror', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json' }),
  Object.freeze({ id: 'er-api', url: 'https://open.er-api.com/v6/latest/USD' }),
]);

export const LIMITS = Object.freeze({
  RATES_TTL_MS: 12 * 60 * 60 * 1000, // rates older than this are refreshed (stale ones are still served meanwhile)
  RATES_ALARM_MINUTES: 360, //         periodic refresh via chrome.alarms
  FETCH_TIMEOUT_MS: 10_000,
  MAX_PRICES_PER_PAGE: 3000, //        stop converting after this many matches (safety valve)
  CLUSTER_MAX_CHARS: 64, //            a split-price element's textContent must be at most this long
  CLUSTER_MAX_DEPTH: 4, //             climb at most this many ancestors from a currency-token text node
  SCAN_DEBOUNCE_MS: 150, //            MutationObserver batching
  SCAN_BUDGET_MS: 12, //               time-slice per scanning chunk (keeps the page responsive)
});

export const ERROR_CODES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  BAD_REQUEST: 'BAD_REQUEST',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  BAD_RESPONSE: 'BAD_RESPONSE',
  NO_RATES: 'NO_RATES',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
});
