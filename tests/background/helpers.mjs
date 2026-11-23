/** Shared helpers for the background tests (not a test file itself): in-memory chrome.* mock, fetch mocks. */

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A chrome.events.Event look-alike. `dispatch(...)` calls every listener and returns their return values. */
export function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    hasListeners: () => listeners.length > 0,
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
  };
}

const MESSAGES = {
  actionTitle: 'TransPrice',
  bg_action_title_off: 'TransPrice — paused on all sites',
};

/**
 * In-memory chrome.* with the APIs the background uses. `log` records side effects; `areas` is the raw storage;
 * `badge.shown(tabId)` is what the toolbar would display for a tab (per-tab text, else the global one).
 * @param {{uiLanguage?: string}} [options]
 */
export function createChromeMock({ uiLanguage = 'en-US' } = {}) {
  const log = { tabsCreated: [], optionsOpened: 0, writes: { sync: 0, local: 0, session: 0 }, badgeCalls: [], tabMessages: [] };
  const areas = { sync: {}, local: {}, session: {} };
  const onChanged = event();

  const storageArea = (name) => ({
    async get(keys) {
      const data = areas[name];
      if (keys == null) return clone(data);
      if (typeof keys === 'string' || Array.isArray(keys)) {
        const list = [].concat(keys);
        return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      }
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d]));
    },
    async set(items) {
      log.writes[name]++;
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        if (!same(areas[name][k], v)) changes[k] = { oldValue: clone(areas[name][k]), newValue: clone(v) };
        areas[name][k] = clone(v);
      }
      // Like Chrome: only real changes are reported, asynchronously.
      if (Object.keys(changes).length) queueMicrotask(() => onChanged.dispatch(changes, name));
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (k in areas[name]) changes[k] = { oldValue: clone(areas[name][k]) };
        delete areas[name][k];
      }
      if (Object.keys(changes).length) queueMicrotask(() => onChanged.dispatch(changes, name));
    },
  });

  const badge = {
    global: { text: '', color: null, textColor: null, title: null },
    tabs: new Map(), // tabId → per-tab text
    shown(tabId) {
      return badge.tabs.has(tabId) ? badge.tabs.get(tabId) : badge.global.text;
    },
  };

  const alarms = new Map();
  const behaviour = {
    tabs: [
      { id: 1, active: true },
      { id: 2, active: false },
    ],
    badgeError: null,
    /** Content-script answer to chrome.tabs.sendMessage (default: no content script in the tab). */
    tabSendMessage: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };

  const chrome = {
    runtime: {
      id: 'transprice-test',
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      getURL: (p) => `chrome-extension://transprice-test/${String(p).replace(/^\//, '')}`,
      getManifest: () => ({ manifest_version: 3, options_ui: { page: 'src/options/options.html' } }),
      openOptionsPage: async () => {
        log.optionsOpened++;
      },
    },
    storage: { sync: storageArea('sync'), local: storageArea('local'), session: storageArea('session'), onChanged },
    i18n: {
      getUILanguage: () => uiLanguage,
      getMessage: (key) => MESSAGES[key] || '',
    },
    alarms: {
      onAlarm: event(),
      create: async (name, info) => {
        alarms.set(name, { name, ...info });
      },
      get: async (name) => (alarms.has(name) ? { ...alarms.get(name) } : undefined),
      clear: async (name) => alarms.delete(name),
    },
    commands: { onCommand: event() },
    tabs: {
      onActivated: event(),
      onRemoved: event(),
      create: async (props) => {
        log.tabsCreated.push(props.url);
        return { id: 99, ...props };
      },
      query: async (q = {}) => behaviour.tabs.filter((t) => q.active === undefined || t.active === q.active).map((t) => ({ ...t })),
      sendMessage: async (tabId, msg, opts) => {
        log.tabMessages.push({ tabId, msg, opts });
        return behaviour.tabSendMessage(tabId, msg, opts);
      },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        log.badgeCalls.push({ method: 'setBadgeText', tabId, text });
        if (behaviour.badgeError) throw behaviour.badgeError;
        if (tabId === undefined) badge.global.text = text ?? '';
        else if (text === null || text === undefined) badge.tabs.delete(tabId);
        else badge.tabs.set(tabId, text);
      },
      setBadgeBackgroundColor: async ({ tabId, color }) => {
        log.badgeCalls.push({ method: 'setBadgeBackgroundColor', tabId, color });
        if (tabId !== undefined) throw new Error('test: per-tab colours are not expected');
        badge.global.color = color;
      },
      setBadgeTextColor: async ({ color }) => {
        badge.global.textColor = color;
      },
      setTitle: async ({ title }) => {
        badge.global.title = title;
      },
    },
  };

  /** Deliver a runtime message to the listeners like Chrome; resolves with the response (undefined = no answer). */
  const sendToBackground = (message, sender = { id: 'transprice-test', url: 'chrome-extension://transprice-test/src/popup/popup.html' }) =>
    new Promise((resolve) => {
      let pending = false;
      let answered = false;
      const respond = (r) => {
        if (!answered) {
          answered = true;
          resolve(r);
        }
      };
      for (const fn of chrome.runtime.onMessage.listeners) if (fn(message, sender, respond) === true) pending = true;
      if (!pending) respond(undefined);
    });

  return { chrome, log, areas, badge, alarms, behaviour, sendToBackground };
}

