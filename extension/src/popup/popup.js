/**
 * TransPrice — toolbar popup (ES module entry). docs/ARCHITECTURE.md §8.
 *
 * Header · big power toggle (settings.enabled) · this-site card (GET_PAGE_INFO from the content script) ·
 * home currency · quick converter (state in storage.local `converterState`) · rates footer (REFRESH_RATES).
 */
import '../shared/currency-data.js'; // side effect: globalThis.TransPriceCurrencies
import '../content/parser.js'; // side effect: globalThis.TransPriceParser
import { AMBIGUOUS_SYMBOLS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import { formatDate, formatRelativeTime, getCurrentUiLocale, initI18n, localizeDocument, reloadOnUiLanguageChange, t } from '../shared/i18n.js';
import { send, sendToTab } from '../shared/messaging.js';
import { getSettings, getStoredRates, isSiteActive, normalizeHostname, onSettingsChanged, siteKey } from '../shared/storage.js';
import { applyTheme } from '../ui/theme.js';
import {
  convertMoney,
  createCurrencyPicker,
  createToast,
  currencyFlag,
  currencyList,
  currencyName,
  el,
  formatMoney,
  hydrateAllIcons,
  rateText,
  setupLogos,
} from '../options/ui-kit.js';
import {
  RATE_SOURCE_LABELS,
  converterDefaults,
  detectedSummary,
  hueFor,
  mainCurrency,
  parseAmount,
  siteActivePatch,
  siteLabel,
} from '../options/ui-helpers.js';

applyTheme('auto'); // follow the OS until settings arrive (no light flash in dark mode)

const PAGE_INFO_TIMEOUT_MS = 1200;
const SAVE_CONVERTER_MS = 300;
const LIVE_REFRESH_MS = 300; // debounce for REPORT_COUNT bursts while the page is still scanning
const ZERO_COUNT_RETRY_MS = 1500; // no report arrived and nothing found yet → ask once more
const ACTIVATING_MS = 2500; // right after switching a site on, "Converting prices…" instead of "No prices found"
const REASON_KEYS = {
  'site-pin': 'popup_reason_site_pin',
  domain: 'popup_reason_domain',
  lang: 'popup_reason_lang',
  script: 'popup_reason_script',
  default: 'popup_reason_default',
};

const $ = (id) => document.getElementById(id);
const showToast = createToast($('toast'));

const state = {
  settings: null,
  rates: null,
  tabId: null,
  /** GET_PAGE_INFO answer; null while loading or when no content script answered */
  page: null,
  pageStatus: 'loading', // 'loading' | 'ready' | 'unavailable'
  conv: { amount: '', from: 'USD', to: 'USD' },
  convTouched: false, // the user changed the converter in this session → don't override `from` with the page currency
  pageCurrencyAdopted: false, // `from` already follows the page's main currency
  reportSeen: false, // a REPORT_COUNT from the active tab arrived while the popup is open
  justActivated: '', // siteKey the user switched on in this popup session → "TransPrice will remember …"
  activatingUntil: 0,
  list: null,
  listKey: '',
};

let pluralRules;
let numberFormat;
const pickers = {};

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

async function init() {
  hydrateAllIcons();
  setupLogos();
  await initI18n(); // Display language — before t(), localizeDocument() and Intl formatters
  localizeDocument();
  const locale = getCurrentUiLocale();
  pluralRules = new Intl.PluralRules(locale);
  numberFormat = new Intl.NumberFormat(locale);

  const [stateRes, tabId, saved] = await Promise.all([
    send(MSG.GET_STATE).catch((err) => {
      console.warn('[TransPrice] GET_STATE failed, reading storage directly', err?.message || err);
      return null;
    }),
    getActiveTabId(),
    chrome.storage.local
      .get(STORAGE_KEYS.CONVERTER)
      .then((d) => d?.[STORAGE_KEYS.CONVERTER] || null)
      .catch(() => null),
  ]);
  state.settings = stateRes?.settings || (await getSettings());
  state.rates = stateRes?.rates || (await getStoredRates().catch(() => null));
  state.tabId = tabId;
  applyTheme(state.settings.theme);

  state.conv = converterDefaults({ saved, home: state.settings.homeCurrency, isAvailable: isConvertible });
  setupPickers();
  setupEvents();
  renderAll();
  $('app').classList.remove('is-loading');

  onSettingsChanged((settings) => {
    const prevHome = state.settings?.homeCurrency;
    state.settings = settings;
    applyTheme(settings.theme);
    if (prevHome && prevHome !== settings.homeCurrency) followHomeChange(prevHome, settings.homeCurrency);
    renderAll();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.RATES]?.newValue) {
      state.rates = changes[STORAGE_KEYS.RATES].newValue;
      renderAll();
    }
  });
  reloadOnUiLanguageChange(flushConverterSave);
  window.addEventListener('pagehide', flushConverterSave);
  setupLiveUpdates();

  await loadPageInfo();
}

