/**
 * Unit tests for the content script's PURE helpers (extension/src/content/scanner.js → NS.util,
 * render.js → NS.renderUtil). Content scripts are classic scripts sharing `globalThis.__transprice`, so they are
 * evaluated in a fresh vm context (no DOM — nothing in them touches the DOM at load time) and read back.
 * currency-data.js + parser.js are loaded too, so fragment classification and run grouping are also checked
 * against the real token list and parser.
 *
 *   node --test tests/content/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'extension/src');
const FILES = ['shared/currency-data.js', 'content/parser.js', 'content/scanner.js', 'content/render.js'];

function load(files = FILES) {
  const ctx = vm.createContext({ console, URL, Intl, setTimeout, clearTimeout });
  for (const f of files) vm.runInContext(readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

const ctx = load();
const NS = ctx.__transprice;
const U = NS.util;
const R = NS.renderUtil;
const P = ctx.TransPriceParser;
const CUR = ctx.TransPriceCurrencies;
/** Objects created inside the vm context have a foreign prototype → compare as plain data. */
const plain = (x) => JSON.parse(JSON.stringify(x));
const strip = U.makeTokenStripper(CUR.TOKENS.map((t) => t.token));
const frag = (t) => U.isFragment(t, strip);
const pageCtx = P.resolveContext({ hostname: 'localhost', lang: 'en', sampleText: '淘宝', settings: { defaultYen: 'CNY', defaultDollar: 'USD' } });

/** The scanner's fragment-run pipeline on plain arrays: groupRun → windows → parsePrice. */
function runPrice(texts, k, opts = {}) {
  const run = U.groupRun(texts, k, { isFragment: frag, ...opts });
  if (!run) return null;
  for (const [a, b] of U.runWindows(texts, run[0], run[1], k)) {
    const m = P.parsePrice(U.joinRun(texts, a, b, opts.sup), pageCtx);
    if (m) return { run: plain(run), window: [a, b], amount: m.amount, currency: m.currency };
  }
  return { run: plain(run), window: null };
}

test('constants mirror src/shared/constants.js', async () => {
  const C = await import(path.join(SRC, 'shared/constants.js'));
  for (const [k, v] of Object.entries(NS.C.MSG)) assert.equal(v, C.MSG[k], `MSG.${k}`);
  for (const [k, v] of Object.entries(NS.C.LIMITS)) assert.equal(v, C.LIMITS[k], `LIMITS.${k}`);
  for (const [k, v] of Object.entries(NS.C.DEFAULT_SETTINGS)) assert.deepEqual(plain(v), plain(C.DEFAULT_SETTINGS[k]), `DEFAULT_SETTINGS.${k}`);
});

test('double injection: a loaded instance is never replaced', () => {
  const c = load();
  const util = c.__transprice.util;
  c.__transprice.loaded = true;
  vm.runInContext(readFileSync(path.join(SRC, 'content/scanner.js'), 'utf8'), c);
  vm.runInContext(readFileSync(path.join(SRC, 'content/render.js'), 'utf8'), c);
  assert.equal(c.__transprice.util, util);
});

test('tag classification: blocks, rejected subtrees, screen-reader-only copies', () => {
  for (const t of ['p', 'li', 'TD', 'tr', 'h3', 'br', 'section', 'ul', 'table']) assert.equal(U.isBlockTag(t), true, t);
  for (const t of ['span', 'div', 'b', 'em', 'i', 'strong', 'sup', 'a', 'img']) assert.equal(U.isBlockTag(t), false, t);
  for (const t of ['script', 'style', 'textarea', 'input', 'select', 'option', 'code', 'pre', 'kbd', 'samp', 'svg', 'math', 'iframe', 'canvas', 'noscript', 'template', 'transprice-badge']) {
    assert.equal(U.isRejectedTag(t), true, t);
  }
  assert.equal(U.isRejectedTag('span'), false);
  assert.equal(U.isSrOnlyClass('a-offscreen'), true);
  assert.equal(U.isSrOnlyClass('foo sr-only bar'), true);
  assert.equal(U.isSrOnlyClass('visually-hidden'), true);
  assert.equal(U.isSrOnlyClass('a-price-whole'), false);
  assert.equal(U.isSrOnlyClass('sr-only-ish'), false);
  assert.equal(U.isSrOnlyClass(null), false);
  assert.match(U.REJECT_SELECTOR, /\.a-offscreen/);
  assert.match(U.REJECT_SELECTOR, /\[contenteditable\]:not\(\[contenteditable="false"\]\)/);
});