/** Sender of a top-frame content script in tab `tabId` on `url`. */
export const tabSender = (tabId, url = 'https://world.taobao.com/item/1', frameId = 0) => ({
  id: 'transprice-test',
  url,
  frameId,
  tab: { id: tabId, url, active: true },
});

/** Let pending microtasks/timers run. */
export const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Repeat flush until `predicate()` is true (max ~1 s). */
export async function until(predicate, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return true;
    await flush(10);
  }
  throw new Error('until(): condition never became true');
}

/* ------------------------------------------------------------------ */
/* fetch mocks                                                         */
/* ------------------------------------------------------------------ */

export const jsonResponse = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/**
 * Mock fetch. `routes` = [[matcher, handler], …]; matcher is a substring or RegExp tested against the URL;
 * handler(url, init) returns a Response (or a promise) or throws to simulate a network error.
 * `fetchImpl.calls` records every request URL; `fetchImpl.count(sub)` counts requests containing `sub`.
 */
export function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [matcher, handler] of routes) {
      if (typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u)) return handler(u, init);
    }
    throw new TypeError(`fetch failed: no mock route for ${u}`);
  };
  fetchImpl.calls = calls;
  fetchImpl.count = (sub = '') => calls.filter((c) => c.url.includes(sub)).length;
  return fetchImpl;
}

/** A fetch that never settles until aborted (exercises timeouts). */
export const hangingFetch = (url, init = {}) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

/** A promise you resolve from outside. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------ */
/* Provider fixtures (shapes copied from the live APIs, trimmed)       */
/* ------------------------------------------------------------------ */

export const HOSTS = {
  currencyApi: 'cdn.jsdelivr.net',
  mirror: 'latest.currency-api.pages.dev',
  erApi: 'open.er-api.com',
};

/** fawazahmed0 currency-api: lowercase codes, includes crypto/metals. */
export const currencyApiBody = (overrides = {}) => ({
  date: '2026-11-22',
  usd: {
    '1inch': 5.1,
    aed: 3.6725,
    btc: 0.00001698574,
    cny: 6.6729035,
    eur: 0.91158016,
    gbp: 0.76429717,
    jpy: 158.55921,
    krw: 1346.0375,
    usd: 1,
    vnd: 25788.84767895,
    xau: 0.00025,
    ...overrides,
  },
});

/** open.er-api.com v6: uppercase codes, unix timestamps. 1795305600 = 2026-11-22T00:00:00Z. */
export const erApiBody = (overrides = {}) => ({
  result: 'success',
  provider: 'https://www.exchangerate-api.com',
  time_last_update_unix: 1795305600,
  time_last_update_utc: 'Sun, 22 Nov 2026 00:00:01 +0000',
  base_code: 'USD',
  rates: { USD: 1, AED: 3.6725, CNY: 6.67, EUR: 0.9116, JPY: 158.56, VND: 25790, XDR: 0.7447, ...overrides },
});

/** A valid stored RatesTable. */
export const ratesTable = (overrides = {}) => ({
  base: 'USD',
  rates: { CNY: 6.7, EUR: 0.92, JPY: 158, USD: 1, VND: 25800 },
  date: '2026-11-22',
  fetchedAt: Date.now(),
  source: 'currency-api',
  ...overrides,
});