async function getActiveTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return Number.isInteger(tab?.id) ? tab.id : null;
  } catch {
    return null;
  }
}

/** GET_PAGE_INFO from the active tab's content script (null when nothing answers in time). */
async function queryPageInfo() {
  if (state.tabId === null) return null;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_INFO_TIMEOUT_MS));
  const request = sendToTab(state.tabId, MSG.GET_PAGE_INFO).catch(() => null);
  const info = await Promise.race([request, timeout]);
  return info && typeof info === 'object' && typeof info.hostname === 'string' ? info : null;
}

async function loadPageInfo() {
  const info = await queryPageInfo();
  if (info) applyPageInfo(info);
  else if (state.pageStatus === 'loading') {
    state.pageStatus = 'unavailable';
    renderSite();
  }
  // The page may still be scanning (count 0) or the content script not loaded yet: if no REPORT_COUNT
  // arrives meanwhile, ask once more.
  if (!info || !(Number(info.count) > 0)) {
    setTimeout(() => {
      if (!state.reportSeen) refreshPageInfoQuietly();
    }, ZERO_COUNT_RETRY_MS);
  }
}

/** Store a GET_PAGE_INFO answer and update the card in place (no skeleton → no flicker). */
function applyPageInfo(info) {
  state.page = info;
  state.pageStatus = normalizeHostname(info.hostname) ? 'ready' : 'unavailable';
  renderSite();
  adoptPageCurrency(info);
}

/**
 * First time the page shows a main currency: convert from it (unless the user already touched the converter).
 * On an inactive site the content script only reports what it *detected* (read-only), which is just as good a hint.
 */
function adoptPageCurrency(info) {
  const pageCurrency = mainCurrency(info?.currencies) || detectedSummary(info?.detected, state.settings.homeCurrency).codes[0];
  if (state.pageCurrencyAdopted || state.convTouched || !pageCurrency || !isConvertible(pageCurrency)) return;
  state.pageCurrencyAdopted = true;
  const next = converterDefaults({
    saved: state.conv,
    pageCurrency,
    home: state.settings.homeCurrency,
    isAvailable: isConvertible,
  });
  if (next.from !== state.conv.from || next.to !== state.conv.to) {
    state.conv = next;
    renderConverter();
  }
}

/**
 * Stay live while the popup is open: the content script reports its count with REPORT_COUNT through
 * chrome.runtime.sendMessage, which reaches extension pages too. Only reports from the active tab count, and
 * this listener never answers (returns false, no sendResponse) so the service worker's response wins.
 */
function setupLiveUpdates() {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== MSG.REPORT_COUNT) return false;
    if (state.tabId === null || sender?.tab?.id !== state.tabId) return false;
    state.reportSeen = true;
    scheduleLiveRefresh();
    return false;
  });
}

let liveTimer = 0;
function scheduleLiveRefresh(delay = LIVE_REFRESH_MS) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(refreshPageInfoQuietly, delay);
}

let refreshInFlight = false;
let refreshAgain = false;
/** Re-query GET_PAGE_INFO without touching the card while waiting; one request at a time. */
async function refreshPageInfoQuietly() {
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  refreshInFlight = true;
  try {
    const info = await queryPageInfo();
    if (info) applyPageInfo(info);
  } finally {
    refreshInFlight = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleLiveRefresh();
    }
  }
}