test('isFragment: digits, separators, tokens, multipliers or whitespace only', () => {
  for (const t of ['¥', '￥', '43', '.65', '.', ',99', '1,299', "1'234", '1 234', '1 234', '1 234', 'USD', 'US$', '元', '€', '₫', '12,99 €', '¥43.65', '1.5万', '万', '1.5k', '2M', '   ', '\n\t', '']) {
    assert.equal(frag(t), true, JSON.stringify(t));
  }
  for (const t of ['5 people bought', '5人付款', 'Same style', 'Free shipping', '7 off for every 6', '10 off over 198', 'Guangdong', '广东', 'KM', 'k', '¥189 only', 'USDT', '43-65', 'x']) {
    assert.equal(frag(t), false, JSON.stringify(t));
  }
  // Fallback stripper (no token list available) still knows the common symbols.
  assert.equal(U.isFragment('¥'), true);
  assert.equal(U.isFragment('5 people bought'), false);
});

test('groupRun: Taobao wrapper with sales + province inside — run is ¥ 43 .65 only', () => {
  const texts = ['Birthday Gift for Best Friend', '7 off for every 6', '¥', '43', '.65', '5人付款', '广东'];
  assert.deepEqual(plain(U.groupRun(texts, 2, { isFragment: frag })), [2, 4]);
  const english = ['¥', '43', '.65', '5 people bought', 'Zhejiang'];
  assert.deepEqual(plain(U.groupRun(english, 0, { isFragment: frag })), [0, 2]);
  assert.deepEqual(runPrice(texts, 2), { run: [2, 4], window: [2, 4], amount: 43.65, currency: 'CNY' });
});

test('groupRun: digit→digit across a node boundary is never one number ("¥43.65" + "5" ≠ 43.655)', () => {
  const texts = ['¥', '10', '.3', '5', ' people bought'];
  assert.deepEqual(plain(U.groupRun(texts, 0, { isFragment: frag })), [0, 2]);
  assert.equal(runPrice(texts, 0).amount, 10.3);
  // whitespace between the digits does not glue them either
  assert.deepEqual(plain(U.groupRun(['¥', '43', ' ', '5'], 0, { isFragment: frag })), [0, 1]);
  // price + quantity badge
  assert.deepEqual(plain(U.groupRun(['¥189', '12'], 0, { isFragment: frag })), [0, 0]);
});

test('groupRun: number-first, Amazon, sup cents, whitespace', () => {
  assert.deepEqual(plain(U.groupRun(['43.65', '元'], 1, { isFragment: frag })), [0, 1]);
  assert.deepEqual(runPrice(['43.65', '元'], 1), { run: [0, 1], window: [0, 1], amount: 43.65, currency: 'CNY' });
  const amazon = ['$', '1,299', '.', '99'];
  assert.deepEqual(plain(U.groupRun(amazon, 0, { isFragment: frag })), [0, 3]);
  assert.equal(runPrice(amazon, 0).amount, 1299.99);
  // Walmart-style $12<sup>99</sup>: only a <sup> lets digits follow digits
  assert.deepEqual(plain(U.groupRun(['$', '12', '99'], 0, { isFragment: frag })), [0, 1]);
  const sup = [false, false, true];
  assert.deepEqual(plain(U.groupRun(['$', '12', '99'], 0, { isFragment: frag, sup })), [0, 2]);
  assert.equal(runPrice(['$', '12', '99'], 0, { sup }).amount, 12.99);
  // whitespace-only items are transparent and trimmed off both ends
  assert.deepEqual(plain(U.groupRun([' ', '¥', ' ', '43', '\n  '], 1, { isFragment: frag })), [1, 3]);
});

