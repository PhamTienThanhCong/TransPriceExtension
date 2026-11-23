/**
 * TransPrice — toolbar badge (docs/ARCHITECTURE.md §5).
 *
 *  - enabled, site active, count > 0 → per-tab text = the count ('999+' cap) on the brand colour
 *  - settings.enabled === false      → global text 'off' on grey (every per-tab text is cleared)
 *  - otherwise                       → empty
 *
 * Chrome shows a tab's own badge text instead of the global one, so a per-tab count would hide the global 'off'.
 * We therefore remember which tabs carry a per-tab text (chrome.storage.session survives service-worker restarts)
 * and reset them (`text: null` = "use the global text") when the extension is turned off.
 * The background colour is only ever set globally (brand while on, grey while off): per-tab colours can't be reset.
 * Every chrome.action call is guarded so this module also runs on top of the dev harness' fake chrome.*.
 */

export const BADGE_COLORS = Object.freeze({ brand: '#B45309', off: '#6B7280', text: '#FFFFFF' });
export const BADGE_OFF_TEXT = 'off';
export const MAX_BADGE_COUNT = 999;

/** chrome.storage.session key: tab ids that currently have a per-tab badge text. */
export const SESSION_KEY = 'badgeTabs';

const warn = (label, err) => console.warn(`[TransPrice] badge ${label}:`, err?.message || err);

/**
 * Badge text for a price count: '' for 0 / invalid, '1'…'999', then '999+'.
 * @param {number} count
 * @returns {string}
 */
export function formatCount(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(n);
}

/* ------------------------------------------------------------------ */
/* Tracked tab ids (chrome.storage.session, in-memory fallback)        */
/* ------------------------------------------------------------------ */

let memoryTabs = null; // Set<number> cache; null = not loaded yet
let chain = Promise.resolve(); // serialises read-modify-write of the tracked set

const session = () => globalThis.chrome?.storage?.session || null;

async function loadTabs() {
  if (memoryTabs) return memoryTabs;
  let ids = [];
  try {
    const data = await session()?.get(SESSION_KEY);
    if (Array.isArray(data?.[SESSION_KEY])) ids = data[SESSION_KEY].filter((id) => Number.isInteger(id) && id >= 0);
  } catch {
    /* session storage unavailable (dev harness) → memory only */
  }
  memoryTabs = new Set(ids);
  return memoryTabs;
}

async function saveTabs(tabs) {
  try {
    await session()?.set({ [SESSION_KEY]: [...tabs] });
  } catch {
    /* memory only */
  }
}

/** Run `fn(trackedSet)` exclusively; persists the set afterwards if `fn` returns true. */
function withTabs(fn) {
  const run = async () => {
    const tabs = await loadTabs();
    if (await fn(tabs)) await saveTabs(tabs);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------------------ */
/* chrome.action wrappers                                              */
/* ------------------------------------------------------------------ */

const action = () => globalThis.chrome?.action || null;

async function call(method, details) {
  const api = action();
  if (typeof api?.[method] !== 'function') return;
  try {
    await api[method](details);
  } catch (err) {
    // Closed tabs ("No tab with id") are expected; anything else is worth a warning.
    if (!/no tab with id/i.test(String(err?.message))) warn(method, err);
  }
}

const offTitle = () => {
  try {
    return globalThis.chrome?.i18n?.getMessage?.('bg_action_title_off') || '';
  } catch {
    return '';
  }
};
const defaultTitle = () => {
  try {
    return globalThis.chrome?.i18n?.getMessage?.('actionTitle') || '';
  } catch {
    return '';
  }
};

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Apply the global badge state for `settings` (on: empty text, brand colour; off: 'off' on grey) and, when off,
 * clear every per-tab count so the global 'off' is visible in every tab.
 * @param {{enabled: boolean}} settings
 */
export async function refreshBadge(settings) {
  const off = settings?.enabled === false;
  await call('setBadgeBackgroundColor', { color: off ? BADGE_COLORS.off : BADGE_COLORS.brand });
  await call('setBadgeTextColor', { color: BADGE_COLORS.text });
  await call('setBadgeText', { text: off ? BADGE_OFF_TEXT : '' });
  const title = off ? offTitle() : defaultTitle();
  if (title) await call('setTitle', { title });
  if (off) {
    await withTabs(async (tabs) => {
      if (!tabs.size) return false;
      const ids = [...tabs];
      tabs.clear();
      await Promise.all(ids.map((tabId) => call('setBadgeText', { tabId, text: null })));
      return true;
    });
  }
}

/**
 * Show `count` on `tabId` (REPORT_COUNT). Nothing is shown when the extension is off or the site is inactive
 * (`active: false`) or the count is 0 — the tab then falls back to the global text.
 * @param {number} tabId
 * @param {number} count
 * @param {{enabled: boolean}} settings
 * @param {{active?: boolean}} [options]  false when the tab's site is in disabledSites
 */
export async function setTabCount(tabId, count, settings, { active = true } = {}) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const text = settings?.enabled !== false && active ? formatCount(count) : '';
  await withTabs(async (tabs) => {
    if (text) {
      await call('setBadgeText', { tabId, text });
      if (tabs.has(tabId)) return false;
      tabs.add(tabId);
      return true;
    }
    await call('setBadgeText', { tabId, text: null }); // back to the global text ('' or 'off')
    return tabs.delete(tabId);
  });
}

/**
 * Forget a closed tab (tabs.onRemoved). Chrome drops its badge state itself.
 * @param {number} tabId
 */
export function forgetTab(tabId) {
  return withTabs(async (tabs) => tabs.delete(tabId));
}

/** Tab ids currently tracked as having a per-tab text (tests / diagnostics). */
export async function trackedTabs() {
  await chain;
  return [...(await loadTabs())];
}

/** Drop the in-memory cache (tests: simulate a service-worker restart). */
export function resetBadgeCache() {
  memoryTabs = null;
}
