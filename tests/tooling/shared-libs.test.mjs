// Unit tests for the foundation's shared libraries used by every extension page:
// src/shared/i18n.js and src/shared/messaging.js (with a tiny in-memory chrome stub).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = { sync: {}, local: {} };
const changeListeners = new Set();
globalThis.chrome = {
  i18n: {
    getUILanguage: () => 'en-US',
    getMessage: (key, subs) => (key === 'common_save' ? 'Save' : key === 'common_version' ? `Version ${[].concat(subs ?? [])[0] ?? ''}` : ''),
  },
  runtime: { getURL: (p) => `chrome-extension://id/${p}`, sendMessage: async () => undefined },
  tabs: { sendMessage: async () => undefined },
  storage: {
    sync: { get: async (k) => (k in store.sync ? { [k]: store.sync[k] } : {}) },
    local: { get: async (k) => (k in store.local ? { [k]: store.local[k] } : {}) },
    onChanged: { addListener: (fn) => changeListeners.add(fn), removeListener: (fn) => changeListeners.delete(fn) },
  },
};

const i18n = await import('../../extension/src/shared/i18n.js');
const messaging = await import('../../extension/src/shared/messaging.js');

beforeEach(() => {
  store.sync = {};
  store.local = {};
  i18n.setUiMessages(null, null);
});

test('formatMessage follows chrome.i18n rules', () => {
  const { formatMessage } = i18n;
  assert.equal(formatMessage({ message: 'Rates of $P1$', placeholders: { p1: { content: '$1' } } }, '22/11/2026'), 'Rates of 22/11/2026');
  assert.equal(formatMessage({ message: '$A$ and $b$', placeholders: { a: { content: '$2' }, B: { content: '$1' } } }, ['x', 'y']), 'y and x');
  assert.equal(formatMessage('Cost: $$5 $1', ['ok']), 'Cost: $5 ok');
  assert.equal(formatMessage('Missing $2 sub', ['a']), 'Missing  sub');
  assert.equal(formatMessage('Trailing $', []), 'Trailing ');
  assert.equal(formatMessage(null), '');
});

test('t(): override dictionary first, then chrome.i18n, then the key', () => {
  assert.equal(i18n.t('common_save'), 'Save');
  assert.equal(i18n.t('common_version', '0.1.0'), 'Version 0.1.0');
  assert.equal(i18n.t('nope_missing'), 'nope_missing');
  i18n.setUiMessages('vi', { common_save: { message: 'Lưu' }, Common_Version: { message: 'Phiên bản $P1$', placeholders: { p1: { content: '$1' } } } });
  assert.equal(i18n.t('common_save'), 'Lưu');
  assert.equal(i18n.t('COMMON_VERSION', ['0.1.0']), 'Phiên bản 0.1.0', 'case-insensitive like Chrome');
  assert.equal(i18n.t('@@ui_locale'), 'vi');
  assert.equal(i18n.getCurrentUiLocale(), 'vi');
  assert.equal(i18n.uiDir(), 'ltr');
});

test('readUiLanguageSetting: sync settings first, local mirror as fallback, invalid → auto', async () => {
  assert.equal(await i18n.readUiLanguageSetting(), 'auto');
  store.local.uiLanguage = 'vi';
  assert.equal(await i18n.readUiLanguageSetting(), 'vi');
  store.sync.settings = { uiLanguage: 'en' };
  assert.equal(await i18n.readUiLanguageSetting(), 'en');
  store.sync.settings = { uiLanguage: 'xx' };
  store.local.uiLanguage = 'fr';
  assert.equal(await i18n.readUiLanguageSetting(), 'auto');
});

test('initI18n("auto") follows the browser locale; getBrowserUiLocale normalises', async () => {
  assert.equal(await i18n.initI18n({ uiLanguage: 'auto' }), 'en-US');
  assert.equal(i18n.getUiLanguageSetting(), 'auto');
  assert.equal(i18n.getBrowserUiLocale(), 'en-US');
});