test('groupRun: hard boundaries, consumed nodes, length cap, bad token node', () => {
  // breaks[x] = boundary before item x (block element between the nodes)
  assert.deepEqual(plain(U.groupRun(['¥', '43', '.65'], 0, { isFragment: frag, breaks: [false, true, false] })), [0, 0]);
  assert.deepEqual(plain(U.groupRun(['43', '¥', '.65'], 1, { isFragment: frag, breaks: [false, true, false] })), [1, 2]);
  // used[x] = already part of a converted price
  assert.deepEqual(plain(U.groupRun(['¥', '43.65', ' ', '¥', '59'], 3, { isFragment: frag, used: [true, true, false, false, false] })), [3, 4]);
  assert.equal(U.groupRun(['¥'], 0, { isFragment: frag, used: [true] }), null);
  // CLUSTER_MAX_CHARS on trimmed text
  assert.deepEqual(plain(U.groupRun(['¥', '1234567890', '1234567890'.replace(/^/, '.')], 0, { isFragment: frag, maxChars: 12 })), [0, 1]);
  assert.equal(U.groupRun(['¥189 only'], 0, { isFragment: frag }), null);
  assert.equal(U.groupRun([], 0, { isFragment: frag }), null);
  assert.equal(U.groupRun(['¥'], 3, { isFragment: frag }), null);
});

test('runWindows: full run first, then smaller windows that keep the token node', () => {
  const texts = ['¥', '43', '.65', ' ', '¥59'];
  const w = plain(U.runWindows(texts, 0, 4, 0));
  assert.deepEqual(w[0], [0, 4]);
  assert.deepEqual(w[1], [0, 2]);
  assert.ok(w.every(([a, b]) => a <= 0 && b >= 0));
  assert.ok(!w.some(([, b]) => b === 3), 'never ends on whitespace');
  // price + old price in one run: the window parser picks ¥43.65
  assert.deepEqual(runPrice(texts, 0), { run: [0, 4], window: [0, 2], amount: 43.65, currency: 'CNY' });
  // ties prefer token-first: a stray count before the symbol never wins ('5¥' would parse as suffix yen)
  assert.deepEqual(plain(U.runWindows(['5', '¥', '43'], 0, 2, 1)), [[0, 2], [1, 2], [0, 1], [1, 1]]);
  assert.deepEqual(runPrice(['5', '¥', '43'], 1), { run: [0, 2], window: [1, 2], amount: 43, currency: 'CNY' });
  assert.deepEqual(runPrice(['43.65', '元', '5'], 1), { run: [0, 2], window: [0, 1], amount: 43.65, currency: 'CNY' });
});

test('joinRun: trims pieces, drops blanks, restores <sup> cents', () => {
  assert.equal(U.joinRun([' ¥', '43 ', '.65'], 0, 2), '¥43.65');
  assert.equal(U.joinRun(['¥', '\n ', '43'], 0, 2), '¥43');
  assert.equal(U.joinRun(['$', '12', '99'], 0, 2, [false, false, true]), '$12.99');
  assert.equal(U.joinRun(['$', '12.5', '99'], 0, 2, [false, false, true]), '$12.599'); // already has a decimal part
  assert.equal(U.joinRun(['a', '¥', '1'], 1, 2), '¥1');
});

test('coversWhole: one match spanning the trimmed text', () => {
  assert.equal(U.coversWhole('  ¥189 ', { start: 2, end: 6 }), true);
  assert.equal(U.coversWhole('Only ¥189', { start: 5, end: 9 }), false);
  assert.equal(U.coversWhole('¥189 today', { start: 0, end: 4 }), false);
  assert.equal(U.coversWhole('¥189', null), false);
});

test('hostnames: normalize + exact/subdomain matching (same rule as storage.js)', () => {
  assert.equal(U.normalizeHost('WWW.Taobao.com'), 'taobao.com');
  assert.equal(U.normalizeHost('world.taobao.com.'), 'world.taobao.com');
  assert.equal(U.isSiteMatch('world.taobao.com', ['taobao.com']), true);
  assert.equal(U.isSiteMatch('www.taobao.com', ['taobao.com']), true);
  assert.equal(U.isSiteMatch('taobao.com', ['www.taobao.com']), true);
  assert.equal(U.isSiteMatch('nottaobao.com', ['taobao.com']), false);
  assert.equal(U.isSiteMatch('taobao.com', []), false);
  assert.equal(U.isSiteMatch('', ['taobao.com']), false);
  assert.equal(U.isSiteMatch('taobao.com', null), false);
});

