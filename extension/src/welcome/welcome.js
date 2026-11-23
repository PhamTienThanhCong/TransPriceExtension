/**
 * TransPrice — Welcome / onboarding page (opened by the background right after install).
 * Lets the user confirm the home currency (prefilled from the browser language), explains the three steps
 * (detected → converted → toolbar toggle) with a real conversion, and shows the Alt+Shift+C shortcut.
 */
import '../shared/currency-data.js'; // side effect: globalThis.TransPriceCurrencies
import '../content/parser.js'; // side effect: globalThis.TransPriceParser
import { MSG, STORAGE_KEYS, UI_LANGUAGES } from '../shared/constants.js';
import { initI18n, localizeDocument, reloadOnUiLanguageChange, t } from '../shared/i18n.js';
import { send } from '../shared/messaging.js';
import { getSettings, getStoredRates, onSettingsChanged, updateSettings } from '../shared/storage.js';
import { applyTheme } from '../ui/theme.js';
import {
  DEFAULT_SHORTCUTS,
  anyIcon,
  convertMoney,
  createCurrencyPicker,
  createToast,
  currencyList,
  el,
  fillUiLanguageSelect,
  formatMoney,
  getCommands,
  hydrateAllIcons,
  kbdGroup,
  logoImg,
  openShortcutsPage,
  prettyKey,
  setupLogos,
} from '../options/ui-kit.js';
import { shortcutKeys } from '../options/ui-helpers.js';

applyTheme('auto');

const $ = (sel) => document.querySelector(sel);
const EXAMPLE_PRICES = '¥189, $1,299.99, 12,99 €, 189元';
const showToast = createToast($('#toast'));
const state = { settings: null, rates: null, theme: null, list: null, listKey: '' };
let picker = null;

async function init() {
  await initI18n(); // Display language — before localizeDocument() and Intl formatters
  hydrateAllIcons();
  localizeDocument();
  setupLogos();
  $('#mini-ext-logo').append(logoImg(18));
  // Example prices are page text, not UI copy — passed as a substitution (a literal "$1" can't live in messages.json).
  $('#step1-desc').textContent = t('welcome_step1_desc', [EXAMPLE_PRICES]);

  fillUiLanguageSelect($('#w-uiLanguage'), UI_LANGUAGES);
  $('#w-uiLanguage').addEventListener('change', (e) => save({ uiLanguage: e.target.value })); // → page reloads

  const [settings, rates] = await Promise.all([getSettings(), loadRates()]);
  state.rates = rates;

  picker = createCurrencyPicker({
    label: t('welcome_home_title'),
    getList: () => state.list || currencyList({ home: state.settings?.homeCurrency, rates: state.rates }),
    align: 'end',
    onChange: (code) => save({ homeCurrency: code }),
  });
  picker.button.setAttribute('aria-describedby', 'home-desc');
  $('#w-home').append(picker.el);

  render(settings);
  setupShortcutTip();
  setupActions();

  onSettingsChanged((s) => render(s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.RATES]?.newValue) {
      state.rates = changes[STORAGE_KEYS.RATES].newValue;
      renderIllustrations();
    }
  });
  reloadOnUiLanguageChange();
}

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
/* Settings                                                            */
/* ================================================================== */

let saveChain = Promise.resolve();
let toastTimer = 0;

function save(patch) {
  if (state.settings) render({ ...state.settings, ...patch });
  saveChain = saveChain
    .then(() => updateSettings(patch))
    .then((next) => {
      render(next);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => showToast(t('options_saved')), 80);
    })
    .catch((err) => {
      console.error('[TransPrice] failed to save settings', err);
      showToast(t('options_save_failed'), { type: 'error', duration: 3200 });
    });
  return saveChain;
}

function render(s) {
  if (!s) return;
  state.settings = s;
  if (s.theme !== state.theme) {
    state.theme = s.theme;
    applyTheme(s.theme);
  }
  const lang = $('#w-uiLanguage');
  if (lang.value !== s.uiLanguage) lang.value = s.uiLanguage;

  const key = `${s.homeCurrency}|${Object.keys(state.rates?.rates || {}).length}`;
  if (key !== state.listKey) {
    state.listKey = key;
    state.list = currencyList({ home: s.homeCurrency, rates: state.rates });
    picker.refresh();
  }
  picker.setValue(s.homeCurrency);
  renderIllustrations();
}

