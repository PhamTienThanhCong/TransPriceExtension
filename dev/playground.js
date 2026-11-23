/**
 * TransPrice — algorithm playground (dev only). Runs the real engine (currency-data.js + parser.js, loaded as classic
 * scripts by playground.html) on the textarea and shows every match, the page context and the conversion with the
 * bundled rate snapshot. Builds DOM nodes only — the input text never goes through innerHTML.
 */
import { RATES_SNAPSHOT } from '../extension/src/background/rates-snapshot.js';

const C = globalThis.TransPriceCurrencies;
const P = globalThis.TransPriceParser;
const $ = (id) => document.getElementById(id);

const NBSP = '\u00A0';
const NNBSP = '\u202F';
const SAMPLE = [
  '淘宝 · 夏季新款连衣裙',
  '¥189  ¥43.65  ¥126  ¥109  ¥140  ¥3.6  ¥157  ¥10.3  ¥16.8  ¥296  ¥181.3  ¥6.15',
  '10 off over 198 · 7 off for every 6 · 100 off 5 · 5 people bought · 2027',
  '券后价 ¥43.65 起 · 189元包邮 · 人民币1.5万元 · ¥10-20 · 1000日元',
  '',
  'Amazon: Kindle Paperwhite $1,299.99 — or US$5/month, HK$12, CAD $24.99, $10 - $20, $1.5 million',
  `Europa: 12,99 € statt 1.234,56 € · 1${NBSP}234,56${NNBSP}€ · CHF 12.50 · 99 kr · 25 zł · £5m · 10–20 €`,
  '日本: 1.5万円 · ￥43.65 · 1,980円(税込) · ¥12,800',
  'Việt Nam: 50.000đ · 50.000 ₫ · 1,2 triệu đ · chỉ 99k₫ · 5 tỷ đồng',
  'Asia: Rp 15.000 · ₹12,34,567.89 · ₩12,000 · 1만원 · ฿100 · RM12.90 · R$ 1.234,56',
  'Codes: USD 12.99 · 12.99 USD · 150 TRY · $5 USD',
  '',
  'Not prices: v1.2.3 · USDT 5 · abc$5 · ${price} · call 0912 345 678 · 5:30 · TOP 10 · Giá 199k',
].join('\n');

const DEFAULTS = { hostname: 'item.taobao.com', lang: '', defaultYen: 'CNY', defaultDollar: 'USD' };
const DOLLARS = C.TOKENS.find((t) => t.token === '$').currencies;
const uiLocales = navigator.languages && navigator.languages.length ? [...navigator.languages] : ['en'];

/** Tiny DOM builder: el('td', { className: 'num' }, 'text', childNode). Text children become text nodes. */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function fillSelects() {
  const names = new Intl.DisplayNames(uiLocales, { type: 'currency' });
  const home = $('home');
  for (const code of C.CODES) {
    const label = `${C.flag(code)} ${code} — ${names.of(code)}`.trim();
    home.append(el('option', { value: code, textContent: label }));
  }
  home.value = 'VND';
  for (const code of DOLLARS) $('defaultDollar').append(el('option', { value: code, textContent: code }));
  $('defaultDollar').value = DEFAULTS.defaultDollar;
}

function reset() {
  $('text').value = SAMPLE;
  $('hostname').value = DEFAULTS.hostname;
  $('lang').value = DEFAULTS.lang;
  $('defaultYen').value = DEFAULTS.defaultYen;
  $('defaultDollar').value = DEFAULTS.defaultDollar;
  render();
}

/** Why a match has its currency: the explicit token, or the context rule that resolved $ / ¥ / kr. */
function reasonOf(m, ctx) {
  if (!m.ambiguous) return { text: 'token', title: 'the token names the currency', amb: false };
  if (C.AMBIGUOUS.yen.includes(m.token)) return { text: ctx.reasons.yen, title: `¥ means ${ctx.yen} here`, amb: true };
  if (C.AMBIGUOUS.dollar.includes(m.token) || m.token === 'dollars') return { text: ctx.reasons.dollar, title: `$ means ${ctx.dollar} here`, amb: true };
  return { text: 'domain/lang', title: `kr means ${ctx.kr} here`, amb: true };
}

function convertedText(m, home, compact) {
  if (m.currency === home) return { text: 'home currency', ok: false };
  const locale = C.localeFor(home, uiLocales);
  const fmt = (v) => P.formatMoney(v, home, { locale, compact });
  const lo = P.convert(m.amount, m.currency, home, RATES_SNAPSHOT);
  if (lo === null) return { text: 'no rate', ok: false };
  if (m.amountMax === undefined) return { text: `≈ ${fmt(lo)}`, ok: true };
  return { text: `≈ ${fmt(lo)} – ${fmt(P.convert(m.amountMax, m.currency, home, RATES_SNAPSHOT))}`, ok: true };
}

