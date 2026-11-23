#!/usr/bin/env node
/**
 * TransPrice — static checks for the extension. Zero dependencies (Node ≥ 22).
 *
 *   node scripts/check.mjs        (or: npm run check)
 *
 * Verifies:
 *  - locales: i18n/*.json → _locales is up to date (`build-locales --check`), en & vi have identical key sets
 *  - manifest.json is valid JSON with the required MV3 fields and a valid version; every referenced file exists
 *    (icons with the right pixel size, popup, options, service worker, content scripts …); every __MSG_x__ exists;
 *    permissions are the documented ones and every RATE_SOURCES url is covered by host_permissions
 *  - extension HTML: every local src/href exists and stays inside extension/, no inline <script>, no on*= handlers,
 *    no javascript: URLs, no remote resources (links in <a href> are fine)
 *  - extension CSS: no remote @import / url()
 *  - extension JS: `node --check` passes for every file; content scripts listed in the manifest contain no
 *    import/export and compile as classic scripts; no eval( / new Function( / string timers / remote code; every
 *    relative ES-module import and getURL('…') literal resolves
 *  - i18n keys: every data-i18n*="key" in HTML and every literal t('key') / getMessage('key') under extension/src exists
 *  - .mainignore: parses, and lists no product path (extension/, README.md, LICENSE, CHANGELOG.md, docs/PRIVACY.md,
 *    .github/ISSUE_TEMPLATE, .gitignore, images shown by README.md)
 *  - release hygiene (warnings): placeholder EXTENSION_ID, CHANGELOG entry for the manifest version, store icon
 *
 * Exit code 0 = no errors (warnings allowed), 1 = at least one error.
 * Works on a partially written tree: missing files are reported, never crash the script.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyUrl,
  findForbiddenJs,
  findHtmlI18nKeys,
  findHtmlRefs,
  findInlineHandlers,
  findInlineScripts,
  findJsI18nKeys,
  findModuleSyntax,
  findProductPathsInMainignore,
  lineOf,
  manifestMessageKeys,
  matchPatternCovers,
  parseMainignore,
  pngSize,
  PRODUCT_PATHS,
  readmeImages,
  stripComments,
  stripHtmlComments,
  stripQuery,
} from './lib/check-helpers.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/') || '.';

/** Permissions documented in docs/ARCHITECTURE.md §1.5 (each one needs a Web Store justification). */
const EXPECTED_PERMISSIONS = ['storage', 'alarms'];