/* ================================================================== */
/* "How it works" illustrations (a real conversion into the chosen currency) */
/* ================================================================== */

function sample(home) {
  return home === 'CNY' ? { raw: '$25.99', amount: 25.99, currency: 'USD' } : { raw: '¥189', amount: 189, currency: 'CNY' };
}

function renderIllustrations() {
  const home = state.settings?.homeCurrency || 'USD';
  const src = sample(home);
  const value = convertMoney(src.amount, src.currency, home, state.rates);
  const converted = value === null ? '—' : formatMoney(value, home);

  const product = (price) =>
    el(
      'span',
      { class: 'il-product' },
      el('span', { class: 'il-thumb' }, anyIcon('tag', { size: 20 })),
      el('span', { class: 'il-lines' }, el('span', { class: 'il-bar' }), el('span', { class: 'il-bar il-bar--short' }), price),
    );

  $('#illus-detect').replaceChildren(
    product(el('span', { class: 'il-price is-scanning', text: src.raw })),
    el('span', { class: 'il-scan-badge' }, anyIcon('scan-search', { size: 14 })),
  );

  $('#illus-convert').replaceChildren(
    el(
      'span',
      { class: 'il-convert' },
      el('span', { class: 'il-from', text: src.raw }),
      el('span', { class: 'il-arrow' }, anyIcon('arrow-right', { size: 16 })),
      el('span', { class: 'il-to', text: converted, title: `${src.raw} → ${converted}` }),
    ),
  );

  $('#illus-toggle').replaceChildren(
    el(
      'span',
      { class: 'il-toggle' },
      el(
        'span',
        { class: 'il-toolbar' },
        el('span', { class: 'il-url' }),
        anyIcon('puzzle', { size: 15 }),
        el(
          'span',
          { class: 'il-ext' },
          logoImg(18),
          el('span', { class: 'il-badge', text: '24' }),
          el('span', { class: 'il-cursor' }, anyIcon('pointer', { size: 18 })),
        ),
      ),
      el(
        'span',
        { class: 'il-switch' },
        el('span', { class: 'il-switch-knob' }, anyIcon('power', { size: 11 })),
        t('welcome_illus_on'),
      ),
    ),
  );
}

/* ================================================================== */
/* Shortcut tip + actions                                              */
/* ================================================================== */

function setupShortcutTip() {
  renderShortcutTip();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderShortcutTip();
  });
}

async function renderShortcutTip() {
  const commands = await getCommands();
  const command = commands.find((c) => c.name === 'toggle-enabled');
  const keys = command ? shortcutKeys(command.shortcut) : shortcutKeys(DEFAULT_SHORTCUTS['toggle-enabled']).map(prettyKey);
  const holder = $('#tip-keys');
  if (keys.length) {
    holder.replaceChildren(kbdGroup(keys));
    return;
  }
  // The user (or a conflicting extension) removed the shortcut — offer to set one.
  const button = el('button', { type: 'button', class: 'link-btn' }, t('welcome_tip_shortcut_set'), anyIcon('external-link', { size: 13 }));
  button.addEventListener('click', openShortcutsPage);
  holder.replaceChildren(button);
}

function setupActions() {
  $('#w-open-settings').addEventListener('click', () => {
    Promise.resolve()
      .then(() => chrome.runtime.openOptionsPage())
      .catch(() => send(MSG.OPEN_OPTIONS).catch(() => {}));
  });
  $('#w-start').addEventListener('click', async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id !== undefined) {
        await chrome.tabs.remove(tab.id);
        return;
      }
    } catch {
      /* fall through */
    }
    window.close();
  });
}

/* Boot (last, so every module-level binding above is initialised). */
init().catch((err) => console.error('[TransPrice] welcome failed to initialise', err));
