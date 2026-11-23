import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectContentScripts, injectMock, isDemoPage, isExtensionPage } from '../../scripts/dev-server.mjs';

test('pages that get the chrome mock + service worker', () => {
  assert.ok(isExtensionPage('/extension/src/popup/popup.html'));
  assert.ok(isExtensionPage('/extension/src/options/options.html'));
  assert.ok(!isExtensionPage('/extension/src/popup/popup.js'));
  assert.ok(!isExtensionPage('/dev/demo.html'));
  assert.ok(isDemoPage('/dev/demo.html'));
  assert.ok(isDemoPage('/dev/demo-taobao.html'));
  assert.ok(!isDemoPage('/dev/playground.html'));
  assert.ok(!isDemoPage('/dev/sub/demo.html'));
});

test('injectMock puts the mock and the real service worker first in <head>, once', () => {
  const html = '<!doctype html><html><head lang="en"><meta charset="utf-8"><script type="module" src="popup.js"></script></head></html>';
  const out = injectMock(html);
  const mock = out.indexOf('<script src="/dev/chrome-mock.js" data-background="/extension/src/background/service-worker.js"></script>');
  const sw = out.indexOf('<script type="module" src="/extension/src/background/service-worker.js"></script>');
  assert.ok(mock > out.indexOf('<head lang="en">'));
  assert.ok(sw > mock);
  assert.ok(out.indexOf('popup.js') > sw, 'before the page scripts');
  assert.equal(injectMock(out), out, 'idempotent');
  assert.ok(injectMock('<p>no head</p>').startsWith('<script src="/dev/chrome-mock.js"'));
});

test('injectContentScripts: marker, else before </body>, never twice', () => {
  const scripts = ['src/shared/currency-data.js', 'src/content/parser.js', 'src/content/content.js'];
  const tags = '<script src="/extension/src/shared/currency-data.js"></script>\n<script src="/extension/src/content/parser.js"></script>\n<script src="/extension/src/content/content.js"></script>';
  assert.equal(injectContentScripts('<body><!--CONTENT_SCRIPTS--><p>x</p></body>', scripts), `<body>${tags}<p>x</p></body>`);
  assert.equal(injectContentScripts('<body><p>x</p></body>', scripts), `<body><p>x</p>${tags}\n</body>`);
  const own = '<body><script src="../extension/src/content/content.js"></script></body>';
  assert.equal(injectContentScripts(own, scripts), own);
});
