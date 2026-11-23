/**
 * TransPrice — exchange rates (background). See docs/ARCHITECTURE.md §3.2 / §3.4.
 *
 *  - normalizeRates()     PURE: provider JSON (fawazahmed0 currency-api or open.er-api.com) → RatesTable
 *  - fetchSource()        one source, with an AbortController timeout
 *  - fetchLatestRates()   every RATE_SOURCE in order, first valid table wins
 *  - createRatesService() stale-while-revalidate cache over chrome.storage.local, one refresh in flight,
 *                         bundled snapshot as the last resort. All I/O is injected so it is Node-testable.
 */
import { ERROR_CODES, LIMITS, RATE_SOURCES } from '../shared/constants.js';
import { makeError } from '../shared/messaging.js';
import { REQUIRED_RATE_CODES, getStoredRates, isKnownCurrency, setStoredRates } from '../shared/storage.js';
import { RATES_SNAPSHOT } from './rates-snapshot.js';

/** After a failed automatic refresh, wait this long before the next automatic attempt (forced ones always run). */
export const FAILED_REFRESH_BACKOFF_MS = 5 * 60 * 1000;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a provider response into a RatesTable (§3.2).
 *  - currency-api: `{ date: 'YYYY-MM-DD', usd: { aed: 3.67, …lowercase, includes crypto } }`
 *  - er-api:       `{ result: 'success', base_code: 'USD', time_last_update_unix, rates: { AED: 3.67, … } }`
 * Codes are upper-cased and filtered to TransPriceCurrencies.CURRENCIES; non-positive / non-finite values are dropped;
 * USD is forced to 1. Throws BAD_RESPONSE for unknown shapes or tables missing USD/EUR/CNY/JPY/VND.
 * @param {any} json
 * @param {{source: string, fetchedAt?: number}} meta
 * @returns {{base: 'USD', rates: Record<string, number>, date: string, fetchedAt: number, source: string}}
 */
export function normalizeRates(json, { source, fetchedAt = 0 } = {}) {
  if (!isPlainObject(json)) throw makeError(ERROR_CODES.BAD_RESPONSE, 'Rate response is not an object');
  let raw;
  let date = '';
  if (isPlainObject(json.usd)) {
    raw = json.usd;
    date = typeof json.date === 'string' ? json.date : '';
  } else if (isPlainObject(json.rates)) {
    if (json.result !== undefined && json.result !== 'success') {
      throw makeError(ERROR_CODES.BAD_RESPONSE, `Rate provider error: ${String(json['error-type'] || json.result)}`);
    }
    if (json.base_code !== undefined && json.base_code !== 'USD') {
      throw makeError(ERROR_CODES.BAD_RESPONSE, `Unexpected base currency: ${String(json.base_code)}`);
    }
    raw = json.rates;
    const unix = Number(json.time_last_update_unix);
    if (Number.isFinite(unix) && unix > 0) date = isoDay(unix * 1000);
  } else {
    throw makeError(ERROR_CODES.BAD_RESPONSE, 'Unknown rate response format');
  }

  const rates = {};
  for (const [key, value] of Object.entries(raw)) {
    const code = String(key).toUpperCase();
    if (!isKnownCurrency(code)) continue; // drops crypto, metals, typos
    const n = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) rates[code] = n;
  }
  rates.USD = 1;
  const missing = REQUIRED_RATE_CODES.filter((code) => !(code in rates));
  if (missing.length) throw makeError(ERROR_CODES.BAD_RESPONSE, `Rate table is missing ${missing.join(', ')}`);

  const sorted = Object.fromEntries(Object.keys(rates).sort().map((code) => [code, rates[code]]));
  if (!DATE_RE.test(date)) date = isoDay(fetchedAt || Date.now());
  return { base: 'USD', rates: sorted, date, fetchedAt, source: String(source || 'unknown') };
}

/**
 * Fetch and normalise one source. The timeout covers the whole request including the body.
 * @param {{id: string, url: string}} source
 * @param {{fetch: typeof fetch, now?: () => number, timeoutMs?: number}} deps
 */
