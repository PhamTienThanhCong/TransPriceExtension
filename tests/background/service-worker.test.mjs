/**
 * Service worker integration test: loads service-worker.js on an in-memory chrome.* mock with a mocked fetch and
 * exercises every background message (envelopes, ARCHITECTURE §5), lifecycle events, alarm, command and badge.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, MSG, RATE_SOURCES, STORAGE_KEYS } from '../../extension/src/shared/constants.js';
import { createChromeMock, currencyApiBody, flush, jsonResponse, mockFetch, ratesTable, tabSender, until } from './helpers.mjs';

const mock = createChromeMock({ uiLanguage: 'vi' });
const { chrome, areas, badge, alarms, log, sendToBackground: send } = mock;

const net = { mode: 'ok' };
const fetchMock = mockFetch([
  [
    /./,
    () => {
      if (net.mode === 'fail') throw new TypeError('fetch failed');
      return jsonResponse(currencyApiBody());
    },
  ],
]);

let sw;
before(async () => {
  globalThis.chrome = chrome;
  globalThis.fetch = fetchMock;
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['vi-VN', 'en-US'] }, configurable: true, writable: true });
  sw = await import('../../extension/src/background/service-worker.js');
  await flush(10);
});

const settings = () => areas.sync[STORAGE_KEYS.SETTINGS];

test('every listener is registered synchronously at load', () => {
  for (const [name, ev] of Object.entries({
    'runtime.onMessage': chrome.runtime.onMessage,
    'runtime.onInstalled': chrome.runtime.onInstalled,
    'runtime.onStartup': chrome.runtime.onStartup,
    'alarms.onAlarm': chrome.alarms.onAlarm,
    'commands.onCommand': chrome.commands.onCommand,
    'storage.onChanged': chrome.storage.onChanged,
    'tabs.onActivated': chrome.tabs.onActivated,
    'tabs.onRemoved': chrome.tabs.onRemoved,
  })) {
    assert.ok(ev.hasListeners(), name);
  }
});

test('worker start: refresh alarm ensured, badge initialised, uiLanguage mirrored', () => {
  const alarm = alarms.get(sw.RATES_ALARM);
  assert.ok(alarm);
  assert.equal(alarm.periodInMinutes, LIMITS.RATES_ALARM_MINUTES);
  assert.equal(badge.global.text, '');
  assert.equal(badge.global.color, '#B45309');
  assert.equal(areas.local[STORAGE_KEYS.UI_LANGUAGE], 'auto');
  assert.equal(fetchMock.calls.length, 0, 'no network at worker start');
});

test('handlers cover every background MSG (and nothing else)', () => {
  const background = ['GET_STATE', 'REFRESH_RATES', 'UPDATE_SETTINGS', 'SET_SITE_DISABLED', 'SET_SITE_CURRENCY', 'REPORT_COUNT', 'OPEN_OPTIONS'];
  assert.deepEqual(Object.keys(sw.handlers).sort(), background.map((k) => MSG[k]).sort());
  assert.ok(!(MSG.GET_PAGE_INFO in sw.handlers) && !(MSG.RESCAN in sw.handlers), 'content-script messages are left alone');
});

test('GET_STATE: settings (home currency guessed: vi → VND) + snapshot first, live rates stored in the background', async () => {
  const r = await send({ type: MSG.GET_STATE });
  assert.equal(r.ok, true);
  assert.equal(r.settings.homeCurrency, 'VND');
  assert.equal(r.settings.enabled, true);
  assert.equal(r.rates.source, 'snapshot');
  assert.equal(r.rates.base, 'USD');
  await until(() => areas.local[STORAGE_KEYS.RATES]);
  assert.equal(areas.local.rates.source, 'currency-api');
  const calls = fetchMock.calls.length;
  const r2 = await send({ type: MSG.GET_STATE });
  assert.equal(r2.rates.source, 'currency-api');
  assert.equal(r2.rates.rates.VND, 25788.84767895);
  assert.equal(fetchMock.calls.length, calls, 'fresh table served from storage');
});

test('REFRESH_RATES: forces a live fetch → { rates }', async () => {
  const before = fetchMock.calls.length;
  const r = await send({ type: MSG.REFRESH_RATES });
  assert.equal(r.ok, true);
  assert.equal(r.rates.source, 'currency-api');
  assert.ok(r.rates.fetchedAt > 0);
  assert.equal(fetchMock.calls.length, before + 1);
});

test('UPDATE_SETTINGS: validated → { settings }; bad patch → BAD_REQUEST', async () => {
  const r = await send({ type: MSG.UPDATE_SETTINGS, patch: { displayMode: 'append', homeCurrency: 'eur', theme: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.displayMode, 'append');
  assert.equal(r.settings.homeCurrency, 'EUR');
  assert.equal(r.settings.theme, 'auto');
  assert.equal(settings().displayMode, 'append');
  for (const patch of [undefined, null, 'x', [1]]) {
    const bad = await send({ type: MSG.UPDATE_SETTINGS, patch });
    assert.deepEqual([bad.ok, bad.error.code], [false, 'BAD_REQUEST'], String(patch));
    assert.equal(typeof bad.error.message, 'string');
  }
});

test('SET_SITE_DISABLED: normalised host, idempotent, enabling removes covering rules; sender fallback; errors', async () => {
  let r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'https://WWW.Taobao.com/item', disabled: true });
  assert.deepEqual(r.settings.disabledSites, ['taobao.com']);
  r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'world.taobao.com', disabled: true });
  assert.deepEqual(r.settings.disabledSites, ['taobao.com'], 'already covered by taobao.com');
  r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'jd.com', disabled: true });
  assert.deepEqual(r.settings.disabledSites, ['taobao.com', 'jd.com']);
  r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'world.taobao.com', disabled: false });
  assert.deepEqual(r.settings.disabledSites, ['jd.com'], 'the parent rule covering the site is removed');
  r = await send({ type: MSG.SET_SITE_DISABLED, disabled: true }, tabSender(4, 'https://shop.example.com/p'));
  assert.deepEqual(r.settings.disabledSites, ['jd.com', 'shop.example.com'], 'falls back to the sender page');
  r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'shop.example.com', disabled: false });
  r = await send({ type: MSG.SET_SITE_DISABLED, hostname: 'jd.com', disabled: false });
  assert.deepEqual(r.settings.disabledSites, []);

  for (const msg of [
    { hostname: 'jd.com' },
    { hostname: 'jd.com', disabled: 'yes' },
    { hostname: 'not a host', disabled: true },
    { disabled: true }, // no hostname, sender is an extension page
  ]) {
    const bad = await send({ type: MSG.SET_SITE_DISABLED, ...msg });
    assert.deepEqual([bad.ok, bad.error.code], [false, 'BAD_REQUEST'], JSON.stringify(msg));
  }
});

test('SET_SITE_CURRENCY: pin, merge, un-pin (incl. parent pins); errors', async () => {
  let r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'www.taobao.com', symbol: 'yen', currency: 'cny' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings.siteCurrency, { 'taobao.com': { yen: 'CNY' } });
  r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'taobao.com', symbol: 'dollar', currency: 'USD' });
  assert.deepEqual(r.settings.siteCurrency, { 'taobao.com': { yen: 'CNY', dollar: 'USD' } });
  r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'shop.ca', symbol: 'dollar', currency: 'CAD' });
  r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'world.taobao.com', symbol: 'yen', currency: null });
  assert.deepEqual(r.settings.siteCurrency, { 'taobao.com': { dollar: 'USD' }, 'shop.ca': { dollar: 'CAD' } });
  r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'taobao.com', symbol: 'dollar', currency: '' });
  assert.deepEqual(r.settings.siteCurrency, { 'shop.ca': { dollar: 'CAD' } }, 'empty entry dropped');
  r = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'shop.ca', symbol: 'dollar', currency: null });
  assert.deepEqual(r.settings.siteCurrency, {});

  const bad1 = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'a.com', symbol: 'euro', currency: 'EUR' });
  assert.equal(bad1.error.code, 'BAD_REQUEST');
  const bad2 = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'a.com', symbol: 'yen', currency: 'USD' });
  assert.equal(bad2.error.code, 'UNSUPPORTED_CURRENCY');
  const bad3 = await send({ type: MSG.SET_SITE_CURRENCY, hostname: '', symbol: 'yen', currency: 'JPY' });
  assert.equal(bad3.error.code, 'BAD_REQUEST');
  const bad4 = await send({ type: MSG.SET_SITE_CURRENCY, hostname: 'a.com', symbol: 'constructor', currency: 'USD' });
  assert.equal(bad4.error.code, 'BAD_REQUEST');
});

test('REPORT_COUNT: badge for sender.tab.id; cap; ignored for sub-frames / no tab; inactive site cleared', async () => {
  let r = await send({ type: MSG.REPORT_COUNT, count: 24 }, tabSender(11));
  assert.deepEqual(r, { ok: true });
  assert.equal(badge.shown(11), '24');
  await send({ type: MSG.REPORT_COUNT, count: 4321 }, tabSender(12, 'https://www.amazon.co.jp/'));
  assert.equal(badge.shown(12), '999+');
  await send({ type: MSG.REPORT_COUNT, count: 7 }, tabSender(13, 'https://ads.example.com/', 3));
  assert.equal(badge.shown(13), '', 'sub-frame report ignored');
  r = await send({ type: MSG.REPORT_COUNT, count: 7 }); // from an extension page: no tab
  assert.deepEqual(r, { ok: true });
  await send({ type: MSG.REPORT_COUNT, count: 0 }, tabSender(11));
  assert.equal(badge.shown(11), '');

  await send({ type: MSG.SET_SITE_DISABLED, hostname: 'taobao.com', disabled: true });
  await send({ type: MSG.REPORT_COUNT, count: 5 }, tabSender(14, 'https://world.taobao.com/x'));
  assert.equal(badge.shown(14), '', 'disabled site → no count');
  await send({ type: MSG.SET_SITE_DISABLED, hostname: 'taobao.com', disabled: false });
  await send({ type: MSG.REPORT_COUNT, count: 'garbage' }, tabSender(14));
  assert.equal(badge.shown(14), '');
});

test('OPEN_OPTIONS: openOptionsPage, or a tab with a sanitised #section', async () => {
  const before = log.optionsOpened;
  assert.deepEqual(await send({ type: MSG.OPEN_OPTIONS }), { ok: true });
  assert.equal(log.optionsOpened, before + 1);
  await send({ type: MSG.OPEN_OPTIONS, section: 'sites' });
  assert.equal(log.tabsCreated.at(-1), 'chrome-extension://transprice-test/src/options/options.html#sites');
  await send({ type: MSG.OPEN_OPTIONS, section: '#rates"><img>' });
  assert.equal(log.tabsCreated.at(-1), 'chrome-extension://transprice-test/src/options/options.html#ratesimg');
});

test('unknown, content-script-only and malformed messages get no answer from the worker', async () => {
  assert.equal(await send({ type: 'nope' }), undefined);
  assert.equal(await send({ type: MSG.GET_PAGE_INFO }), undefined);
  assert.equal(await send({ type: MSG.RESCAN }), undefined);
  assert.equal(await send(null), undefined);
  assert.equal(await send('get-state'), undefined);
  assert.equal(await send({ type: 42 }), undefined);
});

test('command toggle-enabled: flips enabled, badge shows "off" everywhere, and back', async () => {
  await send({ type: MSG.REPORT_COUNT, count: 9 }, tabSender(21));
  assert.equal(badge.shown(21), '9');
  chrome.commands.onCommand.dispatch('toggle-enabled');
  await until(() => settings().enabled === false && badge.global.text === 'off');
  assert.equal(badge.global.color, '#6B7280');
  assert.equal(badge.shown(21), 'off', 'per-tab count cleared so the global "off" shows');

  await send({ type: MSG.REPORT_COUNT, count: 9 }, tabSender(21));
  assert.equal(badge.shown(21), 'off', 'no counts while off');

  chrome.commands.onCommand.dispatch('toggle-enabled');
  await until(() => settings().enabled === true && badge.global.text === '');
  assert.equal(badge.global.color, '#B45309');

  chrome.commands.onCommand.dispatch('_execute_action');
  chrome.commands.onCommand.dispatch('something-else');
  await flush(10);
  assert.equal(settings().enabled, true);
});

test('settings written elsewhere (page / other device): badge and uiLanguage mirror follow', async () => {
  await chrome.storage.sync.set({ settings: { ...settings(), enabled: false, uiLanguage: 'vi' } });
  await until(() => badge.global.text === 'off' && areas.local[STORAGE_KEYS.UI_LANGUAGE] === 'vi');
  await chrome.storage.sync.set({ settings: { ...settings(), enabled: true, uiLanguage: 'auto' } });
  await until(() => badge.global.text === '' && areas.local[STORAGE_KEYS.UI_LANGUAGE] === 'auto');
});

test('tabs.onActivated refreshes the badge; tabs.onRemoved forgets the tab', async () => {
  badge.global.color = 'stale';
  chrome.tabs.onActivated.dispatch({ tabId: 1, windowId: 1 });
  await until(() => badge.global.color === '#B45309');

  await send({ type: MSG.REPORT_COUNT, count: 3 }, tabSender(31));
  assert.ok(areas.session.badgeTabs.includes(31));
  chrome.tabs.onRemoved.dispatch(31, { windowId: 1, isWindowClosing: false });
  await until(() => !areas.session.badgeTabs.includes(31));
});

test('onInstalled(install): welcome page, alarm (re)created, rates refreshed; update: no welcome', async () => {
  alarms.clear();
  const fetches = fetchMock.calls.length;
  chrome.runtime.onInstalled.dispatch({ reason: 'install' });
  await until(() => alarms.has(sw.RATES_ALARM) && fetchMock.calls.length > fetches && !sw.rates.inflight);
  assert.equal(log.tabsCreated.at(-1), 'chrome-extension://transprice-test/src/welcome/welcome.html');
  assert.equal(alarms.get(sw.RATES_ALARM).periodInMinutes, LIMITS.RATES_ALARM_MINUTES);

  const tabs = log.tabsCreated.length;
  chrome.runtime.onInstalled.dispatch({ reason: 'update', previousVersion: '0.0.9' });
  await until(() => fetchMock.calls.length > fetches + 1 && !sw.rates.inflight);
  await flush(10);
  assert.equal(log.tabsCreated.length, tabs, 'no welcome tab on update');
});

test('onStartup: alarm ensured; rates fetched only when stale', async () => {
  alarms.clear();
  areas.local.rates = ratesTable({ fetchedAt: Date.now() });
  let fetches = fetchMock.calls.length;
  chrome.runtime.onStartup.dispatch();
  await until(() => alarms.has(sw.RATES_ALARM));
  await flush(10);
  assert.equal(fetchMock.calls.length, fetches, 'fresh → no fetch');

  areas.local.rates = ratesTable({ fetchedAt: Date.now() - LIMITS.RATES_TTL_MS - 1000 });
  fetches = fetchMock.calls.length;
  chrome.runtime.onStartup.dispatch();
  await until(() => fetchMock.calls.length > fetches && areas.local.rates.source === 'currency-api' && !sw.rates.inflight);
});

test('alarm: the refresh alarm fetches, other alarms are ignored', async () => {
  const fetches = fetchMock.calls.length;
  chrome.alarms.onAlarm.dispatch({ name: 'something-else' });
  await flush(10);
  assert.equal(fetchMock.calls.length, fetches);
  chrome.alarms.onAlarm.dispatch({ name: sw.RATES_ALARM, scheduledTime: Date.now() });
  await until(() => fetchMock.calls.length === fetches + 1 && !sw.rates.inflight);
});

test('REFRESH_RATES when every source fails → error envelope; GET_STATE still serves the stored table', async () => {
  net.mode = 'fail';
  const before = fetchMock.calls.length;
  const r = await send({ type: MSG.REFRESH_RATES });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NETWORK');
  assert.equal(r.error.details.attempts.length, RATE_SOURCES.length);
  assert.equal(fetchMock.calls.length, before + RATE_SOURCES.length);
  const state = await send({ type: MSG.GET_STATE });
  assert.equal(state.ok, true);
  assert.equal(state.rates.source, 'currency-api');
  net.mode = 'ok';
});