/** The content script re-scans after a settings change — ask again a little later for the fresh count. */
let pageRefreshTimers = [];
function refreshPageInfoSoon() {
  pageRefreshTimers.forEach(clearTimeout);
  pageRefreshTimers = [500, 1500].map((ms) => setTimeout(refreshPageInfoQuietly, ms));
}

/* ================================================================== */
/* Rendering                                                           */
/* ================================================================== */

function renderAll() {
  rebuildListIfNeeded();
  renderPower();
  renderSite();
  renderHome();
  renderConverter();
  renderFooter();
}

function rebuildListIfNeeded() {
  const home = state.settings.homeCurrency;
  const key = `${home}|${Object.keys(state.rates?.rates || {}).length}`;
  if (key === state.listKey && state.list) return;
  state.listKey = key;
  state.list = currencyList({ home, rates: state.rates });
  Object.values(pickers).forEach((p) => p.refresh());
}

function isConvertible(code) {
  return typeof code === 'string' && (!state.rates?.rates || state.rates.rates[code] > 0);
}

/* ---------- Power ---------- */

function renderPower() {
  const on = state.settings.enabled;
  const power = $('power');
  power.setAttribute('aria-pressed', on ? 'true' : 'false');
  const stateEl = $('power-state');
  if (on) {
    const [before, after] = splitAround(t('popup_power_on', ['\u0000']));
    stateEl.replaceChildren(before, el('strong', { text: state.settings.homeCurrency }), after);
  } else {
    stateEl.textContent = t('popup_power_off');
  }
}

/** Split a translated sentence around a marker so part of it can be wrapped in <strong> (never innerHTML). */
function splitAround(text, marker = '\u0000') {
  const i = text.indexOf(marker);
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + marker.length)];
}

/* ---------- This site ---------- */

/** The page's siteKey (what rules are stored as and what the card shows): "s.taobao.com" → "taobao.com". */
function pageSiteKey() {
  const host = normalizeHostname(state.page?.hostname || '');
  return state.page?.siteKey || siteKey(host) || host;
}

/**
 * This-site card (ARCHITECTURE §3.5): 'paused' (global power off: muted, switch disabled), 'inactive' (the default:
 * compact, one-line hint using what the page `detected`), 'active' (count, currencies, ¥/$ selects).
 */
function renderSite() {
  const card = $('site');
  const loading = state.pageStatus === 'loading';
  const unavailable = state.pageStatus === 'unavailable';
  $('site-loading').hidden = !loading;
  $('site-notice').hidden = !unavailable;
  $('site-main').hidden = loading || unavailable;
  if (loading || unavailable || !state.page) {
    delete card.dataset.state;
    return;
  }

  const host = normalizeHostname(state.page.hostname);
  const key = pageSiteKey();
  const home = state.settings.homeCurrency;
  const siteOn = isSiteActive({ ...state.settings, enabled: true }, host);
  const mode = !state.settings.enabled ? 'paused' : siteOn ? 'active' : 'inactive';
  card.dataset.state = mode;

  const label = siteLabel(key);
  const avatar = $('site-avatar');
  avatar.textContent = label.charAt(0);
  avatar.style.setProperty('--hue', String(hueFor(label)));
  $('site-host').textContent = key;
  $('site-host').title = host;
  const sw = $('sw-site');
  sw.checked = siteOn;
  sw.disabled = mode === 'paused';

  // Status line
  let text;
  let tone = '';
  if (mode === 'paused') {
    text = t('popup_site_paused');
  } else if (mode === 'inactive') {
    const found = detectedSummary(state.page.detected, home);
    if (found.count > 0) {
      const msg = pluralRules.select(found.count) === 'one' ? 'popup_site_detected_one' : 'popup_site_detected_other';
      text = t(msg, [numberFormat.format(found.count), found.codes.slice(0, 2).join('/')]);
    } else {
      text = t('popup_site_off_hint');
    }
  } else {
    const count = Number(state.page.count) || 0;
    if (count > 0) {
      tone = 'is-on';
      const msg = pluralRules.select(count) === 'one' ? 'popup_site_count_one' : 'popup_site_count_other';
      const main = mainCurrency(state.page.currencies);
      text = `${t(msg, [numberFormat.format(count)])}${main ? ` · ${main} → ${home}` : ''}`;
    } else if (Date.now() < state.activatingUntil) {
      tone = 'is-busy'; // just switched on: the content script is scanning, REPORT_COUNT will fill the count in
      text = t('popup_site_activating');
    } else {
      text = t('popup_site_none');
    }
  }
  const status = $('site-status');
  status.className = `site-status ${tone}`.trim();
  status.replaceChildren(el('span', { class: 'status-dot', 'aria-hidden': 'true' }), text);
  status.title = text;

  // "TransPrice will remember taobao.com" — only right after the user switched it on here.
  const remember = mode === 'active' && state.justActivated === key;
  $('site-remember').hidden = !remember;
  if (remember) $('site-remember-text').textContent = t('popup_site_remember', [key]);

  renderSymbols(host, mode === 'active');
}

