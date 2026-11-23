/** storage.js: settings validation (every field), host normalisation/matching, home-currency guess, rates I/O. */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../../extension/src/shared/constants.js';
import {
  MAX_SITE_CURRENCY,
  MAX_SITE_LIST,
  MULTI_PART_SUFFIXES,
  browserLocales,
  getSettings,
  getStoredRates,
  guessHomeCurrency,
  isSiteActive,
  isSiteMatch,
  isValidRatesTable,
  mirrorUiLanguage,
  normalizeHostname,
  normalizeSettings,
  onSettingsChanged,
  setStoredRates,
  siteKey,
  updateSettings,
} from '../../extension/src/shared/storage.js';
import { createChromeMock, flush, ratesTable } from './helpers.mjs';

let mock;
const setUi = (lang, languages = ['en-US']) => {
  mock = createChromeMock({ uiLanguage: lang });
  globalThis.chrome = mock.chrome;
  Object.defineProperty(globalThis, 'navigator', { value: { languages }, configurable: true, writable: true });
};
beforeEach(() => setUi('en-US'));

const norm = (raw) => normalizeSettings(raw, { locales: ['vi-VN'] }); // deterministic guess → VND

describe('normalizeHostname', () => {
  test('lowercase, strip www./*./port/path/trailing dot, accept URLs', () => {
    const cases = {
      'Taobao.com': 'taobao.com',
      'www.taobao.com': 'taobao.com',
      'WWW.World.Taobao.COM': 'world.taobao.com',
      '  amazon.co.jp  ': 'amazon.co.jp',
      'https://www.Example.com/path?q=1#x': 'example.com',
      'http://shop.example.com:8080/a': 'shop.example.com',
      'example.com/some/path': 'example.com',
      'example.com.': 'example.com',
      '*.example.com': 'example.com',
      localhost: 'localhost',
      '192.168.1.10': '192.168.1.10',
      'bücher.de': 'xn--bcher-kva.de',
      wwwexample: 'wwwexample',
      '[::1]': '[::1]',
      'http://[2001:db8::1]:8080/x': '[2001:db8::1]',
    };
    for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeHostname(input), expected, input);
  });

  test('rejects non-hostnames', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, 'a b.com', 'file:///etc/hosts', '::1', '[zz::1]', 'exa$mple.com', 'http://']) {
      assert.equal(normalizeHostname(bad), '', String(bad));
    }
  });
});

describe('isSiteMatch', () => {
  test('exact host or subdomain, never a mere suffix', () => {
    const list = ['taobao.com', 'shop.example.org'];
    assert.equal(isSiteMatch('taobao.com', list), true);
    assert.equal(isSiteMatch('www.taobao.com', list), true);
    assert.equal(isSiteMatch('world.taobao.com', list), true);
    assert.equal(isSiteMatch('a.b.taobao.com', list), true);
    assert.equal(isSiteMatch('nottaobao.com', list), false);
    assert.equal(isSiteMatch('taobao.com.evil.net', list), false);
    assert.equal(isSiteMatch('example.org', list), false, 'parent of a rule is not matched');
    assert.equal(isSiteMatch('x.shop.example.org', list), true);
    assert.equal(isSiteMatch('https://World.Taobao.com/item', list), true, 'URLs and case are normalised');
  });

  test('defensive with junk input', () => {
    assert.equal(isSiteMatch('', ['taobao.com']), false);
    assert.equal(isSiteMatch('taobao.com', null), false);
    assert.equal(isSiteMatch('taobao.com', 'taobao.com'), false);
    assert.equal(isSiteMatch('taobao.com', [null, 42, '', 'WWW.TAOBAO.COM']), true);
  });
});

