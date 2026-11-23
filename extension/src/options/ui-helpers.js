/**
 * TransPrice — PURE helpers shared by the popup, the options page and the welcome page.
 * No DOM, no chrome.*, no globals: everything they need is passed in, so they run unchanged in Node tests
 * (tests/ui/*.test.mjs). DOM building lives in ui-kit.js.
 */

/** Currencies listed under "Suggested" right after the home currency (most-shopped / most-traded first). */
export const POPULAR_CURRENCIES = Object.freeze([
  'USD',
  'EUR',
  'CNY',
  'JPY',
  'KRW',
  'GBP',
  'VND',
  'THB',
  'SGD',
  'HKD',
  'TWD',
  'AUD',
  'CAD',
]);

/** Display names of the rate providers (brand names, not translated). `snapshot` is localized by the caller. */
export const RATE_SOURCE_LABELS = Object.freeze({
  'currency-api': 'Currency API',
  'currency-api-mirror': 'Currency API',
  'er-api': 'ExchangeRate-API',
});

/* ------------------------------------------------------------------ */
/* Text folding (search)                                               */
/* ------------------------------------------------------------------ */

/**
 * Lower-case + strip diacritics so "dong", "Đồng" and "ĐỒNG" all match ("đ" has no NFD decomposition).
 * @param {string} text
 * @returns {string}
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

/* ------------------------------------------------------------------ */
/* Currency list                                                       */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} CurrencyItem
 * @property {string} code     ISO 4217, e.g. 'VND'
 * @property {string} name     name in the UI language (what the list shows)
 * @property {string} symbol   preferred display symbol, e.g. '₫'
 * @property {string} flag     emoji flag ('' if none)
 * @property {string[]} names  every name searched (UI language + English + Vietnamese …), deduped
 * @property {string[]} symbols every symbol/marker searched ('¥', '元', 'RMB' …), deduped
 */

/**
 * Build the picker's currency list: the home currency first, then the popular ones (in POPULAR order),
 * then every other code A→Z. Codes missing from `codes` (e.g. no exchange rate) are skipped.
 *
 * @param {object} opts
 * @param {string[]} opts.codes                       available ISO codes
 * @param {string} [opts.home]                        home currency (pinned first)
 * @param {string[]} [opts.popular]                   default POPULAR_CURRENCIES
 * @param {(code: string, locale: string) => string} opts.nameOf   localized currency name
 * @param {string} [opts.locale]                      UI locale for `name`
 * @param {string[]} [opts.searchLocales]             extra locales whose names are searchable (default ['en', 'vi'])
 * @param {(code: string) => string} [opts.symbolOf]  display symbol
 * @param {(code: string) => string[]} [opts.markersOf] other recognisable markers (tokens) of the currency
 * @param {(code: string) => string} [opts.flagOf]    emoji flag
 * @returns {{ suggested: CurrencyItem[], others: CurrencyItem[], all: CurrencyItem[] }}
 *   `all` = suggested followed by others (the list order).
 */
