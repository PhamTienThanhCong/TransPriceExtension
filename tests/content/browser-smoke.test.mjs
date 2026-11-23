/**
 * Browser smoke test for the content script: headless Chrome `--dump-dom` against the dev server's demo page
 * (dev/demo.html), in replace and append mode. AUTO-SKIPS when Chrome or the dev server is not available
 * (CI, no `npm run dev` running). Run it with:
 *
 *   npm run dev &   node --test tests/content/browser-smoke.test.mjs
 *
 * Env: CHROME_PATH (browser binary), TRANSPRICE_DEV_URL (default http://localhost:5180).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.TRANSPRICE_DEV_URL || 'http://localhost:5180';
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));

async function devServerUp() {
  try {
    const res = await fetch(`${BASE}/dev/demo.html`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes('content/content.js');
  } catch {
    return false;
  }
}

const skip = !CHROME ? 'Chrome not found (set CHROME_PATH)' : !(await devServerUp()) ? `dev server not running at ${BASE} (npm run dev)` : false;

/** Serialized DOM of the demo page after the content script ran (closed shadow roots are not serialized). */
async function dumpDom(query) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'transprice-smoke-'));
  try {
    return await new Promise((resolve, reject) => {
      execFile(
        CHROME,
        ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
          '--window-size=1400,2000', '--virtual-time-budget=8000', '--dump-dom', `${BASE}/dev/demo.html?${query}`],
        { timeout: 45000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))),
      );
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

/** The 12 product cards of the static grid (each card is an <a> up to the next card / end of grid). */
function gridCards(html) {
  const start = html.indexOf('id="sec-grid"');
  const end = html.indexOf('id="sec-formats"');
  const grid = html.slice(start, end);
  return grid.split(/<a class="(?:Card--doubleCardWrapper|item-card)"/).slice(1);
}

const count = (s, re) => (s.match(re) || []).length;
const between = (html, from, to) => {
  const a = html.indexOf(from);
  return a < 0 ? '' : html.slice(a, html.indexOf(to, a + from.length));
};

function commonChecks(html) {
  const cards = gridCards(html);
  assert.equal(cards.length, 12, '12 product cards');
  cards.forEach((c, i) => assert.equal(count(c, /<transprice-badge/g), 1, `card ${i + 1}: exactly one badge`));
  for (const promo of ['Selected for the new wine glass', '7 off for every 6', 'Free shipping', '10 off over 198', '100 off 5', 'Return treasure']) {
    assert.ok(html.includes(`<span class="promo">${promo}</span>`), `promo untouched: ${promo}`);
  }
  assert.ok(html.includes('<span class="Price--realSales">5 people bought</span>'), 'sales counter untouched');
  // home currency, editable, code, screen-reader copies: no badge
  assert.match(html, /<span class="vn">250\.000 ₫<\/span><\/div>/, 'VND price untouched, no badge');
  const editable = between(html, 'class="case__body editable"', 'case__expect');
  assert.equal(count(editable, /<transprice-badge/g), 0, 'nothing converted in textarea / contenteditable / code / pre');
  assert.ok(editable.includes('Draft note: the cup set is ¥189 (keep as typed)'));
  assert.ok(editable.includes('Editable: shipping costs $25 here'));
  assert.ok(editable.includes('const PRICE = "$19.99";'));
  assert.ok(editable.includes('Total: ¥500 (preformatted)'));
  assert.match(html, /<span class="a-offscreen">\$1,299\.99<\/span>/, 'a-offscreen copy untouched');
  const amazon = between(html, 'class="case__body amz"', 'case__expect');
  assert.equal(count(amazon, /<transprice-badge/g), 2, 'one badge per Amazon price (2 prices)');
  const tickers = between(html, 'class="tickers"', 'id="more-grid"');
  assert.equal(count(tickers, /<transprice-badge/g), 3, 'one badge per ticker');
}

test('demo page — replace mode: one badge per price, pieces hidden, nothing else touched', { skip, timeout: 60000 }, async () => {
  const html = await dumpDom('ticker=0&mode=replace');
  commonChecks(html);
  assert.ok(count(html, /data-transprice-hidden=""/g) >= 20, 'split price pieces hidden');
  assert.match(html, /<style data-transprice-ignore="">\[data-transprice-hidden\]\{display:none!important\}<\/style>/);
});

test('demo page — append mode: badges after prices, nothing hidden', { skip, timeout: 60000 }, async () => {
  const html = await dumpDom('ticker=0&mode=append');
  commonChecks(html);
  assert.equal(count(html, /data-transprice-hidden=""/g), 0, 'append mode hides nothing');
  assert.ok(html.includes('<span class="Price--unit">¥</span><span class="Price--priceInt">43</span><span class="Price--priceFloat">.65</span>'), 'original split price intact');
});