describe('siteKey (§3.5 registrable-domain heuristic)', () => {
  test('table', () => {
    const cases = {
      's.taobao.com': 'taobao.com',
      'item.taobao.com': 'taobao.com',
      'world.taobao.com': 'taobao.com',
      'taobao.com': 'taobao.com',
      'www.taobao.com': 'taobao.com',
      'shopee.com.vn': 'shopee.com.vn',
      'www.shopee.com.vn': 'shopee.com.vn',
      'm.shopee.com.vn': 'shopee.com.vn',
      'www.amazon.co.uk': 'amazon.co.uk',
      'bbc.co.uk': 'bbc.co.uk',
      'news.bbc.co.uk': 'bbc.co.uk',
      'www.amazon.co.jp': 'amazon.co.jp',
      'item.rakuten.co.jp': 'rakuten.co.jp',
      'detail.tmall.com': 'tmall.com',
      'a.b.c.example.com': 'example.com',
      'https://Item.Taobao.com/item.htm?id=1': 'taobao.com',
      'co.uk': 'co.uk', // a bare suffix stays as it is
      'example.vn': 'example.vn',
      localhost: 'localhost',
      '127.0.0.1': '127.0.0.1',
      '192.168.1.20': '192.168.1.20',
      '[::1]': '[::1]',
      intranet: 'intranet', // single label
    };
    for (const [input, expected] of Object.entries(cases)) assert.equal(siteKey(input), expected, input);
  });

  test('invalid input → empty string', () => {
    for (const bad of ['', null, undefined, 42, 'a b.com', 'file:///x']) assert.equal(siteKey(bad), '', String(bad));
  });

  test('MULTI_PART_SUFFIXES: the contract list, lowercase two-label entries, read-only', () => {
    const contract = 'co.uk com.au com.vn co.jp com.cn com.hk com.tw com.sg co.kr co.nz com.br com.mx co.id co.th com.my com.ph co.in ac.uk gov.uk org.uk net.au edu.vn gov.vn net.vn org.vn';
    for (const sfx of contract.split(' ')) assert.ok(MULTI_PART_SUFFIXES.has(sfx), sfx);
    for (const sfx of MULTI_PART_SUFFIXES) assert.match(sfx, /^[a-z]+\.[a-z]+$/);
    assert.ok(MULTI_PART_SUFFIXES instanceof Set);
    assert.ok(Object.isFrozen(MULTI_PART_SUFFIXES));
    assert.throws(() => MULTI_PART_SUFFIXES.add('evil.com'), TypeError);
    assert.throws(() => MULTI_PART_SUFFIXES.delete('co.uk'), TypeError);
    assert.throws(() => MULTI_PART_SUFFIXES.clear(), TypeError);
    assert.ok(MULTI_PART_SUFFIXES.has('co.uk'));
  });
});

describe('isSiteActive', () => {
  const base = norm({});
  test('allowlist (default): only hosts covered by enabledSites', () => {
    const s = { ...base, enabledSites: ['taobao.com'] };
    assert.equal(isSiteActive(s, 's.taobao.com'), true);
    assert.equal(isSiteActive(s, 'item.taobao.com'), true);
    assert.equal(isSiteActive(s, 'taobao.com'), true);
    assert.equal(isSiteActive(s, 'jd.com'), false);
    assert.equal(isSiteActive(s, ''), false);
    assert.equal(isSiteActive(base, 'taobao.com'), false, 'nothing turned on → off everywhere');
    assert.equal(isSiteActive({ ...s, disabledSites: ['jd.com'] }, 'jd.com'), false, 'disabledSites is ignored in allowlist mode');
  });

  test('all: every host except those covered by disabledSites', () => {
    const s = { ...base, siteMode: 'all', disabledSites: ['taobao.com'], enabledSites: ['jd.com'] };
    assert.equal(isSiteActive(s, 'item.taobao.com'), false);
    assert.equal(isSiteActive(s, 'amazon.com'), true);
    assert.equal(isSiteActive(s, 'jd.com'), true);
  });

  test('global switch off → inactive everywhere, in both modes', () => {
    assert.equal(isSiteActive({ ...base, enabled: false, enabledSites: ['taobao.com'] }, 'taobao.com'), false);
    assert.equal(isSiteActive({ ...base, enabled: false, siteMode: 'all' }, 'amazon.com'), false);
    assert.equal(isSiteActive(null, 'taobao.com'), false);
    assert.equal(isSiteActive(undefined, 'taobao.com'), false);
  });
});

describe('home currency guess', () => {
  test('vi → VND, en-US → USD, ja → JPY, fallback USD', () => {
    assert.equal(guessHomeCurrency(['vi']), 'VND');
    assert.equal(guessHomeCurrency(['vi-VN']), 'VND');
    assert.equal(guessHomeCurrency(['en-US']), 'USD');
    assert.equal(guessHomeCurrency(['ja']), 'JPY');
    assert.equal(guessHomeCurrency(['ja-JP']), 'JPY');
    assert.equal(guessHomeCurrency([]), 'USD');
  });

  test('browserLocales = chrome UI language first, then navigator.languages (deduped)', () => {
    setUi('vi', ['en-US', 'vi', 'fr']);
    assert.deepEqual(browserLocales(), ['vi', 'en-US', 'fr']);
  });

  test('getSettings guesses from the browser when homeCurrency is unset', async () => {
    setUi('vi', ['en-US']);
    assert.equal((await getSettings()).homeCurrency, 'VND');
    setUi('ja', ['ja']);
    assert.equal((await getSettings()).homeCurrency, 'JPY');
    setUi('en-US', ['en-US']);
    assert.equal((await getSettings()).homeCurrency, 'USD');
  });

  test('without chrome.i18n / navigator (plain Node) the guess still works', () => {
    const saved = globalThis.chrome;
    globalThis.chrome = undefined;
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(normalizeSettings({}).homeCurrency, 'USD');
    } finally {
      globalThis.chrome = saved;
    }
  });
});

