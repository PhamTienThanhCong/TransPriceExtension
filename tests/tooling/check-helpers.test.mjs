import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyUrl,
  findForbiddenJs,
  findHtmlI18nKeys,
  findHtmlRefs,
  findInlineHandlers,
  findInlineScripts,
  findJsI18nKeys,
  findModuleSyntax,
  lineOf,
  manifestMessageKeys,
  matchPatternCovers,
  pngSize,
  stripComments,
  stripCommentsAndStrings,
  stripQuery,
} from '../../scripts/lib/check-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('stripComments blanks comments but keeps strings, regexes and line numbers', () => {
  const src = "const a = 'x // not a comment'; // eval(1)\n/* new Function(\n */ const r = /\\/\\/ y/; const t = `/* z */`;";
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(out.includes("'x // not a comment'"));
  assert.ok(!out.includes('eval(1)'));
  assert.ok(!out.includes('new Function'));
  assert.ok(out.includes('/\\/\\/ y/'));
  assert.ok(out.includes('`/* z */`'));
});

test('stripCommentsAndStrings blanks string contents (quotes kept)', () => {
  const out = stripCommentsAndStrings("x('import a from \"b\"'); y(`export default 1`); // export const z");
  assert.ok(!/import|export/.test(out));
  assert.ok(out.startsWith("x('"));
});

test('findModuleSyntax detects static import/export and import.meta', () => {
  const src = [
    "import { a } from './a.js';",
    "import './side-effect.js';",
    'import * as ns from "./ns.js";',
    'import def from "./d.js";',
    'export const x = 1;',
    'export default function f() {}',
    'export { a };',
    'export * from "./all.js";',
    '  export async function g() {}',
    'const u = new URL("x", import.meta.url);',
  ].join('\n');
  const found = findModuleSyntax(src);
  assert.deepEqual(
    found.map((f) => [f.line, f.kind]),
    [
      [1, 'import'],
      [2, 'import'],
      [3, 'import'],
      [4, 'import'],
      [5, 'export'],
      [6, 'export'],
      [7, 'export'],
      [8, 'export'],
      [9, 'export'],
      [10, 'import.meta'],
    ],
  );
  assert.equal(found[0].text, "import { a } from './a.js';");
});

test('findModuleSyntax ignores classic-script lookalikes', () => {
  const src = [
    '(() => {',
    "  'use strict';",
    '  // import x from "y";  (comment)',
    "  const s = 'import a from \"b\"';",
    '  const t = `export default ${1}`;',
    '  const lazy = () => import("./mod.js"); // dynamic import is allowed syntax',
    '  const o = { import: 1, export: 2 };',
    '  const p = {',
    '    import: true,',
    '  };',
    '  globalThis.importer = 1; obj.export = 2;',
    '  /* export const z = 1; */',
    '})();',
  ].join('\n');
  assert.deepEqual(findModuleSyntax(src), []);
});

test('findForbiddenJs flags eval, new Function, string timers and remote code', () => {
  const code = stripComments(
    [
      'eval("1");',
      'const f = new Function("return 1");',
      'setTimeout("alert(1)", 10);',
      "import x from 'https://cdn.example.com/x.js';",
      "importScripts('//cdn.example.com/y.js');",
      '// eval("comment")',
      'obj.evaluate(1); retrieval(2); setTimeout(() => 1, 0);',
    ].join('\n'),
  );
  const msgs = findForbiddenJs(code).map((f) => [lineOf(code, f.index), f.message.split(' ')[0]]);
  assert.deepEqual(msgs, [
    [1, 'eval('],
    [2, 'new'],
    [3, 'string'],
    [4, 'remote'],
    [5, 'remote'],
  ]);
});

test('findInlineScripts: bodies are flagged, src/JSON scripts are not', () => {
  const html = [
    '<script src="a.js"></script>',
    '<script>console.log(1)</script>',
    '<script type="application/json">{"a":1}</script>',
    '<script type="module">\n  import "./x.js";\n</script>',
    '<script>   </script>',
  ].join('\n');
  assert.deepEqual(findInlineScripts(html), [{ line: 2 }, { line: 4 }]);
});

