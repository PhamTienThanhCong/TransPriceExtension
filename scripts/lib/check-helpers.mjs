/**
 * TransPrice — pure helpers used by scripts/check.mjs (and unit-tested in tests/tooling/check-helpers.test.mjs).
 * Zero dependencies. Every function here is PURE except pngSize() (reads 24 bytes of a file).
 */
import { openSync, readSync, closeSync } from 'node:fs';

/** 1-based line number of `index` in `text`. */
export const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Drop `?query` and `#hash` from a URL/path. */
export const stripQuery = (u) => String(u).split('#')[0].split('?')[0];

/** PNG width/height from the IHDR chunk, or null if the file is missing / not a PNG. */
export function pngSize(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(24);
    readSync(fd, buf, 0, 24, 0);
    closeSync(fd);
    if (buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/* ───────────────────────────── JavaScript ───────────────────────────── */

const REGEX_PREFIX = '(,=:[!&|?{};+-*%<>~^';

/**
 * Scan JS source, calling `onComment(start, end)` / `onString(start, end)` (end exclusive, quotes included) so callers
 * can blank them out. Template literals are treated as one string (their `${…}` parts too — good enough for the
 * pattern checks, which only care about top-level code). Regex literals are kept as code.
 */
function scanJs(src, { onComment, onString }) {
  let i = 0;
  let last = '';
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      onComment(i, stop);
      i = stop;
    } else if (ch === '/' && nx === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      onComment(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        else if (ch !== '`' && src[j] === '\n') break;
        j++;
      }
      onString(i, Math.min(j + 1, n));
      i = j + 1;
      last = ch;
    } else if (ch === '/' && (last === '' || REGEX_PREFIX.includes(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      last = '/';
    } else {
      if (!/\s/.test(ch)) last = ch;
      i++;
    }
  }
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * Blank out JS comments (keeping newlines and string/regex/template literals intact) so that pattern checks don't
 * trip over documentation and line numbers stay correct.
 */
export function stripComments(src) {
  const parts = [];
  let pos = 0;
  scanJs(src, {
    onComment(s, e) {
      parts.push(src.slice(pos, s), blank(src.slice(s, e)));
      pos = e;
    },
    onString() {},
  });
  parts.push(src.slice(pos));
  return parts.join('');
}

/** Blank out comments AND the contents of string/template literals (quotes kept). Offsets/lines are preserved. */
export function stripCommentsAndStrings(src) {
  const parts = [];
  let pos = 0;
  scanJs(src, {
    onComment(s, e) {
      parts.push(src.slice(pos, s), blank(src.slice(s, e)));
      pos = e;
    },
    onString(s, e) {
      const body = src.slice(s + 1, Math.max(s + 1, e - 1));
      parts.push(src.slice(pos, s + 1), blank(body), e - 1 > s ? src.slice(e - 1, e) : '');
      pos = e;
    },
  });
  parts.push(src.slice(pos));
  return parts.join('');
}

/**
 * ES-module-only syntax in a script: static `import … from '…'`, `import '…'`, `export …` and `import.meta`.
 * Content scripts are injected as classic scripts, so any of these is a hard error there. `import(` (dynamic import)
 * and object keys named `import`/`export` are not reported.
 * @returns {Array<{line: number, kind: 'import'|'export'|'import.meta', text: string}>}
 */
export function findModuleSyntax(src) {
  const code = stripCommentsAndStrings(src);
  const out = [];
  const re = /(^|[;{}\n])([ \t]*)(import|export)\b/g;
  for (const m of code.matchAll(re)) {
    const start = m.index + m[1].length + m[2].length;
    const rest = code.slice(start + m[3].length, start + m[3].length + 40);
    let kind = m[3];
    if (kind === 'import') {
      if (/^\s*\(/.test(rest) || /^\s*:/.test(rest)) continue; // dynamic import() / { import: … }
      if (/^\s*\.\s*meta\b/.test(rest)) kind = 'import.meta';
      else if (!/^\s*(["'`{*]|[A-Za-z_$])/.test(rest)) continue;
    } else if (!/^\s*(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*)/.test(rest)) {
      continue; // e.g. `export: 1` or an identifier that merely starts a line
    }
    const lineEnd = src.indexOf('\n', start);
    out.push({ line: lineOf(src, start), kind, text: src.slice(start, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 80) });
  }
  // `import.meta` anywhere (not only at a statement start), e.g. `new URL('x', import.meta.url)`
  for (const m of code.matchAll(/(?<![\w$.])import\s*\.\s*meta\b/g)) {
    const line = lineOf(src, m.index);
    if (!out.some((o) => o.line === line && o.kind === 'import.meta')) out.push({ line, kind: 'import.meta', text: 'import.meta' });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * MV3 / CSP violations in (comment-stripped) JS: eval(, new Function(, string timers, remote module/script loads.
 * @returns {Array<{index: number, message: string}>}
 */
export function findForbiddenJs(code) {
  const out = [];
  const add = (re, message) => {
    for (const m of code.matchAll(re)) out.push({ index: m.index, message });
  };
  add(/(?<![\w$.])eval\s*\(/g, 'eval( is forbidden (MV3 CSP)');
  add(/\bnew\s+Function\s*\(/g, 'new Function( is forbidden (MV3 CSP)');
  add(/\bset(?:Timeout|Interval)\s*\(\s*["'`]/g, 'string passed to setTimeout/setInterval (implicit eval)');
  add(/\b(?:import|export)\s*(?:[^'"`;()]*?\s*from\s*)?["'`](?:https?:)?\/\//g, 'remote ES module import (remote code is forbidden)');
  add(/\b(?:import|importScripts)\s*\(\s*["'`](?:https?:)?\/\//g, 'remote script loading (remote code is forbidden)');
  return out.sort((a, b) => a.index - b.index);
}

/** Literal i18n keys used in JS: t('key'), t("key", …), chrome.i18n.getMessage('key'). @returns {Array<{key, index}>} */
export function findJsI18nKeys(code) {
  return [...code.matchAll(/(?<![\w$])(?:t|getMessage)\(\s*(["'])([A-Za-z0-9_@]+)\1/g)].map((m) => ({ key: m[2], index: m.index }));
}

/* ───────────────────────────── HTML ───────────────────────────── */

/** Blank out `<!-- … -->` comments (offsets/lines preserved). */
export const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, blank);

/** Inline `<script>` bodies (JSON data blocks allowed). @returns {Array<{line: number}>} */
export function findInlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const isData = /\btype\s*=\s*["']?application\/(ld\+)?json/i.test(attrs);
    if (!/\bsrc\s*=/i.test(attrs) && m[2].trim() && !isData) out.push({ line: lineOf(html, m.index) });
  }
  return out;
}

/** Every start tag with its attribute string. @returns {Array<{tag: string, attrs: string, index: number}>} */
function tags(html) {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)].map((t) => ({ tag: t[1].toLowerCase(), attrs: t[2], index: t.index }));
}

/** Inline event handlers (`onclick=` …) and `javascript:` URLs. @returns {Array<{line, tag, attr}>} */
export function findInlineHandlers(html) {
  const out = [];
  for (const { tag, attrs, index } of tags(html)) {
    // Only real attributes: a quoted value containing " onclick=" is not a handler.
    const bare = attrs.replace(/"[^"]*"|'[^']*'/g, (q) => q[0] + ' '.repeat(q.length - 2) + q[0]);
    for (const h of bare.matchAll(/(?:^|\s)(on[a-z]+)\s*=/gi)) out.push({ line: lineOf(html, index), tag, attr: h[1].toLowerCase() });
    for (const a of attrs.matchAll(/(?:^|\s)(href|src|action|formaction)\s*=\s*(["'])\s*javascript:/gi)) {
      out.push({ line: lineOf(html, index), tag, attr: `${a[1].toLowerCase()}=javascript:` });
    }
  }
  return out;
}

/** src= / href= references. @returns {Array<{line, tag, attr, url}>} */
export function findHtmlRefs(html) {
  const out = [];
  for (const { tag, attrs, index } of tags(html)) {
    for (const a of attrs.matchAll(/(?:^|\s)(src|href)\s*=\s*(["'])(.*?)\2/gi)) {
      out.push({ line: lineOf(html, index), tag, attr: a[1].toLowerCase(), url: a[3].trim() });
    }
  }
  return out;
}

/** Classify a reference: 'skip' (anchor, data:, mailto: …), 'remote' (http(s):// or //host) or 'local'. */
export function classifyUrl(url) {
  if (!url || url.startsWith('#') || /^(mailto|tel|data|blob|chrome|chrome-extension|about):/i.test(url)) return 'skip';
  if (/^javascript:/i.test(url)) return 'javascript';
  if (/^(https?:)?\/\//i.test(url)) return 'remote';
  return 'local';
}

/** data-i18n="key", data-i18n-title, data-i18n-aria-label, data-i18n-placeholder, data-i18n-doc-title. */
export function findHtmlI18nKeys(html) {
  return [...html.matchAll(/\sdata-i18n(?:-[a-z-]+)?\s*=\s*(["'])([^"']*)\1/g)].map((m) => ({ key: m[2].trim(), line: lineOf(html, m.index) }));
}

/* ───────────────────────────── manifest ───────────────────────────── */

/** `__MSG_key__` keys used anywhere in the manifest (Chrome's predefined `@@…` included). */
export const manifestMessageKeys = (manifest) => [...new Set([...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((m) => m[1]))];

/** Does a Chrome match pattern (scheme://host/path with `*`) cover `url`? Simplified: `*` = any run of characters. */
export function matchPatternCovers(pattern, url) {
  if (pattern === '<all_urls>') return /^(https?|wss?|ftp|file):/.test(url);
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
  return re.test(url);
}

/* ───────────────────────────── .mainignore ───────────────────────────── */

/**
 * Parse .mainignore like scripts/sync-main.sh does: strip `#` comments and surrounding whitespace, drop blank lines.
 * @returns {Array<{line: number, pattern: string}>}
 */
export function parseMainignore(text) {
  const out = [];
  String(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const pattern = raw.replace(/#.*/, '').trim();
      if (pattern) out.push({ line: i + 1, pattern });
    });
  return out;
}

/** Bash glob (one path segment rules: `*`, `?`, `[…]`; no globstar, no braces) → RegExp matching a whole path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        let body = glob.slice(i + 1, end);
        if (body[0] === '!') body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re.replace(/\/+$/, '')}$`);
}

/** Files and folders that must exist on `main` (CLAUDE.md "Never list product files there"). */
export const PRODUCT_PATHS = Object.freeze([
  'extension/manifest.json',
  'extension',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/PRIVACY.md',
  '.github/ISSUE_TEMPLATE',
  '.gitignore',
]);

/**
 * .mainignore entries that would delete a product path from main: the entry matches the product path, one of its
 * parent folders (e.g. `docs` or `*.md`), or anything inside extension/.
 * @param {Array<{line: number, pattern: string}>} entries  from parseMainignore()
 * @param {string[]} [productPaths]  PRODUCT_PATHS + e.g. the images README.md shows
 * @returns {Array<{line: number, pattern: string, product: string}>}
 */
export function findProductPathsInMainignore(entries, productPaths = PRODUCT_PATHS) {
  const out = [];
  for (const { line, pattern } of entries) {
    const clean = pattern.replace(/^\.\//, '');
    const re = globToRegExp(clean);
    const hit = productPaths.find((p) => {
      const segs = p.split('/');
      for (let k = 1; k <= segs.length; k++) if (re.test(segs.slice(0, k).join('/'))) return true;
      return false;
    });
    if (hit) out.push({ line, pattern, product: hit });
    else if (/^extension\//.test(clean)) out.push({ line, pattern, product: 'extension/' });
  }
  return out;
}

/** Relative image paths shown by a README (Markdown `![](…)` and `<img src>`), which must stay on main. */
export function readmeImages(markdown) {
  return [...String(markdown).matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img\b[^>]*\ssrc=["']([^"']+)["']/g)]
    .map((m) => m[1] || m[2])
    .filter((u) => !/^(https?:|data:|#)/i.test(u))
    .map((u) => stripQuery(u).replace(/^\.\//, ''));
}