describe('normalizeSettings — every field', () => {
  test('empty / garbage input → defaults (home currency guessed)', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      assert.deepEqual(norm(raw), { ...DEFAULT_SETTINGS, homeCurrency: 'VND', enabledSites: [], disabledSites: [], siteCurrency: {} });
      assert.equal(norm(raw).siteMode, 'allowlist', 'off everywhere by default');
    }
  });

  test('output has exactly the DEFAULT_SETTINGS keys (unknown keys dropped)', () => {
    const s = norm({ evil: true, __proto__: { polluted: 1 }, enabled: false });
    assert.deepEqual(Object.keys(s).sort(), Object.keys(DEFAULT_SETTINGS).sort());
    assert.equal(s.evil, undefined);
  });

  test('booleans: enabled, compact, highlight', () => {
    for (const key of ['enabled', 'compact', 'highlight']) {
      assert.equal(norm({ [key]: !DEFAULT_SETTINGS[key] })[key], !DEFAULT_SETTINGS[key], key);
      for (const bad of ['true', 1, 0, null, {}]) assert.equal(norm({ [key]: bad })[key], DEFAULT_SETTINGS[key], `${key}=${bad}`);
    }
  });

  test('homeCurrency: known code (case-insensitive) kept, otherwise guessed', () => {
    assert.equal(norm({ homeCurrency: 'EUR' }).homeCurrency, 'EUR');
    assert.equal(norm({ homeCurrency: ' jpy ' }).homeCurrency, 'JPY');
    for (const bad of ['', 'XYZ', 'EURO', 'BTC', 7, null]) assert.equal(norm({ homeCurrency: bad }).homeCurrency, 'VND', String(bad));
    assert.equal(normalizeSettings({ homeCurrency: '' }, { locales: ['ja'] }).homeCurrency, 'JPY');
  });

  test('displayMode', () => {
    assert.equal(norm({ displayMode: 'append' }).displayMode, 'append');
    assert.equal(norm({ displayMode: 'replace' }).displayMode, 'replace');
    assert.equal(norm({ displayMode: 'APPEND' }).displayMode, 'replace');
    assert.equal(norm({ displayMode: 'both' }).displayMode, 'replace');
  });

  test('defaultDollar / defaultYen restricted to AMBIGUOUS_SYMBOLS', () => {
    assert.equal(norm({ defaultDollar: 'CAD' }).defaultDollar, 'CAD');
    assert.equal(norm({ defaultDollar: 'twd' }).defaultDollar, 'TWD');
    assert.equal(norm({ defaultDollar: 'EUR' }).defaultDollar, 'USD');
    assert.equal(norm({ defaultDollar: 1 }).defaultDollar, 'USD');
    assert.equal(norm({ defaultYen: 'JPY' }).defaultYen, 'JPY');
    assert.equal(norm({ defaultYen: 'USD' }).defaultYen, 'CNY');
    assert.equal(norm({ defaultYen: null }).defaultYen, 'CNY');
  });

  test('siteMode: allowlist | all, anything else → allowlist', () => {
    assert.equal(norm({ siteMode: 'all' }).siteMode, 'all');
    assert.equal(norm({ siteMode: 'allowlist' }).siteMode, 'allowlist');
    for (const bad of ['ALL', 'blocklist', '', null, true]) assert.equal(norm({ siteMode: bad }).siteMode, 'allowlist', String(bad));
  });

  for (const key of ['enabledSites', 'disabledSites']) {
    test(`${key}: normalised, deduped, junk dropped, newest kept under the cap`, () => {
      assert.deepEqual(norm({ [key]: ['WWW.Taobao.com', 'taobao.com', 'https://jd.com/x', '', 42, null, 'bad host'] })[key], [
        'taobao.com',
        'jd.com',
      ]);
      for (const bad of ['taobao.com', {}, null, 1]) assert.deepEqual(norm({ [key]: bad })[key], []);
      const many = Array.from({ length: MAX_SITE_LIST + 50 }, (_, i) => `site${i}.com`);
      const capped = norm({ [key]: many })[key];
      assert.equal(capped.length, MAX_SITE_LIST);
      assert.equal(capped.at(-1), `site${MAX_SITE_LIST + 49}.com`);
      assert.equal(capped[0], 'site50.com');
    });
  }

  test('both lists and the pins at their caps still fit chrome.storage.sync QUOTA_BYTES_PER_ITEM (8192)', () => {
    const host = (i) => `s${String(i).padStart(4, '0')}.example.co`; // 16 chars, like "world.taobao.com"
    assert.equal(host(1).length, 16);
    const s = norm({
      enabledSites: Array.from({ length: MAX_SITE_LIST }, (_, i) => host(i)),
      disabledSites: Array.from({ length: MAX_SITE_LIST }, (_, i) => host(i + 5000)),
      siteCurrency: Object.fromEntries(Array.from({ length: MAX_SITE_CURRENCY }, (_, i) => [host(i), { dollar: 'USD', yen: 'CNY' }])),
    });
    assert.equal(s.enabledSites.length + s.disabledSites.length + Object.keys(s.siteCurrency).length, 2 * MAX_SITE_LIST + MAX_SITE_CURRENCY);
    const bytes = 'settings'.length + new TextEncoder().encode(JSON.stringify(s)).length;
    assert.ok(bytes < 8192, `${bytes} bytes with 16-char hostnames`);
  });

  test('siteCurrency: hostnames normalised, bad symbols/codes/entries dropped, duplicates merged', () => {
    const s = norm({
      siteCurrency: {
        'WWW.Taobao.com': { yen: 'cny' },
        'taobao.com': { dollar: 'USD' }, // same host after normalisation → merged
        'amazon.co.jp': { yen: 'JPY', dollar: 'EUR' }, // EUR is not a "$" meaning → dropped
        'shop.ca': { dollar: 'CAD', euro: 'EUR' }, // unknown symbol dropped
        'empty.com': {},
        'bad.com': { yen: 'USD' }, // nothing valid left → entry dropped
        'not a host': { yen: 'JPY' },
        'list.com': ['JPY'],
        'null.com': null,
      },
    });
    assert.deepEqual(s.siteCurrency, {
      'taobao.com': { yen: 'CNY', dollar: 'USD' },
      'amazon.co.jp': { yen: 'JPY' },
      'shop.ca': { dollar: 'CAD' },
    });
    for (const bad of [[], 'x', null, 3]) assert.deepEqual(norm({ siteCurrency: bad }).siteCurrency, {});
    const many = Object.fromEntries(Array.from({ length: MAX_SITE_CURRENCY + 20 }, (_, i) => [`s${i}.com`, { yen: 'JPY' }]));
    assert.equal(Object.keys(norm({ siteCurrency: many }).siteCurrency).length, MAX_SITE_CURRENCY);
  });

  test('theme / uiLanguage', () => {
    assert.equal(norm({ theme: 'dark' }).theme, 'dark');
    assert.equal(norm({ theme: 'light' }).theme, 'light');
    assert.equal(norm({ theme: 'sepia' }).theme, 'auto');
    assert.equal(norm({ uiLanguage: 'vi' }).uiLanguage, 'vi');
    assert.equal(norm({ uiLanguage: 'en' }).uiLanguage, 'en');
    assert.equal(norm({ uiLanguage: 'fr' }).uiLanguage, 'auto');
    assert.equal(norm({ uiLanguage: null }).uiLanguage, 'auto');
  });
});

