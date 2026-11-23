/**
 * Unit tests for the pure UI helpers (extension/src/options/ui-helpers.js).
 * Run: node --test tests/ui/
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  POPULAR_CURRENCIES,
  buildCurrencyList,
  converterDefaults,
  daysSince,
  detectedSummary,
  filterCurrencies,
  fold,
  mainCurrency,
  parseAmount,
  parseIsoDate,
  ratesAreStale,
  relativeDayText,
  relativeTimeText,
  shortcutKeys,
  ruleCovers,
  siteActivePatch,
  siteFromInput,
  siteLabel,
  sitePinList,
  topCurrencies,
} from '../../extension/src/options/ui-helpers.js';

/* ------------------------------------------------------------------ */
/* Fixtures: a tiny currency table (names via Intl, like currency-data) */
/* ------------------------------------------------------------------ */

const CODES = ['AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'KRW', 'SGD', 'THB', 'TWD', 'USD', 'VND', 'ZAR'];
const SYMBOLS = { USD: '$', EUR: '€', CNY: '¥', JPY: '¥', VND: '₫', GBP: '£', KRW: '₩', THB: '฿', CHF: 'CHF', ZAR: 'R' };
const MARKERS = { CNY: ['元', 'RMB', 'CN¥'], JPY: ['円', '￥'], VND: ['đ', 'VNĐ'], USD: ['US$'] };
const nameOf = (code, locale) => new Intl.DisplayNames([locale], { type: 'currency' }).of(code);

const list = (opts = {}) =>
  buildCurrencyList({
    codes: CODES,
    home: 'VND',
    nameOf,
    locale: 'vi',
    symbolOf: (c) => SYMBOLS[c] || '',
    markersOf: (c) => MARKERS[c] || [],
    flagOf: (c) => (c === 'VND' ? '🇻🇳' : ''),
    ...opts,
  });

describe('fold', () => {
  test('lower-cases and strips Vietnamese diacritics, including đ', () => {
    assert.equal(fold('Đồng Việt Nam'), 'dong viet nam');
    assert.equal(fold('  ĐÔ LA MỸ '), 'do la my');
    assert.equal(fold('Yên Nhật'), 'yen nhat');
  });
  test('handles nullish input', () => {
    assert.equal(fold(undefined), '');
    assert.equal(fold(null), '');
  });
});

describe('buildCurrencyList', () => {
  test('home currency first, then popular ones in order, then the rest A→Z', () => {
    const { suggested, others, all } = list();
    assert.equal(suggested[0].code, 'VND');
    const expectedPopular = POPULAR_CURRENCIES.filter((c) => c !== 'VND' && CODES.includes(c));
    assert.deepEqual(
      suggested.slice(1).map((i) => i.code),
      expectedPopular,
    );
    assert.deepEqual(
      others.map((i) => i.code),
      ['CHF', 'ZAR'],
    );
    assert.equal(all.length, CODES.length);
    assert.equal(new Set(all.map((i) => i.code)).size, CODES.length, 'no duplicates');
  });

  test('a home currency that is not popular is still pinned first', () => {
    const { suggested, others } = list({ home: 'ZAR' });
    assert.equal(suggested[0].code, 'ZAR');
    assert.ok(!others.some((i) => i.code === 'ZAR'));
  });

  test('skips codes that are not available (e.g. no exchange rate) and invalid codes', () => {
    const { all } = buildCurrencyList({ codes: ['USD', 'VND', 'xx', 'EURO'], home: 'JPY', nameOf });
    assert.deepEqual(
      all.map((i) => i.code),
      ['USD', 'VND'],
    );
  });

  test('items carry the localized name, names in both languages, symbol, markers and flag', () => {
    const vnd = list().all.find((i) => i.code === 'VND');
    assert.equal(vnd.name, nameOf('VND', 'vi'));
    assert.ok(vnd.names.includes(nameOf('VND', 'en')));
    assert.ok(vnd.names.includes(nameOf('VND', 'vi')));
    assert.equal(vnd.symbol, '₫');
    assert.deepEqual(vnd.symbols, ['₫', 'đ', 'VNĐ']);
    assert.equal(vnd.flag, '🇻🇳');
  });

  test('a throwing name function falls back to the code', () => {
    const { all } = buildCurrencyList({
      codes: ['USD'],
      nameOf: () => {
        throw new Error('boom');
      },
    });
    assert.equal(all[0].name, 'USD');
  });
});

describe('filterCurrencies', () => {
  const items = list().all;
  const codes = (q) => filterCurrencies(items, q).map((i) => i.code);

  test('empty query returns the whole list in order', () => {
    assert.deepEqual(codes(''), items.map((i) => i.code));
    assert.deepEqual(codes('   '), items.map((i) => i.code));
  });

  test('exact code first, case-insensitive', () => {
    assert.equal(codes('usd')[0], 'USD');
    assert.equal(codes('JPY')[0], 'JPY');
  });

  test('code prefix', () => {
    assert.deepEqual(codes('h'), ['HKD'].concat(codes('h').slice(1)));
    assert.ok(codes('TW').includes('TWD'));
  });

  test('English names', () => {
    assert.equal(codes('yen')[0], 'JPY');
    assert.ok(codes('dollar').includes('USD'));
    assert.ok(codes('dollar').includes('SGD'));
    assert.ok(codes('pound').includes('GBP'));
  });

  test('Vietnamese names, with or without diacritics', () => {
    assert.equal(codes('đồng')[0], 'VND');
    assert.equal(codes('dong viet')[0], 'VND');
    assert.ok(codes('nhân dân tệ').includes('CNY'));
    assert.ok(codes('nhan dan te').includes('CNY'));
    assert.ok(codes('won').includes('KRW'));
  });

  test('symbols and markers', () => {
    assert.deepEqual(codes('¥').slice(0, 2).sort(), ['CNY', 'JPY']);
    assert.equal(codes('₫')[0], 'VND');
    assert.equal(codes('元')[0], 'CNY');
    assert.equal(codes('円')[0], 'JPY');
    assert.equal(codes('rmb')[0], 'CNY');
    assert.equal(codes('€')[0], 'EUR');
  });

  test('ranking: exact code beats a name match', () => {
    // "eur" is the EUR code and also a substring of nothing else; "aud" code vs "Saudi" style substrings
    assert.equal(codes('eur')[0], 'EUR');
  });

  test('word prefixes, in any order, without accidental substrings', () => {
    assert.ok(codes('south kor').includes('KRW'));
    assert.ok(codes('kor south').includes('KRW'));
    assert.ok(codes('dong').includes('VND'));
    // "yen" is inside Vietnamese "chuyển" (convertible) — must not match unrelated currencies
    assert.deepEqual(codes('yen'), ['JPY']);
    assert.ok(!codes('ollar').includes('USD'), 'no mid-word matches');
  });

  test('no match → empty list', () => {
    assert.deepEqual(codes('zzzz'), []);
    assert.deepEqual(codes('bitcoin'), []);
  });
});

describe('parseAmount', () => {
  test('plain numbers', () => {
    assert.equal(parseAmount('189'), 189);
    assert.equal(parseAmount('0'), 0);
    assert.equal(parseAmount('43.65'), 43.65);
    assert.equal(parseAmount('12,5'), 12.5);
    assert.equal(parseAmount('.5'), 0.5);
  });

  test('European and US grouping', () => {
    assert.equal(parseAmount('1.234,5'), 1234.5);
    assert.equal(parseAmount('1,234.5'), 1234.5);
    assert.equal(parseAmount('1.234.567,89'), 1234567.89);
    assert.equal(parseAmount('1,234,567.89'), 1234567.89);
    assert.equal(parseAmount('1 234,5'), 1234.5);
    assert.equal(parseAmount('1 234,50'), 1234.5);
    assert.equal(parseAmount("1'234.50"), 1234.5);
  });

  test('a single separator followed by exactly three digits is grouping', () => {
    assert.equal(parseAmount('1.000'), 1000);
    assert.equal(parseAmount('1,000'), 1000);
    assert.equal(parseAmount('25.000'), 25000);
    assert.equal(parseAmount('1.000.000'), 1000000);
    assert.equal(parseAmount('0.125'), 0.125, 'leading zero → decimal');
  });

  test('currency marks around the number are ignored', () => {
    assert.equal(parseAmount('$25.99'), 25.99);
    assert.equal(parseAmount('¥189'), 189);
    assert.equal(parseAmount('189元'), 189);
    assert.equal(parseAmount('12,99 €'), 12.99);
    assert.equal(parseAmount('USD 1,299.99'), 1299.99);
    assert.equal(parseAmount('730.000 ₫'), 730000);
  });

  test('multiplier suffixes', () => {
    assert.equal(parseAmount('1.5k'), 1500);
    assert.equal(parseAmount('2tr'), 2_000_000);
    assert.equal(parseAmount('3 triệu'), 3_000_000);
    assert.equal(parseAmount('1,2 tỷ'), 1_200_000_000);
    assert.equal(parseAmount('2M'), 2_000_000);
  });

  test('empty and garbage → null', () => {
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('   '), null);
    assert.equal(parseAmount(undefined), null);
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount('abc'), null);
    assert.equal(parseAmount('.'), null);
    assert.equal(parseAmount(',,'), null);
    assert.equal(parseAmount('12abc34'), null);
    assert.equal(parseAmount('1e5'), null);
    assert.equal(parseAmount('-5'), null);
    assert.equal(parseAmount('Infinity'), null);
  });
});

