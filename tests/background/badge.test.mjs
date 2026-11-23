/** badge.js: count formatting, on/off states, per-tab texts tracked in storage.session and cleared when off. */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGE_COLORS,
  SESSION_KEY,
  forgetTab,
  formatCount,
  refreshBadge,
  resetBadgeCache,
  setTabCount,
  trackedTabs,
} from '../../extension/src/background/badge.js';
import { createChromeMock } from './helpers.mjs';

let mock;
const ON = { enabled: true };
const OFF = { enabled: false };

beforeEach(() => {
  mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  resetBadgeCache();
});

describe('formatCount', () => {
  test('0/invalid → empty, integers as-is, 999+ cap', () => {
    assert.equal(formatCount(0), '');
    assert.equal(formatCount(-3), '');
    assert.equal(formatCount(NaN), '');
    assert.equal(formatCount('abc'), '');
    assert.equal(formatCount(undefined), '');
    assert.equal(formatCount(1), '1');
    assert.equal(formatCount(12.9), '12');
    assert.equal(formatCount('42'), '42');
    assert.equal(formatCount(999), '999');
    assert.equal(formatCount(1000), '999+');
    assert.equal(formatCount(123456), '999+');
  });
});

describe('global state', () => {
  test('enabled → empty text on the brand colour, default title', async () => {
    await refreshBadge(ON);
    assert.equal(mock.badge.global.text, '');
    assert.equal(mock.badge.global.color, BADGE_COLORS.brand);
    assert.equal(BADGE_COLORS.brand, '#B45309');
    assert.equal(mock.badge.global.textColor, '#FFFFFF');
    assert.equal(mock.badge.global.title, 'TransPrice');
  });

  test('disabled → "off" on grey with an explanatory title', async () => {
    await refreshBadge(OFF);
    assert.equal(mock.badge.global.text, 'off');
    assert.equal(mock.badge.global.color, BADGE_COLORS.off);
    assert.equal(mock.badge.global.title, 'TransPrice — paused on all sites');
  });

  test('colours are only ever set globally (per-tab colours cannot be reset)', async () => {
    await refreshBadge(ON);
    await setTabCount(3, 5, ON);
    await refreshBadge(OFF);
    assert.ok(mock.log.badgeCalls.filter((c) => c.method === 'setBadgeBackgroundColor').every((c) => c.tabId === undefined));
  });
});

describe('per-tab counts', () => {
  test('count shown on the tab and tracked in storage.session', async () => {
    await refreshBadge(ON);
    await setTabCount(5, 24, ON);
    await setTabCount(6, 1500, ON);
    assert.equal(mock.badge.shown(5), '24');
    assert.equal(mock.badge.shown(6), '999+');
    assert.equal(mock.badge.shown(7), '', 'other tabs show the global (empty) text');
    assert.deepEqual(mock.areas.session[SESSION_KEY], [5, 6]);
    const sessionWrites = mock.log.writes.session;
    await setTabCount(5, 25, ON);
    assert.equal(mock.badge.shown(5), '25');
    assert.equal(mock.log.writes.session, sessionWrites, 'already tracked → no session write');
  });

  test('count 0, inactive site or extension off → per-tab text reset to the global one, untracked', async () => {
    await setTabCount(5, 24, ON);
    await setTabCount(5, 0, ON);
    assert.equal(mock.badge.tabs.has(5), false);
    await setTabCount(6, 10, ON, { active: false });
    assert.equal(mock.badge.tabs.has(6), false);
    await refreshBadge(OFF);
    await setTabCount(7, 10, OFF);
    assert.equal(mock.badge.shown(7), 'off');
    assert.deepEqual(await trackedTabs(), []);
  });

  test('turning off clears every per-tab text so "off" shows everywhere; on again → counts come back via reports', async () => {
    await refreshBadge(ON);
    await setTabCount(5, 24, ON);
    await setTabCount(6, 3, ON);
    await refreshBadge(OFF);
    assert.equal(mock.badge.shown(5), 'off');
    assert.equal(mock.badge.shown(6), 'off');
    assert.deepEqual(mock.areas.session[SESSION_KEY], []);
    await refreshBadge(ON);
    assert.equal(mock.badge.shown(5), '');
    await setTabCount(5, 2, ON);
    assert.equal(mock.badge.shown(5), '2');
  });

  test('tracked tabs survive a service-worker restart (storage.session)', async () => {
    await setTabCount(5, 24, ON);
    resetBadgeCache(); // new worker instance: memory gone, session storage kept
    await refreshBadge(OFF);
    assert.equal(mock.badge.shown(5), 'off');
  });

  test('forgetTab drops a closed tab; invalid tab ids are ignored', async () => {
    await setTabCount(5, 1, ON);
    await setTabCount(8, 1, ON);
    await forgetTab(5);
    assert.deepEqual(await trackedTabs(), [8]);
    const calls = mock.log.badgeCalls.length;
    await setTabCount(-1, 3, ON);
    await setTabCount(undefined, 3, ON);
    await setTabCount(1.5, 3, ON);
    assert.equal(mock.log.badgeCalls.length, calls);
  });

  test('concurrent reports keep the tracked set consistent', async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map((id) => setTabCount(id, id, ON)));
    assert.deepEqual(
      [...mock.areas.session[SESSION_KEY]].sort(),
      [1, 2, 3, 4, 5, 6],
    );
  });

  test('a closed tab ("No tab with id") does not throw', async () => {
    mock.behaviour.badgeError = new Error('No tab with id: 5.');
    await setTabCount(5, 3, ON);
    await refreshBadge(OFF);
  });
});

describe('without chrome.action / storage.session (dev harness)', () => {
  test('every call is a harmless no-op', async () => {
    globalThis.chrome = { storage: {}, i18n: { getMessage: () => '' } };
    resetBadgeCache();
    await refreshBadge(ON);
    await setTabCount(5, 24, ON);
    assert.deepEqual(await trackedTabs(), [5], 'tracked in memory');
    await refreshBadge(OFF);
    assert.deepEqual(await trackedTabs(), []);
    globalThis.chrome = undefined;
    await refreshBadge(OFF);
  });
});
