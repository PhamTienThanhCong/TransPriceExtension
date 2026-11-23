/**
 * TransPrice dev harness — a fake `chrome.*` API so extension pages AND the content script run in a normal browser
 * tab served by scripts/dev-server.mjs, talking to the REAL background code. DEV ONLY (never packaged).
 *
 * The dev server injects, at the top of <head> of every /extension/src/**.html page and every /dev/demo*.html page:
 *   <script src="/dev/chrome-mock.js" data-background="/extension/src/background/service-worker.js"></script>
 *   <script type="module" src="/extension/src/background/service-worker.js"></script>
 * so each such page runs its own copy of the service worker (same module instance as the mock's import()).
 *
 * Message bus (ARCHITECTURE §5) — every onMessage listener is tagged by WHO registered it, detected from the call
 * stack (`new Error().stack`, bottom-most frame under /extension/src/):
 *   background  ← code under /extension/src/background/
 *   content     ← code under /extension/src/content/
 *   page        ← anything else (popup / options / welcome / dev pages)
 * - runtime.sendMessage from content or a page → background listeners (+ page listeners when sent by content);
 *   from the background → page listeners. Waits until the service-worker module has finished evaluating.
 *   Sender for content: { id, url, origin, frameId: 0, tab: { id: 1, url, title, active: true, windowId: 1 } }.
 * - tabs.sendMessage(tabId, msg) → the content listeners of the "active tab": this page if it has content listeners,
 *   else another same-origin tab/frame that has them (BroadcastChannel; e.g. the popup iframe of the split view
 *   reaching the demo frame). Nobody listening → rejects with Chrome's
 *   "Could not establish connection. Receiving end does not exist."
 * - Messages and responses are JSON-cloned, listeners run asynchronously, `return true` keeps the channel open,
 *   the first sendResponse() wins; listeners exist but none answers → resolves undefined.
 *
 * Also: storage.{sync,local,session} → localStorage (`transprice-mock:<area>`) + onChanged (only changed keys; also
 * across tabs via the `storage` event); i18n (lang = ?lang= → localStorage 'transprice-dev:lang' → browser);
 * runtime.{id,getURL,getManifest,openOptionsPage,onInstalled,onStartup}; tabs.{query,get,sendMessage,create,update,
 * onActivated,onUpdated,onRemoved} (fake active tab id 1); action.* (shown in the dev bar); alarms (setTimeout/
 * setInterval, plus a "fire alarms" button); commands.onCommand (Alt+Shift+C → 'toggle-enabled').
 *
 * Dev bar (bottom-right, top-level pages only; ?devbar=1 forces it in a frame, ?devbar=0 hides it): badge + title,
 * language en/vi, theme, fire alarms, reset storage. Debug handle: window.__transpriceDev.
 */