describe('page currencies', () => {
  test('mainCurrency / topCurrencies sort by count', () => {
    assert.equal(mainCurrency({ CNY: 24, USD: 3 }), 'CNY');
    assert.equal(mainCurrency({}), '');
    assert.equal(mainCurrency(null), '');
    assert.deepEqual(topCurrencies({ USD: 3, CNY: 24, EUR: 3, JPY: 0 }), ['CNY', 'EUR', 'USD']);
    assert.deepEqual(topCurrencies({ USD: 3, CNY: 24, EUR: 3 }, 2), ['CNY', 'EUR']);
  });
});

describe('detectedSummary (inactive site hint)', () => {
  test('counts foreign prices only, main currency first', () => {
    assert.deepEqual(detectedSummary({ count: 47, currencies: { CNY: 45, USD: 2 } }, 'VND'), { count: 47, codes: ['CNY', 'USD'] });
    assert.deepEqual(detectedSummary({ count: 50, currencies: { VND: 40, USD: 10 } }, 'VND'), { count: 10, codes: ['USD'] });
  });
  test('home-currency-only pages and missing data → nothing to promise', () => {
    assert.deepEqual(detectedSummary({ count: 40, currencies: { VND: 40 } }, 'VND'), { count: 0, codes: [] });
    assert.deepEqual(detectedSummary(undefined, 'VND'), { count: 0, codes: [] });
    assert.deepEqual(detectedSummary({ count: 3 }, 'VND'), { count: 0, codes: [] });
  });
});

