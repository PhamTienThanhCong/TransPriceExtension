/**
 * TransPrice — Settings page (opened from the popup, chrome://extensions or `#section` deep links).
 * Every control saves on change through updateSettings() (storage.js validates); a small "Saved" toast confirms.
 * The page live-syncs with storage.onChanged (settings from the popup / other devices, new rate tables).
 */
import '../shared/currency-data.js'; // side effect: globalThis.TransPriceCurrencies
import '../content/parser.js'; // side effect: globalThis.TransPriceParser
import { AMBIGUOUS_SYMBOLS, MSG, STORAGE_KEYS, UI_LANGUAGES } from '../shared/constants.js';
import { formatDate, formatRelativeTime, initI18n, localizeDocument, reloadOnUiLanguageChange, t } from '../shared/i18n.js';
import { send } from '../shared/messaging.js';
import { getSettings, getStoredRates, onSettingsChanged, updateSettings } from '../shared/storage.js';
import { applyTheme } from '../ui/theme.js';
import {
  DEFAULT_SHORTCUTS,
  ISSUES_URL,
  PRIVACY_URL,
  REPO_URL,
  anyIcon,
  commandLabel,
  convertMoney,
  createCurrencyPicker,
  createToast,
  currencyFlag,
  currencyList,
  currencyName,
  el,
  fillUiLanguageSelect,
  formatMoney,
  getCommands,
  hydrateAllIcons,
  kbdGroup,
  openShortcutsPage,
  prefersReducedMotion,
  prettyKey,
  rateText,
  setupLogos,
  setupRadioGroup,
} from './ui-kit.js';
import { RATE_SOURCE_LABELS, hueFor, shortcutKeys, siteFromInput, siteLabel, sitePinList } from './ui-helpers.js';

const root = document.documentElement;
root.classList.add('is-loading');
applyTheme('auto');

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

const SECTIONS = ['general', 'display', 'symbols', 'sites', 'appearance', 'rates', 'about'];
const MOBILE_QUERY = '(max-width: 760px)';
const SYMBOL_GLYPH = { dollar: '$', yen: '¥' };
/** Sample conversions shown in the Rates section (the home currency is skipped). */
const SAMPLE_CODES = ['USD', 'EUR', 'CNY', 'JPY', 'KRW', 'GBP'];

const state = {
  settings: null,
  rates: null,
  theme: null,
  lastAddedSite: null,
  activeSection: null,
  list: null,
  listKey: '',
};

/** Controllers keyed by setting name (theme, displayMode) — each has setValue(value). */
const controls = {};
let homePicker = null;
const showToast = createToast($('#toast'));

async function init() {
  await initI18n(); // Display language — before localizeDocument(), t() and Intl formatters
  hydrateAllIcons();
  localizeDocument();
  setupLogos();
  renderMeta();
  setupControls();
  setupNav();
  setupSites();
  setupShortcuts();
  setupRates();

  const [settings, rates] = await Promise.all([getSettings(), loadRates()]);
  state.rates = rates;
  render(settings);
  renderRates();
  root.classList.remove('is-loading');

  onSettingsChanged((s) => render(s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.RATES]?.newValue) {
      state.rates = changes[STORAGE_KEYS.RATES].newValue;
      render(state.settings);
      renderRates();
    }
  });
  reloadOnUiLanguageChange(); // new display language → reload with the new strings

  const initial = sectionFromHash();
  if (initial) requestAnimationFrame(() => goTo(initial));
}

/** The background serves the stored table or the bundled snapshot; storage is the fallback if it's asleep/broken. */
async function loadRates() {
  try {
    const res = await send(MSG.GET_STATE);
    if (res?.rates) return res.rates;
  } catch {
    /* fall through */
  }
  return getStoredRates().catch(() => null);
}

/* ================================================================== */
/* Static bits                                                         */
/* ================================================================== */

function renderMeta() {
  let version = '';
  try {
    version = chrome.runtime.getManifest()?.version || '';
  } catch {
    /* ignore */
  }
  $('#brand-version').textContent = version ? `v${version}` : '';
  $('#about-version').textContent = version ? t('options_version', [version]) : '';
  $('#link-repo').href = REPO_URL;
  $('#link-issues').href = ISSUES_URL;
  $('#privacy-link').href = PRIVACY_URL;
}

/* ================================================================== */
/* Settings controls                                                   */
/* ================================================================== */

