/**
 * Performance budgets (ARCHITECTURE §1.7: a 2 000-product page must stay smooth). Must hold on OLDER V8 too (Node 22 ≈
 * Chrome 124; the manifest allows Chrome ≥ 116): `npx -y node@22 --test tests/engine/perf.test.mjs`.
 * Laptop numbers (M-series, Node 22 and 24): findPrices 1 MB ≈ 35 ms, quickTest 100k ≈ 5 ms.
 * Limits are multiplied by PERF_SCALE (default 3 on CI, whose runners are ~2–2.5× slower, else 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, C, CTX } from './helpers.mjs';

const SCALE = Number(process.env.PERF_SCALE) || (process.env.CI ? 3 : 1);
const LIMIT = { findPrices: 120 * SCALE, quickTest: 50 * SCALE };

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

test(`findPrices over ~1 MB of mixed text < ${LIMIT.findPrices} ms`, (t) => {
  const text = CHUNK.repeat(Math.ceil(1_000_000 / CHUNK.length));
  const { ms, out } = timeIt(() => P.findPrices(text, CTX.taobao));
  const perChunk = P.findPrices(CHUNK, CTX.taobao).length;
  t.diagnostic(`findPrices: ${(text.length / 1e6).toFixed(2)} MB, ${out.length} matches in ${ms.toFixed(1)} ms (limit ${LIMIT.findPrices} ms, PERF_SCALE ${SCALE})`);
  assert.equal(out.length, perChunk * Math.ceil(1_000_000 / CHUNK.length));
  assert.ok(ms < LIMIT.findPrices, `${ms.toFixed(1)} ms ≥ ${LIMIT.findPrices} ms`);
});

test(`quickTest over 100k short strings < ${LIMIT.quickTest} ms`, (t) => {
  const samples = ['Add to cart', 'Free shipping', '5 people bought', '¥189', 'Lorem ipsum dolor sit amet', 'Sold 1.2k',
    'USD', '2027', '已售 5', 'Giá 50.000đ', 'menu', 'Product details and specifications', 'Người Việt đi được'];
  const strings = Array.from({ length: 100_000 }, (_, i) => samples[i % samples.length] + (i % 7 ? '' : ` ${i}`));
  const { ms, out } = timeIt(() => strings.filter((s) => P.quickTest(s)).length);
  t.diagnostic(`quickTest: 100k strings in ${ms.toFixed(1)} ms, ${out} candidates (limit ${LIMIT.quickTest} ms, PERF_SCALE ${SCALE})`);
  assert.ok(out > 0);
  assert.ok(ms < LIMIT.quickTest, `${ms.toFixed(1)} ms ≥ ${LIMIT.quickTest} ms`);
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

test('token trie ≡ the flat longest-first alternation it replaced (every window of the corpus)', () => {
  // Reference: the original regex — each token escaped, longest first, with the same letter boundaries.
  const WL = 'A-Za-z' + [[0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0x24f], [0x300, 0x4ff], [0x600, 0x6ff], [0x1e00, 0x1eff]]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('');
  const isWL = (ch) => new RegExp(`[${WL}]`).test(ch);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const flat = new RegExp(C.TOKENS.map((t) => t.token).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((t) => (isWL(t[0]) ? `(?<![${WL}])` : '') + esc(t) + (isWL(t[t.length - 1]) ? `(?![${WL}])` : '')).join('|'));
  const corpus = `${CHUNK} USDT 5 Skr kr. 99kr C$ ABC$5 US $5 BUS $5 VNĐ đi Đà 日元 元旦 CN¥ JP¥ Rs. Rp. S/. zł Kč`;
  let checked = 0;
  for (let i = 0; i < corpus.length; i++) {
    for (let len = 1; len <= 8 && i + len <= corpus.length; len++) {
      const w = corpus.slice(i, i + len);
      assert.equal(P.hasToken(w), flat.test(w), JSON.stringify(w));
      checked++;
    }
  }
  assert.ok(checked > 4000);
});
