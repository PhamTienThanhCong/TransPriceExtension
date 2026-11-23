/**
 * currency-data.js (TransPriceCurrencies) + the classic-script contract of both engine files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { C, RATES_SNAPSHOT } from './helpers.mjs';

const ROOT = new URL('../../', import.meta.url);
const source = (p) => readFileSync(new URL(p, ROOT), 'utf8');

test('CURRENCIES covers every code of the bundled rate snapshot', () => {
  for (const code of Object.keys(RATES_SNAPSHOT.rates)) {
    const c = C.CURRENCIES[code];
    assert.ok(c, `missing ${code}`);
    assert.equal(c.code, code);
    assert.ok([0, 2, 3].includes(c.decimals), `${code} decimals`);
    assert.ok(typeof c.symbol === 'string' && c.symbol.length > 0, `${code} symbol`);
  }
});

test('decimals: practical minor units', () => {
  const d = (code) => C.CURRENCIES[code].decimals;
  for (const code of ['VND', 'JPY', 'KRW', 'IDR', 'CLP', 'HUF', 'TWD', 'ISK']) assert.equal(d(code), 0, code);
  for (const code of ['USD', 'EUR', 'CNY', 'GBP', 'THB', 'INR']) assert.equal(d(code), 2, code);
  for (const code of ['KWD', 'BHD', 'OMR', 'JOD']) assert.equal(d(code), 3, code);
});

test('CODES is sorted and frozen; data is immutable', () => {
  assert.deepEqual([...C.CODES], [...C.CODES].sort());
  assert.ok(Object.isFrozen(C.CODES) && Object.isFrozen(C.CURRENCIES) && Object.isFrozen(C.TOKENS));
  assert.ok(Object.isFrozen(C.CURRENCIES.VND) && Object.isFrozen(C.TOKENS[0]));
  assert.ok(Object.isFrozen(globalThis.TransPriceCurrencies) && Object.isFrozen(globalThis.TransPriceParser));
});

test('TOKENS: shape, uniqueness and the required markers', () => {
  const byToken = new Map(C.TOKENS.map((t) => [t.token, t]));
  assert.equal(byToken.size, C.TOKENS.length, 'unique tokens');
  for (const t of C.TOKENS) {
    assert.ok(['code', 'symbol', 'word'].includes(t.kind), t.token);
    assert.ok(t.prefix || t.suffix, t.token);
    assert.ok(t.currencies.length > 0 && t.currencies.every((c) => C.CURRENCIES[c]), t.token);
  }
  const required = ['USD', 'US$', '$', '¥', '￥', '＄', 'CN¥', 'JP¥', 'RMB', '元', '圆', '円', '원', '₫', 'đ', 'VND', '€', '£', '₩',
    '₹', '฿', '₱', '₺', '₽', '₪', '₴', '₦', 'zł', 'Kč', 'Ft', 'kr', 'RM', 'Rp', 'Rs', 'CHF', 'AED', 'SAR', 'R$', 'HK$', 'NT$',
    'S$', 'C$', 'A$', 'NZ$', 'MX$'];
  for (const tok of required) assert.ok(byToken.has(tok), `missing token ${tok}`);
  assert.deepEqual([...byToken.get('¥').currencies], ['CNY', 'JPY']);
  assert.equal(byToken.get('元').prefix, false);
  assert.equal(byToken.get('USD').kind, 'code');
});

test('TOKENS: at least 40 currencies have a symbol or local word (not only their ISO code)', () => {
  const covered = new Set(C.TOKENS.filter((t) => t.kind !== 'code').flatMap((t) => t.currencies));
  assert.ok(covered.size >= 40, `only ${covered.size}`);
});

test('AMBIGUOUS', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(C.AMBIGUOUS)), { dollar: ['$', '＄'], yen: ['¥', '￥'] });
});

const GUESS = [
  [['vi-VN'], 'VND'], [['vi'], 'VND'], [['ja'], 'JPY'], [['en-GB'], 'GBP'], [['en-US'], 'USD'], [['en'], 'USD'],
  [['de-DE'], 'EUR'], [['fr'], 'EUR'], [['zh-TW'], 'TWD'], [['zh-CN'], 'CNY'], [['ko'], 'KRW'], [['hr'], 'EUR'],
  [['', 'not a locale!!', 'th'], 'THB'], [[], 'USD'], [undefined, 'USD'],
];
for (const [locales, expected] of GUESS) {
  test(`guessHomeCurrency(${JSON.stringify(locales)}) → ${expected}`, () => {
    assert.equal(C.guessHomeCurrency(locales), expected);
  });
}

test('currencyName via Intl.DisplayNames, fallback = code', () => {
  assert.equal(C.currencyName('CNY', 'vi'), 'Nhân dân tệ');
  assert.equal(C.currencyName('VND', 'en'), 'Vietnamese Dong');
  assert.equal(C.currencyName('ZZZ', 'en'), 'ZZZ');
  assert.equal(C.currencyName('USD', '!!bad'), 'USD');
});

test('flag', () => {
  assert.equal(C.flag('VND'), '🇻🇳');
  assert.equal(C.flag('EUR'), '🇪🇺');
  assert.equal(C.flag('USD'), '🇺🇸');
  assert.equal(C.flag('XOF'), '');
  assert.equal(C.flag('usd'), '');
  assert.equal(C.flag(undefined), '');
});

test('localeFor: first preferred locale whose region uses the currency, else its home locale', () => {
  assert.equal(C.localeFor('VND', []), 'vi-VN');
  assert.equal(C.localeFor('VND', ['en-US', 'vi']), 'vi');
  assert.equal(C.localeFor('JPY', ['en-US']), 'ja-JP');
  assert.equal(C.localeFor('USD', ['vi-VN', 'en-US']), 'en-US');
  assert.equal(C.localeFor('EUR', ['fr-FR']), 'fr-FR');
  assert.equal(C.localeFor('EUR', ['en-US']), 'de-DE');
  assert.equal(C.localeFor('THB', []), 'th-TH');
  assert.match(C.localeFor('EGP', []), /^ar-EG/);
});

test('engine files are classic scripts: no import/export, no DOM, no chrome.*', () => {
  for (const file of ['extension/src/shared/currency-data.js', 'extension/src/content/parser.js']) {
    const code = source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // strip comments
    assert.doesNotMatch(code, /^\s*(import|export)\s/m, file);
    assert.doesNotMatch(code, /\b(document|window|chrome)\./, file);
  }
});

test('engine files run as plain <script>s in a fresh realm (vm context, sloppy global scope)', () => {
  const realm = vm.createContext({});
  vm.runInContext(source('extension/src/shared/currency-data.js'), realm, { filename: 'currency-data.js' });
  vm.runInContext(source('extension/src/content/parser.js'), realm, { filename: 'parser.js' });
  const ctx = realm.TransPriceParser.resolveContext({ hostname: 'taobao.com' });
  const [m] = realm.TransPriceParser.findPrices('¥43.65', ctx);
  assert.equal(m.amount, 43.65);
  assert.equal(m.currency, 'CNY');
});

test('parser.js fails loudly when currency-data.js was not loaded first', () => {
  const realm = vm.createContext({});
  assert.throws(() => vm.runInContext(source('extension/src/content/parser.js'), realm), /currency-data/);
});
