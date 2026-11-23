/**
 * TransPrice — small UI kit shared by the popup, the options page and the welcome page.
 * Everything here builds DOM nodes; page / user text is only ever assigned via textContent.
 *
 * Pages must import the engine for its side effects BEFORE using the money helpers:
 *   import '../shared/currency-data.js';   // globalThis.TransPriceCurrencies
 *   import '../content/parser.js';         // globalThis.TransPriceParser
 */
import { getCurrentUiLocale, t } from '../shared/i18n.js';
import { icon } from '../ui/icons.js';
import { buildCurrencyList, filterCurrencies } from './ui-helpers.js';

export const LOGO_SRC = '../../icons/logo.svg';
export const REPO_URL = 'https://github.com/PhamTienThanhCong/TransPriceExtension';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const PRIVACY_URL = `${REPO_URL}/blob/main/docs/PRIVACY.md`;
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Tiny element factory: el('span', { class: 'x', text: 'hello', 'aria-label': '…' }, child1, 'text child')
 * `text` → textContent (safe). Other keys → attributes (`false`/`null`/`undefined` skipped, `true` → '').
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/**
 * SVGElement for `name` from the shared icon set (src/ui/icons.js). Kept as a wrapper so callers have one entry point.
 * @param {string} name
 * @param {{size?: number, className?: string, strokeWidth?: number}} [opts]
 * @returns {SVGElement}
 */
export function anyIcon(name, opts = {}) {
  return icon(name, opts);
}

/** Replace every `<i data-icon="name" [data-icon-size]>` placeholder (shared or extra icons). */
export function hydrateAllIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((node) => {
    const size = Number(node.dataset.iconSize) || undefined;
    node.replaceWith(anyIcon(node.dataset.icon, { size, className: node.className || '' }));
  });
}

/* ------------------------------------------------------------------ */
/* Logo                                                                */
/* ------------------------------------------------------------------ */

function logoFallback(img) {
  if (!img.parentNode || img.dataset.fallback) return;
  img.dataset.fallback = '1';
  const size = Number(img.getAttribute('width')) || 28;
  const fallback = el('span', { class: `logo-fallback ${img.className}`, 'aria-hidden': 'true' });
  fallback.style.width = `${size}px`;
  fallback.style.height = `${size}px`;
  fallback.append(anyIcon('coins', { size: Math.round(size * 0.6) }));
  img.replaceWith(fallback);
}

/** The TransPrice logo <img>; degrades to a gradient coin mark if the SVG is missing. */
export function logoImg(size = 28, className = '') {
  const img = el('img', { src: LOGO_SRC, width: size, height: size, alt: '', class: `logo ${className}`.trim(), draggable: 'false' });
  img.addEventListener('error', () => logoFallback(img), { once: true });
  return img;
}

/** Attach the fallback to every `img.logo` already in the document (the error may have fired already). */
export function setupLogos(root = document) {
  root.querySelectorAll('img.logo').forEach((img) => {
    img.addEventListener('error', () => logoFallback(img), { once: true });
    img.decode?.().catch(() => {
      if (img.complete) logoFallback(img);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Money (thin wrappers around the engine globals, with Intl fallbacks) */
/* ------------------------------------------------------------------ */

const currencies = () => globalThis.TransPriceCurrencies || null;
const parser = () => globalThis.TransPriceParser || null;

/** UI locale first, then the browser's languages — what localeFor() picks a formatting locale from. */
export function preferredLocales() {
  const out = [getCurrentUiLocale()];
  for (const l of (typeof navigator !== 'undefined' && navigator.languages) || []) if (!out.includes(l)) out.push(l);
  return out;
}

/** Locale used to format amounts of `code` ("730.373 ₫" for VND, "$25.99" for USD). */
export function moneyLocale(code) {
  try {
    return currencies()?.localeFor?.(code, preferredLocales()) || getCurrentUiLocale();
  } catch {
    return getCurrentUiLocale();
  }
}

/**
 * Format an amount in `code` the same way the in-page badges do.
 * @param {number} value
 * @param {string} code
 * @param {{compact?: boolean}} [opts]
 */
export function formatMoney(value, code, { compact = false } = {}) {
  const locale = moneyLocale(code);
  try {
    const out = parser()?.formatMoney?.(value, code, { locale, compact });
    if (out) return out;
  } catch {
    /* fall back below */
  }
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, notation: compact ? 'compact' : 'standard' }).format(value);
  } catch {
    return `${value} ${code}`;
  }
}

/** amount / rates[from] * rates[to], or null when a rate is missing. */
export function convertMoney(amount, from, to, rates) {
  try {
    const fn = parser()?.convert;
    if (fn) return fn(amount, from, to, rates);
  } catch {
    return null;
  }
  const a = rates?.rates?.[from];
  const b = rates?.rates?.[to];
  return a > 0 && b > 0 && Number.isFinite(amount) ? (amount / a) * b : null;
}

/**
 * "1 CNY = 3.865 ₫" ('' when a rate is missing). The engine flips tiny rates for readability
 * (VND→CNY reads "1 CNY = 3.865 ₫"); pass `{ flip: false }` to keep the literal from → to direction.
 * @param {string} from
 * @param {string} to
 * @param {object|null} rates
 * @param {{flip?: boolean}} [opts]
 */
export function rateText(from, to, rates, { flip = true } = {}) {
  try {
    const out = parser()?.rateText?.(from, to, rates, { locale: moneyLocale(to), flip });
    if (out) return out;
  } catch {
    /* fall back below */
  }
  const value = convertMoney(1, from, to, rates);
  return value === null ? '' : `1 ${from} = ${formatMoney(value, to)}`;
}

/** Localized currency name in the UI language ("Đồng Việt Nam"), falling back to the code. */
export function currencyName(code, locale = getCurrentUiLocale()) {
  try {
    const name = currencies()?.currencyName?.(code, locale);
    if (name) return name;
  } catch {
    /* fall back below */
  }
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) || code;
  } catch {
    return code;
  }
}