function setupControls() {
  fillUiLanguageSelect($('#s-uiLanguage'), UI_LANGUAGES);
  fillSymbolSelect($('#s-defaultDollar'), AMBIGUOUS_SYMBOLS.dollar);
  fillSymbolSelect($('#s-defaultYen'), AMBIGUOUS_SYMBOLS.yen);

  $$('input[type="checkbox"][data-setting]').forEach((input) => {
    input.addEventListener('change', () => save({ [input.dataset.setting]: input.checked }));
  });
  $$('select[data-setting]').forEach((select) => {
    select.addEventListener('change', () => save({ [select.dataset.setting]: select.value }));
  });
  $$('.segmented[data-setting]').forEach((group) => {
    const key = group.dataset.setting;
    controls[key] = setupRadioGroup(group, (value) => save({ [key]: value }));
  });
  controls.displayMode = setupRadioGroup($('#mode-cards'), (value) => save({ displayMode: value }));

  homePicker = createCurrencyPicker({
    label: t('options_home_title'),
    getList: () => state.list || currencyList({ home: state.settings?.homeCurrency, rates: state.rates }),
    align: 'end',
    onChange: (code) => save({ homeCurrency: code }),
  });
  homePicker.button.setAttribute('aria-describedby', 'home-desc');
  $('#home-picker').append(homePicker.el);
}

function fillSymbolSelect(select, codes) {
  select.replaceChildren(
    ...codes.map((code) => {
      const flag = currencyFlag(code);
      return new Option(`${flag ? `${flag}  ` : ''}${code} — ${currencyName(code)}`, code);
    }),
  );
}

/* ---------- Saving ---------- */

let saveChain = Promise.resolve();
let savedToastTimer = 0;

/** Optimistically render, then persist (serialized so quick successive changes never overwrite each other). */
function save(patch) {
  if (state.settings && typeof patch === 'object') render({ ...state.settings, ...patch });
  saveChain = saveChain
    .then(() => updateSettings(patch))
    .then((next) => {
      render(next);
      clearTimeout(savedToastTimer);
      savedToastTimer = setTimeout(() => showToast(t('options_saved')), 80);
      return next;
    })
    .catch(async (err) => {
      console.error('[TransPrice] failed to save settings', err);
      showToast(t('options_save_failed'), { type: 'error', duration: 3200 });
      try {
        render(await getSettings());
      } catch {
        /* ignore */
      }
    });
  return saveChain;
}

/* ---------- Rendering ---------- */

function render(settings) {
  if (!settings) return;
  const s = settings;
  const prevHome = state.settings?.homeCurrency;
  state.settings = s;

  if (s.theme !== state.theme) {
    state.theme = s.theme;
    applyTheme(s.theme);
  }

  $$('input[type="checkbox"][data-setting]').forEach((input) => {
    input.checked = Boolean(s[input.dataset.setting]);
  });
  $$('select[data-setting]').forEach((select) => {
    const value = String(s[select.dataset.setting] ?? '');
    if (select.value !== value) select.value = value;
  });
  for (const [key, control] of Object.entries(controls)) control.setValue(s[key]);

  const listKey = `${s.homeCurrency}|${Object.keys(state.rates?.rates || {}).length}`;
  if (listKey !== state.listKey) {
    state.listKey = listKey;
    state.list = currencyList({ home: s.homeCurrency, rates: state.rates });
    homePicker.refresh();
  }
  homePicker.setValue(s.homeCurrency);

  renderPreview(s);
  renderSites(s.disabledSites);
  renderPins(s.siteCurrency);
  if (prevHome !== s.homeCurrency) renderRates();
}

/* ---------- Display-mode preview (a real conversion with the current settings) ---------- */

/** What the preview converts: ¥189 on a Chinese shop, or $25.99 when the home currency is already CNY. */
function previewSource(home) {
  return home === 'CNY'
    ? { raw: '$25.99', amount: 25.99, currency: 'USD', title: 'Wireless earbuds Pro' }
    : { raw: '¥189', amount: 189, currency: 'CNY', title: '无线蓝牙耳机 Pro · 降噪' };
}

