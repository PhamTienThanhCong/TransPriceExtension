/**
 * Number grammar & separator rules (parseNumber), the "1.234 vs 1,234" decision table, and parsePrice()
 * (whole string = exactly one price — the split-price path of the content script).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, CTX } from './helpers.mjs';

/** [input, options, expected] */
const NUMBERS = [
  ['189', {}, 189],
  ['43.65', {}, 43.65],
  ['1,299.99', {}, 1299.99],
  ['1.234,56', {}, 1234.56],
  ['1 234,56', {}, 1234.56],
  ['1\u00A0234,56', {}, 1234.56],
  ['1\u202F234\u202F567', {}, 1234567],
  ["1'234.56", {}, 1234.56],
  ['1’234.56', {}, 1234.56],
  ['12,34,567.89', {}, 1234567.89],
  ['1,00,000', {}, 100000],
  ['1.234.567', {}, 1234567],
  ['1,234,567', {}, 1234567],
  ['12,99', {}, 12.99],
  ['1,5', {}, 1.5],
  ['0,99', {}, 0.99],
  ['１２，８００', { currency: 'JPY' }, 12800],
  ['1.5万', {}, 15000],
  ['1,2 triệu', {}, 1200000],
  ['2 tỷ', {}, 2e9],
  ['5k', {}, 5000],
  ['3 crore', {}, 3e7],
  ['  42  ', {}, 42],
  // invalid
  ['.99', {}, null],
  ['1.2.3', {}, null],
  ['0912345678', {}, null],
  ['12abc', {}, null],
  ['1,2345,6', {}, null],
  ['', {}, null],
  [null, {}, null],
  ['abc', {}, null],
  ['1 2345', {}, null],
];

for (const [input, opts, expected] of NUMBERS) {
  test(`parseNumber ${JSON.stringify(input)} ${JSON.stringify(opts)} → ${expected}`, () => {
    assert.equal(P.parseNumber(input, opts), expected);
  });
}

/**
 * Decision table for a single separator followed by exactly 3 digits (docs/ALGORITHM.md §4).
 * [input, currency, ctx decimal, expected]
 */
const DECISION = [
  ['1.234', 'VND', null, 1234], //   0-decimal currency → always a thousands group
  ['1.234', 'JPY', '.', 1234],
  ['1,234', 'KRW', ',', 1234],
  ['1.234', 'EUR', ',', 1234], //    the page's decimal mark is the other char → group
  ['1,234', 'USD', '.', 1234],
  ['1.234', 'USD', '.', 1.234], //   the page says '.' is the decimal mark → decimal
  ['1,234', 'EUR', ',', 1.234],
  ['1.234', 'EUR', null, 1234], //   unknown page → group (3 fraction digits are rare for 2-decimal currencies)
  ['1,234', 'USD', null, 1234],
  ['1.234', 'KWD', null, 1.234], //  3-decimal currency → decimal
  ['1,234', 'KWD', '.', 1234],
  ['1.23', 'VND', null, 1.23], //    1–2 digits → always decimal
  ['1,5', 'USD', '.', 1.5],
  ['1.234,5', 'USD', '.', 1234.5], // both marks → the last one is the decimal mark
  ['1,234.5', 'EUR', ',', 1234.5],
];

for (const [input, currency, decimal, expected] of DECISION) {
  test(`separator rule ${input} [${currency}, decimal ${decimal}] → ${expected}`, () => {
    assert.equal(P.parseNumber(input, { currency, decimal }), expected);
  });
}

/** [input, ctx, expected {amount, currency, raw?} | null] */
const WHOLE = [
  [' ¥ 43.65 ', 'taobao', { amount: 43.65, currency: 'CNY', raw: '¥ 43.65', start: 1, end: 8 }],
  ['￥43.65', 'taobao', { amount: 43.65, currency: 'CNY', raw: '￥43.65', token: '￥' }],
  ['¥\n   43\n   .65', 'taobao', { amount: 43.65, currency: 'CNY' }], // <span>¥</span> <span>43</span> <span>.65</span>
  ['$12.99', 'none', { amount: 12.99, currency: 'USD' }],
  ['43.65元', 'none', { amount: 43.65, currency: 'CNY' }],
  ['1\u00A0234,56\u00A0€', 'none', { amount: 1234.56, currency: 'EUR' }],
  ['¥10-20', 'taobao', { amount: 10, amountMax: 20, currency: 'CNY' }],
  ['189', 'taobao', null], //             no token
  ['¥', 'taobao', null], //               no number
  ['¥189 起', 'taobao', null], //          extra text
  ['券后 ¥43.65', 'taobao', null],
  ['¥189 ¥43.65', 'taobao', null], //      two prices
  ['', 'none', null],
];

for (const [input, ctx, expected] of WHOLE) {
  test(`parsePrice ${JSON.stringify(input)} → ${expected ? expected.amount : null}`, () => {
    const m = P.parsePrice(input, CTX[ctx]);
    if (expected === null) return assert.equal(m, null);
    assert.ok(m, 'expected a match');
    for (const [k, v] of Object.entries(expected)) assert.equal(m[k], v, k);
    assert.equal(input.slice(m.start, m.end), m.raw);
    assert.equal(m.raw, input.trim());
  });
}
