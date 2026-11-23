/**
 * TransPrice — storage helpers (ES module, imported by the service worker and extension pages).
 * Settings live in chrome.storage.sync (key `settings`), the rate table and small UI state in chrome.storage.local.
 * See docs/ARCHITECTURE.md §3.
 *
 * Every read goes through normalizeSettings(): unknown keys are dropped, every field is validated (§3.1) and an
 * unset home currency is guessed from the browser languages, so callers never see an invalid value.
 */
import './currency-data.js'; // side effect: globalThis.TransPriceCurrencies (§4.1)
import {
  AMBIGUOUS_SYMBOLS,
  DEFAULT_SETTINGS,
  DISPLAY_MODES,
  SITE_MODES,
  STORAGE_KEYS,
  THEMES,
  UI_LANGUAGES,
} from './constants.js';

/**
 * chrome.storage.sync allows 8 KB per item and all settings are ONE item: cap the lists (newest kept) so that even
 * with both site lists and the pins full of typical hostnames the object stays under the quota.
 */
export const MAX_SITE_LIST = 120; // enabledSites, disabledSites (each)
export const MAX_SITE_CURRENCY = 50;

/** Codes a usable rate table must contain (the currencies the detector relies on most). */
export const REQUIRED_RATE_CODES = Object.freeze(['USD', 'EUR', 'CNY', 'JPY', 'VND']);

/* ------------------------------------------------------------------ */
/* Currency helpers                                                    */
/* ------------------------------------------------------------------ */

const currencyTable = () => globalThis.TransPriceCurrencies?.CURRENCIES || null;

/** True if `code` is a currency TransPrice knows (falls back to "looks like ISO 4217" if the table is missing). */
export function isKnownCurrency(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  const table = currencyTable();
  return table ? Object.prototype.hasOwnProperty.call(table, code) : true;
}

const upper = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