function renderPreview(s) {
  const src = previewSource(s.homeCurrency);
  const value = convertMoney(src.amount, src.currency, s.homeCurrency, state.rates);
  const converted = value === null ? '—' : formatMoney(value, s.homeCurrency, { compact: s.compact });
  const full = value === null ? '—' : formatMoney(value, s.homeCurrency);
  const tooltip = `${src.raw} → ${full} · ${rateText(src.currency, s.homeCurrency, state.rates)}`;

  for (const stage of $$('[data-preview]')) {
    const mode = stage.dataset.preview;
    const line = el('span', { class: 'pv-price-line' });
    if (mode === 'replace') {
      line.append(el('span', { class: `pv-price${s.highlight ? ' is-hl' : ''}`, text: converted, title: tooltip }));
    } else {
      line.append(
        el('span', { class: 'pv-price', text: src.raw }),
        el('span', { class: `pv-append${s.highlight ? ' is-hl' : ''}`, text: `≈ ${converted}`, title: tooltip }),
      );
    }
    stage.replaceChildren(
      el('span', { class: 'pv-thumb' }, anyIcon('tag', { size: 24 })),
      el('span', { class: 'pv-body' }, el('span', { class: 'pv-title', lang: src.currency === 'CNY' ? 'zh' : 'en', text: src.title }), line),
    );
  }

  // Compact description shows the actual effect on a large amount in the home currency (≈ 1 200 USD, 2 digits).
  const example = roundSignificant(convertMoney(1200, 'USD', s.homeCurrency, state.rates) ?? 1200);
  $('#s-compact-desc').textContent = t('options_compact_desc', [
    formatMoney(example, s.homeCurrency),
    formatMoney(example, s.homeCurrency, { compact: true }),
  ]);
}

function roundSignificant(value, digits = 2) {
  if (!(value > 0)) return value;
  const step = 10 ** (Math.floor(Math.log10(value)) - digits + 1);
  return Math.round(value / step) * step;
}

/* ================================================================== */
/* Navigation: hash routing + scroll-spy (same behaviour as TransPop)  */
/* ================================================================== */

let navLocked = false;
let navLockTimer = 0;
let scrollFrame = 0;

function setupNav() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-section]');
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goTo(link.dataset.section, { smooth: true, focus: true });
  });
  window.addEventListener('hashchange', () => {
    const id = sectionFromHash();
    if (id) goTo(id, { smooth: true });
  });
  window.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updateActive();
      });
    },
    { passive: true },
  );
  window.addEventListener('scrollend', () => {
    navLocked = false;
  });
  window.addEventListener('resize', () => updateActive(), { passive: true });
  setActive(sectionFromHash() || SECTIONS[0]);
}

function sectionFromHash() {
  let id = '';
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    /* ignore */
  }
  return SECTIONS.includes(id) ? id : null;
}

function goTo(id, { smooth = false, focus = false } = {}) {
  const section = document.getElementById(id);
  if (!section) return;
  setActive(id);
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  navLocked = true;
  clearTimeout(navLockTimer);
  navLockTimer = setTimeout(() => {
    navLocked = false;
  }, 1500);
  section.scrollIntoView({ behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'instant', block: 'start' });
  if (focus) section.querySelector('.section-title')?.focus({ preventScroll: true });
}

function updateActive() {
  if (navLocked) return;
  const mobile = matchMedia(MOBILE_QUERY).matches;
  const offset = mobile ? $('.sidebar').offsetHeight + 32 : 120;
  let current = SECTIONS[0];
  for (const id of SECTIONS) {
    const section = document.getElementById(id);
    if (section && section.getBoundingClientRect().top - offset <= 0) current = id;
  }
  if (window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= root.scrollHeight - 2) {
    current = SECTIONS[SECTIONS.length - 1];
  }
  if (current === state.activeSection) return;
  setActive(current);
  if (location.hash || window.scrollY > 0) history.replaceState(null, '', `#${current}`);
}

function setActive(id) {
  state.activeSection = id;
  let activeLink = null;
  $$('.nav-link').forEach((link) => {
    if (link.dataset.section === id) {
      link.setAttribute('aria-current', 'location');
      activeLink = link;
    } else {
      link.removeAttribute('aria-current');
    }
  });
  const nav = $('#nav');
  if (activeLink && nav.scrollWidth > nav.clientWidth + 1) {
    const navRect = nav.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    const delta = linkRect.left - navRect.left - (navRect.width - linkRect.width) / 2;
    nav.scrollBy({ left: delta, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
  }
}

/* ================================================================== */
/* Websites: disabled list + per-site currency pins                    */
/* ================================================================== */

function setupSites() {
  const input = $('#site-input');
  $('#site-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addSite();
  });
  input.addEventListener('input', () => setSiteError(''));
  $('#site-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove-site]');
    if (button) removeFromList(button, 'removeSite', (host) => removeSite(host));
  });
  $('#pin-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove-pin]');
    if (button) removeFromList(button, 'removePin', (host) => removePin(host));
  });
}

