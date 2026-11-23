/**
 * Site activation (docs/ARCHITECTURE.md §3.5): the content script MIRRORS storage.js (it can't import modules).
 * This test loads both — storage.js as an ES module, scanner.js in a vm context like the browser does — and asserts
 * identical results for normalizeHostname / isSiteMatch / siteKey / isSiteActive on a table of hosts × settings,
 * in both site modes, plus the multi-part suffix list itself.
 *
 *   node --test "tests/content/*.test.mjs"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'extension/src');
const storage = await import(path.join(SRC, 'shared/storage.js'));

const ctx = vm.createContext({ console, URL, Intl, setTimeout, clearTimeout });
vm.runInContext(readFileSync(path.join(SRC, 'content/scanner.js'), 'utf8'), ctx, { filename: 'scanner.js' });
const U = ctx.__transprice.util;

const HOSTS = [
  'taobao.com', 'www.taobao.com', 's.taobao.com', 'item.taobao.com', 'world.taobao.com', 'TAOBAO.COM', 'taobao.com.',
  'nottaobao.com', 'tmall.com', 'detail.tmall.com', 'shopee.com.vn', 'www.shopee.com.vn', 'mall.shopee.com.vn',
  'amazon.co.uk', 'www.amazon.co.uk', 'smile.amazon.co.uk', 'amazon.com', 'www.amazon.co.jp', 'rakuten.co.jp',
  'bbc.co.uk', 'example.com.au', 'shop.example.com.au', 'jd.com', 'item.jd.com', 'a.b.c.d.example.org', 'gov.vn',
  'chinhphu.gov.vn', 'tiki.vn', 'localhost', '127.0.0.1', '192.168.1.20', '[::1]', 'intranet', 'xn--fiq228c.com',
  '例子.com', 'https://www.taobao.com/item?id=1', '*.taobao.com', 'taobao.com:8080', '', ' ', 'not a host', null,
  undefined, 42,
];

const SETTINGS = [
  { enabled: true, siteMode: 'allowlist', enabledSites: [], disabledSites: [] },
  { enabled: true, siteMode: 'allowlist', enabledSites: ['taobao.com'], disabledSites: [] },
  { enabled: true, siteMode: 'allowlist', enabledSites: ['shopee.com.vn', 'amazon.co.uk', 'localhost'], disabledSites: ['taobao.com'] },
  { enabled: true, siteMode: 'allowlist', enabledSites: ['www.TAOBAO.com', '127.0.0.1', '[::1]'], disabledSites: [] },
  { enabled: false, siteMode: 'allowlist', enabledSites: ['taobao.com'], disabledSites: [] },
  { enabled: true, siteMode: 'all', enabledSites: [], disabledSites: [] },
  { enabled: true, siteMode: 'all', enabledSites: ['taobao.com'], disabledSites: ['taobao.com', 'co.uk'] },
  { enabled: true, siteMode: 'all', enabledSites: [], disabledSites: ['amazon.co.uk', 'jd.com'] },
  { enabled: false, siteMode: 'all', enabledSites: [], disabledSites: [] },
  { enabled: true, siteMode: 'bogus', enabledSites: ['taobao.com'], disabledSites: ['jd.com'] },
  { enabled: true, enabledSites: ['taobao.com'] },
  { enabled: true, siteMode: 'allowlist', enabledSites: 'taobao.com' },
  null,
];

test('mirror: MULTI_PART_SUFFIXES is the same set as storage.js', () => {
  assert.deepEqual([...U.MULTI_PART_SUFFIXES].sort(), [...storage.MULTI_PART_SUFFIXES].sort());
});

test('mirror: normalizeHostname + siteKey identical on every host of the table', () => {
  for (const h of HOSTS) {
    assert.equal(U.normalizeHost(h), storage.normalizeHostname(h), `normalize ${JSON.stringify(h)}`);
    assert.equal(U.siteKey(h), storage.siteKey(h), `siteKey ${JSON.stringify(h)}`);
  }
});

test('mirror: isSiteMatch + isSiteActive identical on hosts × settings (both site modes)', () => {
  let active = 0;
  for (const st of SETTINGS) {
    for (const h of HOSTS) {
      const label = `${JSON.stringify(h)} with ${JSON.stringify(st)}`;
      const lists = st ? [st.enabledSites, st.disabledSites] : [];
      for (const list of lists) assert.equal(U.isSiteMatch(h, list), storage.isSiteMatch(h, list), `isSiteMatch ${label}`);
      const got = U.isSiteActive(st, h);
      assert.equal(got, storage.isSiteActive(st, h), `isSiteActive ${label}`);
      if (got) active++;
    }
  }
  assert.ok(active > 20, 'the table exercises active hosts too');
});

test('§3.5 examples: off by default, on only where turned on (registrable domain covers subdomains)', () => {
  assert.equal(U.siteKey('s.taobao.com'), 'taobao.com');
  assert.equal(U.siteKey('shopee.com.vn'), 'shopee.com.vn');
  assert.equal(U.siteKey('www.amazon.co.uk'), 'amazon.co.uk');
  assert.equal(U.siteKey('localhost'), 'localhost');
  assert.equal(U.siteKey('127.0.0.1'), '127.0.0.1');
  const defaults = { enabled: true, siteMode: 'allowlist', enabledSites: [], disabledSites: [] };
  assert.equal(U.isSiteActive(defaults, 's.taobao.com'), false, 'default = off everywhere');
  const on = { ...defaults, enabledSites: [U.siteKey('s.taobao.com')] };
  assert.equal(U.isSiteActive(on, 'item.taobao.com'), true, 'turning s.taobao.com on covers item.taobao.com');
  assert.equal(U.isSiteActive({ ...on, enabled: false }, 'item.taobao.com'), false, 'global switch still pauses');
  assert.equal(U.isSiteActive({ ...defaults, siteMode: 'all' }, 'jd.com'), true, "'all' mode = everywhere");
});