export async function fetchSource(source, { fetch: fetchImpl, now = Date.now, timeoutMs = LIMITS.FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let json;
    try {
      const res = await fetchImpl(source.url, {
        signal: controller.signal,
        cache: 'no-cache', // revalidate with the CDN instead of trusting the HTTP cache blindly
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res || !res.ok) throw makeError(ERROR_CODES.NETWORK, `${source.id}: HTTP ${res?.status ?? '?'}`);
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        throw makeError(ERROR_CODES.BAD_RESPONSE, `${source.id}: invalid JSON`);
      }
    } catch (err) {
      if (timedOut) throw makeError(ERROR_CODES.TIMEOUT, `${source.id}: timed out after ${timeoutMs} ms`);
      if (err?.code && ERROR_CODES[err.code]) throw err;
      throw makeError(ERROR_CODES.NETWORK, `${source.id}: ${err?.message || err}`);
    }
    try {
      return normalizeRates(json, { source: source.id, fetchedAt: now() });
    } catch (err) {
      throw makeError(ERROR_CODES.BAD_RESPONSE, `${source.id}: ${err?.message || err}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try every source in order; resolve with the first valid table. When all fail, reject with an error whose
 * `details.attempts` lists each failure (code TIMEOUT if all timed out, BAD_RESPONSE if all answered garbage,
 * NETWORK otherwise).
 * @param {{fetch: typeof fetch, now?: () => number, sources?: Array<{id: string, url: string}>, timeoutMs?: number}} deps
 */
export async function fetchLatestRates({ fetch: fetchImpl, now = Date.now, sources = RATE_SOURCES, timeoutMs } = {}) {
  const attempts = [];
  for (const source of sources) {
    try {
      return await fetchSource(source, { fetch: fetchImpl, now, timeoutMs });
    } catch (err) {
      attempts.push({ source: source.id, code: err?.code || ERROR_CODES.UNKNOWN, message: String(err?.message || err) });
    }
  }
  const codes = new Set(attempts.map((a) => a.code));
  const code =
    codes.size === 1 && (codes.has(ERROR_CODES.TIMEOUT) || codes.has(ERROR_CODES.BAD_RESPONSE)) ? [...codes][0] : ERROR_CODES.NETWORK;
  const err = makeError(code, `All rate sources failed: ${attempts.map((a) => a.message).join('; ') || 'no sources'}`);
  err.details = { attempts };
  throw err;
}

/** The bundled snapshot as a RatesTable (fresh copy, `fetchedAt: 0`, `source: 'snapshot'`). */
export function snapshotTable(snapshot = RATES_SNAPSHOT) {
  return { base: 'USD', rates: { ...snapshot.rates }, date: snapshot.date, fetchedAt: 0, source: 'snapshot' };
}

/**
 * Stale-while-revalidate rate cache.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]            default: globalThis.fetch (looked up at call time)
 * @param {() => number} [deps.now]              default: Date.now
 * @param {() => Promise<object|null>} [deps.load]   default: getStoredRates (chrome.storage.local)
 * @param {(table: object) => Promise<void>} [deps.save] default: setStoredRates
 * @param {object} [deps.snapshot]               default: RATES_SNAPSHOT
 * @param {Array} [deps.sources]                 default: RATE_SOURCES
 * @param {number} [deps.ttlMs]                  default: LIMITS.RATES_TTL_MS
 * @param {number} [deps.timeoutMs]              default: LIMITS.FETCH_TIMEOUT_MS
 * @param {(err: Error) => void} [deps.onError]  background-refresh failures (default: console.warn)
 */
export function createRatesService(deps = {}) {
  const {
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    now = Date.now,
    load = getStoredRates,
    save = setStoredRates,
    snapshot = RATES_SNAPSHOT,
    sources = RATE_SOURCES,
    ttlMs = LIMITS.RATES_TTL_MS,
    timeoutMs = LIMITS.FETCH_TIMEOUT_MS,
    onError = (err) => console.warn('[TransPrice] rates refresh failed:', err?.message || err),
  } = deps;

  let inflight = null;
  let lastFailureAt = -Infinity;

  const isStale = (table) => !table || !(table.fetchedAt > 0) || now() - table.fetchedAt > ttlMs;

  async function loadSafe() {
    try {
      return await load();
    } catch {
      return null;
    }
  }

  /** Live fetch + persist. Concurrent callers share the same promise (one refresh in flight). */
  function refresh() {
    if (!inflight) {
      inflight = (async () => {
        try {
          const table = await fetchLatestRates({ fetch: fetchImpl, now, sources, timeoutMs });
          await save(table);
          lastFailureAt = -Infinity;
          return table;
        } catch (err) {
          lastFailureAt = now();
          throw err;
        }
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  /** Start a background refresh unless one is running or the last automatic attempt failed recently. */
  function revalidate() {
    if (inflight) return inflight.catch(() => null);
    if (now() - lastFailureAt < FAILED_REFRESH_BACKOFF_MS) return Promise.resolve(null);
    return refresh().catch((err) => {
      onError(err);
      return null;
    });
  }

  /**
   * The table to serve right now: the stored one; the snapshot if nothing is stored, or if the stored table is
   * stale AND older than the bundled snapshot (long offline, then an extension update shipped newer data).
   */
  function pick(stored) {
    if (!stored) return snapshotTable(snapshot);
    return isStale(stored) && snapshot.date > stored.date ? snapshotTable(snapshot) : stored;
  }

  /**
   * Rates to use. Default: answer immediately from storage (or the snapshot) and revalidate in the background
   * when missing or older than the TTL. `force`: wait for a live fetch (joining one already in flight) and
   * reject if every source fails.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object>} RatesTable
   */
  async function getRates({ force = false } = {}) {
    if (force) return refresh();
    const stored = await loadSafe();
    if (isStale(stored)) revalidate();
    return pick(stored);
  }

  /** Refresh only if the stored table is missing or stale (startup). Never rejects. */
  async function refreshIfStale() {
    const stored = await loadSafe();
    return isStale(stored) ? revalidate() : stored;
  }

  return {
    getRates,
    refresh,
    refreshIfStale,
    isStale,
    /** @returns {Promise<object>|null} the refresh in flight, if any (tests / diagnostics). */
    get inflight() {
      return inflight;
    },
  };
}