function setSiteError(message) {
  $('#site-error').textContent = message;
  $('#site-input').setAttribute('aria-invalid', message ? 'true' : 'false');
}

function addSite() {
  const input = $('#site-input');
  const host = siteFromInput(input.value);
  if (!host) {
    setSiteError(t('options_sites_error_invalid'));
    input.focus();
    return;
  }
  const list = state.settings?.disabledSites || [];
  if (list.includes(host)) {
    setSiteError(t('options_sites_error_duplicate', [host]));
    input.select();
    return;
  }
  state.lastAddedSite = host;
  input.value = '';
  setSiteError('');
  save((cur) => ({ disabledSites: [...cur.disabledSites.filter((h) => h !== host), host] }));
  render({ ...state.settings, disabledSites: [...list, host] });
  input.focus();
}

function removeSite(host) {
  render({ ...state.settings, disabledSites: state.settings.disabledSites.filter((h) => h !== host) });
  save((cur) => ({ disabledSites: cur.disabledSites.filter((h) => h !== host) }));
}

function removePin(host) {
  const strip = (map) => {
    const next = { ...map };
    delete next[host];
    return next;
  };
  render({ ...state.settings, siteCurrency: strip(state.settings.siteCurrency) });
  save((cur) => ({ siteCurrency: strip(cur.siteCurrency) }));
}

/** Remove an item and keep keyboard focus on a neighbour (or the add field). */
function removeFromList(button, dataKey, action) {
  const host = button.dataset[dataKey];
  const item = button.closest('li');
  const neighbour = item?.nextElementSibling || item?.previousElementSibling;
  const neighbourHost = neighbour?.querySelector(`[data-${dataKey === 'removeSite' ? 'remove-site' : 'remove-pin'}]`)?.dataset[dataKey];
  action(host);
  const attr = dataKey === 'removeSite' ? 'data-remove-site' : 'data-remove-pin';
  const target = neighbourHost && $(`[${attr}="${CSS.escape(neighbourHost)}"]`);
  if (target) target.focus();
  else if (dataKey === 'removeSite') $('#site-input').focus();
}

function siteAvatar(host) {
  const label = siteLabel(host);
  const avatar = el('span', { class: 'site-avatar', 'aria-hidden': 'true', text: label.charAt(0) });
  avatar.style.setProperty('--hue', String(hueFor(label)));
  return avatar;
}

function renderSites(list = []) {
  const ul = $('#site-list');
  const key = list.join('\n');
  if (ul.dataset.key === key) return; // unchanged → keep DOM (and focus) intact
  ul.dataset.key = key;
  ul.replaceChildren(
    ...[...list].reverse().map((host) => {
      const label = t('options_sites_remove', [host]);
      const item = el(
        'li',
        { class: 'site-item' },
        siteAvatar(host),
        el('span', { class: 'site-host', dir: 'ltr', title: host, text: host }),
        el(
          'button',
          { type: 'button', class: 'icon-btn site-remove', 'data-remove-site': host, 'aria-label': label, title: label },
          anyIcon('x', { size: 16 }),
        ),
      );
      if (host === state.lastAddedSite) item.classList.add('is-new');
      return item;
    }),
  );
  state.lastAddedSite = null;
  $('#site-empty').hidden = list.length > 0;
}

