#!/usr/bin/env node
/**
 * TransPrice — render the PNG icons from the SVG sources with headless Chrome (no rsvg-convert / ImageMagick needed).
 *
 *   npm run icons                     (or: node scripts/render-icons.mjs)
 *   CHROME_PATH=/path/to/chrome npm run icons
 *   node scripts/render-icons.mjs --preview <dir>   # also write a light/dark preview sheet (preview.png) to <dir>
 *
 * Sources:
 *   extension/icons/logo.svg        master artwork (48, 128, 512)
 *   store-assets/src/icon-16.svg    simplified artwork for tiny sizes (16, 32): no ₫ glyph, thicker strokes
 * Outputs:
 *   extension/icons/icon{16,32,48,128}.png, store-assets/store-icon-128.png, store-assets/logo-512.png
 *
 * Chrome lookup: $CHROME_PATH → Google Chrome (macOS app / Linux PATH) → Chromium → the Playwright cache
 * (~/Library/Caches/ms-playwright or ~/.cache/ms-playwright). Each PNG is a `--screenshot` of a generated page whose
 * window is exactly N×N with a transparent background (`--default-background-color=00000000`).
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pngSize } from './lib/check-helpers.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGO = path.join(ROOT, 'extension/icons/logo.svg');
const SMALL = path.join(ROOT, 'store-assets/src/icon-16.svg');

/**
 * What to render. `pad` = transparent pixels on each side (Chrome Web Store guidance for the 128 icon: 96×96 artwork
 * centred in a 128×128 canvas).
 */
const TARGETS = [
  { src: SMALL, size: 16, pad: 0, out: 'extension/icons/icon16.png' },
  { src: SMALL, size: 32, pad: 1, out: 'extension/icons/icon32.png' },
  { src: LOGO, size: 48, pad: 2, out: 'extension/icons/icon48.png' },
  { src: LOGO, size: 128, pad: 16, out: 'extension/icons/icon128.png' },
  { src: LOGO, size: 512, pad: 0, out: 'store-assets/logo-512.png' },
];

/** Candidate Chrome binaries, most specific first. */
async function chromeCandidates() {
  const list = [];
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  list.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  );
  for (const cache of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    const dirs = (await readdir(cache)).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const sub of ['chrome-mac-arm64', 'chrome-mac', 'chrome-linux', 'chrome-linux64']) {
        list.push(
          path.join(cache, d, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
          path.join(cache, d, sub, 'Chromium.app/Contents/MacOS/Chromium'),
          path.join(cache, d, sub, 'chrome'),
        );
      }
    }
  }
  return list;
}

async function findChrome() {
  for (const p of await chromeCandidates()) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** HTML page showing `svg` at (size − 2·pad) px, centred on a transparent N×N canvas. */
function pageFor(svgText, size, pad) {
  const inner = size - pad * 2;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgText).toString('base64')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${size}px;height:${size}px}
img{display:block;position:absolute;left:${pad}px;top:${pad}px;width:${inner}px;height:${inner}px}
</style></head><body><img src="${dataUrl}" alt=""></body></html>`;
}

async function screenshot(chrome, htmlFile, outFile, width, height, profileDir) {
  await execFileP(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profileDir}`,
      `--screenshot=${outFile}`,
      `--window-size=${width},${height}`,
      '--default-background-color=00000000',
      pathToFileURL(htmlFile).href,
    ],
    { timeout: 60_000 },
  );
  const dim = pngSize(outFile);
  if (!dim || dim.w !== width || dim.h !== height) {
    throw new Error(`${path.relative(ROOT, outFile)}: expected ${width}×${height}, got ${dim ? `${dim.w}×${dim.h}` : 'no PNG'}`);
  }
}

/** Preview sheet: every icon at 1× on light and dark toolbars, plus 4× zoom of the tiny ones (pixelated). */
function previewPage() {
  const icons = ['icon16', 'icon32', 'icon48', 'icon128'];
  const row = (bg, fg) => `<div style="background:${bg};color:${fg};padding:16px;display:flex;gap:20px;align-items:center">
${icons.map((n) => `<img src="${pathToFileURL(path.join(ROOT, `extension/icons/${n}.png`)).href}">`).join('')}
<img src="${pathToFileURL(path.join(ROOT, 'extension/icons/icon16.png')).href}" style="width:64px;image-rendering:pixelated">
<img src="${pathToFileURL(path.join(ROOT, 'extension/icons/icon32.png')).href}" style="width:128px;image-rendering:pixelated">
<span style="font:600 14px system-ui">TransPrice</span></div>`;
  return `<!doctype html><html><body style="margin:0">${row('#ffffff', '#1c1917')}${row('#dee1e6', '#1c1917')}${row('#202124', '#f2efeb')}</body></html>`;
}

async function main() {
  const previewIdx = process.argv.indexOf('--preview');
  const previewDir = previewIdx > -1 ? path.resolve(process.argv[previewIdx + 1] || '.') : null;

  const chrome = await findChrome();
  if (!chrome) {
    console.error('✖ Chrome/Chromium not found. Set CHROME_PATH=/path/to/chrome (or install Google Chrome).');
    process.exit(1);
  }
  console.log(`• Chrome: ${chrome}`);
  for (const t of TARGETS) if (!existsSync(t.src)) throw new Error(`missing source ${path.relative(ROOT, t.src)}`);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'transprice-icons-'));
  try {
    const profile = path.join(tmp, 'profile');
    for (const t of TARGETS) {
      const html = path.join(tmp, `icon-${t.size}.html`);
      await writeFile(html, pageFor(await readFile(t.src, 'utf8'), t.size, t.pad));
      const out = path.join(ROOT, t.out);
      await mkdir(path.dirname(out), { recursive: true });
      await screenshot(chrome, html, out, t.size, t.size, profile);
      console.log(`  ✔ ${t.out.padEnd(34)} ${t.size}×${t.size}  ${statSync(out).size} bytes  (from ${path.relative(ROOT, t.src)})`);
    }
    await copyFile(path.join(ROOT, 'extension/icons/icon128.png'), path.join(ROOT, 'store-assets/store-icon-128.png'));
    console.log('  ✔ store-assets/store-icon-128.png (copy of icon128.png)');
    if (previewDir) {
      await mkdir(previewDir, { recursive: true });
      const html = path.join(tmp, 'preview.html');
      await writeFile(html, previewPage());
      await screenshot(chrome, html, path.join(previewDir, 'preview.png'), 640, 3 * 160, profile);
      console.log(`  ✔ preview → ${path.join(previewDir, 'preview.png')}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
