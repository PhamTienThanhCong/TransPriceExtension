/**
 * findPrices() — table-driven: every row is one test. Row = [input, context, expected matches], where a match is
 * [raw, amount, currency, ambiguous = false, amountMax?]. Every match is also checked for offsets into the ORIGINAL
 * string (text.slice(start, end) === raw), including inputs with NBSP / narrow NBSP / fullwidth characters.
 *
 *   node --test tests/engine/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, CTX } from './helpers.mjs';

const AMB = true; // currency came from the context (bare $ / ¥ / kr)

/** @type {Array<[string, string, Array<[string, number, string, boolean?, number?]>]>} */
const POSITIVE = [
  // ── the Taobao screenshot (taobao.com → ¥ = CNY) ──
  ['¥189', 'taobao', [['¥189', 189, 'CNY', AMB]]],
  ['¥43.65', 'taobao', [['¥43.65', 43.65, 'CNY', AMB]]],
  ['¥126', 'taobao', [['¥126', 126, 'CNY', AMB]]],
  ['¥109', 'taobao', [['¥109', 109, 'CNY', AMB]]],
  ['¥140', 'taobao', [['¥140', 140, 'CNY', AMB]]],
  ['¥3.6', 'taobao', [['¥3.6', 3.6, 'CNY', AMB]]],
  ['¥157', 'taobao', [['¥157', 157, 'CNY', AMB]]],
  ['¥10.3', 'taobao', [['¥10.3', 10.3, 'CNY', AMB]]],
  ['¥16.8', 'taobao', [['¥16.8', 16.8, 'CNY', AMB]]],
  ['¥296', 'taobao', [['¥296', 296, 'CNY', AMB]]],
  ['¥181.3', 'taobao', [['¥181.3', 181.3, 'CNY', AMB]]],
  ['¥6.15', 'taobao', [['¥6.15', 6.15, 'CNY', AMB]]],
  ['Taobao card: 夏季连衣裙 ¥43.65 10 off over 198 · 5 people bought', 'taobao', [['¥43.65', 43.65, 'CNY', AMB]]],
  ['¥189 100人付款 · 2027', 'taobao', [['¥189', 189, 'CNY', AMB]]],
  ['价格¥189起', 'taobao', [['¥189', 189, 'CNY', AMB]]],
  ['¥ 43.65', 'taobao', [['¥ 43.65', 43.65, 'CNY', AMB]]],
  ['￥43.65', 'taobao', [['￥43.65', 43.65, 'CNY', AMB]]],
  ['お値段：￥１，２８０（税込）', 'jp', [['￥１，２８０', 1280, 'JPY', AMB]]],
  // ── dollars ──
  ['$1,299.99', 'none', [['$1,299.99', 1299.99, 'USD', AMB]]],
  ['US$5', 'none', [['US$5', 5, 'USD']]],
  ['US $12.34', 'none', [['US $12.34', 12.34, 'USD']]],
  ['HK$12', 'none', [['HK$12', 12, 'HKD']]],
  ['NT$1,290', 'none', [['NT$1,290', 1290, 'TWD']]],
  ['S$5 · C$10 · A$10 · NZ$7 · MX$100', 'none', [['S$5', 5, 'SGD'], ['C$10', 10, 'CAD'], ['A$10', 10, 'AUD'], ['NZ$7', 7, 'NZD'], ['MX$100', 100, 'MXN']]],
  ['$24.99', 'ca', [['$24.99', 24.99, 'CAD', AMB]]],
  ['＄12', 'none', [['＄12', 12, 'USD', AMB]]],
  ['$5 USD', 'ca', [['$5 USD', 5, 'USD']]],
  ['CAD $12.99', 'none', [['CAD $12.99', 12.99, 'CAD']]],
  ['USD$5', 'none', [['USD$5', 5, 'USD']]],
  ['-$5 refund', 'none', [['$5', 5, 'USD', AMB]]],
  ['Total $0.99', 'none', [['$0.99', 0.99, 'USD', AMB]]],
  ['Pay $5,000.', 'none', [['$5,000', 5000, 'USD', AMB]]],
  ['Save 5% on $20', 'none', [['$20', 20, 'USD', AMB]]],
  ['iPhone 15 Pro $999', 'none', [['$999', 999, 'USD', AMB]]],
  ['CVE-2024-1234 fixed in v1.2.3 — $5', 'none', [['$5', 5, 'USD', AMB]]],
  // ── yen / yuan ──
  ['¥12,800', 'jp', [['¥12,800', 12800, 'JPY', AMB]]],
  ['¥12,800', 'taobao', [['¥12,800', 12800, 'CNY', AMB]]],
  ['189元', 'none', [['189元', 189, 'CNY']]],
  ['1.5万円', 'none', [['1.5万円', 15000, 'JPY']]],
  ['1,980円(税込)', 'none', [['1,980円', 1980, 'JPY']]],
  ['１２３円', 'none', [['１２３円', 123, 'JPY']]],
  ['1000日元', 'none', [['1000日元', 1000, 'JPY']]],
  ['人民币1.5万元', 'none', [['人民币1.5万元', 15000, 'CNY']]],
  ['¥189元', 'jp', [['¥189元', 189, 'CNY']]],
  ['¥1.5万', 'taobao', [['¥1.5万', 15000, 'CNY', AMB]]],
  ['CN¥189 · JP¥1000 · RMB 189', 'none', [['CN¥189', 189, 'CNY'], ['JP¥1000', 1000, 'JPY'], ['RMB 189', 189, 'CNY']]],
  // ── euro & Europe ──
  ['12,99 €', 'none', [['12,99 €', 12.99, 'EUR']]],
  ['1.234,56 €', 'none', [['1.234,56 €', 1234.56, 'EUR']]],
  ['1\u00A0234,56\u202F€', 'none', [['1\u00A0234,56\u202F€', 1234.56, 'EUR']]],
  ['Preis: 1\u202F234,56 € inkl. MwSt.', 'de', [['1\u202F234,56 €', 1234.56, 'EUR']]],
  ['€\u202F1\u202F234', 'none', [['€\u202F1\u202F234', 1234, 'EUR']]],
  ['€10.000,00', 'de', [['€10.000,00', 10000, 'EUR']]],
  ['12,99 € 5,99 €', 'none', [['12,99 €', 12.99, 'EUR'], ['5,99 €', 5.99, 'EUR']]],
  ['€ 12,99 € 5,99', 'none', [['€ 12,99', 12.99, 'EUR'], ['€ 5,99', 5.99, 'EUR']]],
  ['99k€', 'none', [['99k€', 99000, 'EUR']]],
  ['£1,000.50 or £5m', 'none', [['£1,000.50', 1000.5, 'GBP'], ['£5m', 5e6, 'GBP']]],
  ['CHF 12.50', 'none', [['CHF 12.50', 12.5, 'CHF']]],
  ["CHF 1'234.50", 'none', [["CHF 1'234.50", 1234.5, 'CHF']]],
  ['99 kr', 'none', [['99 kr', 99, 'SEK', AMB]]],
  ['99 kr.', 'none', [['99 kr', 99, 'SEK', AMB]]],
  ['kr 1 299,-', 'no', [['kr 1 299,-', 1299, 'NOK', AMB]]],
  ['1.299,- kr · Fr. 12.–', 'no', [['1.299,- kr', 1299, 'NOK', AMB], ['Fr. 12.–', 12, 'CHF']]],
  ['25 zł · 199 Kč · 1 990 Ft · 49,90 lei', 'none', [['25 zł', 25, 'PLN'], ['199 Kč', 199, 'CZK'], ['1 990 Ft', 1990, 'HUF'], ['49,90 lei', 49.9, 'RON']]],
  ['1 299 ₽ · 100 руб.', 'none', [['1 299 ₽', 1299, 'RUB'], ['100 руб.', 100, 'RUB']]],
  ['₺99,90 · 99,90 TL · ₴200', 'none', [['₺99,90', 99.9, 'TRY'], ['99,90 TL', 99.9, 'TRY'], ['₴200', 200, 'UAH']]],
  // ── Vietnamese đồng ──
  ['50.000đ', 'none', [['50.000đ', 50000, 'VND']]],
  ['50.000 ₫', 'none', [['50.000 ₫', 50000, 'VND']]],
  ['1,2 triệu đ', 'none', [['1,2 triệu đ', 1200000, 'VND']]],
  ['Tổng: 1.290.000đ (đã gồm VAT) - giảm 10%', 'vn', [['1.290.000đ', 1290000, 'VND']]],
  ['chỉ 99.000 VNĐ', 'none', [['99.000 VNĐ', 99000, 'VND']]],
  ['Mua 2 tặng 1 chỉ 99k₫', 'none', [['99k₫', 99000, 'VND']]],
  ['5 tỷ đồng', 'none', [['5 tỷ đồng', 5e9, 'VND']]],
  ['VND 1,000,000', 'none', [['VND 1,000,000', 1e6, 'VND']]],
  // ── Asia / others ──
  ['Rp 15.000', 'none', [['Rp 15.000', 15000, 'IDR']]],
  ['₹12,34,567.89', 'none', [['₹12,34,567.89', 1234567.89, 'INR']]],
  ['Rs. 500 · ₹5 lakh', 'none', [['Rs. 500', 500, 'INR'], ['₹5 lakh', 500000, 'INR']]],
  ['R$ 1.234,56', 'none', [['R$ 1.234,56', 1234.56, 'BRL']]],
  ['₩12,000 · 12,000원 · 1만원', 'none', [['₩12,000', 12000, 'KRW'], ['12,000원', 12000, 'KRW'], ['1만원', 10000, 'KRW']]],
  ['฿100 · ₱1,299 · RM12.90 · ₪50 · ₦5,000', 'none', [['฿100', 100, 'THB'], ['₱1,299', 1299, 'PHP'], ['RM12.90', 12.9, 'MYR'], ['₪50', 50, 'ILS'], ['₦5,000', 5000, 'NGN']]],
  ['AED 100 · 100 د.إ · SAR 50 · S/ 25.90', 'none', [['AED 100', 100, 'AED'], ['100 د.إ', 100, 'AED'], ['SAR 50', 50, 'SAR'], ['S/ 25.90', 25.9, 'PEN']]],
  // ── ISO codes ──
  ['USD 12.99', 'none', [['USD 12.99', 12.99, 'USD']]],
  ['12.99 USD', 'none', [['12.99 USD', 12.99, 'USD']]],
  ['Qty 2 USD 12.99', 'none', [['USD 12.99', 12.99, 'USD']]],
  ['12 USD 15 USD', 'none', [['12 USD', 12, 'USD'], ['15 USD', 15, 'USD']]],
  ['150 TRY', 'none', [['150 TRY', 150, 'TRY']]],
  // ── multipliers (only next to a token) ──
  ['$1.5 million', 'none', [['$1.5 million', 1.5e6, 'USD', AMB]]],
  ['$5k', 'none', [['$5k', 5000, 'USD', AMB]]],
  ['$5 months', 'none', [['$5', 5, 'USD', AMB]]],
  // ── ranges ──
  ['$10 - $20', 'none', [['$10 - $20', 10, 'USD', AMB, 20]]],
  ['¥10-20', 'taobao', [['¥10-20', 10, 'CNY', AMB, 20]]],
  ['10–20 €', 'none', [['10–20 €', 10, 'EUR', false, 20]]],
  ['10€ – 20€', 'none', [['10€ – 20€', 10, 'EUR', false, 20]]],
  ['¥1,000〜¥2,000', 'jp', [['¥1,000〜¥2,000', 1000, 'JPY', AMB, 2000]]],
  ['¥1-2万', 'taobao', [['¥1-2万', 10000, 'CNY', AMB, 20000]]],
  ['$10-$5', 'none', [['$10', 10, 'USD', AMB], ['$5', 5, 'USD', AMB]]],
  // ── whitespace inside one text node (HTML collapses it) ──
  ['¥\n      43.65', 'taobao', [['¥\n      43.65', 43.65, 'CNY', AMB]]],
];