test('findInlineHandlers: real on*= attributes and javascript: URLs only', () => {
  const html = [
    '<button onclick="go()">Go</button>',
    '<img src="x.png" onerror=alert(1)>',
    '<a href="javascript:void(0)">x</a>',
    '<div data-onclick="x" title="say onclick=hi" aria-label="online">ok</div>',
    '<input type="text" placeholder="on=1">',
    "<body\n  onload='init()'>",
  ].join('\n');
  assert.deepEqual(findInlineHandlers(html), [
    { line: 1, tag: 'button', attr: 'onclick' },
    { line: 2, tag: 'img', attr: 'onerror' },
    { line: 3, tag: 'a', attr: 'href=javascript:' },
    { line: 6, tag: 'body', attr: 'onload' },
  ]);
});

test('findHtmlRefs + classifyUrl', () => {
  const html = '<link rel="stylesheet" href="../ui/tokens.css">\n<script type="module" src="popup.js?v=1"></script>\n<a href="https://github.com/x">gh</a><img src="data:image/png;base64,AA"><a href="#top">t</a><script src="//cdn.x/y.js"></script>';
  const refs = findHtmlRefs(html);
  assert.deepEqual(
    refs.map((r) => [r.tag, r.attr, r.url, r.line, classifyUrl(r.url)]),
    [
      ['link', 'href', '../ui/tokens.css', 1, 'local'],
      ['script', 'src', 'popup.js?v=1', 2, 'local'],
      ['a', 'href', 'https://github.com/x', 3, 'remote'],
      ['img', 'src', 'data:image/png;base64,AA', 3, 'skip'],
      ['a', 'href', '#top', 3, 'skip'],
      ['script', 'src', '//cdn.x/y.js', 3, 'remote'],
    ],
  );
  assert.equal(classifyUrl('javascript:alert(1)'), 'javascript');
  assert.equal(classifyUrl('chrome://extensions'), 'skip');
  assert.equal(stripQuery('a/b.css?x=1#y'), 'a/b.css');
});

test('i18n key extraction from HTML and JS', () => {
  const html = '<html data-i18n-doc-title="popup_title">\n<h1 data-i18n="popup_heading"></h1>\n<button data-i18n-aria-label="common_close" data-i18n-title=\'common_close\'></button><input data-i18n-placeholder="common_search_currency">';
  assert.deepEqual(
    findHtmlI18nKeys(html).map((k) => [k.key, k.line]),
    [
      ['popup_title', 1],
      ['popup_heading', 2],
      ['common_close', 3],
      ['common_close', 3],
      ['common_search_currency', 3],
    ],
  );
  const js = "t('popup_a'); t(\"popup_b\", [1]); chrome.i18n.getMessage('bg_c'); set('nope'); t(variable); format('x'); i18n.t('popup_d');";
  assert.deepEqual(
    findJsI18nKeys(js).map((k) => k.key),
    ['popup_a', 'popup_b', 'bg_c', 'popup_d'],
  );
});

test('manifestMessageKeys + matchPatternCovers against the real manifest and RATE_SOURCES', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
  const keys = manifestMessageKeys(manifest);
  for (const k of ['extName', 'extShortName', 'extDescription', 'actionTitle', 'cmdToggleEnabled']) assert.ok(keys.includes(k), k);
  const { RATE_SOURCES } = await import('../../extension/src/shared/constants.js');
  for (const s of RATE_SOURCES) {
    assert.ok(
      manifest.host_permissions.some((h) => matchPatternCovers(h, s.url)),
      `${s.id} (${s.url}) must be covered by host_permissions`,
    );
  }
  assert.equal(matchPatternCovers('https://open.er-api.com/*', 'https://evil.com/?https://open.er-api.com/'), false);
  assert.equal(matchPatternCovers('<all_urls>', 'https://a.b/c'), true);
});

test('pngSize reads the rendered icons (and rejects non-PNG files)', () => {
  for (const n of [16, 32, 48, 128]) assert.deepEqual(pngSize(path.join(ROOT, `extension/icons/icon${n}.png`)), { w: n, h: n });
  assert.equal(pngSize(path.join(ROOT, 'extension/icons/logo.svg')), null);
  assert.equal(pngSize(path.join(ROOT, 'does/not/exist.png')), null);
});