test('reloadOnUiLanguageChange reacts to sync settings and the local mirror only when the value changes', async () => {
  await i18n.initI18n({ uiLanguage: 'auto' });
  let reloads = 0;
  globalThis.location = { reload: () => reloads++ };
  const off = i18n.reloadOnUiLanguageChange();
  const emit = (changes, area) => [...changeListeners].forEach((fn) => fn(changes, area));
  emit({ settings: { newValue: { uiLanguage: 'auto', theme: 'dark' } } }, 'sync');
  emit({ rates: { newValue: {} } }, 'local');
  assert.equal(reloads, 0);
  emit({ settings: { newValue: { uiLanguage: 'vi' } } }, 'sync');
  emit({ uiLanguage: { newValue: 'en' } }, 'local');
  assert.equal(reloads, 2);
  off();
  emit({ settings: { newValue: { uiLanguage: 'vi' } } }, 'sync');
  assert.equal(reloads, 2);
});

test('formatDate: Y-M-D strings are calendar dates, invalid input → empty', () => {
  i18n.setUiMessages('vi', { x: { message: 'x' } });
  assert.equal(i18n.formatDate('2026-11-22'), '22/11/2026');
  assert.equal(i18n.formatDate(new Date(2026, 0, 5)), '05/01/2026');
  assert.equal(i18n.formatDate('not a date'), '');
});

test('formatRelativeTime uses the UI locale', () => {
  const now = Date.UTC(2026, 10, 23, 12);
  assert.equal(i18n.formatRelativeTime(now - 5 * 60_000, now), '5 minutes ago');
  i18n.setUiMessages('vi', { x: { message: 'x' } });
  assert.equal(i18n.formatRelativeTime(now - 2 * 3600_000, now), '2 giờ trước');
});

test('messaging: makeError / serializeError keep known codes only', () => {
  const { makeError, serializeError } = messaging;
  assert.equal(makeError('NO_RATES', 'none').code, 'NO_RATES');
  assert.equal(makeError('WHATEVER').code, 'UNKNOWN');
  assert.deepEqual(serializeError(makeError('NETWORK', 'offline')), { code: 'NETWORK', message: 'offline' });
  assert.deepEqual(serializeError('boom'), { code: 'UNKNOWN', message: 'boom' });
  const e = makeError('BAD_REQUEST', 'x');
  e.details = { field: 'homeCurrency' };
  assert.deepEqual(serializeError(e).details, { field: 'homeCurrency' });
});

test('messaging: send() unwraps envelopes and throws coded errors', async () => {
  chrome.runtime.sendMessage = async (msg) => (msg.type === 'ok' ? { ok: true, value: msg.n * 2 } : { ok: false, error: { code: 'NO_RATES', message: 'no rates' } });
  assert.deepEqual(await messaging.send('ok', { n: 21 }), { value: 42 });
  await assert.rejects(messaging.send('bad'), (err) => err.code === 'NO_RATES' && err.message === 'no rates');
  chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(messaging.send('x'), /No response/);
});

test('messaging: sendToTab() → null when no content script listens', async () => {
  chrome.tabs.sendMessage = async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  };
  assert.equal(await messaging.sendToTab(1, 'get-page-info'), null);
  chrome.tabs.sendMessage = async (tabId, msg, opts) => ({ ok: true, tabId, type: msg.type, frameId: opts.frameId });
  assert.deepEqual(await messaging.sendToTab(7, 'rescan'), { tabId: 7, type: 'rescan', frameId: 0 });
  chrome.tabs.sendMessage = async () => {
    throw new Error('Something else');
  };
  await assert.rejects(messaging.sendToTab(1, 'x'), /Something else/);
});

test('messaging: createHandler answers with envelopes and ignores unknown types', async () => {
  const handler = messaging.createHandler({
    hello: async (msg, sender) => ({ greeting: `hi ${msg.name}`, from: sender.id }),
    fail: () => {
      throw messaging.makeError('BAD_REQUEST', 'nope');
    },
  });
  const call = (msg) =>
    new Promise((resolve) => {
      const ret = handler(msg, { id: 'ext' }, resolve);
      if (ret !== true) resolve({ returned: ret });
    });
  assert.deepEqual(await call({ type: 'hello', name: 'Cong' }), { ok: true, greeting: 'hi Cong', from: 'ext' });
  assert.deepEqual(await call({ type: 'fail' }), { ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } });
  assert.deepEqual(await call({ type: 'other' }), { returned: false });
  assert.deepEqual(await call(null), { returned: false });
});
