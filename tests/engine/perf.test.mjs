/**
 * Performance budgets (ARCHITECTURE §1.7: a 2 000-product page must stay smooth). Generous limits so CI machines
 * don't flake; typical numbers on a laptop are ~10× lower (printed with the test name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, CTX } from './helpers.mjs';

const CHUNK =
  '夏季新款连衣裙 ¥189 已售 5 people bought · 10 off over 198 · 7 off for every 6. Version 1.2.3 released 2027-01-05, ' +
  'call 0912 345 678. The Kindle costs $1,299.99 or US$5 (HK$12). Preis: 12,99 € statt 1.234,56 €. 189元 包邮 1.5万円 ' +
  '¥12,800 50.000đ 1,2 triệu đ. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Giá chỉ 50.000 ₫, Rp 15.000, ₹12,34,567.89, R$ 1.234,56, CHF 12.50, ' +
  '99 kr, USD 12.99 and 12.99 USD; range $10 - $20, ¥10-20. Người Việt đi được đâu đó với 2 người bạn. ';

const timeIt = (fn) => {
  fn(); // warm-up (JIT, regex compilation)
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
};

test('findPrices over ~1 MB of mixed text < 300 ms', (t) => {
  const text = CHUNK.repeat(Math.ceil(1_000_000 / CHUNK.length));
  const { ms, out } = timeIt(() => P.findPrices(text, CTX.taobao));
  const perChunk = P.findPrices(CHUNK, CTX.taobao).length;
  t.diagnostic(`findPrices: ${(text.length / 1e6).toFixed(2)} MB, ${out.length} matches in ${ms.toFixed(1)} ms`);
  assert.equal(out.length, perChunk * Math.ceil(1_000_000 / CHUNK.length));
  assert.ok(ms < 300, `${ms.toFixed(1)} ms`);
});

test('quickTest over 100k short strings < 150 ms', (t) => {
  const samples = ['Add to cart', 'Free shipping', '5 people bought', '¥189', 'Lorem ipsum dolor sit amet', 'Sold 1.2k',
    'USD', '2027', '已售 5', 'Giá 50.000đ', 'menu', 'Product details and specifications', 'Người Việt đi được'];
  const strings = Array.from({ length: 100_000 }, (_, i) => samples[i % samples.length] + (i % 7 ? '' : ` ${i}`));
  const { ms, out } = timeIt(() => strings.filter((s) => P.quickTest(s)).length);
  t.diagnostic(`quickTest: 100k strings in ${ms.toFixed(1)} ms (${out} candidates)`);
  assert.ok(out > 0);
  assert.ok(ms < 150, `${ms.toFixed(1)} ms`);
});

test('quickTest / hasToken semantics', () => {
  assert.equal(P.quickTest('¥189'), true);
  assert.equal(P.quickTest('￥１８９'), true);
  assert.equal(P.quickTest('price 189'), false, 'digit but no token');
  assert.equal(P.quickTest('¥'), false, 'token but no digit');
  assert.equal(P.quickTest('USDT 5'), false, 'letter boundary');
  assert.equal(P.quickTest(undefined), false);
  assert.equal(P.hasToken('¥'), true);
  assert.equal(P.hasToken('元'), true);
  assert.equal(P.hasToken('hello'), false);
  assert.equal(P.hasToken(null), false);
});
