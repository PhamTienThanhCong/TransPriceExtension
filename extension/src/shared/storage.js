/**
 * TransPrice — storage helpers (ES module, imported by the service worker and extension pages).
 * Settings live in chrome.storage.sync (key `settings`), the rate table and small UI state in chrome.storage.local.
 * See docs/ARCHITECTURE.md §3.
 *
 * Every read goes through normalizeSettings(): unknown keys are dropped, every field is validated (§3.1) and an
 * unset home currency is guessed from the browser languages, so callers never see an invalid value.
 */
import './currency-data.js'; // side effect: globalThis.TransPriceCurrencies (§4.1)
import { AMBIGUOUS_SYMBOLS, DEFAULT_SETTINGS, DISPLAY_MODES, STORAGE_KEYS, THEMES, UI_LANGUAGES } from './constants.js';

/** chrome.storage.sync allows 8 KB per item: cap the lists so the settings object always fits (newest kept). */
const MAX_DISABLED_SITES = 200;
const MAX_SITE_CURRENCY = 100;

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
  s = s.replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(s) ? s : '';
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

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pickBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const pickEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

function normalizeDisabledSites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    const host = normalizeHostname(entry);
    if (host) {
      seen.delete(host); // re-adding moves it to the end ("newest")
      seen.add(host);
    }
  }
  return [...seen].slice(-MAX_DISABLED_SITES);
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
    disabledSites: normalizeDisabledSites(s.disabledSites),
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