/** Text that contains no price at all (or whose numbers/tokens must not pair up). */
const NEGATIVE = [
  ['10 off over 198', 'taobao'],
  ['7 off for every 6', 'taobao'],
  ['100 off 5', 'taobao'],
  ['5 people bought', 'taobao'],
  ['2027', 'taobao'],
  ['已售 5 · 月销 1000+', 'taobao'],
  ['USDT 5', 'none'], //               letter boundary after a code
  ['abc$5', 'none'], //                symbol glued to a word
  ['x$5', 'none'],
  ['${price}', 'none'], //             template syntax
  ['const total = `${a + b}`;', 'none'],
  ['v1.2.3', 'none'], //               version strings
  ['$1.2.3', 'none'],
  ['$1,2,3', 'none'],
  ['call 0912 345 678', 'none'], //    phone numbers
  ['$0912345678', 'none'],
  ['5:30 $', 'none'], //               time / date next to a token
  ['$12/25', 'none'],
  ['$5x', 'none'],
  ['$5km', 'none'],
  ['$.99', 'none'],
  ['TRY 7 DAYS FREE', 'none'], //       suffix-only code
  ['TOP 10', 'none'], //                blocked code (English word)
  ['the price in USD is shown below', 'none'], // token without number
  ['đi được 5 km', 'none'], //          'đ' inside Vietnamese words
  ['Giá 199k', 'none'], //              multiplier without a token
  ['50 Ft garden hose', 'none'], //     feet, not forint
  ['Skr 5 · Mrs 5', 'none'],
];