/** Emoji flag for a currency ('' if none). */
export function currencyFlag(code) {
  try {
    return currencies()?.flag?.(code) || '';
  } catch {
    return '';
  }
}

/** Preferred display symbol ('₫', '¥', '$' …), '' if unknown. */
export function currencySymbol(code) {
  return currencies()?.CURRENCIES?.[code]?.symbol || '';
}

let markersCache = null;
/** code → every symbol/word marker the detector knows for it (from TransPriceCurrencies.TOKENS). */
function markersOf(code) {
  if (!markersCache) {
    markersCache = new Map();
    for (const token of currencies()?.TOKENS || []) {
      if (!token || token.kind === 'code') continue;
      for (const c of token.currencies || []) {
        if (!markersCache.has(c)) markersCache.set(c, []);
        markersCache.get(c).push(token.token);
      }
    }
  }
  return markersCache.get(code) || [];
}

/**
 * Codes the UI may offer: every currency the engine knows that also has an exchange rate
 * (all known codes when the rate table is missing).
 * @param {{rates?: Record<string, number>}|null} rates
 * @returns {string[]}
 */
export function availableCodes(rates) {
  const codes = currencies()?.CODES || Object.keys(rates?.rates || {});
  const table = rates?.rates;
  return table ? codes.filter((c) => table[c] > 0) : [...codes];
}

/** Picker list (home + popular first) for the current UI language. */
export function currencyList({ home, rates }) {
  return buildCurrencyList({
    codes: availableCodes(rates),
    home,
    nameOf: (code, locale) => currencyName(code, locale),
    locale: getCurrentUiLocale(),
    symbolOf: currencySymbol,
    markersOf,
    flagOf: currencyFlag,
  });
}

/* ------------------------------------------------------------------ */
/* Currency picker — searchable combobox (flag + code + name)          */
/* ------------------------------------------------------------------ */

let pickerSeq = 0;
/** The picker whose panel is open (only one at a time). */
let openPicker = null;

function flagNode(flag, className) {
  return flag
    ? el('span', { class: className, 'aria-hidden': 'true', text: flag })
    : el('span', { class: `${className} is-empty`, 'aria-hidden': 'true' });
}

/**
 * A button that opens a searchable currency list. Typing on the focused button opens it with that text;
 * ↑/↓/PageUp/PageDown move, Enter picks, Esc closes. Matches code, names (UI language + en + vi, no diacritics
 * needed) and symbols — see filterCurrencies().
 *
 * @param {object} opts
 * @param {string} opts.label                    accessible name ("Your currency")
 * @param {() => {suggested: object[], others: object[], all: object[]}} opts.getList   current list
 * @param {string} [opts.value]
 * @param {(code: string) => void} [opts.onChange]  user picks only
 * @param {'full'|'compact'} [opts.variant]      compact = flag + code only (converter)
 * @param {'start'|'end'} [opts.align]           which trigger edge the panel lines up with
 * @param {string} [opts.className]
 * @returns {{ el: HTMLElement, button: HTMLButtonElement, setValue(code: string): void, getValue(): string,
 *             refresh(): void, close(): void, setDisabled(disabled: boolean): void }}
 */