export function buildCurrencyList({
  codes,
  home = '',
  popular = POPULAR_CURRENCIES,
  nameOf,
  locale = 'en',
  searchLocales = ['en', 'vi'],
  symbolOf = () => '',
  markersOf = () => [],
  flagOf = () => '',
}) {
  const available = new Set((codes || []).filter((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)));
  const safe = (fn, ...args) => {
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
  const make = (code) => {
    const name = String(safe(nameOf, code, locale) || code);
    const names = uniq([name, ...searchLocales.map((l) => safe(nameOf, code, l))]);
    const symbol = String(safe(symbolOf, code) || '');
    const markers = safe(markersOf, code);
    return {
      code,
      name,
      symbol,
      flag: String(safe(flagOf, code) || ''),
      names,
      symbols: uniq([symbol, ...(Array.isArray(markers) ? markers : [])]),
    };
  };

  const suggestedCodes = uniq([home, ...popular]).filter((c) => available.has(c));
  const suggestedSet = new Set(suggestedCodes);
  const suggested = suggestedCodes.map(make);
  const others = [...available]
    .filter((c) => !suggestedSet.has(c))
    .sort()
    .map(make);
  return { suggested, others, all: [...suggested, ...others] };
}

function uniq(list) {
  const out = [];
  for (const v of list) {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Filter + rank currencies for a search query. Matches the ISO code, the names in every searched language
 * (diacritic-insensitive: "dong" finds "Đồng Việt Nam") and the symbols ("¥", "元", "₫").
 * Names match by word prefixes — every query word must start a word of the same name ("nhan dan", "south kor") —
 * so short queries don't drown in accidental substrings ("yen" must not hit "chuyển đổi").
 * Ranking: exact code → exact symbol → code prefix → name prefix → word prefixes → symbol substring;
 * ties keep list order. An empty query returns the list unchanged.
 *
 * @param {CurrencyItem[]} items
 * @param {string} query
 * @returns {CurrencyItem[]}
 */
export function filterCurrencies(items, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return [...items];
  const q = fold(raw);
  const words = q.split(WORD_SPLIT).filter(Boolean);
  const ranked = [];
  items.forEach((item, index) => {
    const rank = matchRank(item, raw, q, words);
    if (rank !== null) ranked.push({ item, index, rank });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.item);
}

const WORD_SPLIT = /[\s\-–()/.,']+/;

function matchRank(item, raw, q, words) {
  const code = item.code.toLowerCase();
  if (code === q) return 0;
  const symbols = item.symbols || [];
  if (symbols.some((s) => s === raw || fold(s) === q)) return 1;
  if (code.startsWith(q)) return 2;
  const names = (item.names?.length ? item.names : [item.name]).map(fold);
  if (names.some((n) => n.startsWith(q))) return 3;
  if (
    words.length &&
    names.some((n) => {
      const nameWords = n.split(WORD_SPLIT).filter(Boolean);
      return words.every((w) => nameWords.some((nw) => nw.startsWith(w)));
    })
  ) {
    return 4;
  }
  if (q.length >= 2 && symbols.some((s) => fold(s).includes(q))) return 5;
  return null;
}

/* ------------------------------------------------------------------ */
/* Amount input                                                        */
/* ------------------------------------------------------------------ */

const MULTIPLIERS = { k: 1e3, nghin: 1e3, ngan: 1e3, m: 1e6, tr: 1e6, trieu: 1e6, b: 1e9, ty: 1e9 };

/**
 * Parse what a user typed in the converter's amount box. Accepts both "1.234,5" and "1,234.5", spaces /
 * apostrophes as grouping ("1 234,5", "1'234.50"), a currency mark around the number ("$25", "189元", "12,99 €")
 * and a short multiplier suffix ("1.5k", "2tr", "3 triệu"). Returns null for empty or garbage input.
 *
 * Separator rules (same spirit as the in-page parser, docs/ALGORITHM.md): both "." and "," present → the last one
 * is the decimal mark; one kind repeated → grouping; a single separator followed by exactly 3 digits → grouping
 * (nobody types three decimals for money), unless the integer part is 0 ("0.125"); otherwise → decimal.
 *
 * @param {string} input
 * @returns {number|null}  a finite, non-negative number
 */
export function parseAmount(input) {
  const text = String(input ?? '')
    .replace(/[    ]/g, ' ')
    .trim();
  if (!text) return null;
  // [currency mark] number [multiplier | currency mark] — letters are only allowed around the number.
  const m = /^[^\d.,]*?([\d.,][\d.,' ]*)([^\d]*)$/u.exec(text);
  if (!m) return null;
  let body = m[1].replace(/[' ]/g, '');
  if (!/\d/.test(body)) return null;
  const prefix = text.slice(0, text.length - m[1].length - m[2].length);
  if (/[-−]\s*$/.test(prefix)) return null; // negative amounts make no sense in a converter

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = body.split(sep).length - 1;
    if (count === 1) {
      const [intPart, frac] = body.split(sep);
      const grouping = frac.length === 3 && intPart !== '' && !/^0+$/.test(intPart);
      decimal = grouping ? null : sep;
    }
  }
  if (decimal) {
    const group = decimal === '.' ? ',' : '.';
    const idx = body.lastIndexOf(decimal);
    body = `${body.slice(0, idx).split(group).join('').split(decimal).join('')}.${body.slice(idx + 1)}`;
  } else {
    body = body.replace(/[.,]/g, '');
  }
  if (!/^\d*\.?\d*$/.test(body) || body === '.' || body === '') return null;
  let value = Number(body);
  if (!Number.isFinite(value)) return null;

  const suffix = fold(m[2]).replace(/[.\s]/g, '');
  if (suffix && Object.hasOwn(MULTIPLIERS, suffix)) value *= MULTIPLIERS[suffix];
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Converter defaults                                                  */
/* ------------------------------------------------------------------ */

/**
 * The currency a page mostly uses, from GET_PAGE_INFO's `currencies` ({ CODE: count }). '' if none.
 * @param {Record<string, number>|null|undefined} currencies
 * @returns {string}
 */
export function mainCurrency(currencies) {
  return topCurrencies(currencies, 1)[0] || '';
}

/**
 * Codes sorted by count (desc), then code. Non-positive counts are ignored.
 * @param {Record<string, number>|null|undefined} currencies
 * @param {number} [max]
 * @returns {string[]}
 */
export function topCurrencies(currencies, max = Infinity) {
  if (!currencies || typeof currencies !== 'object') return [];
  return Object.entries(currencies)
    .filter(([code, n]) => /^[A-Z]{3}$/.test(code) && Number(n) > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([code]) => code);
}

/**
 * Initial quick-converter state. `to` = the saved target, else the home currency. `from` = the page's main
 * detected currency (what the user is looking at right now), else the saved source, else USD. Never from === to.
 *
 * @param {object} opts
 * @param {{amount?: string, from?: string, to?: string}|null} [opts.saved]  storage.local converterState
 * @param {string} [opts.pageCurrency]   main currency detected on the active tab
 * @param {string} opts.home             home currency
 * @param {(code: string) => boolean} [opts.isAvailable]  currencies we can convert (have a rate)
 * @param {string} [opts.defaultAmount]
 * @returns {{amount: string, from: string, to: string}}
 */
export function converterDefaults({ saved = null, pageCurrency = '', home, isAvailable = () => true, defaultAmount = '100' }) {
  const ok = (c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c) && isAvailable(c);
  const amount = typeof saved?.amount === 'string' ? saved.amount.slice(0, 32) : defaultAmount;
  let to = ok(saved?.to) ? saved.to : ok(home) ? home : 'USD';
  let from = ok(pageCurrency) && pageCurrency !== to ? pageCurrency : ok(saved?.from) ? saved.from : 'USD';
  if (from === to) {
    if (to !== home && ok(home)) to = home;
    else from = to === 'USD' ? (ok('EUR') ? 'EUR' : from) : 'USD';
  }
  return { amount, from, to };
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Parse a provider date 'YYYY-MM-DD' as a LOCAL calendar date (no UTC shift). null if invalid.
 * @param {string} value
 * @returns {Date|null}
 */
export function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.getMonth() === Number(m[2]) - 1 ? date : null;
}

/**
 * Whole calendar days between a 'YYYY-MM-DD' date and `now` (local time). 0 = today, 1 = yesterday,
 * negative = future (clock skew / provider timezone ahead). null if invalid.
 * @param {string} value
 * @param {number|Date} [now]
 * @returns {number|null}
 */
export function daysSince(value, now = Date.now()) {
  const date = parseIsoDate(value);
  if (!date) return null;
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((today - date) / 86_400_000);
}

/**
 * "today" / "yesterday" / "3 days ago" for a 'YYYY-MM-DD' rate date (Intl.RelativeTimeFormat, numeric: auto).
 * Dates a day "in the future" (providers publish in UTC) read as "today". '' if invalid.
 * @param {string} value
 * @param {{now?: number|Date, locale?: string}} [opts]
 * @returns {string}
 */
export function relativeDayText(value, { now = Date.now(), locale = 'en' } = {}) {
  const days = daysSince(value, now);
  if (days === null) return '';
  return makeRtf(locale).format(-Math.max(0, days), 'day');
}

/**
 * "just now"-style relative time for a timestamp: seconds → minutes → hours → days (Intl.RelativeTimeFormat).
 * '' for a missing timestamp (0 = bundled snapshot).
 * @param {number} ts
 * @param {{now?: number, locale?: string}} [opts]
 * @returns {string}
 */
export function relativeTimeText(ts, { now = Date.now(), locale = 'en' } = {}) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const rtf = makeRtf(locale);
  const diff = Math.round((ts - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86_400), 'day');
}

function makeRtf(locale) {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
}

/**
 * Should the UI warn that rates may be out of date? True for the bundled snapshot or data older than `maxDays`.
 * @param {{source?: string, date?: string}|null} rates
 * @param {{now?: number, maxDays?: number}} [opts]
 * @returns {boolean}
 */
export function ratesAreStale(rates, { now = Date.now(), maxDays = 3 } = {}) {
  if (!rates) return true;
  if (rates.source === 'snapshot') return true;
  const days = daysSince(rates.date, now);
  return days === null || days > maxDays;
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Turn what the user typed in "Add a site" ("https://www.Taobao.com/item?id=1", "*.example.com", "ví-dụ.vn")
 * into a rule hostname (lowercase, punycode, no `www.`), or '' if it isn't a plausible hostname.
 * @param {string} raw
 * @returns {string}
 */
export function siteFromInput(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^\*\./, '');
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`).hostname;
  } catch {
    return '';
  }
  host = host.replace(/\.+$/, '').replace(/^www\./, '');
  return host === 'localhost' || HOST_RE.test(host) || IPV4_RE.test(host) ? host : '';
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/**
 * The "brand" label of a hostname, for avatars: "world.taobao.com" → "taobao", "www.amazon.co.jp" → "amazon",
 * "localhost" → "localhost". IP addresses are returned unchanged.
 * @param {string} host
 * @returns {string}
 */
export function siteLabel(host) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
  if (!h || /^[\d.]+$/.test(h) || !h.includes('.')) return h;
  const parts = h.split('.');
  let i = parts.length - 2;
  if (i > 0 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[i])) i -= 1;
  return parts[Math.max(0, i)];
}

/** Stable 0–359 hue for a hostname avatar. */
export function hueFor(text) {
  let hash = 0;
  for (const ch of String(text ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 360;
}

/**
 * Per-site pins as a sorted list for the options page.
 * @param {Record<string, {dollar?: string, yen?: string}>} siteCurrency
 * @returns {Array<{host: string, pins: Array<{symbol: 'dollar'|'yen', currency: string}>}>}
 */
export function sitePinList(siteCurrency) {
  if (!siteCurrency || typeof siteCurrency !== 'object') return [];
  return Object.entries(siteCurrency)
    .map(([host, pins]) => ({
      host,
      pins: ['dollar', 'yen'].filter((s) => typeof pins?.[s] === 'string' && pins[s]).map((symbol) => ({ symbol, currency: pins[symbol] })),
    }))
    .filter((e) => e.pins.length)
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

/**
 * Split a Chrome shortcut ("Alt+Shift+C", or the Mac form "⌥⇧C") into keys for <kbd> rendering.
 * @param {string} shortcut
 * @returns {string[]}
 */
export function shortcutKeys(shortcut) {
  if (!shortcut) return [];
  if (shortcut.includes('+') && shortcut.length > 1) {
    return shortcut
      .split('+')
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const keys = [];
  let rest = shortcut;
  while (rest.length > 1 && /^[⌘⌥⇧⌃]/.test(rest)) {
    keys.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest) keys.push(rest);
  return keys;
}