// ───────────────────────────── output helpers ─────────────────────────────
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const bold = paint(1);
const dim = paint(2);
let errorCount = 0;
let warnCount = 0;
const ok = (msg) => console.log(`  ${green('✔')} ${msg}`);
const fail = (msg) => {
  errorCount++;
  console.log(`  ${red('✖')} ${msg}`);
};
const warn = (msg) => {
  warnCount++;
  console.log(`  ${yellow('⚠')} ${msg}`);
};
const info = (msg) => console.log(`  ${dim('·')} ${dim(msg)}`);
const section = (title) => console.log(`\n${bold(title)}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ───────────────────────────── fs helpers ─────────────────────────────
async function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const insideExt = (p) => p === EXT || p.startsWith(EXT + path.sep);
const safeDecode = (u) => {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
};
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
async function pool(items, size, fn) {
  let next = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ───────────────────────────── load inputs ─────────────────────────────
const allFiles = await walk(EXT);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));
const jsFiles = allFiles.filter((f) => /\.m?js$/.test(f));
const cssFiles = allFiles.filter((f) => f.endsWith('.css'));
const sources = new Map(); // file -> { raw, code (comments blanked) }
for (const f of [...htmlFiles, ...jsFiles, ...cssFiles]) {
  let raw = '';
  try {
    raw = await readFile(f, 'utf8');
  } catch {
    /* unreadable → empty */
  }
  const code = f.endsWith('.html') ? stripHtmlComments(raw) : f.endsWith('.css') ? raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) : stripComments(raw);
  sources.set(f, { raw, code });
}

console.log(bold('TransPrice — extension checks'));
info(`${rel(EXT)}/: ${allFiles.length} files (${jsFiles.length} JS, ${htmlFiles.length} HTML, ${cssFiles.length} CSS)`);

// ───────────────────────────── locales ─────────────────────────────
section('Locales');
let enKeys = null; // Set of lower-cased keys (chrome.i18n lookups are case-insensitive)
{
  const locDir = path.join(EXT, '_locales');
  const keySets = new Map(); // locale -> Set(keys)
  for (const loc of ['en', 'vi']) {
    const p = path.join(locDir, loc, 'messages.json');
    try {
      const data = await readJson(p);
      const bad = Object.entries(data).filter(([, v]) => !v || typeof v.message !== 'string').map(([k]) => k);
      if (bad.length) fail(`${rel(p)}: entries without a "message" string: ${bad.join(', ')}`);
      else ok(`${rel(p)}: ${plural(Object.keys(data).length, 'message')}`);
      keySets.set(loc, new Set(Object.keys(data)));
    } catch (e) {
      fail(`${rel(p)}: ${e.code === 'ENOENT' ? 'not found — run: npm run i18n' : `invalid JSON — ${e.message}`}`);
    }
  }
  if (keySets.has('en')) enKeys = new Set([...keySets.get('en')].map((k) => k.toLowerCase()));
  if (keySets.has('en') && keySets.has('vi')) {
    const en = keySets.get('en');
    const vi = keySets.get('vi');
    const onlyEn = [...en].filter((k) => !vi.has(k));
    const onlyVi = [...vi].filter((k) => !en.has(k));
    if (onlyEn.length || onlyVi.length) {
      fail(`en/vi key sets differ — only in en: ${onlyEn.join(', ') || '—'}; only in vi: ${onlyVi.join(', ') || '—'}`);
    } else ok(`en and vi have identical key sets (${en.size})`);
  }
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [path.join(ROOT, 'scripts', 'build-locales.mjs'), '--check'], { cwd: ROOT });
    const lines = `${stdout}${stderr}`.trim().split('\n').filter(Boolean);
    const summary = lines.find((l) => l.startsWith('✔')) || 'build-locales --check passed';
    ok(`build-locales --check: ${summary.replace(/^✔\s*/, '')}`);
    for (const l of lines.filter((x) => x.startsWith('⚠'))) info(l.replace(/^⚠\s*/, 'i18n: '));
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
    fail(`build-locales --check failed:\n      ${out.split('\n').join('\n      ')}`);
  }
}
const hasKey = (k) => !enKeys || enKeys.has(k.toLowerCase());

// ───────────────────────────── manifest ─────────────────────────────
section('Manifest');
let manifest = null;
const manifestPath = path.join(EXT, 'manifest.json');
try {
  manifest = await readJson(manifestPath);
  ok('manifest.json is valid JSON');
} catch (e) {
  fail(`manifest.json: ${e.code === 'ENOENT' ? 'not found' : `invalid JSON — ${e.message}`}`);
}

const contentScriptFiles = new Set();
if (manifest) {
  if (manifest.manifest_version !== 3) fail(`manifest_version must be 3 (found ${JSON.stringify(manifest.manifest_version)})`);
  const missing = ['name', 'version', 'description', 'icons', 'action', 'background'].filter((k) => manifest[k] === undefined);
  if (missing.length) fail(`missing required field(s): ${missing.join(', ')}`);
  else ok('required fields present (manifest_version, name, version, description, icons, action, background)');

  const v = String(manifest.version ?? '');
  if (/^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) && v.split('.').every((p) => Number(p) <= 65535 && (p === '0' || !p.startsWith('0')))) ok(`version ${v}`);
  else fail(`invalid version "${v}" (1–4 dot-separated integers 0–65535, no leading zeros)`);

  const msgKeys = manifestMessageKeys(manifest);
  if (msgKeys.length && !manifest.default_locale) fail('manifest uses __MSG_*__ but has no default_locale');
  if (manifest.default_locale && !existsSync(path.join(EXT, '_locales', manifest.default_locale, 'messages.json'))) {
    fail(`default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/messages.json`);
  }
  if (msgKeys.length) {
    const absent = msgKeys.filter((k) => !k.startsWith('@@') && !hasKey(k));
    if (absent.length) fail(`__MSG_*__ keys missing from _locales/en/messages.json: ${absent.join(', ')} (add them to i18n/meta.json)`);
    else ok(`__MSG_*__ keys resolve: ${msgKeys.join(', ')}`);
  }

  // Referenced files
  const refs = []; // [label, relPath, expectedSize?]
  for (const [size, p] of Object.entries(manifest.icons || {})) refs.push([`icons.${size}`, p, Number(size)]);
  const di = manifest.action?.default_icon;
  if (typeof di === 'string') refs.push(['action.default_icon', di]);
  else for (const [size, p] of Object.entries(di || {})) refs.push([`action.default_icon.${size}`, p, Number(size)]);
  if (manifest.action?.default_popup) refs.push(['action.default_popup', manifest.action.default_popup]);
  if (manifest.options_ui?.page) refs.push(['options_ui.page', manifest.options_ui.page]);
  if (manifest.options_page) refs.push(['options_page', manifest.options_page]);
  if (manifest.background?.service_worker) refs.push(['background.service_worker', manifest.background.service_worker]);
  if (manifest.side_panel?.default_path) refs.push(['side_panel.default_path', manifest.side_panel.default_path]);
  for (const [k, p] of Object.entries(manifest.chrome_url_overrides || {})) refs.push([`chrome_url_overrides.${k}`, p]);
  (manifest.content_scripts || []).forEach((cs, i) => {
    for (const p of cs.js || []) {
      refs.push([`content_scripts[${i}].js`, p]);
      contentScriptFiles.add(path.resolve(EXT, p));
    }
    for (const p of cs.css || []) refs.push([`content_scripts[${i}].css`, p]);
  });
  (manifest.web_accessible_resources || []).forEach((w, i) => {
    for (const p of w.resources || []) if (!/[*?]/.test(p)) refs.push([`web_accessible_resources[${i}]`, p]);
  });
  let refOk = 0;
  for (const [label, p, size] of refs) {
    const abs = path.resolve(EXT, String(p).replace(/^\//, ''));
    if (!insideExt(abs)) fail(`${label}: "${p}" points outside extension/`);
    else if (!isFile(abs)) fail(`${label}: missing file extension/${p}`);
    else if (size && p.endsWith('.png')) {
      const d = pngSize(abs);
      if (!d) fail(`${label}: extension/${p} is not a valid PNG`);
      else if (d.w !== size || d.h !== size) fail(`${label}: extension/${p} is ${d.w}×${d.h}, expected ${size}×${size}`);
      else refOk++;
    } else refOk++;
  }
  if (refs.length && refOk === refs.length) ok(`all ${plural(refs.length, 'file')} referenced by the manifest exist`);
  else if (refs.length) info(`${refOk}/${refs.length} manifest references OK`);
  if (!manifest.icons?.['128']) fail('icons.128 is required by the Chrome Web Store');
  if (manifest.background?.service_worker && manifest.background.type !== 'module') {
    contentScriptFiles.add(path.resolve(EXT, manifest.background.service_worker)); // classic SW → classic-script check too
  }

  // Permissions
  const perms = manifest.permissions || [];
  const hosts = manifest.host_permissions || [];
  const extraPerms = perms.filter((p) => !EXPECTED_PERMISSIONS.includes(p));
  if (extraPerms.length) warn(`permissions not documented in docs/ARCHITECTURE.md §1.5 (needs manager approval + a store justification): ${extraPerms.join(', ')}`);
  else ok(`permissions: ${perms.join(', ') || '(none)'}`);
  if (hosts.some((h) => h === '<all_urls>' || /^\*:\/\/\*\//.test(h) || /^https?:\/\/\*\/\*$/.test(h))) {
    warn('host_permissions contains a match-all pattern — expect a slower, stricter Web Store review');
  }
  try {
    const { RATE_SOURCES } = await import(pathToFileURL(path.join(EXT, 'src', 'shared', 'constants.js')).href);
    const uncovered = (RATE_SOURCES || []).filter((s) => !hosts.some((h) => matchPatternCovers(h, s.url)));
    const unused = hosts.filter((h) => !(RATE_SOURCES || []).some((s) => matchPatternCovers(h, s.url)));
    if (uncovered.length) fail(`RATE_SOURCES not covered by host_permissions: ${uncovered.map((s) => s.id).join(', ')}`);
    else ok(`host_permissions cover all ${plural(RATE_SOURCES.length, 'rate source')}`);
    if (unused.length) warn(`host_permissions not used by any RATE_SOURCES entry: ${unused.join(', ')}`);
  } catch (e) {
    warn(`could not load src/shared/constants.js to verify host_permissions: ${e.message}`);
  }
  if (manifest.content_security_policy) info('custom content_security_policy present — make sure it does not allow remote code');
}

// ───────────────────────────── HTML ─────────────────────────────
section('HTML (extension pages)');
const i18nHtmlKeys = []; // [file, line, key]
if (!htmlFiles.length) warn('no HTML files under extension/ yet');
for (const file of htmlFiles) {
  const { code } = sources.get(file);
  const problems = [];
  let localRefs = 0;
  for (const s of findInlineScripts(code)) problems.push(`line ${s.line}: inline <script> body (blocked by the MV3 CSP — move it to a .js file)`);
  for (const h of findInlineHandlers(code)) {
    problems.push(h.attr.includes('javascript:') ? `line ${h.line}: ${h.attr} URL on <${h.tag}>` : `line ${h.line}: inline event handler ${h.attr}= on <${h.tag}> (use addEventListener)`);
  }
  for (const r of findHtmlRefs(code)) {
    const kind = classifyUrl(r.url);
    if (kind === 'skip' || kind === 'javascript') continue;
    if (kind === 'remote') {
      if (r.tag !== 'a') problems.push(`line ${r.line}: remote URL <${r.tag} ${r.attr}="${r.url}"> (no remote code/CSS/fonts/images — bundle it)`);
      continue;
    }
    const clean = safeDecode(stripQuery(r.url));
    const target = clean.startsWith('/') ? path.join(EXT, clean) : path.resolve(path.dirname(file), clean);
    if (!insideExt(target)) problems.push(`line ${r.line}: ${r.attr}="${r.url}" points outside extension/ (breaks in the packaged zip)`);
    else if (!isFile(target)) problems.push(`line ${r.line}: ${r.attr}="${r.url}" → missing ${rel(target)}`);
    else localRefs++;
  }
  for (const k of findHtmlI18nKeys(code)) i18nHtmlKeys.push([file, k.line, k.key]);
  if (problems.length) for (const p of problems) fail(`${rel(file)}: ${p}`);
  else ok(`${rel(file)} (${plural(localRefs, 'local reference')} OK, CSP-safe)`);
}

// ───────────────────────────── CSS ─────────────────────────────
if (cssFiles.length) {
  section('CSS');
  for (const file of cssFiles) {
    const { code } = sources.get(file);
    const problems = [];
    let n = 0;
    for (const m of code.matchAll(/@import\s+(?:url\()?\s*["']?(https?:)?\/\//gi)) problems.push(`line ${lineOf(code, m.index)}: remote @import (bundle it locally)`);
    for (const m of code.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
      const url = m[2].trim();
      if (/^(data|blob|chrome-extension):/i.test(url) || url.startsWith('#')) continue;
      if (/^(https?:)?\/\//i.test(url)) {
        problems.push(`line ${lineOf(code, m.index)}: remote url(${url}) (no remote fonts/images)`);
        continue;
      }
      const target = url.startsWith('/') ? path.join(EXT, stripQuery(url)) : path.resolve(path.dirname(file), stripQuery(url));
      if (!insideExt(target) || !isFile(target)) problems.push(`line ${lineOf(code, m.index)}: url(${url}) → missing ${rel(target)}`);
      else n++;
    }
    if (problems.length) for (const p of problems) fail(`${rel(file)}: ${p}`);
    else ok(`${rel(file)}${n ? ` (${plural(n, 'url() reference')} OK)` : ''}`);
  }
}

// ───────────────────────────── JS syntax ─────────────────────────────
section('JavaScript syntax');
if (!jsFiles.length) warn('no JS files under extension/ yet');
const syntax = await pool(jsFiles, Math.max(2, os.cpus().length), async (file) => {
  try {
    await execFileP(process.execPath, ['--check', file], { cwd: ROOT });
    return null;
  } catch (e) {
    const msg = `${e.stderr || e.message}`.trim().split('\n').filter((l) => l.trim() && !l.startsWith('Node.js v')).slice(0, 4).join('\n      ');
    return `${rel(file)}:\n      ${msg}`;
  }
});
const syntaxErrors = syntax.filter(Boolean);
for (const s of syntaxErrors) fail(s);
if (jsFiles.length && !syntaxErrors.length) ok(`${plural(jsFiles.length, 'JS file')} parse cleanly (node --check)`);

// Content scripts are injected as classic scripts: no import/export allowed.
for (const file of contentScriptFiles) {
  if (!sources.has(file)) continue; // missing file already reported in Manifest
  const { raw } = sources.get(file);
  const moduleSyntax = findModuleSyntax(raw);
  if (moduleSyntax.length) {
    for (const m of moduleSyntax) fail(`${rel(file)}:${m.line}: \`${m.kind}\` in a content script (classic script — share code via globalThis instead): ${m.text}`);
    continue;
  }
  try {
    new vm.Script(raw, { filename: rel(file) });
    ok(`${rel(file)}: classic script, no import/export (content script)`);
  } catch (e) {
    fail(`${rel(file)}: not a valid classic script — ${e.message}`);
  }
}