describe('siteActivePatch (optimistic SET_SITE_ACTIVE)', () => {
  const allow = { siteMode: 'allowlist', enabledSites: ['amazon.co.jp', 'taobao.com'], disabledSites: ['x.com'] };
  const all = { siteMode: 'all', enabledSites: [], disabledSites: ['taobao.com', 'github.com'] };

  test('ruleCovers: host or subdomain, never a lookalike', () => {
    assert.equal(ruleCovers('taobao.com', 'taobao.com'), true);
    assert.equal(ruleCovers('taobao.com', 's.taobao.com'), true);
    assert.equal(ruleCovers('taobao.com', 'nottaobao.com'), false);
    assert.equal(ruleCovers('', 'taobao.com'), false);
  });
  test('allowlist: turning on adds the siteKey once', () => {
    assert.deepEqual(siteActivePatch(allow, 'item.jd.com', 'jd.com', true), { enabledSites: ['amazon.co.jp', 'taobao.com', 'jd.com'] });
    assert.deepEqual(siteActivePatch(allow, 's.taobao.com', 'taobao.com', true), { enabledSites: ['amazon.co.jp', 'taobao.com'] });
  });
  test('allowlist: turning off drops every rule covering the host', () => {
    const s = { siteMode: 'allowlist', enabledSites: ['taobao.com', 's.taobao.com', 'jd.com'] };
    assert.deepEqual(siteActivePatch(s, 's.taobao.com', 'taobao.com', false), { enabledSites: ['jd.com'] });
  });
  test("'all' mode is the mirror on disabledSites", () => {
    assert.deepEqual(siteActivePatch(all, 'world.taobao.com', 'taobao.com', true), { disabledSites: ['github.com'] });
    assert.deepEqual(siteActivePatch(all, 'shopee.vn', 'shopee.vn', false), { disabledSites: ['taobao.com', 'github.com', 'shopee.vn'] });
  });
  test('missing lists / mode default to allowlist with an empty list', () => {
    assert.deepEqual(siteActivePatch({}, 'a.com', 'a.com', true), { enabledSites: ['a.com'] });
  });
});