export function createCurrencyPicker({ label, getList, value = '', onChange, variant = 'full', align = 'start', className = '' }) {
  const uid = `cur-${++pickerSeq}`;
  let current = value;
  let query = '';
  let options = []; // rendered option elements, in order
  let active = -1;

  const flag = el('span', { class: 'cur-flag', 'aria-hidden': 'true' });
  const code = el('span', { class: 'cur-code' });
  const name = variant === 'full' ? el('span', { class: 'cur-name' }) : null;
  const button = el(
    'button',
    { type: 'button', class: 'cur-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', id: `${uid}-btn` },
    flag,
    code,
    name,
    anyIcon('chevron-down', { size: 16, className: 'cur-chevron' }),
  );
  const root = el('div', { class: `cur-picker cur-picker--${variant} ${className}`.trim() }, button);

  // Panel (created once, attached to <body> while open so no overflow:hidden ancestor clips it).
  const input = el('input', {
    type: 'text',
    class: 'cur-search-input',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': `${uid}-list`,
    'aria-autocomplete': 'list',
    'aria-label': t('options_picker_search_label'),
    placeholder: t('options_picker_search'),
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const listbox = el('div', { class: 'cur-list', role: 'listbox', id: `${uid}-list`, 'aria-label': label });
  const empty = el('p', { class: 'cur-empty', text: t('options_picker_empty'), hidden: true });
  const panel = el(
    'div',
    { class: 'cur-panel', role: 'dialog', 'aria-label': label },
    el('div', { class: 'cur-search' }, anyIcon('search', { size: 16, className: 'cur-search-icon' }), input),
    listbox,
    empty,
  );

  function itemFor(c) {
    return getList().all.find((i) => i.code === c) || null;
  }

  function renderButton() {
    const item = itemFor(current);
    flag.textContent = item?.flag || '';
    flag.classList.toggle('is-empty', !item?.flag);
    code.textContent = current || '—';
    if (name) name.textContent = item?.name || '';
    const fullName = item ? `${item.code} — ${item.name}` : current;
    button.setAttribute('aria-label', `${label}: ${fullName}`);
    button.title = fullName || '';
  }

  function optionNode(item) {
    const selected = item.code === current;
    return el(
      'div',
      {
        class: `cur-option${selected ? ' is-selected' : ''}`,
        role: 'option',
        id: `${uid}-opt-${item.code}`,
        'data-code': item.code,
        'aria-selected': selected ? 'true' : 'false',
      },
      flagNode(item.flag, 'cur-opt-flag'),
      el('span', { class: 'cur-opt-code', text: item.code }),
      el('span', { class: 'cur-opt-name', text: item.name }),
      item.symbol && item.symbol !== item.code ? el('span', { class: 'cur-opt-symbol', text: item.symbol }) : null,
      selected ? anyIcon('check', { size: 15, className: 'cur-opt-check', strokeWidth: 2.5 }) : null,
    );
  }

  function renderList() {
    const list = getList();
    const frag = document.createDocumentFragment();
    options = [];
    const addGroup = (title, items) => {
      if (!items.length) return;
      const groupId = `${uid}-g${frag.childNodes.length}`;
      const nodes = items.map(optionNode);
      options.push(...nodes);
      frag.append(
        el(
          'div',
          { class: 'cur-group', role: 'group', 'aria-labelledby': groupId },
          el('div', { class: 'cur-group-label', id: groupId, role: 'presentation', text: title }),
          ...nodes,
        ),
      );
    };
    if (query.trim()) {
      addGroup(t('options_picker_results'), filterCurrencies(list.all, query));
    } else {
      addGroup(t('options_picker_suggested'), list.suggested);
      addGroup(t('options_picker_all'), list.others);
    }
    listbox.replaceChildren(frag);
    empty.hidden = options.length > 0;
    listbox.hidden = options.length === 0;
    const selectedIndex = query.trim() ? 0 : options.findIndex((o) => o.dataset.code === current);
    listbox.scrollTop = 0;
    // Selected item far down the list → bring it to the middle; near the top → leave the group label visible.
    const node = options[selectedIndex];
    const far = node && node.offsetTop + node.offsetHeight > listbox.clientHeight;
    setActive(selectedIndex >= 0 ? selectedIndex : 0, { scroll: far ? 'center' : false });
  }

  function setActive(index, { scroll = 'nearest' } = {}) {
    options[active]?.classList.remove('is-active');
    active = options.length ? Math.max(0, Math.min(options.length - 1, index)) : -1;
    const node = options[active];
    if (node) {
      node.classList.add('is-active');
      input.setAttribute('aria-activedescendant', node.id);
      if (scroll) scrollIntoList(node, scroll);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function scrollIntoList(node, mode) {
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (mode === 'center') {
      listbox.scrollTop = Math.max(0, top - listbox.clientHeight / 2 + node.offsetHeight / 2);
    } else if (top < listbox.scrollTop + 28) {
      listbox.scrollTop = Math.max(0, top - 28); // keep the sticky group label from covering it
    } else if (bottom > listbox.scrollTop + listbox.clientHeight) {
      listbox.scrollTop = bottom - listbox.clientHeight;
    }
  }

  function position() {
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const width = Math.min(Math.max(r.width, 280), vw - margin * 2);
    let left = align === 'end' ? r.right - width : r.left;
    left = Math.max(margin, Math.min(left, vw - margin - width));
    const spaceBelow = vh - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const below = spaceBelow >= 300 || spaceBelow >= spaceAbove;
    const room = Math.max(160, (below ? spaceBelow : spaceAbove) - 6);
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    panel.style.maxHeight = `${Math.min(380, room)}px`;
    if (below) {
      panel.style.top = `${r.bottom + 6}px`;
      panel.style.bottom = 'auto';
    } else {
      panel.style.top = 'auto';
      panel.style.bottom = `${vh - r.top + 6}px`;
    }
    panel.dataset.side = below ? 'bottom' : 'top';
  }

  const onDocPointer = (e) => {
    if (!panel.contains(e.target) && !button.contains(e.target)) close(false);
  };
  const onViewport = (e) => {
    if (e?.type === 'scroll' && panel.contains(e.target)) return;
    if (e?.type === 'resize' || e?.type === 'blur') close(false);
    else position();
  };

  function open(initialQuery = '') {
    if (button.disabled) return;
    if (openPicker && openPicker !== api) openPicker.close();
    openPicker = api;
    query = initialQuery;
    input.value = initialQuery;
    document.body.append(panel);
    button.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    position();
    renderList();
    input.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('scroll', onViewport, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('blur', onViewport);
  }

  function close(focusButton = true) {
    if (!panel.isConnected) return;
    panel.remove();
    if (openPicker === api) openPicker = null;
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('blur', onViewport);
    if (focusButton) button.focus({ preventScroll: true });
  }

  function choose(c) {
    if (!c) return;
    const changed = c !== current;
    current = c;
    renderButton();
    close(true);
    if (changed) onChange?.(c);
  }

  button.addEventListener('click', () => (panel.isConnected ? close(true) : open()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // type-to-search: the first character seeds the query
      open(e.key);
    }
  });

  input.addEventListener('input', () => {
    query = input.value;
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
    if (step) {
      e.preventDefault();
      setActive(active + step);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(options[active]?.dataset.code);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // close the list, not the whole popup
      close(true);
    } else if (e.key === 'Tab') {
      // Hand focus back to the button; the default Tab action then moves on from there.
      close(true);
    }
  });

  listbox.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
  listbox.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"]');
    if (option) choose(option.dataset.code);
  });
  listbox.addEventListener('pointermove', (e) => {
    const option = e.target.closest('[role="option"]');
    const index = option ? options.indexOf(option) : -1;
    if (index >= 0 && index !== active) setActive(index, { scroll: false });
  });

  const api = {
    el: root,
    button,
    setValue(c) {
      current = c || '';
      renderButton();
    },
    getValue: () => current,
    refresh() {
      renderButton();
      if (panel.isConnected) renderList();
    },
    close: () => close(false),
    setDisabled(disabled) {
      button.disabled = Boolean(disabled);
      if (disabled) close(false);
    },
  };
  renderButton();
  return api;
}

/* ------------------------------------------------------------------ */
/* Radio groups (segmented controls, selectable cards)                 */
/* ------------------------------------------------------------------ */

/**
 * Make `[role=radio]` children of `group` behave like a radio group: click / Space / Enter select,
 * arrow keys move + select, roving tabindex. `onChange(value)` fires only for user changes.
 * @returns {{ setValue(value: string): void, getValue(): string|null }}
 */
export function setupRadioGroup(group, onChange) {
  const radios = () => [...group.querySelectorAll('[role="radio"]')];
  let value = null;

  const setValue = (next) => {
    value = next == null ? null : String(next);
    const list = radios();
    const hasMatch = list.some((r) => r.dataset.value === value);
    list.forEach((r, i) => {
      const on = r.dataset.value === value;
      r.setAttribute('aria-checked', on ? 'true' : 'false');
      r.tabIndex = on || (!hasMatch && i === 0) ? 0 : -1;
    });
  };

  const choose = (radio) => {
    const next = radio.dataset.value;
    if (next === value) return;
    setValue(next);
    onChange?.(next);
  };

  group.addEventListener('click', (e) => {
    const radio = e.target.closest('[role="radio"]');
    if (radio && group.contains(radio)) choose(radio);
  });

  group.addEventListener('keydown', (e) => {
    const list = radios();
    const index = list.indexOf(e.target.closest('[role="radio"]'));
    if (index < 0) return;
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = index + 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = list[(next + list.length) % list.length];
    target.focus();
    choose(target);
  });

  return { setValue, getValue: () => value };
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLElement} node  the page's `.toast` element
 * @returns {(message: string, opts?: {type?: 'success'|'error'|'info', duration?: number}) => void}
 */
export function createToast(node) {
  let timer = 0;
  return function show(message, { type = 'success', duration = 1800 } = {}) {
    const glyph = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check';
    node.replaceChildren(anyIcon(glyph, { size: 16 }), el('span', { text: message }));
    node.dataset.type = type;
    node.classList.remove('is-visible');
    void node.offsetWidth; // restart the transition when a toast is already visible
    node.classList.add('is-visible');
    clearTimeout(timer);
    timer = setTimeout(() => node.classList.remove('is-visible'), duration);
  };
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

export function isMac() {
  const platform = (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** chrome.commands.getAll(), toggle first. Never throws ([] in the dev harness). */
export async function getCommands() {
  try {
    if (!chrome.commands?.getAll) return [];
    const list = await chrome.commands.getAll();
    const order = ['toggle-enabled', '_execute_action'];
    const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length);
    return [...(list || [])].sort((a, b) => rank(a.name) - rank(b.name));
  } catch {
    return [];
  }
}

/** Default keys from the manifest, shown when chrome.commands is unavailable. */
export const DEFAULT_SHORTCUTS = Object.freeze({ 'toggle-enabled': 'Alt+Shift+C', _execute_action: 'Alt+Shift+P' });

/** Our command names → message keys, so labels follow the Display-language setting. */
export function commandLabel(command) {
  const keys = { 'toggle-enabled': 'options_shortcut_toggle', _execute_action: 'options_shortcut_popup' };
  const key = keys[command?.name];
  return key ? t(key) : command?.description || command?.name || '';
}

/** Mac shows ⌥ / ⇧ for the manifest's Alt / Shift. */
export function prettyKey(key) {
  if (!isMac()) return key;
  return { Alt: '⌥ Option', Shift: '⇧ Shift', Ctrl: '⌃ Control', Command: '⌘ Command', MacCtrl: '⌃ Control' }[key] || key;
}

/** Element with one `.kbd` per key. */
export function kbdGroup(keys) {
  const group = el('span', { class: 'kbd-group' });
  for (const key of keys) group.append(el('kbd', { class: 'kbd', text: key }));
  return group;
}

export async function openShortcutsPage() {
  try {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
  } catch {
    /* ignore — e.g. dev harness */
  }
}

/* ------------------------------------------------------------------ */
/* Display language                                                    */
/* ------------------------------------------------------------------ */

/** A language's own name ("English", "Tiếng Việt") — findable even in a UI language the user can't read. */
export function endonym(code) {
  try {
    const n = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (n && n.toLowerCase() !== code.toLowerCase()) return n.charAt(0).toLocaleUpperCase(code) + n.slice(1);
  } catch {
    /* fall through */
  }
  return code;
}

/** Fill a Display-language <select>: "Auto (browser language)" + each shipped UI locale by its endonym. */
export function fillUiLanguageSelect(select, languages) {
  select.replaceChildren(
    new Option(t('options_ui_language_auto'), 'auto'),
    ...languages
      .filter((code) => code !== 'auto')
      .map((code) => {
        const option = new Option(endonym(code), code);
        option.lang = code;
        return option;
      }),
  );
}
