/**
 * The service worker is also loaded by dev pages on top of a minimal fake chrome.* (dev/chrome-mock.js):
 * it must load and answer messages without alarms, commands, action, tabs events or storage.session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG } from '../../extension/src/shared/constants.js';
import { createChromeMock, currencyApiBody, flush, jsonResponse, until } from './helpers.mjs';

test('loads on a bare chrome.* and answers GET_STATE / UPDATE_SETTINGS / REPORT_COUNT', async () => {
  const full = createChromeMock({ uiLanguage: 'ja' });
  const { chrome: c, areas } = full;
  // Only what the dev mock is guaranteed to provide.
  const bare = {
    runtime: { id: 'dev', onMessage: c.runtime.onMessage, getURL: c.runtime.getURL },
    storage: { sync: c.storage.sync, local: c.storage.local, onChanged: c.storage.onChanged },
    i18n: { getUILanguage: () => 'ja', getMessage: () => '' },
  };
  globalThis.chrome = bare;
  globalThis.fetch = async () => jsonResponse(currencyApiBody());
  Object.defineProperty(globalThis, 'navigator', { value: { languages: ['ja'] }, configurable: true, writable: true });

  await import('../../extension/src/background/service-worker.js');
  await flush(10);

  const state = await full.sendToBackground({ type: MSG.GET_STATE });
  assert.equal(state.ok, true);
  assert.equal(state.settings.homeCurrency, 'JPY');
  assert.ok(state.rates.rates.USD === 1);
  await until(() => areas.local.rates);

  const upd = await full.sendToBackground({ type: MSG.UPDATE_SETTINGS, patch: { enabled: false } });
  assert.equal(upd.settings.enabled, false);
  await flush(10); // storage.onChanged → badge refresh must not throw without chrome.action

  const rep = await full.sendToBackground({ type: MSG.REPORT_COUNT, count: 3 }, { id: 'dev', url: 'http://localhost:5180/dev/demo.html', tab: { id: 1 } });
  assert.deepEqual(rep, { ok: true });

  const opt = await full.sendToBackground({ type: MSG.OPEN_OPTIONS, section: 'rates' });
  assert.equal(opt.ok, false, 'no tabs API → error envelope, not a crash');
});
