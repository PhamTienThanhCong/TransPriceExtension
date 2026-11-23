#!/usr/bin/env node
/**
 * TransPrice dev server — run the extension pages and the content script in a normal browser tab, no install needed.
 *
 *   npm run dev            → http://localhost:5180   (PORT=xxxx to change)
 *
 * - Serves the repo root as static files (no caching), `/` → /dev/index.html (the dev hub).
 * - Injects the chrome mock + the REAL service worker at the top of <head> of every HTML page under /extension/src/
 *   and of every /dev/demo*.html page:
 *     <script src="/dev/chrome-mock.js" data-background="/extension/src/background/service-worker.js"></script>
 *     <script type="module" src="/extension/src/background/service-worker.js"></script>
 *   so popup/options/welcome and the demo's content script talk to the real background logic (dev/chrome-mock.js
 *   explains the message bus).
 * - /dev/demo*.html also get the manifest's content scripts (classic <script>s, in manifest order): in place of a
 *   `<!--CONTENT_SCRIPTS-->` marker if there is one, else right before </body> — unless the page already loads
 *   content/content.js itself.
 * - GET /__dev/pages.json lists the dev pages and extension pages (used by the hub).
 *
 * Dev-only: never shipped (only extension/ is packaged). Listens on 127.0.0.1 only.
 */
import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '127.0.0.1';
const SW = '/extension/src/background/service-worker.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const MOCK_TAGS = `<script src="/dev/chrome-mock.js" data-background="${SW}"></script>\n<script type="module" src="${SW}"></script>`;

/** Pages that get the mock + service worker. */
export const isExtensionPage = (p) => p.startsWith('/extension/src/') && p.endsWith('.html');
export const isDemoPage = (p) => /^\/dev\/demo[^/]*\.html$/.test(p);

/** Insert the mock + SW right after <head …> (or at the very top when there is no <head>). */
export function injectMock(html) {
  if (html.includes('/dev/chrome-mock.js')) return html;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${MOCK_TAGS}`) : `${MOCK_TAGS}\n${html}`;
}

/** Add the manifest's content scripts to a demo page (see header). */
export function injectContentScripts(html, scripts) {
  const tags = scripts.map((s) => `<script src="/extension/${s}"></script>`).join('\n');
  if (html.includes('<!--CONTENT_SCRIPTS-->')) return html.replace('<!--CONTENT_SCRIPTS-->', tags);
  if (/content\/content\.js/.test(html)) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tags}\n</body>`) : `${html}\n${tags}`;
}

async function contentScripts() {
  try {
    const manifest = JSON.parse(await readFile(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
    return (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
  } catch {
    return [];
  }
}

async function listHtml(dir, base) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listHtml(p, `${base}${e.name}/`)));
    else if (e.name.endsWith('.html')) out.push(`${base}${e.name}`);
  }
  return out.sort();
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 302, '', undefined, { Location: '/dev/index.html' });
    if (url.pathname === '/__dev/pages.json') {
      const dev = (await listHtml(path.join(ROOT, 'dev'), '/dev/')).filter((p) => p !== '/dev/index.html');
      const extension = await listHtml(path.join(ROOT, 'extension/src'), '/extension/src/');
      return send(res, 200, JSON.stringify({ dev, extension }), MIME['.json']);
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    let filePath = path.normalize(path.join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
    if (path.relative(ROOT, filePath).split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.well-known')) return send(res, 403, 'Forbidden'); // .git, .env …
    let info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath).catch(() => null);
    }
    if (!info || !info.isFile()) return send(res, 404, `Not found: ${url.pathname}`);

    const ext = path.extname(filePath).toLowerCase();
    let body = await readFile(filePath);
    if (ext === '.html' && (isExtensionPage(url.pathname) || isDemoPage(url.pathname))) {
      let html = injectMock(body.toString('utf8'));
      if (isDemoPage(url.pathname)) html = injectContentScripts(html, await contentScripts());
      body = html;
    }
    send(res, 200, req.method === 'HEAD' ? '' : body, MIME[ext] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err?.stack || err));
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`TransPrice dev server → http://localhost:${PORT}  (hub: /dev/index.html · Ctrl+C to stop)`);
  });
}