describe('converterDefaults', () => {
  test('first open: from = page currency, to = home', () => {
    assert.deepEqual(converterDefaults({ pageCurrency: 'CNY', home: 'VND' }), { amount: '100', from: 'CNY', to: 'VND' });
  });
  test('first open without a page currency: from = USD', () => {
    assert.deepEqual(converterDefaults({ home: 'VND' }), { amount: '100', from: 'USD', to: 'VND' });
  });
  test('saved state is restored; the page currency wins for `from`', () => {
    const saved = { amount: '25', from: 'EUR', to: 'USD' };
    assert.deepEqual(converterDefaults({ saved, home: 'VND' }), { amount: '25', from: 'EUR', to: 'USD' });
    assert.deepEqual(converterDefaults({ saved, pageCurrency: 'JPY', home: 'VND' }), { amount: '25', from: 'JPY', to: 'USD' });
  });
  test('never from === to', () => {
    const r1 = converterDefaults({ home: 'USD' });
    assert.notEqual(r1.from, r1.to);
    const r2 = converterDefaults({ saved: { amount: '1', from: 'EUR', to: 'VND' }, pageCurrency: 'VND', home: 'VND' });
    assert.notEqual(r2.from, r2.to);
    const r3 = converterDefaults({ saved: { amount: '1', from: 'VND', to: 'VND' }, home: 'JPY' });
    assert.notEqual(r3.from, r3.to);
  });
  test('unavailable / invalid saved codes are ignored', () => {
    const isAvailable = (c) => c !== 'XYZ';
    const r = converterDefaults({ saved: { amount: '5', from: 'XYZ', to: 'nope' }, home: 'VND', isAvailable });
    assert.deepEqual(r, { amount: '5', from: 'USD', to: 'VND' });
  });
});

describe('dates', () => {
  const now = new Date(2026, 10, 23, 15, 30).getTime(); // 23 Nov 2026, local time

  test('parseIsoDate reads a local calendar date', () => {
    const d = parseIsoDate('2026-11-22');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 10);
    assert.equal(d.getDate(), 22);
    assert.equal(parseIsoDate('2026-02-31'), null);
    assert.equal(parseIsoDate('22/11/2026'), null);
    assert.equal(parseIsoDate(''), null);
  });

  test('daysSince', () => {
    assert.equal(daysSince('2026-11-23', now), 0);
    assert.equal(daysSince('2026-11-22', now), 1);
    assert.equal(daysSince('2026-11-13', now), 10);
    assert.equal(daysSince('2026-11-24', now), -1);
    assert.equal(daysSince('garbage', now), null);
  });

  test('relativeDayText in English and Vietnamese', () => {
    assert.equal(relativeDayText('2026-11-23', { now, locale: 'en' }), 'today');
    assert.equal(relativeDayText('2026-11-22', { now, locale: 'en' }), 'yesterday');
    assert.equal(relativeDayText('2026-11-20', { now, locale: 'en' }), '3 days ago');
    assert.equal(relativeDayText('2026-11-24', { now, locale: 'en' }), 'today', 'future (UTC ahead) reads as today');
    // ICU capitalises some Vietnamese forms ("Hôm nay") — callers lower-case mid-sentence.
    assert.equal(relativeDayText('2026-11-23', { now, locale: 'vi' }).toLowerCase(), 'hôm nay');
    assert.equal(relativeDayText('2026-11-22', { now, locale: 'vi' }).toLowerCase(), 'hôm qua');
    assert.equal(relativeDayText('2026-11-20', { now, locale: 'vi' }), '3 ngày trước');
    assert.equal(relativeDayText('nope', { now }), '');
  });

  test('relativeTimeText', () => {
    assert.equal(relativeTimeText(now - 10_000, { now, locale: 'en' }), 'now');
    assert.equal(relativeTimeText(now - 5 * 60_000, { now, locale: 'en' }), '5 minutes ago');
    assert.equal(relativeTimeText(now - 3 * 3_600_000, { now, locale: 'en' }), '3 hours ago');
    assert.equal(relativeTimeText(now - 2 * 86_400_000, { now, locale: 'en' }), '2 days ago');
    assert.equal(relativeTimeText(now - 5 * 60_000, { now, locale: 'vi' }), '5 phút trước');
    assert.equal(relativeTimeText(0, { now }), '', 'snapshot (fetchedAt 0) has no relative time');
    assert.equal(relativeTimeText(undefined, { now }), '');
  });

  test('ratesAreStale', () => {
    assert.equal(ratesAreStale(null, { now }), true);
    assert.equal(ratesAreStale({ source: 'snapshot', date: '2026-11-23' }, { now }), true);
    assert.equal(ratesAreStale({ source: 'currency-api', date: '2026-11-22' }, { now }), false);
    assert.equal(ratesAreStale({ source: 'currency-api', date: '2026-11-10' }, { now }), true);
  });
});

