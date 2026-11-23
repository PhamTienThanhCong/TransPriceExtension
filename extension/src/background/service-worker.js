/**
 * TransPrice — background service worker (ES module). See docs/ARCHITECTURE.md §3.4 and §5.
 *
 * Every listener is registered synchronously at top level so events that wake the worker are never missed.
 * The same file is also loaded by dev pages on top of a fake chrome.* (dev/chrome-mock.js): optional APIs
 * (alarms, commands, action, tabs events, session storage) are guarded and no service-worker global is assumed.
 */
import { AMBIGUOUS_SYMBOLS, ERROR_CODES, LIMITS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import { createHandler, makeError, sendToTab } from '../shared/messaging.js';
import {
  getSettings,
  isSiteActive,
  isSiteMatch,
  mirrorUiLanguage,
  normalizeHostname,
  normalizeSettings,
  siteKey,
  updateSettings,
} from '../shared/storage.js';
import { createRatesService } from './rates.js';
import { forgetTab, refreshBadge, setTabCount } from './badge.js';

export const RATES_ALARM = 'transprice-refresh-rates';
const WELCOME_PAGE = 'src/welcome/welcome.html';
const OPTIONS_PAGE = 'src/options/options.html';

const logError = (label) => (err) => console.warn(`[TransPrice] ${label}:`, err?.message || err);

export const rates = createRatesService();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Hostname of the web page that sent a message (content script → its frame URL); '' for extension pages. */
function hostFromSender(sender) {
  for (const url of [sender?.url, sender?.tab?.url]) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const host = normalizeHostname(parsed.hostname);
      if (host) return host;
    } catch {
      /* not a URL */
    }
  }
  return '';
}

/** `msg.hostname` (normalised), else the sender's page. Throws BAD_REQUEST when neither is usable. */
function requireHostname(msg, sender) {
  const host = normalizeHostname(msg.hostname) || (msg.hostname ? '' : hostFromSender(sender));
  if (!host) throw makeError(ERROR_CODES.BAD_REQUEST, 'A valid hostname is required');
  return host;
}

/**
 * The per-site part of isSiteActive() (ignores the global master switch): is the host turned on by the site rules?
 * @param {object} settings  validated settings
 * @param {string} hostname
 */
export function isSiteRuleActive(settings, hostname) {
  return isSiteActive({ ...settings, enabled: true }, hostname);
}

/**
 * Patch that turns conversion on/off for a site (§3.5), or null if nothing changes.
 *  - allowlist: on → add siteKey(host) to enabledSites; off → remove every enabledSites rule covering the host.
 *  - all:       off → add siteKey(host) to disabledSites; on → remove every disabledSites rule covering the host.
 * Adding a key also drops the entries it now covers (`world.taobao.com` once `taobao.com` is added).
 * PURE (exported for tests).
 * @param {object} settings  validated settings
 * @param {string} hostname  normalised hostname
 * @param {boolean} active
 * @returns {object|null}
 */
export function siteActivePatch(settings, hostname, active) {
  const listName = settings.siteMode === 'allowlist' ? 'enabledSites' : 'disabledSites';
  const list = settings[listName];
  const addRule = settings.siteMode === 'allowlist' ? active : !active;
  if (addRule) {
    if (isSiteMatch(hostname, list)) return null; // already covered by a rule
    const key = siteKey(hostname) || hostname;
    return { [listName]: [...list.filter((site) => !isSiteMatch(site, [key])), key] };
  }
  const kept = list.filter((site) => !isSiteMatch(hostname, [site]));
  return kept.length === list.length ? null : { [listName]: kept };
}

/**
 * SET_SITE_ACTIVE (atomic w.r.t. other updates from this worker). `resume`: turning a site on also lifts the
 * global pause (used by the keyboard command, where "on" must visibly mean on).
 */
function setSiteActive(hostname, active, { resume = false } = {}) {
  return updateSettings((current) => {
    const patch = siteActivePatch(current, hostname, active) || {};
    if (active && resume && !current.enabled) patch.enabled = true;
    return patch;
  });
}