test('createThrottle: leading call, one trailing call with the latest args, ≤ 1 per window', () => {
  let t = 1000;
  const timers = [];
  const fake = {
    now: () => t,
    setTimeout: (fn, ms) => (timers.push({ fn, at: t + ms }), timers.length),
    clearTimeout: () => {},
  };
  const calls = [];
  const th = U.createThrottle((n) => calls.push([t, n]), 500, fake);
  th(1);
  assert.deepEqual(calls, [[1000, 1]]);
  t = 1100;
  th(2);
  t = 1200;
  th(3);
  assert.equal(calls.length, 1, 'coalesced');
  assert.equal(timers.length, 1);
  t = timers[0].at;
  timers[0].fn();
  assert.deepEqual(calls[1], [1500, 3], 'trailing call carries the latest value');
  t = 2100;
  th(4);
  assert.deepEqual(calls[2], [2100, 4], 'window elapsed → immediate');
  th(5);
  th.cancel();
  assert.equal(calls.length, 3);
});

test('pruneRoots: drops roots inside another root of the batch', () => {
  const parent = new Map([['text', 'span'], ['span', 'card'], ['card', 'grid'], ['grid', 'body'], ['other', 'body']]);
  const out = U.pruneRoots(['text', 'card', 'span', 'other'], (n) => parent.get(n) || null);
  assert.deepEqual(plain(out).sort(), ['card', 'other']);
  assert.deepEqual(plain(U.pruneRoots(['a', 'a'], () => null)), ['a']);
});

test('aggregatePageInfo: counts, currencies and ambiguity (incl. home-currency skips)', () => {
  const pc = { yen: 'CNY', dollar: 'USD', reasons: { yen: 'domain', dollar: 'default', decimal: 'lang' } };
  const converted = [
    { currency: 'CNY', token: '¥', ambiguous: true },
    { currency: 'CNY', token: '￥', ambiguous: true },
    { currency: 'CNY', token: '¥', ambiguous: true },
    { currency: 'CNY', token: '元', ambiguous: false },
    { currency: 'EUR', token: '€', ambiguous: false },
  ];
  const skipped = [{ currency: 'USD', token: '$', ambiguous: true }];
  const info = plain(U.aggregatePageInfo(converted, skipped, pc));
  assert.equal(info.count, 5);
  assert.deepEqual(info.currencies, { CNY: 4, EUR: 1 });
  assert.deepEqual(info.ambiguous, [
    { symbol: 'yen', token: '¥', currency: 'CNY', reason: 'domain', count: 3 },
    { symbol: 'dollar', token: '$', currency: 'USD', reason: 'default', count: 1 },
  ]);
  assert.deepEqual(plain(U.aggregatePageInfo([], [], null)), { count: 0, currencies: {}, ambiguous: [] });
  assert.equal(U.symbolOf('＄'), 'dollar');
  assert.equal(U.symbolOf('€'), null);
});

test('renderUtil.joinRange shares the trailing currency part', () => {
  assert.equal(R.joinRange('38.650 ₫', '77.300 ₫'), '38.650 – 77.300 ₫');
  assert.equal(R.joinRange('38.650 ₫', '77.300 ₫'), '38.650 – 77.300 ₫');
  assert.equal(R.joinRange('$1.20', '$3.40'), '$1.20 – $3.40');
  assert.equal(R.joinRange('1,2 Tr ₫', '3,4 Tr ₫'), '1,2 – 3,4 Tr ₫');
  assert.equal(R.joinRange('10', '20'), '10 – 20');
  // with the real formatter
  const a = P.formatMoney(38650, 'VND', { locale: 'vi-VN' });
  const b = P.formatMoney(77300, 'VND', { locale: 'vi-VN' });
  assert.match(R.joinRange(a, b), /^38\.650 – 77\.300\s₫$/);
});

test('renderUtil.rewriteText replaces each match in place (inline replace mode)', () => {
  const text = 'Only $5 today, was $12';
  const matches = P.findPrices(text, pageCtx);
  assert.equal(matches.length, 2);
  assert.equal(R.rewriteText(text, matches, ['131.500 ₫', '315.600 ₫']), 'Only 131.500 ₫ today, was 315.600 ₫');
  // order of the match list does not matter
  assert.equal(R.rewriteText('a X b Y c', [{ start: 6, end: 7 }, { start: 2, end: 3 }], ['2', '1']), 'a 1 b 2 c');
  assert.equal(R.rewriteText('abc', [], []), 'abc');
});