(() => {
  'use strict';
  if (window.chrome?.runtime?.id && !window.__transpriceDev) return; // real extension context: do nothing
  if (window.__transpriceDev) return; // injected twice

  const EXT = '/extension/';
  const STORE_PREFIX = 'transprice-mock:'; // + 'sync' | 'local' | 'session'
  const LANG_KEY = 'transprice-dev:lang';
  const INSTALLED_KEY = 'transprice-dev:installed';
  const ACTION_KEY = 'transprice-dev:action';
  const ACTIVE_TAB_KEY = 'transprice-dev:active-tab';
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
  const TAB_ID = 1;
  const params = new URLSearchParams(location.search);
  const isTop = window === window.top;
  const ctxId = Math.random().toString(36).slice(2);
  const log = (...a) => console.debug('[chrome-mock]', ...a);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const later = (fn) => setTimeout(fn, 0);
  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* quota / privacy mode */
    }
  };
  const syncGet = (url) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      return xhr.status === 200 ? xhr.responseText : null;
    } catch {
      return null;
    }
  };
  const parseJson = (s, fallback) => {
    try {
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  };

  const BG_URL = document.currentScript?.dataset.background || '';
  const LANG = (() => {
    const pick = (v) => (v && /^(en|vi)\b/i.test(v) ? v.slice(0, 2).toLowerCase() : null);
    return pick(params.get('lang')) || pick(lsGet(LANG_KEY)) || pick(navigator.language) || 'en';
  })();

  /* ───────────────────────────── events ───────────────────────────── */
  const makeEvent = (name) => {
    const listeners = new Set();
    return {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
      _emit: (...args) => {
        for (const fn of [...listeners]) {
          try {
            fn(...args);
          } catch (e) {
            console.error(`[chrome-mock] ${name} listener threw`, e);
          }
        }
      },
    };
  };

  /* ───────────────────────────── caller detection ───────────────────────────── */
  /** 'background' | 'content' | 'page' — from the bottom-most stack frame under /extension/src/ (libs excluded). */
  function callerKind() {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const stack = String(new Error().stack || '');
    Error.stackTraceLimit = limit;
    const urls = [...stack.matchAll(/(?:https?|file):\/\/[^\s)]+?(?=:\d+:\d+)/g)].map((m) => {
      try {
        return new URL(m[0]).pathname;
      } catch {
        return '';
      }
    });
    let kind = 'page';
    for (const p of urls) {
      const m = /\/extension\/src\/([^/]+)\//.exec(p);
      if (!m || m[1] === 'shared' || m[1] === 'ui') continue;
      kind = m[1] === 'background' ? 'background' : m[1] === 'content' ? 'content' : 'page';
    }
    return kind;
  }

  /* ───────────────────────────── storage ───────────────────────────── */
  const storageOnChanged = makeEvent('storage.onChanged');
  const areaEvents = {};
  const emitStorage = (changes, area) => {
    if (!Object.keys(changes).length) return;
    later(() => {
      storageOnChanged._emit(clone(changes), area);
      areaEvents[area]._emit(clone(changes));
    });
  };
  const makeArea = (area) => {
    const key = STORE_PREFIX + area;
    const read = () => parseJson(lsGet(key), {}) || {};
    const write = (obj) => lsSet(key, JSON.stringify(obj));
    areaEvents[area] = makeEvent(`storage.${area}.onChanged`);
    const diffWrite = (mutate) => {
      const before = read();
      const after = { ...before };
      mutate(after);
      const changes = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
        changes[k] = {};
        if (k in before) changes[k].oldValue = before[k];
        if (k in after) changes[k].newValue = after[k];
      }
      write(after);
      emitStorage(changes, area);
    };
    const withCb = (p, cb) => {
      if (typeof cb === 'function') p.then(cb);
      return p;
    };
    return {
      get(keys, cb) {
        const all = read();
        let out;
        if (keys == null) out = all;
        else if (typeof keys === 'string') out = keys in all ? { [keys]: all[keys] } : {};
        else if (Array.isArray(keys)) out = Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
        else out = Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in all ? all[k] : d]));
        return withCb(Promise.resolve(clone(out)), cb);
      },
      set(items, cb) {
        diffWrite((all) => {
          for (const [k, v] of Object.entries(items || {})) if (v !== undefined) all[k] = clone(v);
        });
        return withCb(Promise.resolve(), cb);
      },
      remove(keys, cb) {
        diffWrite((all) => {
          for (const k of [].concat(keys)) delete all[k];
        });
        return withCb(Promise.resolve(), cb);
      },
      clear(cb) {
        diffWrite((all) => {
          for (const k of Object.keys(all)) delete all[k];
        });
        return withCb(Promise.resolve(), cb);
      },
      getBytesInUse: async () => (lsGet(key) || '').length,
      setAccessLevel: async () => {},
      onChanged: areaEvents[area],
    };
  };
  const storage = { sync: makeArea('sync'), local: makeArea('local'), session: makeArea('session'), onChanged: storageOnChanged };
  // Changes made by other tabs / frames (e.g. options tab ↔ demo tab).
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(STORE_PREFIX)) {
      const area = e.key.slice(STORE_PREFIX.length);
      if (!areaEvents[area]) return;
      const oldAll = parseJson(e.oldValue, {}) || {};
      const newAll = parseJson(e.newValue, {}) || {};
      const changes = {};
      for (const k of new Set([...Object.keys(oldAll), ...Object.keys(newAll)])) {
        if (JSON.stringify(oldAll[k]) === JSON.stringify(newAll[k])) continue;
        changes[k] = {};
        if (k in oldAll) changes[k].oldValue = oldAll[k];
        if (k in newAll) changes[k].newValue = newAll[k];
      }
      emitStorage(changes, area);
    } else if (e.key === ACTION_KEY) devBar.render();
  });

  /* ───────────────────────────── i18n ───────────────────────────── */
  /** messages.json → Map(lower-cased name → entry): chrome.i18n names are case-insensitive. */
  const loadMessages = (lang) => new Map(Object.entries(parseJson(syncGet(`${EXT}_locales/${lang}/messages.json`), {}) || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const messages = loadMessages(LANG);
  const enMessages = LANG === 'en' ? messages : loadMessages('en');
  const lookup = (dict, name) => dict.get(String(name).toLowerCase()) || null;
  /** chrome.i18n.getMessage formatting: $name$ → placeholder content, then $1..$9, $$ → $. */
  const formatEntry = (entry, subs) => {
    const values = subs == null ? [] : [].concat(subs).slice(0, 9).map(String);
    const ph = {};
    for (const [n, p] of Object.entries(entry.placeholders || {})) ph[n.toLowerCase()] = p && p.content;
    const msg = String(entry.message || '').replace(/\$([A-Za-z0-9_@]+)\$/g, (m, n) => ph[n.toLowerCase()] ?? m);
    return msg.replace(/\$(\$+|[1-9])?/g, (m, g) => (g === undefined ? '' : g[0] === '$' ? g : values[Number(g) - 1] ?? ''));
  };
  const getMessage = (name, subs) => {
    switch (String(name).toLowerCase()) {
      case '@@ui_locale':
        return LANG;
      case '@@bidi_dir':
        return 'ltr';
      case '@@bidi_reversed_dir':
        return 'rtl';
      case '@@bidi_start_edge':
        return 'left';
      case '@@bidi_end_edge':
        return 'right';
      case '@@extension_id':
        return 'transprice-dev';
      default: {
        const entry = lookup(messages, name) || lookup(enMessages, name);
        return entry ? formatEntry(entry, subs) : '';
      }
    }
  };

  /* ───────────────────────────── manifest ───────────────────────────── */
  const manifest = parseJson(syncGet(`${EXT}manifest.json`), {}) || {};

  /* ───────────────────────────── background loading ───────────────────────────── */
  let bgState = BG_URL ? 'loading' : 'none'; // 'none' | 'loading' | 'ready' | 'failed'
  let bgError = null;
  const bgReady = BG_URL
    ? import(BG_URL).then(
        () => {
          bgState = 'ready';
          devBar.render();
          log(`background ready (${BG_URL})`);
        },
        (err) => {
          bgState = 'failed';
          bgError = err;
          devBar.render();
          console.error(`[chrome-mock] background failed to load (${BG_URL})`, err);
        },
      )
    : Promise.resolve();

  /* ───────────────────────────── message bus ───────────────────────────── */
  const runtimeListeners = { background: new Set(), content: new Set(), page: new Set() };
  const kindOf = new Map(); // listener → kind
  const onMessage = {
    addListener(fn) {
      if (typeof fn !== 'function' || kindOf.has(fn)) return;
      const kind = callerKind();
      kindOf.set(fn, kind);
      runtimeListeners[kind].add(fn);
      if (kind === 'content') announceTab();
      log(`onMessage listener registered (${kind})`);
    },
    removeListener(fn) {
      const kind = kindOf.get(fn);
      if (kind) runtimeListeners[kind].delete(fn);
      kindOf.delete(fn);
    },
    hasListener: (fn) => kindOf.has(fn),
    hasListeners: () => kindOf.size > 0,
  };

  const pageTab = () => ({ id: TAB_ID, index: 0, windowId: 1, active: true, highlighted: true, status: 'complete', url: location.href, title: document.title });
  const senderFor = (kind) => {
    const base = { id: 'transprice-dev', url: location.href, origin: location.origin };
    return kind === 'content' ? { ...base, frameId: 0, documentId: ctxId, tab: pageTab() } : base;
  };

  /**
   * Deliver `msg` to `listeners` like Chrome: async, JSON-cloned, first sendResponse wins.
   * Resolves { handled: boolean, response } — handled = somebody answered (or kept the channel open and answered).
   */
  function dispatch(listeners, msg, sender) {
    return new Promise((resolve) => {
      let settled = false;
      let keepOpen = false;
      const finish = (handled, response) => {
        if (settled) return;
        settled = true;
        resolve({ handled, response: clone(response) });
      };
      later(() => {
        for (const fn of [...listeners]) {
          let ret;
          try {
            ret = fn(clone(msg), clone(sender), (response) => finish(true, response));
          } catch (e) {
            console.error('[chrome-mock] onMessage listener threw', e);
          }
          if (ret === true) keepOpen = true;
          else if (ret && typeof ret.then === 'function') {
            // Chrome ≥ 99 does NOT treat a returned promise as an answer for onMessage — mirror that (use sendResponse).
            log('onMessage listener returned a Promise — Chrome ignores it; return true + sendResponse instead');
          }
          if (settled) break;
        }
        if (!keepOpen) finish(false, undefined);
      });
    });
  }

  function sendMessage(...args) {
    // Signatures: (message), (message, cb), (message, options, cb), (extensionId, message, options?, cb?)
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let msg = args[0];
    if (typeof args[0] === 'string' && args.length > 1) msg = args[1];
    const kind = callerKind();
    const p = (async () => {
      await bgReady;
      if (bgState === 'failed') throw new Error(`${NO_RECEIVER} (dev: the service worker failed to load — see the console)`);
      const targets = [];
      if (kind !== 'background') targets.push(...runtimeListeners.background);
      if (kind !== 'page') targets.push(...runtimeListeners.page);
      if (!targets.length) throw new Error(NO_RECEIVER);
      log(`runtime.sendMessage ${kind} →`, msg);
      const { response } = await dispatch(targets, msg, senderFor(kind));
      return response;
    })();
    if (cb) {
      p.then(cb, (e) => {
        chromeMock.runtime.lastError = { message: e.message };
        try {
          cb(undefined);
        } finally {
          chromeMock.runtime.lastError = undefined;
        }
      });
      return undefined;
    }
    return p;
  }

  /* ── cross-tab / cross-frame delivery to content listeners (BroadcastChannel) ── */
  const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel('transprice-dev-bus') : null;
  const pending = new Map(); // request id → { ack, resolve, reject, timer }

  /** Pages with content listeners advertise themselves as the active tab (tabs.query / tabs.sendMessage target). */
  function announceTab() {
    if (!runtimeListeners.content.size) return;
    lsSet(ACTIVE_TAB_KEY, JSON.stringify({ url: location.href, title: document.title, ctx: ctxId, ts: Date.now() }));
  }
  window.addEventListener('focus', () => {
    announceTab();
    if (runtimeListeners.content.size) tabsOnActivated._emit({ tabId: TAB_ID, windowId: 1 });
  });
  window.addEventListener('pagehide', () => {
    const cur = parseJson(lsGet(ACTIVE_TAB_KEY), null);
    if (cur && cur.ctx === ctxId) lsSet(ACTIVE_TAB_KEY, null);
  });

  /** The tab chrome.tabs.* talks about: this page if it hosts content scripts, else the announced demo page. */
  function activeTab() {
    if (runtimeListeners.content.size) return pageTab();
    const other = parseJson(lsGet(ACTIVE_TAB_KEY), null);
    if (other && other.url) return { ...pageTab(), url: other.url, title: other.title || '' };
    return pageTab();
  }

  if (bus) {
    bus.onmessage = async (e) => {
      const d = e.data || {};
      if (d.t === 'tab-req' && d.from !== ctxId && runtimeListeners.content.size) {
        const target = parseJson(lsGet(ACTIVE_TAB_KEY), null);
        if (target && target.ctx && target.ctx !== ctxId) return; // another page is the active tab
        bus.postMessage({ t: 'tab-ack', id: d.id, to: d.from });
        const { response } = await dispatch(runtimeListeners.content, d.msg, { id: 'transprice-dev', url: d.url, origin: location.origin });
        bus.postMessage({ t: 'tab-res', id: d.id, to: d.from, response });
      } else if ((d.t === 'tab-ack' || d.t === 'tab-res') && d.to === ctxId && pending.has(d.id)) {
        const req = pending.get(d.id);
        if (d.t === 'tab-ack') {
          req.acked = true;
          clearTimeout(req.timer);
          req.timer = setTimeout(() => req.reject(new Error('The message port closed before a response was received.')), 60_000);
        } else {
          clearTimeout(req.timer);
          pending.delete(d.id);
          req.resolve(d.response);
        }
      }
    };
  }

  function tabsSendMessage(tabId, msg, ...rest) {
    const cb = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    const p = (async () => {
      if (tabId !== TAB_ID) throw new Error(`No tab with id: ${tabId}.`);
      if (runtimeListeners.content.size) {
        log('tabs.sendMessage (this page) →', msg);
        return (await dispatch(runtimeListeners.content, msg, senderFor('page'))).response;
      }
      if (!bus) throw new Error(NO_RECEIVER);
      log('tabs.sendMessage (other tab/frame) →', msg);
      return new Promise((resolve, reject) => {
        const id = `${ctxId}:${Math.random().toString(36).slice(2)}`;
        const done = (fn) => (v) => {
          pending.delete(id);
          fn(v);
        };
        const req = { resolve: done(resolve), reject: done(reject), acked: false, timer: 0 };
        req.timer = setTimeout(() => req.reject(new Error(NO_RECEIVER)), 400);
        pending.set(id, req);
        bus.postMessage({ t: 'tab-req', id, from: ctxId, url: location.href, msg: clone(msg) });
      });
    })();
    if (cb) {
      p.then(cb, (e) => {
        chromeMock.runtime.lastError = { message: e.message };
        try {
          cb(undefined);
        } finally {
          chromeMock.runtime.lastError = undefined;
        }
      });
      return undefined;
    }
    return p;
  }

  /* ───────────────────────────── tabs / windows ───────────────────────────── */
  const tabsOnActivated = makeEvent('tabs.onActivated');
  const tabsOnUpdated = makeEvent('tabs.onUpdated');
  const tabsOnRemoved = makeEvent('tabs.onRemoved');
  /** window.open, or — when the popup blocker says no (no user gesture, e.g. onInstalled) — a link in the dev bar. */
  const openUrl = (url) => {
    const href = String(url || '').replace(/^chrome-extension:\/\/[^/]+\//, EXT);
    const w = /^chrome:/.test(href) ? null : window.open(href, '_blank');
    if (!w) devBar.notice(`tabs.create → ${href}`, href);
    return { id: 2, index: 1, windowId: 1, active: true, url: href, title: '' };
  };

  /* ───────────────────────────── action (toolbar badge) ───────────────────────────── */
  const actionState = () => parseJson(lsGet(ACTION_KEY), {}) || {};
  const setAction = (patch) => {
    lsSet(ACTION_KEY, JSON.stringify({ ...actionState(), ...patch }));
    devBar.render();
  };
  const withCb = (p, cb) => {
    if (typeof cb === 'function') p.then(cb);
    return p;
  };

  /* ───────────────────────────── alarms ───────────────────────────── */
  const alarmsOnAlarm = makeEvent('alarms.onAlarm');
  const alarms = new Map(); // name → { alarm, timers }
  const clearAlarm = (name) => {
    const a = alarms.get(name);
    if (!a) return false;
    clearTimeout(a.timeout);
    clearInterval(a.interval);
    alarms.delete(name);
    return true;
  };
  const fireAlarm = (name) => {
    const a = alarms.get(name);
    if (!a) return;
    log('alarm', name);
    alarmsOnAlarm._emit(clone(a.alarm));
    if (a.alarm.periodInMinutes) a.alarm.scheduledTime = Date.now() + a.alarm.periodInMinutes * 60_000;
    else clearAlarm(name);
    devBar.render();
  };

  /* ───────────────────────────── commands ───────────────────────────── */
  const commandsOnCommand = makeEvent('commands.onCommand');

  /* ───────────────────────────── chrome ───────────────────────────── */
  const runtimeOnInstalled = makeEvent('runtime.onInstalled');
  const runtimeOnStartup = makeEvent('runtime.onStartup');
  const chromeMock = {
    runtime: {
      id: 'transprice-dev',
      lastError: undefined,
      getURL: (p) => EXT + String(p).replace(/^\//, ''),
      getManifest: () => clone(manifest),
      sendMessage,
      onMessage,
      openOptionsPage: (cb) => withCb(Promise.resolve(openUrl(`${EXT}${manifest.options_ui?.page || 'src/options/options.html'}`)).then(() => undefined), cb),
      setUninstallURL: async () => {},
      reload: () => location.reload(),
      getPlatformInfo: async () => ({ os: 'mac', arch: 'arm' }),
      getContexts: async () => [],
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      onSuspend: makeEvent('runtime.onSuspend'),
      onConnect: makeEvent('runtime.onConnect'),
    },
    storage,
    i18n: {
      getMessage,
      getUILanguage: () => LANG,
      getAcceptLanguages: (cb) => withCb(Promise.resolve([LANG, ...(navigator.languages || [])]), cb),
    },
    tabs: {
      TAB_ID_NONE: -1,
      query: (info, cb) => withCb(Promise.resolve([activeTab()]), cb),
      get: (id, cb) => withCb(id === TAB_ID ? Promise.resolve(activeTab()) : Promise.reject(new Error(`No tab with id: ${id}.`)), cb),
      getCurrent: (cb) => withCb(Promise.resolve(undefined), cb),
      sendMessage: tabsSendMessage,
      create: (props, cb) => withCb(Promise.resolve(openUrl(props && props.url)), cb),
      update: (id, props, cb) => {
        if (typeof id === 'object') [props, cb] = [id, props];
        if (props && props.url) openUrl(props.url);
        return withCb(Promise.resolve(activeTab()), cb);
      },
      reload: () => location.reload(),
      onActivated: tabsOnActivated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      create: async ({ url } = {}) => openUrl(url),
      getCurrent: async () => ({ id: 1, focused: true }),
      onFocusChanged: makeEvent('windows.onFocusChanged'),
    },
    action: {
      setBadgeText: ({ text = '', tabId } = {}, cb) => withCb(Promise.resolve(setAction(tabId == null ? { text, tabText: undefined } : { tabText: text })), cb),
      getBadgeText: async () => actionState().tabText ?? actionState().text ?? '',
      setBadgeBackgroundColor: ({ color } = {}, cb) => withCb(Promise.resolve(setAction({ color: Array.isArray(color) ? `rgba(${color.join(',')})` : color })), cb),
      setBadgeTextColor: ({ color } = {}, cb) => withCb(Promise.resolve(setAction({ textColor: Array.isArray(color) ? `rgba(${color.join(',')})` : color })), cb),
      setTitle: ({ title = '' } = {}, cb) => withCb(Promise.resolve(setAction({ title })), cb),
      getTitle: async () => actionState().title ?? '',
      setIcon: async () => {},
      enable: async () => {},
      disable: async () => {},
      onClicked: makeEvent('action.onClicked'),
    },
    alarms: {
      create(name, info) {
        if (typeof name === 'object') [name, info] = ['', name];
        name = name || '';
        info = info || {};
        clearAlarm(name);
        const first = info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        const alarm = { name, scheduledTime: first, ...(info.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) };
        const entry = { alarm, timeout: 0, interval: 0 };
        entry.timeout = setTimeout(() => {
          fireAlarm(name);
          if (info.periodInMinutes && alarms.get(name) === entry) entry.interval = setInterval(() => fireAlarm(name), info.periodInMinutes * 60_000);
        }, Math.max(0, first - Date.now()));
        alarms.set(name, entry);
        devBar.render();
        return Promise.resolve();
      },
      get: (name, cb) => withCb(Promise.resolve(clone(alarms.get(name || '')?.alarm)), cb),
      getAll: (cb) => withCb(Promise.resolve([...alarms.values()].map((a) => clone(a.alarm))), cb),
      clear: (name, cb) => withCb(Promise.resolve(clearAlarm(name || '')), cb),
      clearAll: (cb) => withCb(Promise.resolve([...alarms.keys()].map(clearAlarm).length > 0), cb),
      onAlarm: alarmsOnAlarm,
    },
    commands: {
      getAll: (cb) =>
        withCb(
          Promise.resolve(
            Object.entries(manifest.commands || {}).map(([name, c]) => ({
              name,
              description: c.description ? getMessage(String(c.description).replace(/^__MSG_|__$/g, '')) : '',
              shortcut: c.suggested_key?.mac || c.suggested_key?.default || '',
            })),
          ),
          cb,
        ),
      onCommand: commandsOnCommand,
    },
  };

  try {
    window.chrome = Object.assign(window.chrome || {}, chromeMock);
    if (window.chrome.runtime !== chromeMock.runtime) throw new Error('readonly');
  } catch {
    window.chrome = chromeMock;
  }

  /* ───────────────────────────── life-cycle events ───────────────────────────── */
  bgReady.then(() => {
    if (bgState !== 'ready') return;
    if (!lsGet(INSTALLED_KEY)) {
      lsSet(INSTALLED_KEY, String(Date.now()));
      log('runtime.onInstalled { reason: "install" }');
      runtimeOnInstalled._emit({ reason: 'install' });
    } else {
      let fresh = true;
      try {
        fresh = !sessionStorage.getItem('transprice-dev:started');
        sessionStorage.setItem('transprice-dev:started', '1');
      } catch {
        /* ignore */
      }
      if (fresh) runtimeOnStartup._emit();
    }
    const loaded = () => later(() => tabsOnUpdated._emit(TAB_ID, { status: 'complete' }, activeTab()));
    if (document.readyState === 'complete') loaded();
    else window.addEventListener('load', loaded, { once: true });
  });

  // Alt+Shift+C — the manifest's `toggle-enabled` command.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') {
        e.preventDefault();
        log('commands.onCommand toggle-enabled');
        commandsOnCommand._emit('toggle-enabled', activeTab());
      }
    },
    true,
  );

  /* ───────────────────────────── dev bar ───────────────────────────── */
  const devBar = (() => {
    const show = params.get('devbar') === '1' || (isTop && params.get('devbar') !== '0');
    let host = null;
    let root = null;
    let noticeEl = null;
    let collapsed = lsGet('transprice-dev:bar-collapsed') === '1';
    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
        else if (k === 'style') n.style.cssText = v;
        else n.setAttribute(k, v);
      }
      for (const kid of kids) if (kid != null) n.append(kid);
      return n;
    };
    const setTheme = async (theme) => {
      const cur = (await storage.sync.get('settings')).settings || {};
      await storage.sync.set({ settings: { ...cur, theme } });
    };
    const resetStorage = () => {
      for (const area of ['sync', 'local', 'session']) lsSet(STORE_PREFIX + area, null);
      for (const k of [INSTALLED_KEY, ACTION_KEY, ACTIVE_TAB_KEY]) lsSet(k, null);
      try {
        sessionStorage.removeItem('transprice-dev:started');
      } catch {
        /* ignore */
      }
      location.reload();
    };
    const setLang = (lang) => {
      lsSet(LANG_KEY, lang); // plays the browser language (chrome.i18n) for every page and frame
      // An explicit Display-language setting would override it — keep it in line so the switch always takes effect.
      const sync = parseJson(lsGet(`${STORE_PREFIX}sync`), {}) || {};
      const ui = sync.settings && sync.settings.uiLanguage;
      if (ui && ui !== 'auto' && ui !== lang) lsSet(`${STORE_PREFIX}sync`, JSON.stringify({ ...sync, settings: { ...sync.settings, uiLanguage: lang } }));
      const u = new URL(location.href);
      u.searchParams.delete('lang');
      location.href = u.href;
    };
    function mount() {
      if (!show || host || !document.body) return;
      host = el('div', { 'data-transprice-ignore': '', 'data-transprice-dev': '', style: 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647' });
      root = host.attachShadow({ mode: 'open' });
      document.body.append(host);
      render();
    }
    function render() {
      if (!root) return;
      const a = actionState();
      const text = a.tabText ?? a.text ?? '';
      const style = el('style', {}, `
        :host{all:initial}
        .bar{font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;background:#fffdf8;border:1px solid #e7ddcc;
          border-radius:12px;box-shadow:0 6px 24px rgba(28,25,23,.18);padding:8px 10px;display:flex;flex-direction:column;gap:6px;max-width:320px}
        .row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .brand{font-weight:700;color:#b45309}
        .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;color:#fff;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center}
        .muted{color:#78716c}
        button{font:inherit;border:1px solid #e7ddcc;background:#fff;border-radius:6px;padding:2px 7px;cursor:pointer;color:inherit}
        button[aria-pressed=true]{background:#b45309;border-color:#b45309;color:#fff}
        button:hover{border-color:#b45309}
        a{color:#b45309}
        .err{color:#dc2626}`);
      const bg =
        bgState === 'ready'
          ? el('span', { class: 'muted', title: BG_URL }, 'bg ✓')
          : bgState === 'failed'
            ? el('span', { class: 'err', title: String(bgError?.stack || bgError) }, 'bg ✖ (console)')
            : bgState === 'loading'
              ? el('span', { class: 'muted' }, 'bg …')
              : el('span', { class: 'muted' }, 'no bg');
      const toggle = el('button', { title: collapsed ? 'Expand' : 'Collapse', on: { click: () => { collapsed = !collapsed; lsSet('transprice-dev:bar-collapsed', collapsed ? '1' : '0'); render(); } } }, collapsed ? '▴' : '▾');
      const head = el(
        'div',
        { class: 'row' },
        el('span', { class: 'brand' }, 'TransPrice dev'),
        text ? el('span', { class: 'badge', style: `background:${a.color || '#b45309'};color:${a.textColor || '#fff'}`, title: 'chrome.action badge' }, text) : el('span', { class: 'muted', title: 'chrome.action badge' }, 'badge —'),
        bg,
        toggle,
      );
      const kids = [style, head];
      if (!collapsed) {
        kids.push(el('div', { class: 'row muted', title: 'chrome.action.setTitle' }, a.title ? `title: ${a.title}` : 'title: (manifest default)'));
        kids.push(
          el(
            'div',
            { class: 'row' },
            'lang',
            ...['en', 'vi'].map((l) => el('button', { 'aria-pressed': String(LANG === l), on: { click: () => setLang(l) } }, l)),
            'theme',
            ...['auto', 'light', 'dark'].map((t) => el('button', { on: { click: () => setTheme(t) } }, t)),
          ),
        );
        kids.push(
          el(
            'div',
            { class: 'row' },
            el('button', { title: 'Fire every chrome.alarms alarm now', on: { click: () => [...alarms.keys()].forEach(fireAlarm) } }, `fire alarms (${alarms.size})`),
            el('button', { title: 'Alt+Shift+C', on: { click: () => commandsOnCommand._emit('toggle-enabled', activeTab()) } }, 'toggle cmd'),
            el('button', { title: 'Clear mocked chrome.storage + install flag, then reload (fires onInstalled)', on: { click: resetStorage } }, 'reset storage'),
            el('a', { href: '/dev/index.html' }, 'hub'),
          ),
        );
        if (noticeEl) kids.push(noticeEl);
      }
      root.replaceChildren(el('div', { class: 'bar' }, ...kids));
    }
    function notice(text, href) {
      noticeEl = el('div', { class: 'row' }, href ? el('a', { href, target: '_blank' }, text) : text);
      render();
    }
    if (show) {
      if (document.body) mount();
      else document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
    return { render, notice };
  })();

  window.__transpriceDev = {
    lang: LANG,
    bgReady,
    listeners: () => ({ background: runtimeListeners.background.size, content: runtimeListeners.content.size, page: runtimeListeners.page.size }),
    activeTab,
    fireAlarm,
    command: (name = 'toggle-enabled') => commandsOnCommand._emit(name, activeTab()),
    callerKind,
  };
  log(`ready (lang=${LANG}, background=${BG_URL || 'none'})`);
})();