function renderContext(ctx) {
  const items = [
    ['$', ctx.dollar, ctx.reasons.dollar],
    ['¥', ctx.yen, ctx.reasons.yen],
    ['kr', ctx.kr, ''],
    ['decimal', ctx.decimal === null ? 'unknown' : `"${ctx.decimal}"`, ctx.reasons.decimal],
  ];
  $('ctx').replaceChildren(
    ...items.map(([k, v, why]) =>
      el('div', { className: 'chip' }, el('dt', { textContent: k }), el('dd', {}, el('b', { textContent: v }), why ? el('small', { textContent: why }) : null)),
    ),
  );
}

let active = -1;
function setActive(i) {
  if (active === i) return;
  for (const n of document.querySelectorAll('[data-i].on')) n.classList.remove('on');
  active = i;
  if (i >= 0) for (const n of document.querySelectorAll(`[data-i="${i}"]`)) n.classList.add('on');
}

function render() {
  const text = $('text').value;
  const home = $('home').value;
  const compact = $('compact').checked;
  const settings = { defaultDollar: $('defaultDollar').value, defaultYen: $('defaultYen').value };
  const ctx = P.resolveContext({ hostname: $('hostname').value, lang: $('lang').value, sampleText: text.slice(0, 3000), settings });

  const t0 = performance.now();
  const matches = P.findPrices(text, ctx);
  const ms = performance.now() - t0;

  renderContext(ctx);
  $('stats').textContent = `${matches.length} price${matches.length === 1 ? '' : 's'} · ${ms.toFixed(2)} ms`;

  // Highlighted text: plain text nodes between <mark>s, built node by node.
  const frag = document.createDocumentFragment();
  let pos = 0;
  matches.forEach((m, i) => {
    if (m.start > pos) frag.append(text.slice(pos, m.start));
    const conv = convertedText(m, home, compact);
    const title = [`${m.raw.trim()} → ${conv.text}`, P.rateText(m.currency, home, RATES_SNAPSHOT, { locale: C.localeFor(home, uiLocales) })]
      .filter(Boolean)
      .join(' · ');
    const mark = el('mark', { className: `price${m.ambiguous ? ' amb' : ''}`, title, textContent: text.slice(m.start, m.end) });
    mark.dataset.i = String(i);
    frag.append(mark);
    if (conv.ok) frag.append(el('span', { className: 'conv', textContent: conv.text }));
    pos = m.end;
  });
  if (pos < text.length) frag.append(text.slice(pos));
  $('highlight').replaceChildren(frag);

  // Table
  const rows = matches.map((m, i) => {
    const why = reasonOf(m, ctx);
    const conv = convertedText(m, home, compact);
    const amount = m.amountMax === undefined ? String(m.amount) : `${m.amount} – ${m.amountMax}`;
    const tr = el(
      'tr',
      {},
      el('td', { className: 'muted', textContent: String(i + 1) }),
      el('td', {}, el('code', { textContent: m.raw.replace(/\s+/g, ' ') })),
      el('td', { className: 'num', textContent: amount }),
      el('td', {}, el('span', { className: 'cur', textContent: `${C.flag(m.currency)} ${m.currency}`.trim() })),
      el('td', {}, el('code', { textContent: m.token })),
      el('td', { className: m.ambiguous ? 'amb-cell' : 'muted', textContent: m.ambiguous ? 'yes' : 'no' }),
      el('td', { className: why.amb ? 'amb-cell' : 'muted', textContent: why.text, title: why.title }),
      el('td', { className: `num${conv.ok ? '' : ' muted'}`, textContent: conv.text }),
    );
    tr.dataset.i = String(i);
    return tr;
  });
  if (!rows.length) rows.push(el('tr', {}, el('td', { colSpan: 8, className: 'empty', textContent: 'No price found.' })));
  $('rows').replaceChildren(...rows);
  active = -1;
}

let timer = 0;
const schedule = () => {
  clearTimeout(timer);
  timer = setTimeout(render, 60);
};

function init() {
  fillSelects();
  $('rates').textContent = `Rates: bundled snapshot ${RATES_SNAPSHOT.date} (${Object.keys(RATES_SNAPSHOT.rates).length} currencies, base USD)`;
  for (const id of ['text', 'hostname', 'lang']) $(id).addEventListener('input', schedule);
  for (const id of ['home', 'defaultYen', 'defaultDollar', 'compact']) $(id).addEventListener('change', render);
  $('reset').addEventListener('click', reset);
  $('clear').addEventListener('click', () => {
    $('text').value = '';
    render();
    $('text').focus();
  });
  // Hovering a row lights up its match in the text (and vice versa).
  const hover = (e) => {
    const host = e.target.closest('[data-i]');
    setActive(host ? Number(host.dataset.i) : -1);
  };
  $('rows').addEventListener('mouseover', hover);
  $('highlight').addEventListener('mouseover', hover);
  $('rows').addEventListener('mouseleave', () => setActive(-1));
  $('highlight').addEventListener('mouseleave', () => setActive(-1));
  reset();
}

if (C && P) init();
else document.body.prepend(el('p', { className: 'fatal', textContent: 'Engine not loaded: check the <script src> paths.' }));