function renderPins(siteCurrency) {
  const entries = sitePinList(siteCurrency);
  const ul = $('#pin-list');
  const key = JSON.stringify(entries);
  if (ul.dataset.key === key) return;
  ul.dataset.key = key;
  ul.replaceChildren(
    ...entries.map(({ host, pins }) => {
      const label = t('options_pins_remove', [host]);
      const chips = el(
        'span',
        { class: 'pin-chips' },
        ...pins.map(({ symbol, currency }) =>
          el(
            'span',
            { class: 'pin-chip', title: `${SYMBOL_GLYPH[symbol]} = ${currency} — ${currencyName(currency)}` },
            el('span', { class: 'pin-chip-symbol', text: SYMBOL_GLYPH[symbol] }),
            el('span', { class: 'pin-chip-arrow', text: '=' }),
            el('span', { text: currency }),
          ),
        ),
      );
      return el(
        'li',
        { class: 'site-item' },
        siteAvatar(host),
        el('span', { class: 'site-host', dir: 'ltr', title: host, text: host }),
        chips,
        el(
          'button',
          { type: 'button', class: 'icon-btn site-remove', 'data-remove-pin': host, 'aria-label': label, title: label },
          anyIcon('x', { size: 16 }),
        ),
      );
    }),
  );
  $('#pin-empty').hidden = entries.length > 0;
}

/* ================================================================== */
/* Keyboard shortcuts                                                  */
/* ================================================================== */

function setupShortcuts() {
  renderShortcuts();
  $('#customize-shortcuts').addEventListener('click', openShortcutsPage);
  // The user may change shortcuts in another tab — refresh when we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderShortcuts();
  });
}

async function renderShortcuts() {
  let commands = await getCommands();
  if (!commands.length) {
    // Dev harness / API unavailable: show the manifest defaults.
    commands = Object.entries(DEFAULT_SHORTCUTS).map(([name, shortcut]) => ({ name, shortcut, defaulted: true }));
  }
  $('#shortcut-list').replaceChildren(
    ...commands.map((command) => {
      const keys = shortcutKeys(command.shortcut).map((k) => (command.defaulted ? prettyKey(k) : k));
      return el(
        'li',
        { class: 'shortcut-item' },
        el('span', { class: 'shortcut-name', text: commandLabel(command) }),
        keys.length ? kbdGroup(keys) : el('span', { class: 'shortcut-unset', text: t('options_shortcut_not_set') }),
      );
    }),
  );
}

/* ================================================================== */
/* Exchange rates                                                      */
/* ================================================================== */

function setupRates() {
  $('#rates-refresh').addEventListener('click', refreshRates);
  // Keep "Downloaded 5 minutes ago" honest while the page stays open.
  setInterval(() => {
    if (document.visibilityState === 'visible') renderRates();
  }, 60_000);
}

function renderRates() {
  const rates = state.rates;
  const home = state.settings?.homeCurrency || 'USD';
  $('#rates-warning').hidden = rates?.source !== 'snapshot';
  $('#rates-date').textContent = rates ? formatDate(rates.date) || rates.date : '—';
  $('#rates-updated').textContent =
    rates?.fetchedAt > 0 ? formatRelativeTime(rates.fetchedAt) : rates ? t('options_rates_never') : '—';
  $('#rates-source').textContent = !rates
    ? '—'
    : rates.source === 'snapshot'
      ? t('options_rates_source_snapshot')
      : RATE_SOURCE_LABELS[rates.source] || rates.source;

  $('#rates-sample-label').textContent = t('options_rates_sample', [home]);
  const codes = SAMPLE_CODES.filter((c) => c !== home).slice(0, 4);
  $('#rates-sample').replaceChildren(
    ...codes.map((code) => {
      // Uniform direction under the "In <home>" heading, even for tiny rates (1 JPY = $0.0067).
      const text = rateText(code, home, rates, { flip: false }) || `1 ${code} = —`;
      const flag = currencyFlag(code);
      return el(
        'li',
        { title: `${code} — ${currencyName(code)}` },
        flag ? el('span', { class: 'cur-opt-flag', 'aria-hidden': 'true', text: flag }) : null,
        el('span', { class: 'rates-sample-text', text }),
      );
    }),
  );
}

async function refreshRates() {
  const button = $('#rates-refresh');
  if (button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    const res = await send(MSG.REFRESH_RATES);
    if (res?.rates) state.rates = res.rates;
    render(state.settings);
    renderRates();
    if (state.rates?.source === 'snapshot') showToast(t('options_rates_refresh_failed'), { type: 'error', duration: 3200 });
    else showToast(t('options_rates_refreshed'));
  } catch (err) {
    console.warn('[TransPrice] refresh failed', err?.message || err);
    showToast(t('options_rates_refresh_failed'), { type: 'error', duration: 3200 });
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

/* Boot (last, so every module-level binding above is initialised). */
init().catch((err) => {
  console.error('[TransPrice] options failed to initialise', err);
  root.classList.remove('is-loading');
});