const fmt = (m) => {
  const out = [m.raw, m.amount, m.currency];
  if (m.ambiguous || m.amountMax !== undefined) out.push(m.ambiguous);
  if (m.amountMax !== undefined) out.push(m.amountMax);
  return out;
};

for (const [input, ctx, expected] of POSITIVE) {
  test(`findPrices ${JSON.stringify(input)} [${ctx}]`, () => {
    const got = P.findPrices(input, CTX[ctx]);
    assert.deepEqual(got.map(fmt), expected.map((e) => (e.length === 4 && !e[3] ? e.slice(0, 3) : e)));
    let prevEnd = 0;
    for (const m of got) {
      assert.equal(input.slice(m.start, m.end), m.raw, 'offsets point into the original string');
      assert.ok(m.start >= prevEnd, 'non-overlapping, left → right');
      assert.ok(m.raw.includes(m.token), 'token as written is inside raw');
      prevEnd = m.end;
    }
  });
}

for (const [input, ctx] of NEGATIVE) {
  test(`findPrices rejects ${JSON.stringify(input)}`, () => {
    assert.deepEqual(P.findPrices(input, CTX[ctx]), []);
  });
}

test('findPrices finds all twelve screenshot prices in one line, in order', () => {
  const line = '¥189 ¥43.65 ¥126 ¥109 ¥140 ¥3.6 ¥157 ¥10.3 ¥16.8 ¥296 ¥181.3 ¥6.15';
  const got = P.findPrices(line, CTX.taobao);
  assert.deepEqual(got.map((m) => m.amount), [189, 43.65, 126, 109, 140, 3.6, 157, 10.3, 16.8, 296, 181.3, 6.15]);
  assert.ok(got.every((m) => m.currency === 'CNY' && m.token === '¥' && m.ambiguous));
});

test('findPrices: Match shape and amountMax only on ranges', () => {
  const [m] = P.findPrices('Giá: ¥43.65', CTX.taobao);
  assert.deepEqual(m, { start: 5, end: 11, raw: '¥43.65', amount: 43.65, currency: 'CNY', token: '¥', ambiguous: true });
  assert.equal('amountMax' in m, false);
});

test('findPrices: bad input never throws', () => {
  for (const v of [undefined, null, 42, {}, '', '¥', '$$$', '¥'.repeat(1000), '9'.repeat(5000) + '元']) {
    assert.ok(Array.isArray(P.findPrices(v, CTX.none)));
  }
  assert.deepEqual(P.findPrices('$5'), P.findPrices('$5', CTX.none), 'ctx is optional');
});