test('renderUtil.edges / badgeText / titleText', () => {
  assert.deepEqual(plain(R.edges('  ¥189 \n')), { lead: '  ', trail: ' \n' });
  assert.deepEqual(plain(R.edges('¥189')), { lead: '', trail: '' });
  assert.deepEqual(plain(R.edges('   ')), { lead: '   ', trail: '' });
  assert.equal(R.badgeText('element', 'replace', ['730.373 ₫']), '730.373 ₫');
  assert.equal(R.badgeText('element', 'append', ['730.373 ₫']), '≈ 730.373 ₫');
  assert.equal(R.badgeText('element', 'replace', ['38.650 – 77.300 ₫']), '38.650 – 77.300 ₫');
  assert.equal(R.badgeText('inline', 'append', ['131.500 ₫', '315.600 ₫']), '≈ 131.500 ₫ · 315.600 ₫');
  assert.equal(
    R.titleText([{ raw: ' ¥189', text: '730.373 ₫' }], ['1 CNY = 3.865 ₫'], '2026-11-22'),
    '¥189 → 730.373 ₫ · 1 CNY = 3.865 ₫ · 2026-11-22',
  );
  assert.equal(R.titleText([{ raw: '$5', text: 'a' }, { raw: '$12', text: 'b' }], [], ''), '$5 → a · $12 → b');
});

test('pageValue: the page\'s own value of a text node we may have rewritten', () => {
  assert.equal(U.pageValue('', { original: '¥105', written: '' }), '¥105', 'still our write → remembered original');
  assert.equal(U.pageValue('¥106', { original: '¥105', written: '' }), '¥106', 'page rewrote it → the new value');
  assert.equal(U.pageValue('¥189', undefined), '¥189', 'never written');
  assert.equal(U.pageValue('Only 1 ₫ today', { original: 'Only $5 today', written: 'Only 1 ₫ today' }), 'Only $5 today');
});

test('touchAction: synchronous fast-path decision for a converted record the page touched', () => {
  const base = { partsConnected: true, badgeConnected: true, pageChanged: true };
  // React text instance update: textNode.nodeValue = '¥106' → same nodes, new text → update in place
  assert.equal(U.touchAction(base), 'refresh');
  // echo of our own write / identical re-render → nothing to do (no feedback loop)
  assert.equal(U.touchAction({ ...base, pageChanged: false }), 'none');
  // element.textContent = '…' replaced the text node (and removed our badge) → convert the container again
  assert.equal(U.touchAction({ ...base, partsConnected: false }), 'redetect');
  assert.equal(U.touchAction({ ...base, badgeConnected: false }), 'redetect');
  assert.equal(U.touchAction({ ...base, dead: true }), 'none');
  assert.equal(U.touchAction(null), 'none');
});

test('planParts: first render and in-place refresh of an element record', () => {
  // first render, replace mode: text emptied (leading whitespace kept, trailing moves into the badge)
  assert.deepEqual(plain(R.planParts([{ isText: true, current: ' ¥105 ' }], 'replace')), {
    texts: [{ original: ' ¥105 ', written: ' ' }], trailSpace: true, gap0: false,
  });
  // refresh after the page wrote '¥106' into the emptied node: new original, emptied again
  assert.deepEqual(plain(R.planParts([{ isText: true, current: '¥106', entry: { original: '¥105', written: '' } }], 'replace')), {
    texts: [{ original: '¥106', written: '' }], trailSpace: false, gap0: false,
  });
  // refresh where our write is untouched: original kept, nothing new to write
  assert.deepEqual(plain(R.planParts([{ isText: true, current: '', entry: { original: '¥105', written: '' } }], 'replace')).texts, [
    { original: '¥105', written: '' },
  ]);
  // split price: elements are hidden (null), bare text pieces emptied; middle pieces lose their whitespace
  const split = plain(R.planParts([{ isText: true, current: '$' }, { isText: false }, { isText: true, current: ' ' }, { isText: false }], 'replace'));
  assert.deepEqual(split.texts, [{ original: '$', written: '' }, null, { original: ' ', written: '' }, null]);
  // append mode writes nothing; trailing whitespace → no margin + trailing space in the badge
  assert.deepEqual(plain(R.planParts([{ isText: true, current: '¥189 ' }], 'append')), {
    texts: [{ original: '¥189 ', written: '¥189 ' }], trailSpace: true, gap0: true,
  });
});
