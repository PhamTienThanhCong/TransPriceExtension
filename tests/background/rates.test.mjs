/** Rates: normalisation of both provider formats, source fallback, timeouts, stale-while-revalidate, snapshot. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RATE_SOURCES } from '../../extension/src/shared/constants.js';
import { isValidRatesTable, isKnownCurrency } from '../../extension/src/shared/storage.js';
import {
  FAILED_REFRESH_BACKOFF_MS,
  createRatesService,
  fetchLatestRates,
  fetchSource,
  normalizeRates,
  snapshotTable,
} from '../../extension/src/background/rates.js';
import { RATES_SNAPSHOT } from '../../extension/src/background/rates-snapshot.js';
import { renderSnapshot } from '../../scripts/update-rates-snapshot.mjs';
import {
  HOSTS,
  currencyApiBody,
  deferred,
  erApiBody,
  flush,
  hangingFetch,
  jsonResponse,
  mockFetch,
  ratesTable,
} from './helpers.mjs';

const T0 = Date.UTC(2026, 10, 23, 12); // fixed "now"
const HOUR = 3600_000;

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => err.code === code || assert.fail(`${err.code}: ${err.message}`));
const throwsWith = (fn, code) => assert.throws(fn, (err) => err.code === code || assert.fail(`${err.code}: ${err.message}`));

describe('normalizeRates', () => {
  test('currency-api: uppercase, known fiat only (crypto/tokens dropped), USD = 1, sorted, date kept', () => {
    const t = normalizeRates(currencyApiBody(), { source: 'currency-api', fetchedAt: T0 });
    assert.equal(t.base, 'USD');
    assert.equal(t.source, 'currency-api');
    assert.equal(t.fetchedAt, T0);
    assert.equal(t.date, '2026-11-22');
    assert.equal(t.rates.USD, 1);
    assert.equal(t.rates.VND, 25788.84767895);
    assert.equal(t.rates.EUR, 0.91158016);
    assert.equal(t.rates.BTC, undefined, 'crypto dropped');
    assert.equal(t.rates['1INCH'], undefined, 'token dropped');
    assert.ok(Object.keys(t.rates).every((c) => /^[A-Z]{3}$/.test(c) && isKnownCurrency(c)));
    assert.deepEqual(Object.keys(t.rates), [...Object.keys(t.rates)].sort());
    assert.ok(isValidRatesTable(t));
  });

  test('er-api: date from time_last_update_unix (UTC), uppercase codes kept', () => {
    const t = normalizeRates(erApiBody(), { source: 'er-api', fetchedAt: T0 });
    assert.equal(t.date, '2026-11-22');
    assert.equal(t.source, 'er-api');
    assert.equal(t.rates.CNY, 6.67);
    assert.equal(t.rates.USD, 1);
    assert.ok(isValidRatesTable(t));
  });

  test('USD is forced to 1 even when missing; bad values are dropped, numeric strings accepted', () => {
    const body = currencyApiBody({ usd: undefined, aed: -3, gbp: 'abc', krw: Infinity, eur: '0.9' });
    delete body.usd.usd;
    const t = normalizeRates(JSON.parse(JSON.stringify(body)), { source: 'x', fetchedAt: T0 });
    assert.equal(t.rates.USD, 1);
    assert.equal(t.rates.AED, undefined, 'negative');
    assert.equal(t.rates.GBP, undefined, 'not a number');
    assert.equal(t.rates.KRW, undefined, 'Infinity (null after JSON)');
    assert.equal(t.rates.EUR, 0.9, 'numeric string');
  });

  test('missing or malformed date → the fetch day', () => {
    assert.equal(normalizeRates({ ...currencyApiBody(), date: 'yesterday' }, { source: 'x', fetchedAt: T0 }).date, '2026-11-23');
    const { time_last_update_unix: _, ...noTime } = erApiBody();
    assert.equal(normalizeRates(noTime, { source: 'x', fetchedAt: T0 }).date, '2026-11-23');
  });

  test('garbage and partial responses are rejected with BAD_RESPONSE', () => {
    for (const bad of [null, undefined, 42, 'usd', [], {}, { date: '2026-11-22' }, { usd: [] }, { rates: 'x' }]) {
      throwsWith(() => normalizeRates(bad, { source: 'x' }), 'BAD_RESPONSE');
    }
    // partial: required codes missing (USD/EUR/CNY/JPY/VND)
    throwsWith(() => normalizeRates({ date: '2026-11-22', usd: { usd: 1, eur: 0.9, cny: 6.6, jpy: 158 } }, { source: 'x' }), 'BAD_RESPONSE');
    throwsWith(() => normalizeRates(erApiBody({ VND: 0 }), { source: 'x' }), 'BAD_RESPONSE');
    throwsWith(() => normalizeRates(erApiBody({ JPY: null }), { source: 'x' }), 'BAD_RESPONSE');
    // provider-level errors
    throwsWith(() => normalizeRates({ result: 'error', 'error-type': 'unsupported-code', rates: {} }, { source: 'x' }), 'BAD_RESPONSE');
    throwsWith(() => normalizeRates({ ...erApiBody(), base_code: 'EUR' }, { source: 'x' }), 'BAD_RESPONSE');
  });
});

describe('fetchSource / fetchLatestRates', () => {
  const src = (id) => RATE_SOURCES.find((s) => s.id === id);

  test('fetchSource: OK, HTTP error → NETWORK, invalid JSON → BAD_RESPONSE, thrown → NETWORK', async () => {
    const ok = await fetchSource(src('er-api'), { fetch: async () => jsonResponse(erApiBody()), now: () => T0 });
    assert.equal(ok.source, 'er-api');
    assert.equal(ok.fetchedAt, T0);
    await rejectsWith(fetchSource(src('er-api'), { fetch: async () => jsonResponse('oops', 503) }), 'NETWORK');
    await rejectsWith(fetchSource(src('er-api'), { fetch: async () => jsonResponse('<html>') }), 'BAD_RESPONSE');
    await rejectsWith(fetchSource(src('er-api'), { fetch: async () => jsonResponse({ hello: 1 }) }), 'BAD_RESPONSE');
    await rejectsWith(
      fetchSource(src('er-api'), {
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
      'NETWORK',
    );
  });

  test('fetchSource: aborts after timeoutMs → TIMEOUT (also while reading the body)', async () => {
    const started = Date.now();
    await rejectsWith(fetchSource(src('currency-api'), { fetch: hangingFetch, timeoutMs: 30 }), 'TIMEOUT');
    assert.ok(Date.now() - started < 1000);

    const slowBody = async (url, init) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    await rejectsWith(fetchSource(src('currency-api'), { fetch: slowBody, timeoutMs: 30 }), 'TIMEOUT');
  });

  test('fetchSource: passes an AbortSignal and sends no credentials/referrer', async () => {
    const f = mockFetch([[HOSTS.erApi, () => jsonResponse(erApiBody())]]);
    await fetchSource(src('er-api'), { fetch: f });
    const { init } = f.calls[0];
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
  });

  test('sources are tried in RATE_SOURCES order; first valid wins', async () => {
    assert.deepEqual(
      RATE_SOURCES.map((s) => s.id),
      ['currency-api', 'currency-api-mirror', 'er-api'],
    );
    const f = mockFetch([
      [HOSTS.currencyApi, () => jsonResponse('down', 500)],
      [HOSTS.mirror, () => jsonResponse({ date: '2026-11-22', usd: { usd: 1 } })], // partial → rejected
      [HOSTS.erApi, () => jsonResponse(erApiBody())],
    ]);
    const t = await fetchLatestRates({ fetch: f, now: () => T0 });
    assert.equal(t.source, 'er-api');
    assert.deepEqual(
      f.calls.map((c) => new URL(c.url).hostname),
      [HOSTS.currencyApi, HOSTS.mirror, HOSTS.erApi],
    );

    const first = mockFetch([[/./, () => jsonResponse(currencyApiBody())]]);
    assert.equal((await fetchLatestRates({ fetch: first })).source, 'currency-api');
    assert.equal(first.calls.length, 1, 'stops at the first valid source');
  });

  test('every source fails → error with attempts; code reflects the failures', async () => {
    const mixed = mockFetch([
      [HOSTS.currencyApi, () => jsonResponse('x', 500)],
      [HOSTS.mirror, () => jsonResponse('not json')],
    ]); // er-api: no route → TypeError
    await assert.rejects(fetchLatestRates({ fetch: mixed }), (err) => {
      assert.equal(err.code, 'NETWORK');
      assert.deepEqual(
        err.details.attempts.map((a) => [a.source, a.code]),
        [
          ['currency-api', 'NETWORK'],
          ['currency-api-mirror', 'BAD_RESPONSE'],
          ['er-api', 'NETWORK'],
        ],
      );
      return true;
    });
    await rejectsWith(fetchLatestRates({ fetch: hangingFetch, timeoutMs: 10 }), 'TIMEOUT');
    await rejectsWith(fetchLatestRates({ fetch: async () => jsonResponse({ nope: true }) }), 'BAD_RESPONSE');
  });
});

describe('createRatesService (stale-while-revalidate)', () => {
  /** A service over an in-memory store with a controllable clock. */
  function setup({ stored = null, fetch, snapshot } = {}) {
    const store = { value: stored, saves: 0 };
    const clock = { now: T0 };
    const errors = [];
    const service = createRatesService({
      fetch,
      now: () => clock.now,
      load: async () => store.value,
      save: async (t) => {
        store.saves++;
        store.value = t;
      },
      ...(snapshot ? { snapshot } : {}),
      onError: (e) => errors.push(e),
    });
    return { service, store, clock, errors };
  }
  const okFetch = () => mockFetch([[/./, () => jsonResponse(currencyApiBody())]]);
  const failFetch = () =>
    mockFetch([
      [
        /./,
        () => {
          throw new TypeError('offline');
        },
      ],
    ]);

  test('nothing stored → snapshot immediately, live table stored in the background', async () => {
    const f = okFetch();
    const { service, store } = setup({ fetch: f });
    const t = await service.getRates();
    assert.equal(t.source, 'snapshot');
    assert.equal(t.fetchedAt, 0);
    assert.ok(service.inflight, 'refresh started');
    await service.inflight;
    assert.equal(store.value.source, 'currency-api');
    assert.equal(store.value.fetchedAt, T0);
    assert.equal((await service.getRates()).source, 'currency-api');
    assert.equal(f.calls.length, 1, 'fresh table → no new fetch');
  });

  test('fresh stored table → served, no fetch', async () => {
    const f = okFetch();
    const { service } = setup({ stored: ratesTable({ fetchedAt: T0 - HOUR }), fetch: f });
    assert.equal((await service.getRates()).fetchedAt, T0 - HOUR);
    assert.equal(service.inflight, null);
    assert.equal(f.calls.length, 0);
  });

  test('stale stored table → served immediately, revalidated in the background', async () => {
    const gate = deferred();
    const f = mockFetch([[/./, () => gate.promise.then(() => jsonResponse(currencyApiBody()))]]);
    const stale = ratesTable({ fetchedAt: T0 - 13 * HOUR });
    const { service, store } = setup({ stored: stale, fetch: f });
    const t = await service.getRates();
    assert.equal(t, stale, 'stale value returned without waiting');
    assert.ok(service.inflight);
    gate.resolve();
    await service.inflight;
    assert.equal(store.value.fetchedAt, T0);
  });

  test('only ONE refresh in flight: concurrent reads + force share it', async () => {
    const gate = deferred();
    const f = mockFetch([[/./, () => gate.promise.then(() => jsonResponse(currencyApiBody()))]]);
    const { service, store } = setup({ stored: ratesTable({ fetchedAt: 1 }), fetch: f });
    await Promise.all([service.getRates(), service.getRates(), service.getRates()]);
    const forced = service.getRates({ force: true });
    const forced2 = service.refresh();
    assert.equal(service.inflight, forced2);
    await flush();
    assert.equal(f.calls.length, 1);
    gate.resolve();
    const [a, b] = await Promise.all([forced, forced2]);
    assert.equal(a, b);
    assert.equal(store.saves, 1);
    assert.equal(service.inflight, null);
    await service.getRates({ force: true });
    assert.equal(f.calls.length, 2, 'a new refresh can start once the previous one settled');
  });

  test('force: waits for the live table; rejects (store untouched) when every source fails', async () => {
    const { service, store } = setup({ stored: ratesTable({ fetchedAt: T0 }), fetch: okFetch() });
    const t = await service.getRates({ force: true });
    assert.equal(t.source, 'currency-api');
    assert.equal(store.saves, 1);

    const failing = setup({ stored: ratesTable({ fetchedAt: T0, source: 'er-api' }), fetch: failFetch() });
    await rejectsWith(failing.service.getRates({ force: true }), 'NETWORK');
    assert.equal(failing.store.saves, 0);
    assert.equal(failing.store.value.source, 'er-api');
  });

  test('no stored table and every source fails → snapshot; background errors reported, not thrown', async () => {
    const f = failFetch();
    const { service, errors } = setup({ fetch: f });
    const t = await service.getRates();
    assert.equal(t.source, 'snapshot');
    assert.deepEqual(t.rates, RATES_SNAPSHOT.rates);
    assert.equal(t.date, RATES_SNAPSHOT.date);
    await flush(5);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'NETWORK');
  });

  test('after a failed automatic refresh: back off, then retry; force bypasses the back-off', async () => {
    const f = failFetch();
    const { service, clock } = setup({ fetch: f });
    await service.getRates();
    await flush(5);
    const perAttempt = RATE_SOURCES.length;
    assert.equal(f.calls.length, perAttempt);
    await service.getRates();
    await flush(5);
    assert.equal(f.calls.length, perAttempt, 'no retry during the back-off');
    await service.getRates({ force: true }).catch(() => {});
    assert.equal(f.calls.length, 2 * perAttempt, 'force always fetches');
    clock.now += FAILED_REFRESH_BACKOFF_MS + 1;
    await service.getRates();
    await flush(5);
    assert.equal(f.calls.length, 3 * perAttempt, 'automatic retry after the back-off');
  });

  test('a stale stored table older than the bundled snapshot loses to it; a fresh one never does', async () => {
    const old = ratesTable({ date: '2020-01-01', fetchedAt: T0 - 400 * 24 * HOUR });
    const { service } = setup({ stored: old, fetch: failFetch() });
    assert.equal((await service.getRates()).source, 'snapshot');

    const laggingMirror = ratesTable({ date: '2020-01-01', fetchedAt: T0 - HOUR, source: 'currency-api-mirror' });
    const fresh = setup({ stored: laggingMirror, fetch: failFetch() });
    assert.equal((await fresh.service.getRates()).source, 'currency-api-mirror', 'just fetched → no "offline" snapshot');
  });

  test('a storage read error is treated as "nothing stored"', async () => {
    const service = createRatesService({
      fetch: okFetch(),
      now: () => T0,
      load: async () => {
        throw new Error('storage broken');
      },
      save: async () => {},
      onError: () => {},
    });
    assert.equal((await service.getRates()).source, 'snapshot');
  });

  test('refreshIfStale: no fetch when fresh, fetch when stale/missing', async () => {
    const fresh = setup({ stored: ratesTable({ fetchedAt: T0 }), fetch: okFetch() });
    await fresh.service.refreshIfStale();
    assert.equal(fresh.store.saves, 0);
    const missing = setup({ fetch: okFetch() });
    const t = await missing.service.refreshIfStale();
    assert.equal(t.source, 'currency-api');
    assert.equal(missing.store.saves, 1);
  });

  test('isStale honours the TTL and treats fetchedAt 0 (snapshot) as stale', () => {
    const { service } = setup({ fetch: okFetch() });
    assert.equal(service.isStale(null), true);
    assert.equal(service.isStale(ratesTable({ fetchedAt: 0 })), true);
    assert.equal(service.isStale(ratesTable({ fetchedAt: T0 - 11 * HOUR })), false);
    assert.equal(service.isStale(ratesTable({ fetchedAt: T0 - 13 * HOUR })), true);
  });
});