describe('siteFromInput', () => {
  test('accepts hostnames and URLs, normalises them', () => {
    assert.equal(siteFromInput('taobao.com'), 'taobao.com');
    assert.equal(siteFromInput('https://www.Taobao.com/item?id=1'), 'taobao.com');
    assert.equal(siteFromInput('*.example.com'), 'example.com');
    assert.equal(siteFromInput('world.taobao.com:8080'), 'world.taobao.com');
    assert.equal(siteFromInput('localhost'), 'localhost');
    assert.equal(siteFromInput('192.168.1.10'), '192.168.1.10');
    assert.match(siteFromInput('ví-dụ.vn'), /^xn--[a-z0-9-]+\.vn$/, 'IDN → punycode');
  });
  test('rejects junk', () => {
    assert.equal(siteFromInput(''), '');
    assert.equal(siteFromInput('not a site'), '');
    assert.equal(siteFromInput('com'), '');
    assert.equal(siteFromInput('http://'), '');
  });
});

describe('siteLabel', () => {
  test('picks the brand label of a hostname', () => {
    assert.equal(siteLabel('world.taobao.com'), 'taobao');
    assert.equal(siteLabel('www.amazon.co.jp'), 'amazon');
    assert.equal(siteLabel('shopee.vn'), 'shopee');
    assert.equal(siteLabel('item.jd.com'), 'jd');
    assert.equal(siteLabel('localhost'), 'localhost');
    assert.equal(siteLabel('192.168.1.10'), '192.168.1.10');
    assert.equal(siteLabel(''), '');
  });
});

describe('sitePinList', () => {
  test('flattens and sorts per-site pins', () => {
    const out = sitePinList({ 'shop.ca': { dollar: 'CAD' }, 'amazon.co.jp': { yen: 'JPY', dollar: 'USD' }, 'empty.com': {} });
    assert.deepEqual(out, [
      {
        host: 'amazon.co.jp',
        pins: [
          { symbol: 'dollar', currency: 'USD' },
          { symbol: 'yen', currency: 'JPY' },
        ],
      },
      { host: 'shop.ca', pins: [{ symbol: 'dollar', currency: 'CAD' }] },
    ]);
    assert.deepEqual(sitePinList(null), []);
  });
});

describe('shortcutKeys', () => {
  test('splits Chrome shortcuts', () => {
    assert.deepEqual(shortcutKeys('Alt+Shift+C'), ['Alt', 'Shift', 'C']);
    assert.deepEqual(shortcutKeys('⌥⇧C'), ['⌥', '⇧', 'C']);
    assert.deepEqual(shortcutKeys(''), []);
    assert.deepEqual(shortcutKeys(undefined), []);
  });
});