function renderSymbols(host, show) {
  const wrap = $('site-symbols');
  const list = (show && Array.isArray(state.page?.ambiguous) ? state.page.ambiguous : []).filter(
    (a) => a && AMBIGUOUS_SYMBOLS[a.symbol] && typeof a.currency === 'string',
  );
  wrap.hidden = list.length === 0;
  const key = JSON.stringify([host, state.settings.homeCurrency, list.map((a) => [a.symbol, a.token, a.currency, a.reason])]);
  if (wrap.dataset.key === key) return; // unchanged → keep the DOM (and an open select) as is
  const sameSymbols = wrap.dataset.host === host && wrap.dataset.symbols === list.map((a) => a.symbol).join();
  if (sameSymbols && wrap.contains(document.activeElement)) {
    // The user is on one of these selects: never rebuild under them; values/hints catch up on the next change.
    return;
  }
  wrap.dataset.key = key;
  wrap.dataset.host = host;
  wrap.dataset.symbols = list.map((a) => a.symbol).join();
  if (!list.length) {
    wrap.replaceChildren();
    return;
  }
  wrap.replaceChildren(
    ...list.map((info) => {
      const selectId = `sym-${info.symbol}`;
      const select = el('select', { class: 'select symbol-select', id: selectId });
      for (const code of AMBIGUOUS_SYMBOLS[info.symbol]) {
        const flag = currencyFlag(code);
        select.append(new Option(`${flag ? `${flag} ` : ''}${code} · ${currencyName(code)}`, code));
      }
      select.value = info.currency;
      select.addEventListener('change', () => setSiteCurrency(host, info.symbol, select.value));

      const token = info.token || (info.symbol === 'yen' ? '¥' : '$');
      const [before, after] = splitAround(t('popup_site_symbol', ['\u0000']));
      const label = el(
        'label',
        { class: 'symbol-label', for: selectId },
        before,
        el('span', { class: 'symbol-token', text: token }),
        after.trimStart(),
      );

      const hint = el('span', { class: 'symbol-hint' }, el('span', { text: t(REASON_KEYS[info.reason] || REASON_KEYS.default) }));
      if (info.reason === 'site-pin') {
        const reset = el('button', { type: 'button', class: 'link-btn', text: t('popup_reason_reset') });
        reset.addEventListener('click', () => setSiteCurrency(host, info.symbol, null));
        hint.append(reset);
      }
      return el('div', { class: 'symbol-row' }, label, select, hint);
    }),
  );
}

/* ---------- Home currency ---------- */

function renderHome() {
  pickers.home.setValue(state.settings.homeCurrency);
}

/* ---------- Converter ---------- */