describe('getSettings / updateSettings / onSettingsChanged', () => {
  test('getSettings validates whatever is stored', async () => {
    mock.areas.sync.settings = { enabled: 'nope', displayMode: 'append', disabledSites: ['WWW.A.com'], junk: 1 };
    const s = await getSettings();
    assert.equal(s.enabled, true);
    assert.equal(s.displayMode, 'append');
    assert.deepEqual(s.disabledSites, ['a.com']);
    assert.equal('junk' in s, false);
  });

  test('migration: settings stored before siteMode existed → allowlist, nothing on, old disabledSites kept', async () => {
    mock.areas.sync.settings = { enabled: true, homeCurrency: 'VND', displayMode: 'append', disabledSites: ['jd.com'], siteCurrency: {} };
    const s = await getSettings();
    assert.equal(s.siteMode, 'allowlist');
    assert.deepEqual(s.enabledSites, []);
    assert.deepEqual(s.disabledSites, ['jd.com'], 'kept for whoever switches back to "all"');
    assert.equal(s.displayMode, 'append');
    assert.equal(isSiteActive(s, 'world.taobao.com'), false, 'off by default now');
    const saved = await updateSettings({ compact: true });
    assert.equal(mock.areas.sync.settings.siteMode, 'allowlist', 'persisted on the next write');
    assert.deepEqual(saved.enabledSites, []);
  });

  test('updateSettings merges, validates, persists the complete object and returns it', async () => {
    const s = await updateSettings({ compact: true, theme: 'neon', homeCurrency: 'eur', disabledSites: ['www.x.com'] });
    assert.equal(s.compact, true);
    assert.equal(s.theme, 'auto');
    assert.equal(s.homeCurrency, 'EUR');
    assert.deepEqual(s.disabledSites, ['x.com']);
    assert.deepEqual(mock.areas.sync[STORAGE_KEYS.SETTINGS], s, 'stored value is the validated object');
    const again = await updateSettings({ highlight: false });
    assert.equal(again.compact, true, 'previous values kept');
    assert.equal(again.highlight, false);
  });

  test('the guessed home currency is persisted on the first write (storage listeners never see "")', async () => {
    setUi('vi', ['vi']);
    await updateSettings({ compact: true });
    assert.equal(mock.areas.sync.settings.homeCurrency, 'VND');
  });

  test('no write when nothing changes; garbage patches are ignored', async () => {
    await updateSettings({ compact: true });
    const writes = mock.log.writes.sync;
    await updateSettings({ compact: true });
    await updateSettings(null);
    await updateSettings('x');
    await updateSettings({ theme: 'invalid' });
    assert.equal(mock.log.writes.sync, writes);
  });

  test('function patches are evaluated in a queue: concurrent toggles never lose an update', async () => {
    const toggles = Array.from({ length: 7 }, () => updateSettings((cur) => ({ enabled: !cur.enabled })));
    const results = await Promise.all(toggles);
    assert.deepEqual(
      results.map((r) => r.enabled),
      [false, true, false, true, false, true, false],
    );
    assert.equal((await getSettings()).enabled, false);
  });

  test('a failing update does not block the queue', async () => {
    await assert.rejects(
      updateSettings(() => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await updateSettings({ compact: true })).compact, true);
  });

  test('uiLanguage is mirrored to storage.local only when it changes', async () => {
    await updateSettings({ uiLanguage: 'vi' });
    assert.equal(mock.areas.local[STORAGE_KEYS.UI_LANGUAGE], 'vi');
    const localWrites = mock.log.writes.local;
    await updateSettings({ compact: true });
    assert.equal(mock.log.writes.local, localWrites, 'unchanged → no local write');
    await updateSettings({ uiLanguage: 'en' });
    assert.equal(mock.areas.local[STORAGE_KEYS.UI_LANGUAGE], 'en');
    await mirrorUiLanguage('klingon');
    assert.equal(mock.areas.local[STORAGE_KEYS.UI_LANGUAGE], 'auto');
  });

  test('onSettingsChanged delivers validated settings for sync changes only; unsubscribe works', async () => {
    const seen = [];
    const off = onSettingsChanged((s) => seen.push(s));
    await updateSettings({ displayMode: 'append' });
    await mock.chrome.storage.local.set({ settings: { displayMode: 'replace' } }); // other area → ignored
    await flush();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].displayMode, 'append');
    off();
    await updateSettings({ displayMode: 'replace' });
    await flush();
    assert.equal(seen.length, 1);
  });
});

describe('rates storage', () => {
  test('round-trip a valid table', async () => {
    const t = ratesTable();
    await setStoredRates(t);
    assert.deepEqual(await getStoredRates(), t);
  });

  test('missing or corrupt stored table → null', async () => {
    assert.equal(await getStoredRates(), null);
    for (const bad of [
      'x',
      { ...ratesTable(), base: 'EUR' },
      { ...ratesTable(), rates: { ...ratesTable().rates, USD: 2 } },
      { ...ratesTable(), rates: { USD: 1, EUR: 0.9 } },
      { ...ratesTable(), rates: { ...ratesTable().rates, GBP: -1 } },
      { ...ratesTable(), fetchedAt: 'now' },
      { ...ratesTable(), date: undefined },
    ]) {
      mock.areas.local.rates = bad;
      assert.equal(await getStoredRates(), null, JSON.stringify(bad).slice(0, 60));
      assert.equal(isValidRatesTable(bad), false);
    }
  });

  test('setStoredRates refuses invalid tables', async () => {
    await assert.rejects(setStoredRates({ base: 'USD' }), TypeError);
    assert.equal(mock.areas.local.rates, undefined);
  });
});