/** Browser locales in preference order: Chrome's UI language first, then navigator.languages. */
export function browserLocales() {
  const out = [];
  try {
    const ui = globalThis.chrome?.i18n?.getUILanguage?.();
    if (typeof ui === 'string' && ui) out.push(ui);
  } catch {
    /* not in an extension context */
  }
  const langs = globalThis.navigator?.languages;
  if (Array.isArray(langs) || (langs && typeof langs.length === 'number')) {
    for (const l of langs) if (typeof l === 'string' && l && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Home-currency guess from the browser languages (vi → VND, ja → JPY, en-US → USD …), fallback USD. */
export function guessHomeCurrency(locales = browserLocales()) {
  let guess = '';
  try {
    guess = upper(globalThis.TransPriceCurrencies?.guessHomeCurrency?.(locales));
  } catch {
    guess = '';
  }
  return isKnownCurrency(guess) ? guess : 'USD';
}

/* ------------------------------------------------------------------ */
/* Hostnames                                                           */
/* ------------------------------------------------------------------ */

/**
 * Normalise a hostname (or URL) for site rules: lowercase, punycode, no port/path, no leading `www.` / `*.`.
 * "https://www.Taobao.com/item?id=1" → "taobao.com". Returns '' for anything that is not a hostname.
 * @param {string} input
 * @returns {string}
 */
export function normalizeHostname(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^\*\./, '');
  try {
    // The URL parser lowercases, converts IDN to punycode and drops port/path/credentials for us.
    s = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return '';
  }
  if (/^\[[0-9a-f:.]+\]$/.test(s)) return s; // IPv6 literal, as location.hostname reports it ("[::1]")
  s = s.replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(s) ? s : '';
}

/**
 * Two-label public suffixes under which the registrable domain has THREE labels (`shopee.com.vn`, `bbc.co.uk`).
 * A deliberately small stand-in for the Public Suffix List (§3.5). Immutable: add/delete/clear throw.
 * The content script mirrors this list — keep both in sync (a test compares them).
 * @type {ReadonlySet<string>}
 */
export const MULTI_PART_SUFFIXES = (() => {
  const set = new Set([
    // contract list (§3.5)
    'co.uk', 'com.au', 'com.vn', 'co.jp', 'com.cn', 'com.hk', 'com.tw', 'com.sg', 'co.kr', 'co.nz', 'com.br', 'com.mx',
    'co.id', 'co.th', 'com.my', 'com.ph', 'co.in', 'ac.uk', 'gov.uk', 'org.uk', 'net.au', 'edu.vn', 'gov.vn', 'net.vn',
    'org.vn',
    // common extras
    'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk',
    'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
    'ac.vn', 'int.vn', 'info.vn', 'biz.vn', 'name.vn', 'pro.vn', 'health.vn',
    'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp', 'ad.jp', 'ed.jp', 'lg.jp',
    'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
    'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
    'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
    'ne.kr', 'or.kr', 'ac.kr', 'go.kr', 're.kr',
    'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'gen.nz',
    'net.br', 'org.br', 'gov.br', 'edu.br',
    'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
    'or.id', 'ac.id', 'go.id', 'web.id', 'my.id',
    'in.th', 'or.th', 'ac.th', 'go.th',
    'net.my', 'org.my', 'gov.my', 'edu.my',
    'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
    'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in', 'gen.in', 'ind.in',
    'co.za', 'org.za', 'gov.za', 'ac.za',
    'com.tr', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.ec', 'com.uy', 'com.py', 'com.bo',
    'com.sa', 'com.eg', 'com.pk', 'com.bd', 'com.np', 'com.lk', 'com.kh', 'com.mm', 'com.ng', 'com.gh', 'co.ke',
    'co.il', 'org.il', 'ac.il', 'com.ua', 'com.pl', 'com.es', 'com.pt', 'com.gr', 'co.at', 'or.at',
    'com.qa', 'com.kw', 'com.om', 'com.bh', 'com.lb', 'com.jo', 'com.tn', 'co.ma', 'com.do', 'com.gt', 'com.pa',
  ]);
  const readOnly = () => {
    throw new TypeError('MULTI_PART_SUFFIXES is read-only');
  };
  return Object.freeze(Object.defineProperties(set, { add: { value: readOnly }, delete: { value: readOnly }, clear: { value: readOnly } }));
})();

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Registrable domain of a host (§3.5), approximated without a public-suffix list: normalised (lowercase, no `www.`);
 * IPs, `localhost` and single-label hosts as-is; otherwise the last 2 labels, or the last 3 when the last two are a
 * MULTI_PART_SUFFIXES entry. `item.taobao.com` → `taobao.com`, `www.amazon.co.uk` → `amazon.co.uk`. '' if invalid.
 * @param {string} hostname  hostname or URL
 * @returns {string}
 */
export function siteKey(hostname) {
  const host = normalizeHostname(hostname);
  if (!host || host.startsWith('[') || IPV4_RE.test(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return labels.length > 2 && MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * True if `hostname` is one of `list` or a subdomain of one (a rule for `taobao.com` covers `world.taobao.com`).
 * @param {string} hostname
 * @param {string[]} list
 * @returns {boolean}
 */
export function isSiteMatch(hostname, list) {
  const host = normalizeHostname(hostname);
  if (!host || !Array.isArray(list)) return false;
  return list.some((entry) => {
    const site = normalizeHostname(entry);
    return !!site && (host === site || host.endsWith(`.${site}`));
  });
}

/**
 * THE rule for "does TransPrice convert on this host?" (§3.5) — the content script mirrors this exact function.
 * Global master switch, then the site mode: 'allowlist' → only hosts covered by enabledSites; 'all' → every host
 * not covered by disabledSites.
 * @param {{enabled: boolean, siteMode: string, enabledSites: string[], disabledSites: string[]}} settings
 * @param {string} hostname
 * @returns {boolean}
 */
export function isSiteActive(settings, hostname) {
  if (!settings || !settings.enabled) return false;
  return settings.siteMode === 'allowlist'
    ? isSiteMatch(hostname, settings.enabledSites)
    : !isSiteMatch(hostname, settings.disabledSites);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pickBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const pickEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

/** enabledSites / disabledSites: normalised hostnames, deduped, newest kept under the cap. */
function normalizeSiteList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    const host = normalizeHostname(entry);
    if (host) {
      seen.delete(host); // re-adding moves it to the end ("newest")
      seen.add(host);
    }
  }
  return [...seen].slice(-MAX_SITE_LIST);
}

function normalizeSiteCurrency(value) {
  if (!isPlainObject(value)) return {};
  const out = new Map();
  for (const [rawHost, pins] of Object.entries(value)) {
    const host = normalizeHostname(rawHost);
    if (!host || !isPlainObject(pins)) continue;
    const clean = { ...(out.get(host) || {}) };
    for (const symbol of Object.keys(AMBIGUOUS_SYMBOLS)) {
      const code = upper(pins[symbol]);
      if (AMBIGUOUS_SYMBOLS[symbol].includes(code)) clean[symbol] = code;
    }
    out.delete(host);
    if (Object.keys(clean).length) out.set(host, clean);
  }
  return Object.fromEntries([...out].slice(-MAX_SITE_CURRENCY));
}

/**
 * Merge raw stored settings with DEFAULT_SETTINGS and validate every field (§3.1). Unknown keys are dropped.
 * Synchronous; `homeCurrency` is guessed from the browser languages when unset or unknown.
 * @param {object} raw  anything (a stored value, a patch merged onto current settings, garbage)
 * @param {{locales?: string[]}} [options]  locales for the home-currency guess (default: browserLocales())
 * @returns {object} a complete, valid Settings object
 */
export function normalizeSettings(raw, { locales } = {}) {
  const s = isPlainObject(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  const home = upper(s.homeCurrency);
  const dollar = upper(s.defaultDollar);
  const yen = upper(s.defaultYen);
  return {
    enabled: pickBool(s.enabled, d.enabled),
    homeCurrency: isKnownCurrency(home) ? home : guessHomeCurrency(locales || browserLocales()),
    displayMode: pickEnum(s.displayMode, DISPLAY_MODES, d.displayMode),
    compact: pickBool(s.compact, d.compact),
    highlight: pickBool(s.highlight, d.highlight),
    defaultDollar: AMBIGUOUS_SYMBOLS.dollar.includes(dollar) ? dollar : d.defaultDollar,
    defaultYen: AMBIGUOUS_SYMBOLS.yen.includes(yen) ? yen : d.defaultYen,
    // Settings stored before siteMode existed get the default ('allowlist'): off everywhere until turned on (§3.5).
    siteMode: pickEnum(s.siteMode, SITE_MODES, d.siteMode),
    enabledSites: normalizeSiteList(s.enabledSites),
    disabledSites: normalizeSiteList(s.disabledSites),
    siteCurrency: normalizeSiteCurrency(s.siteCurrency),
    theme: pickEnum(s.theme, THEMES, d.theme),
    uiLanguage: pickEnum(s.uiLanguage, UI_LANGUAGES, d.uiLanguage),
  };
}

async function readRawSettings() {
  const data = await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
  return data?.[STORAGE_KEYS.SETTINGS];
}

/**
 * Current settings: stored values merged with defaults, validated, home currency guessed if unset.
 * @returns {Promise<object>}
 */
export async function getSettings() {
  return normalizeSettings(await readRawSettings());
}

// Serialise read-modify-write cycles made from this context (e.g. two quick toggles) so none is lost.
let writeChain = Promise.resolve();

/**
 * Shallow-merge `patch` into the current settings, validate, persist (only if something changed) and return the
 * new settings. `patch` may also be a function `(current) => patch`, evaluated inside the write queue — use it
 * for updates that depend on the current value (toggles, list edits) so concurrent updates don't race.
 * The written object is complete and validated (including the guessed home currency), so storage.onChanged
 * listeners can use `newValue` as-is. Also mirrors `uiLanguage` to chrome.storage.local (STORAGE_KEYS.UI_LANGUAGE).
 * @param {object | ((current: object) => object)} patch
 * @returns {Promise<object>}
 */
export function updateSettings(patch) {
  const run = async () => {
    const raw = await readRawSettings();
    const current = normalizeSettings(raw);
    const delta = typeof patch === 'function' ? await patch(current) : patch;
    const next = normalizeSettings({ ...current, ...(isPlainObject(delta) ? delta : {}) });
    if (JSON.stringify(raw) !== JSON.stringify(next)) {
      await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: next });
    }
    await mirrorUiLanguage(next.uiLanguage);
    return next;
  };
  const result = writeChain.then(run, run);
  writeChain = result.catch(() => {});
  return result;
}

/**
 * Keep chrome.storage.local[STORAGE_KEYS.UI_LANGUAGE] equal to settings.uiLanguage (read synchronously-ish by
 * i18n.js at page boot). Writes only when the value differs.
 * @param {string} uiLanguage  'auto' | 'en' | 'vi' (anything else → 'auto')
 */
export async function mirrorUiLanguage(uiLanguage) {
  const value = pickEnum(uiLanguage, UI_LANGUAGES, DEFAULT_SETTINGS.uiLanguage);
  const data = await chrome.storage.local.get(STORAGE_KEYS.UI_LANGUAGE);
  if (data?.[STORAGE_KEYS.UI_LANGUAGE] !== value) {
    await chrome.storage.local.set({ [STORAGE_KEYS.UI_LANGUAGE]: value });
  }
}

/**
 * Subscribe to settings changes (from any context or device). The callback receives validated settings.
 * @param {(settings: object) => void} callback
 * @returns {() => void} unsubscribe
 */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'sync' && changes?.[STORAGE_KEYS.SETTINGS]) {
      callback(normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Structural check of a RatesTable (§3.2): base USD, USD = 1, positive finite numbers, the required codes present.
 * @param {any} table
 * @returns {boolean}
 */
export function isValidRatesTable(table) {
  if (!isPlainObject(table) || table.base !== 'USD' || !isPlainObject(table.rates)) return false;
  if (typeof table.date !== 'string' || typeof table.source !== 'string') return false;
  if (typeof table.fetchedAt !== 'number' || !Number.isFinite(table.fetchedAt)) return false;
  if (table.rates.USD !== 1) return false;
  if (!REQUIRED_RATE_CODES.every((code) => code in table.rates)) return false;
  return Object.values(table.rates).every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

/**
 * The rate table stored in chrome.storage.local (last successful live fetch), or null if missing/corrupt.
 * @returns {Promise<object|null>}
 */
export async function getStoredRates() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RATES);
  const table = data?.[STORAGE_KEYS.RATES];
  return isValidRatesTable(table) ? table : null;
}

/**
 * Persist a rate table. Writing it is how content scripts and pages learn about new rates (storage.onChanged).
 * @param {object} table  a valid RatesTable
 */
export async function setStoredRates(table) {
  if (!isValidRatesTable(table)) throw new TypeError('Invalid rates table');
  await chrome.storage.local.set({ [STORAGE_KEYS.RATES]: table });
}