function renderConverter() {
  const { amount, from, to } = state.conv;
  const input = $('conv-amount');
  if (input.value !== amount && document.activeElement !== input) input.value = amount;
  pickers.from.setValue(from);
  pickers.to.setValue(to);

  const result = $('conv-result');
  const value = parseAmount(amount);
  result.classList.remove('is-empty', 'is-error');
  result.removeAttribute('title');
  if (!amount.trim()) {
    result.classList.add('is-empty');
    result.textContent = formatMoney(0, to);
  } else if (value === null) {
    result.classList.add('is-error');
    result.textContent = t('popup_invalid_amount');
  } else {
    const converted = convertMoney(value, from, to, state.rates);
    if (converted === null || !Number.isFinite(converted)) {
      result.classList.add('is-error');
      result.textContent = t('popup_no_rate');
    } else {
      const text = formatMoney(converted, to);
      result.textContent = text;
      result.title = `${formatMoney(value, from)} = ${text}`;
    }
  }
  $('conv-rate').textContent = from === to ? '' : rateText(from, to, state.rates);
}

let convSaveTimer = 0;
function queueConverterSave() {
  state.convTouched = true;
  clearTimeout(convSaveTimer);
  convSaveTimer = setTimeout(flushConverterSave, SAVE_CONVERTER_MS);
}
function flushConverterSave() {
  clearTimeout(convSaveTimer);
  if (!state.convTouched) return;
  chrome.storage.local.set({ [STORAGE_KEYS.CONVERTER]: { ...state.conv } }).catch(() => {});
}

/** When the home currency changes, a converter that targeted the old home follows it. */
function followHomeChange(prevHome, nextHome) {
  if (state.conv.to === prevHome && state.conv.from !== nextHome) {
    state.conv = { ...state.conv, to: nextHome };
    queueConverterSave();
  }
}

/* ---------- Footer ---------- */

function renderFooter() {
  const rates = state.rates;
  const text = $('rates-text');
  const info = $('rates-info');
  if (!rates) {
    text.textContent = t('popup_rates_missing');
    info.removeAttribute('title');
    $('rates-hint').hidden = true;
    return;
  }
  const snapshot = rates.source === 'snapshot';
  const source = snapshot ? t('popup_source_snapshot') : RATE_SOURCE_LABELS[rates.source] || rates.source;
  text.textContent = t('popup_rates_line', [formatDate(rates.date) || rates.date, source]);
  info.title = rates.fetchedAt > 0 ? t('popup_rates_updated', [formatRelativeTime(rates.fetchedAt)]) : '';
  $('rates-hint').hidden = !snapshot;
}

/* ================================================================== */
/* Controls                                                            */
/* ================================================================== */

function setupPickers() {
  const getList = () => state.list || currencyList({ home: state.settings.homeCurrency, rates: state.rates });
  pickers.home = createCurrencyPicker({
    label: t('popup_home_label'),
    getList,
    value: state.settings.homeCurrency,
    align: 'end',
    onChange: (code) => setHomeCurrency(code),
  });
  pickers.from = createCurrencyPicker({
    label: t('popup_from'),
    getList,
    value: state.conv.from,
    variant: 'compact',
    align: 'end',
    onChange: (code) => setConverter({ from: code }),
  });
  pickers.to = createCurrencyPicker({
    label: t('popup_to'),
    getList,
    value: state.conv.to,
    variant: 'compact',
    align: 'end',
    onChange: (code) => setConverter({ to: code }),
  });
  $('home-picker').append(pickers.home.el);
  $('conv-from').append(pickers.from.el);
  $('conv-to').append(pickers.to.el);
}

function setupEvents() {
  $('power').addEventListener('click', toggleEnabled);
  $('sw-site').addEventListener('change', (e) => setSiteActive(e.target.checked));
  $('btn-settings').addEventListener('click', () => openOptions());
  $('btn-refresh').addEventListener('click', refreshRates);
  $('btn-reload').addEventListener('click', reloadTab);

  const input = $('conv-amount');
  input.addEventListener('input', () => {
    state.conv = { ...state.conv, amount: input.value };
    renderConverter();
    queueConverterSave();
  });
  input.addEventListener('focus', () => input.select());

  $('btn-swap').addEventListener('click', () => {
    $('btn-swap').classList.toggle('is-flipped');
    setConverter({ from: state.conv.to, to: state.conv.from });
  });
}

function setConverter(patch) {
  const next = { ...state.conv, ...patch };
  // Picking the same currency on both sides swaps them instead of showing "1 VND = 1 VND".
  if (next.from === next.to) {
    if ('from' in patch && !('to' in patch)) next.to = state.conv.from;
    else if ('to' in patch && !('from' in patch)) next.from = state.conv.to;
  }
  state.conv = next;
  renderConverter();
  queueConverterSave();
}