/**
 * Pin (or un-pin with `currency: null`) what an ambiguous symbol means on a site. Pins are stored on the exact
 * host; un-pinning also removes the symbol from parent-domain pins that cover the host, so the site really
 * goes back to automatic detection.
 */
function setSiteCurrency(hostname, symbol, currency) {
  return updateSettings((current) => {
    const map = { ...current.siteCurrency };
    if (currency) {
      map[hostname] = { ...(map[hostname] || {}), [symbol]: currency };
    } else {
      for (const key of Object.keys(map)) {
        if (!isSiteMatch(hostname, [key]) || !(symbol in map[key])) continue;
        const { [symbol]: _removed, ...rest } = map[key];
        if (Object.keys(rest).length) map[key] = rest;
        else delete map[key];
      }
    }
    return { siteCurrency: map };
  });
}

async function openOptions(section) {
  const clean = typeof section === 'string' ? section.replace(/^#/, '').replace(/[^\w-]/g, '') : '';
  if (!clean && typeof chrome.runtime.openOptionsPage === 'function') {
    await chrome.runtime.openOptionsPage();
    return;
  }
  // openOptionsPage() can't carry a fragment: open the page in a tab with #section instead.
  const page = chrome.runtime.getManifest?.()?.options_ui?.page || OPTIONS_PAGE;
  await chrome.tabs.create({ url: chrome.runtime.getURL(`${page}${clean ? `#${clean}` : ''}`) });
}

/**
 * Keyboard command `toggle-enabled` (§3.5): toggle conversion on the CURRENT site. The hostname comes from the
 * tab's content script (GET_PAGE_INFO, top frame) — no `tabs` permission needed. Tabs without a content script
 * (chrome://, Web Store, tabs opened before install) are ignored quietly.
 * @param {{id?: number}} [tab]  the tab Chrome passes to commands.onCommand (falls back to the active tab)
 * @returns {Promise<object|null>} the new settings, or null when nothing was toggled
 */
export async function toggleCurrentSite(tab) {
  let tabId = tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0) {
    const [active] = (await chrome.tabs?.query?.({ active: true, lastFocusedWindow: true })) || [];
    tabId = active?.id;
  }
  if (!Number.isInteger(tabId) || tabId < 0 || typeof chrome.tabs?.sendMessage !== 'function') return null;
  let info = null;
  try {
    info = await sendToTab(tabId, MSG.GET_PAGE_INFO, {}, { frameId: 0 });
  } catch {
    info = null; // no / broken content script
  }
  const hostname = normalizeHostname(info?.hostname);
  if (!hostname) return null;
  const settings = await getSettings();
  return setSiteActive(hostname, !isSiteRuleActive(settings, hostname), { resume: true });
}

/* ------------------------------------------------------------------ */
/* Message handlers (envelopes via createHandler)                      */
/* ------------------------------------------------------------------ */

export const handlers = {
  [MSG.GET_STATE]: async () => {
    const [settings, table] = await Promise.all([getSettings(), rates.getRates()]);
    return { settings, rates: table };
  },

  [MSG.REFRESH_RATES]: async () => ({ rates: await rates.getRates({ force: true }) }),

  [MSG.UPDATE_SETTINGS]: async (msg) => {
    if (!isPlainObject(msg.patch)) throw makeError(ERROR_CODES.BAD_REQUEST, '`patch` must be an object');
    return { settings: await updateSettings(msg.patch) };
  },

  [MSG.SET_SITE_ACTIVE]: async (msg, sender) => {
    if (typeof msg.active !== 'boolean') throw makeError(ERROR_CODES.BAD_REQUEST, '`active` must be a boolean');
    return { settings: await setSiteActive(requireHostname(msg, sender), msg.active) };
  },

  [MSG.SET_SITE_CURRENCY]: async (msg, sender) => {
    const allowed = Object.prototype.hasOwnProperty.call(AMBIGUOUS_SYMBOLS, msg.symbol) ? AMBIGUOUS_SYMBOLS[msg.symbol] : null;
    if (!allowed) throw makeError(ERROR_CODES.BAD_REQUEST, '`symbol` must be "dollar" or "yen"');
    const host = requireHostname(msg, sender);
    let currency = null;
    if (msg.currency != null && msg.currency !== '') {
      currency = typeof msg.currency === 'string' ? msg.currency.trim().toUpperCase() : '';
      if (!allowed.includes(currency)) {
        throw makeError(ERROR_CODES.UNSUPPORTED_CURRENCY, `${String(msg.currency)} is not a valid meaning of the ${msg.symbol} sign`);
      }
    }
    return { settings: await setSiteCurrency(host, msg.symbol, currency) };
  },

  [MSG.REPORT_COUNT]: async (msg, sender) => {
    const tabId = sender?.tab?.id;
    // Only top-frame content scripts own the tab badge; messages from extension pages have no tab.
    if (!Number.isInteger(tabId) || tabId < 0 || (Number.isInteger(sender.frameId) && sender.frameId !== 0)) return {};
    const settings = await getSettings();
    const host = hostFromSender(sender);
    // Inactive site → empty badge (§3.5). The content script reports 0 there anyway; this guards against races.
    const active = host ? isSiteActive(settings, host) : true;
    await setTabCount(tabId, msg.count, settings, { active });
    return {};
  },

  [MSG.OPEN_OPTIONS]: async (msg) => {
    await openOptions(msg.section);
    return {};
  },
};

const handleMessage = createHandler(handlers);

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Create the periodic refresh alarm if it doesn't exist (alarms may be cleared on browser restart). */
async function ensureAlarm({ reset = false } = {}) {
  const alarms = globalThis.chrome?.alarms;
  if (!alarms?.create) return;
  if (!reset && typeof alarms.get === 'function') {
    const existing = await alarms.get(RATES_ALARM);
    if (existing) return;
  }
  await alarms.create(RATES_ALARM, {
    delayInMinutes: LIMITS.RATES_ALARM_MINUTES,
    periodInMinutes: LIMITS.RATES_ALARM_MINUTES,
  });
}

/** Badge + uiLanguage mirror from the current settings. */
async function syncUi(settings) {
  const s = settings || (await getSettings());
  await Promise.all([refreshBadge(s), mirrorUiLanguage(s.uiLanguage)]);
  return s;
}

async function onInstalled({ reason } = {}) {
  if (reason === 'install') {
    chrome.tabs?.create?.({ url: chrome.runtime.getURL(WELCOME_PAGE) })?.catch?.(logError('open welcome'));
  }
  await Promise.all([
    ensureAlarm({ reset: true }).catch(logError('alarm')),
    rates.refresh().catch(logError('rates')),
    syncUi().catch(logError('badge')),
  ]);
}

async function onStartup() {
  await Promise.all([
    ensureAlarm().catch(logError('alarm')),
    rates.refreshIfStale().catch(logError('rates')),
    syncUi().catch(logError('badge')),
  ]);
}

/* ------------------------------------------------------------------ */
/* Listener registration (synchronous, top level)                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isPlainObject(message) || typeof message.type !== 'string') return false;
  return handleMessage(message, sender, sendResponse);
});

chrome.runtime.onInstalled?.addListener((details) => {
  onInstalled(details).catch(logError('onInstalled'));
});

chrome.runtime.onStartup?.addListener(() => {
  onStartup().catch(logError('onStartup'));
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === RATES_ALARM) rates.refresh().catch(logError('scheduled rates refresh'));
});

chrome.commands?.onCommand?.addListener((command, tab) => {
  if (command === 'toggle-enabled') toggleCurrentSite(tab).catch(logError('toggle-enabled'));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes?.[STORAGE_KEYS.SETTINGS]) return;
  // Covers every writer: this worker, extension pages, and other devices via Chrome sync.
  syncUi(normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue)).catch(logError('settings changed'));
});

chrome.tabs?.onActivated?.addListener(() => {
  getSettings().then(refreshBadge).catch(logError('tab activated'));
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  forgetTab(tabId).catch(logError('tab removed'));
});

// Every time the worker starts (also after disable → enable, where neither onInstalled nor onStartup fire).
ensureAlarm().catch(logError('alarm'));
syncUi().catch(logError('init'));