// ───────────────────────────── JS rules ─────────────────────────────
section('JavaScript rules (MV3 / security / imports)');
const htmlSinks = [];
const i18nJsKeys = []; // [file, line, key]
let importCount = 0;
for (const file of jsFiles) {
  const { code, raw } = sources.get(file);
  const rawLines = raw.split('\n');
  const problems = [];
  const at = (idx) => `${rel(file)}:${lineOf(code, idx)}`;
  for (const f of findForbiddenJs(code)) problems.push(`${at(f.index)}: ${f.message}`);
  for (const m of code.matchAll(/\.(?:innerHTML|outerHTML)\s*\+?=|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(/g)) {
    const line = lineOf(code, m.index);
    if (!/trusted-html/.test(rawLines[line - 1] || '')) htmlSinks.push(`${rel(file)}:${line}`); // `// trusted-html` = reviewed static markup
  }
  // Relative module specifiers must resolve
  const specs = [
    ...code.matchAll(/(?<![\w$.])(?:import|export)\s*(?:[^'"`;()]*?\sfrom\s*)?(["'])([^"'\n]+)\1/g),
    ...code.matchAll(/(?<![\w$.])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g),
  ];
  for (const m of specs) {
    const spec = m[2];
    if (!/^(\.{1,2}\/|\/)/.test(spec)) continue;
    importCount++;
    const target = spec.startsWith('/') ? path.join(EXT, stripQuery(spec)) : path.resolve(path.dirname(file), stripQuery(spec));
    if (!insideExt(target)) problems.push(`${at(m.index)}: import "${spec}" points outside extension/`);
    else if (!isFile(target)) problems.push(`${at(m.index)}: import "${spec}" → missing ${rel(target)}`);
  }
  for (const m of code.matchAll(/\bgetURL\(\s*(["'])([^"'\n]+)\1\s*\)/g)) {
    const target = path.join(EXT, stripQuery(m[2]).replace(/^\//, ''));
    if (!isFile(target)) problems.push(`${at(m.index)}: getURL("${m[2]}") → missing ${rel(target)}`);
  }
  if (file.startsWith(path.join(EXT, 'src') + path.sep)) {
    for (const k of findJsI18nKeys(code)) i18nJsKeys.push([file, lineOf(code, k.index), k.key]);
  }
  for (const p of problems) fail(p);
}
if (jsFiles.length) {
  const bad = errorCount;
  info(`scanned ${plural(jsFiles.length, 'JS file')}: ${plural(importCount, 'relative import')} checked`);
  if (bad === errorCount) ok('no eval / new Function / string timers / remote code');
}
if (htmlSinks.length) {
  warn(`HTML sinks (innerHTML/insertAdjacentHTML/document.write) in ${htmlSinks.length} place(s) — only trusted static markup allowed (ARCHITECTURE §1.3; mark reviewed lines with a // trusted-html comment):\n      ${htmlSinks.join('\n      ')}`);
}

// ───────────────────────────── i18n keys ─────────────────────────────
section('i18n keys used in code');
if (!enKeys) {
  warn('skipped: _locales/en/messages.json is missing');
} else {
  const used = [...i18nHtmlKeys, ...i18nJsKeys].filter(([, , k]) => k && !k.startsWith('@@'));
  const missingKeys = used.filter(([, , k]) => !hasKey(k));
  const byFile = new Map(); // file -> Map(key -> first line)
  for (const [file, line, key] of missingKeys) {
    if (!byFile.has(file)) byFile.set(file, new Map());
    if (!byFile.get(file).has(key)) byFile.get(file).set(key, line);
  }
  for (const [file, keys] of byFile) {
    const list = [...keys].map(([k, l]) => `${k} (line ${l})`);
    fail(`${rel(file)}: ${plural(keys.size, 'unknown message key')} — add to an i18n/*.json fragment, then npm run i18n:\n      ${list.join('\n      ')}`);
    errorCount += keys.size - 1; // count every missing key
  }
  if (!missingKeys.length) ok(`${new Set(used.map((u) => u[2])).size} distinct keys referenced (${i18nHtmlKeys.length} in HTML, ${i18nJsKeys.length} in JS) — all defined`);
}

// ───────────────────────────── .mainignore ─────────────────────────────
section('Branches (.mainignore → main)');
{
  const file = path.join(ROOT, '.mainignore');
  if (!existsSync(file)) fail('.mainignore not found (scripts/sync-main.sh needs it)');
  else {
    const entries = parseMainignore(await readFile(file, 'utf8'));
    const readme = path.join(ROOT, 'README.md');
    const images = existsSync(readme) ? readmeImages(await readFile(readme, 'utf8')) : [];
    const bad = findProductPathsInMainignore(entries, [...PRODUCT_PATHS, ...images]);
    for (const b of bad) fail(`.mainignore:${b.line}: "${b.pattern}" would remove the product path ${b.product} from main`);
    if (!bad.length) ok(`.mainignore: ${plural(entries.length, 'dev-only path')}, no product path listed`);
    for (const p of ['tests', 'dev', 'scripts', 'CLAUDE.md']) {
      if (!entries.some((e) => e.pattern.replace(/\/+$/, '') === p)) warn(`.mainignore does not list "${p}" — it would ship on main`);
    }
  }
}

// ───────────────────────────── release hygiene ─────────────────────────────
section('Release hygiene');
{
  const placeholderFiles = [
    path.join(EXT, 'src', 'shared', 'constants.js'),
    path.join(ROOT, 'README.md'),
    path.join(ROOT, 'docs', 'PRIVACY.md'),
    path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'config.yml'),
  ].filter((f) => existsSync(f));
  const withPlaceholder = [];
  for (const f of placeholderFiles) if (/EXTENSION_ID/.test(await readFile(f, 'utf8'))) withPlaceholder.push(rel(f));
  if (withPlaceholder.length) warn(`placeholder EXTENSION_ID (Chrome Web Store ID) still in: ${withPlaceholder.join(', ')} — replace before publishing (docs/PUBLISHING.md)`);
  else ok('no placeholder URLs');

  const changelog = path.join(ROOT, 'CHANGELOG.md');
  if (manifest?.version && existsSync(changelog)) {
    const txt = await readFile(changelog, 'utf8');
    if (new RegExp(`^##\\s*\\[?${manifest.version.replace(/\./g, '\\.')}\\]?`, 'm').test(txt)) ok(`CHANGELOG.md has an entry for ${manifest.version}`);
    else warn(`CHANGELOG.md has no "## ${manifest.version}" entry`);
  }
  for (const f of ['LICENSE', 'README.md', 'CHANGELOG.md', 'docs/PRIVACY.md', 'store-assets/store-icon-128.png']) {
    if (!existsSync(path.join(ROOT, f))) warn(`missing ${f}`);
  }
  const readme = path.join(ROOT, 'README.md');
  if (existsSync(readme)) {
    const imgs = readmeImages(await readFile(readme, 'utf8'));
    const missingImgs = imgs.filter((u) => !existsSync(path.join(ROOT, u)));
    if (missingImgs.length) warn(`README.md images not found: ${missingImgs.join(', ')}`);
    else if (imgs.length) ok(`README.md: ${plural(imgs.length, 'image reference')} OK`);
  }
  const strays = allFiles.filter((f) => /\.(map|zip|pem|log)$|(^|[\\/])(Thumbs\.db)$/.test(f));
  if (strays.length) warn(`files that should not ship: ${strays.map(rel).join(', ')}`);
}

// ───────────────────────────── summary ─────────────────────────────
console.log('');
if (errorCount) {
  console.log(red(bold(`✖ ${plural(errorCount, 'error')}`)) + (warnCount ? yellow(`, ${plural(warnCount, 'warning')}`) : ''));
  process.exit(1);
}
console.log(green(bold('✔ All checks passed')) + (warnCount ? yellow(` (${plural(warnCount, 'warning')})`) : ''));