describe('bundled snapshot', () => {
  test('is a valid RatesTable of known currencies', () => {
    const t = snapshotTable();
    assert.ok(isValidRatesTable(t));
    assert.equal(t.source, 'snapshot');
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const code of Object.keys(t.rates)) assert.ok(isKnownCurrency(code), `${code} is not in currency-data.js`);
    t.rates.USD = 2;
    assert.equal(RATES_SNAPSHOT.rates.USD, 1, 'snapshotTable() returns a copy');
  });

  test('the file is exactly what scripts/update-rates-snapshot.mjs generates', async () => {
    const text = readFileSync(new URL('../../extension/src/background/rates-snapshot.js', import.meta.url), 'utf8');
    assert.equal(renderSnapshot(RATES_SNAPSHOT), text);
    const src = renderSnapshot({ date: '2026-01-02', rates: { VND: 25788.84767895, USD: 1, KWD: 0.3116231536 } });
    const reparsed = await import(`data:text/javascript,${encodeURIComponent(src)}`);
    assert.deepEqual(reparsed.RATES_SNAPSHOT, {
      base: 'USD',
      date: '2026-01-02',
      source: 'snapshot',
      rates: { KWD: 0.31162315, USD: 1, VND: 25788.848 }, // sorted, 8 significant digits
    });
    assert.ok(Object.isFrozen(reparsed.RATES_SNAPSHOT));
  });
});
