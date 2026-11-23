/**
 * convert(), formatMoney(), rateText() — with the bundled snapshot (rates-snapshot.js) and fixed tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, CTX, RATES_SNAPSHOT, spaces } from './helpers.mjs';

const TABLE = { base: 'USD', rates: { USD: 1, CNY: 7, VND: 25000, JPY: 150, EUR: 0.9 } };

test('convert: amount / rates[from] * rates[to]', () => {
  assert.equal(P.convert(7, 'CNY', 'USD', TABLE), 1);
  assert.equal(P.convert(1, 'USD', 'VND', TABLE), 25000);
  assert.equal(P.convert(189, 'CNY', 'VND', TABLE), 675000);
  assert.equal(P.convert(10, 'VND', 'VND', TABLE), 10);
  assert.equal(P.convert(5, 'XYZ', 'VND', TABLE), null);
  assert.equal(P.convert(5, 'CNY', 'XYZ', TABLE), null);
  assert.equal(P.convert(5, 'CNY', 'VND', null), null);
  assert.equal(P.convert(NaN, 'CNY', 'VND', TABLE), null);
  assert.equal(P.convert(5, 'CNY', 'VND', { rates: { CNY: 0, VND: 1 } }), null);
});

test('worked example (docs/ALGORITHM.md): Taobao ¥43.65 → ≈ 168.695 ₫ with the snapshot', () => {
  const [m] = P.findPrices('¥43.65', CTX.taobao);
  const vnd = P.convert(m.amount, m.currency, 'VND', RATES_SNAPSHOT);
  const expected = (43.65 / RATES_SNAPSHOT.rates.CNY) * RATES_SNAPSHOT.rates.VND;
  assert.ok(Math.abs(vnd - expected) < 1e-6);
  if (RATES_SNAPSHOT.date === '2026-11-22') assert.equal(spaces(P.formatMoney(vnd, 'VND')), '168.695 ₫');
});

/** [value, code, options, expected (NBSP-normalised)] */
const FORMATS = [
  [730373.4, 'VND', {}, '730.373 ₫'],
  [730373.4, 'VND', { locale: 'vi-VN' }, '730.373 ₫'],
  [730373, 'VND', { compact: true }, '730 N ₫'],
  [5.391, 'USD', {}, '$5.39'],
  [1234, 'USD', { compact: true }, '$1.2K'],
  [12800, 'JPY', { locale: 'en-US' }, '¥12,800'],
  [189, 'CNY', { locale: 'zh-CN' }, '¥189.00'],
  [1234.5, 'EUR', {}, '1.234,50 €'],
  [1234567.891, 'INR', {}, '₹12,34,567.89'],
  [15000, 'IDR', {}, 'Rp 15.000'],
  [1.2345, 'KWD', { locale: 'en-US' }, 'KWD 1.235'],
  [0.0039, 'USD', {}, '$0.0039'], //     tiny values keep 2 significant digits
  [0.4, 'VND', {}, '0,4 ₫'],
  [0, 'USD', {}, '$0.00'],
  [5.39, 'USD', { locale: 'vi-VN' }, '5,39 $'], // narrow symbol, Vietnamese grouping
];

for (const [value, code, opts, expected] of FORMATS) {
  test(`formatMoney(${value}, ${code}, ${JSON.stringify(opts)}) → ${expected}`, () => {
    assert.equal(spaces(P.formatMoney(value, code, opts)), expected);
  });
}

test('formatMoney: bad input → empty string, never throws', () => {
  assert.equal(P.formatMoney(NaN, 'USD'), '');
  assert.equal(P.formatMoney(Infinity, 'USD'), '');
  assert.equal(P.formatMoney('5', 'USD'), '');
  assert.equal(P.formatMoney(5, undefined), '');
  assert.equal(typeof P.formatMoney(5, 'USD', { locale: '!!bad' }), 'string');
});

const RATES = { rates: { USD: 1, CNY: 6.6729035, VND: 25788.848, JPY: 158.55921, IDR: 18270.078, EUR: 0.91158016, INR: 92.677657 } };

/**
 * [from, to, options, expected]. Readability rule: if 1 `from` is worth < 0.01 `to`, the line is flipped
 * ("1 to = x from"); `{ flip: false }` forces the literal direction. Callers pass the locale of `to`.
 */
const RATE_LINES = [
  ['CNY', 'VND', {}, '1 CNY = 3.865 ₫'], //                          unchanged
  ['JPY', 'VND', { locale: 'vi-VN' }, '1 JPY = 162,6 ₫'], //           unchanged
  ['USD', 'VND', {}, '1 USD = 25.789 ₫'], //                          unchanged (≥ 10 000 → whole units)
  ['USD', 'CNY', { locale: 'en-US' }, '1 USD = ¥6.673'],
  ['INR', 'USD', {}, '1 INR = $0.01079'], //                           just above the threshold
  ['VND', 'CNY', { locale: 'zh-CN' }, '1 CNY = 3.865 ₫'], //           flipped, đồng side stays vi-VN
  ['VND', 'USD', { locale: 'en-US' }, '1 USD = 25.789 ₫'], //          flipped
  ['IDR', 'EUR', { locale: 'de-DE' }, '1 EUR = Rp 20.042'], //         flipped, rupiah formatted in id-ID
  ['JPY', 'USD', {}, '1 USD = ￥158.6'], //                            flipped, ja-JP (Intl uses the fullwidth ￥)
  ['VND', 'CNY', { flip: false, locale: 'en-US' }, '1 VND = ¥0.0002588'], // literal on request
  ['VND', 'USD', { flip: false }, '1 VND = $0.00003878'],
];

for (const [from, to, opts, expected] of RATE_LINES) {
  test(`rateText(${from}, ${to}, ${JSON.stringify(opts)}) → ${expected}`, () => {
    assert.equal(spaces(P.rateText(from, to, RATES, opts)), expected);
  });
}

test('rateText: unknown currency → empty string', () => {
  assert.equal(P.rateText('USD', 'XYZ', RATES), '');
  assert.equal(P.rateText('XYZ', 'VND', RATES), '');
  assert.equal(P.rateText('VND', 'USD', null), '');
});