/* ---------- Settings writes (through the background) ---------- */

async function applySettingsChange(request, optimistic) {
  const prev = state.settings;
  if (optimistic) {
    state.settings = { ...prev, ...optimistic };
    renderAll();
  }
  try {
    const res = await request();
    if (res?.settings) {
      state.settings = res.settings;
      renderAll();
    }
    refreshPageInfoSoon();
  } catch (err) {
    console.error('[TransPrice] settings update failed', err);
    state.settings = prev;
    renderAll();
    showToast(t('popup_error'), { type: 'error', duration: 2600 });
  }
}

function toggleEnabled() {
  const enabled = !state.settings.enabled;
  applySettingsChange(() => send(MSG.UPDATE_SETTINGS, { patch: { enabled } }), { enabled });
}

function setHomeCurrency(code) {
  const prevHome = state.settings.homeCurrency;
  if (code === prevHome) return;
  followHomeChange(prevHome, code);
  applySettingsChange(() => send(MSG.UPDATE_SETTINGS, { patch: { homeCurrency: code } }), { homeCurrency: code });
}

/** Switch the current site on/off (remembered per siteKey by the background, ARCHITECTURE §3.5). */
function setSiteActive(active) {
  const hostname = normalizeHostname(state.page?.hostname || '');
  if (!hostname || !state.settings.enabled) return;
  const key = pageSiteKey();
  state.justActivated = active ? key : '';
  state.activatingUntil = active ? Date.now() + ACTIVATING_MS : 0;
  if (active) setTimeout(renderSite, ACTIVATING_MS + 50); // drop "Converting prices…" if no count arrived
  applySettingsChange(
    () => send(MSG.SET_SITE_ACTIVE, { hostname, active }),
    siteActivePatch(state.settings, hostname, key, active),
  );
}

function setSiteCurrency(hostname, symbol, currency) {
  applySettingsChange(() => send(MSG.SET_SITE_CURRENCY, { hostname, symbol, currency }), null).then(() => {
    // Show the new choice right away; the content script's answer follows via refreshPageInfoSoon().
    if (state.page?.ambiguous) {
      state.page = {
        ...state.page,
        ambiguous: state.page.ambiguous.map((a) =>
          a.symbol === symbol ? { ...a, currency: currency || a.currency, reason: currency ? 'site-pin' : a.reason } : a,
        ),
      };
      renderSite();
    }
  });
}

/* ---------- Other actions ---------- */

async function refreshRates() {
  const button = $('btn-refresh');
  if (button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    const res = await send(MSG.REFRESH_RATES);
    if (res?.rates) state.rates = res.rates;
    renderAll();
    if (state.rates?.source === 'snapshot') showToast(t('popup_refresh_failed'), { type: 'error', duration: 3000 });
    else showToast(t('popup_refreshed'));
  } catch (err) {
    console.warn('[TransPrice] refresh failed', err?.message || err);
    showToast(t('popup_refresh_failed'), { type: 'error', duration: 3000 });
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

async function openOptions(section) {
  try {
    await send(MSG.OPEN_OPTIONS, section ? { section } : {});
  } catch {
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
  }
  window.close();
}

/** Tab opened before install: reload it so the content script gets injected, then ask again. */
async function reloadTab() {
  if (state.tabId === null) return;
  const button = $('btn-reload');
  button.disabled = true;
  try {
    await chrome.tabs.reload(state.tabId);
  } catch {
    button.disabled = false;
    return;
  }
  state.pageStatus = 'loading';
  renderSite();
  for (const wait of [1200, 1500, 2500]) {
    await new Promise((r) => setTimeout(r, wait));
    const info = await queryPageInfo();
    if (info) {
      applyPageInfo(info);
      button.disabled = false;
      return;
    }
  }
  state.pageStatus = 'unavailable';
  renderSite();
  button.disabled = false;
}

init().catch((err) => {
  console.error('[TransPrice] popup failed to initialise', err);
  $('app').classList.remove('is-loading');
});
