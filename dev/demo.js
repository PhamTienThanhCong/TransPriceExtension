/*
 * TransPrice demo page controller (dev only). Runs BEFORE the content scripts (see dev/demo.html):
 *  - applies URL params to the settings (?home=VND&mode=append&highlight=0&compact=1&enabled=0&ticker=0),
 *  - snapshots #static before any conversion → "Check restore" compares it byte-for-byte after turning TransPrice off,
 *  - dev panel (enabled / mode / highlight / compact / home), live status,
 *  - dynamic content: "Load more" cards and three React-style tickers.
 * In the dev harness the content scripts run in the page world, so window.__transprice.debug is reachable here.
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const INITIAL_STATIC = $('static') ? $('static').innerHTML : '';
  window.__demoInitialStatic = INITIAL_STATIC;

  const hasChrome = !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage);

  function sendBg(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => resolve(res || null));
      } catch {
        resolve(null);
      }
    });
  }

  async function patchSettings(patch) {
    const res = await sendBg('update-settings', { patch });
    if (res && res.ok) return res.settings;
    // Fallback: write storage directly (the content script re-reads through GET_STATE).
    const { settings = {} } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
    return { ...settings, ...patch };
  }

  /* ---------------- initial settings from the URL ---------------- */

  const bool = (v) => !(v === '0' || v === 'false' || v === 'off');
  const initialPatch = {};
  if (params.has('enabled')) initialPatch.enabled = bool(params.get('enabled'));
  if (params.has('mode')) initialPatch.displayMode = params.get('mode') === 'append' ? 'append' : 'replace';
  if (params.has('highlight')) initialPatch.highlight = bool(params.get('highlight'));
  if (params.has('compact')) initialPatch.compact = bool(params.get('compact'));
  initialPatch.homeCurrency = (params.get('home') || 'VND').toUpperCase(); // the demo's expectations are VND-based
  if (!params.has('enabled')) initialPatch.enabled = true;
  if (!params.has('mode')) initialPatch.displayMode = 'replace';

  /* ---------------- dev panel ---------------- */

  function syncPanel(st) {
    if (!st) return;
    $('dev-enabled').checked = !!st.enabled;
    $('dev-mode').value = st.displayMode === 'append' ? 'append' : 'replace';
    $('dev-highlight').checked = !!st.highlight;
    $('dev-compact').checked = !!st.compact;
    if (st.homeCurrency) $('dev-home').value = st.homeCurrency;
  }

  function wirePanel() {
    $('dev-enabled').addEventListener('change', (e) => patchSettings({ enabled: e.target.checked }).then(syncPanel));
    $('dev-mode').addEventListener('change', (e) => patchSettings({ displayMode: e.target.value }).then(syncPanel));
    $('dev-highlight').addEventListener('change', (e) => patchSettings({ highlight: e.target.checked }).then(syncPanel));
    $('dev-compact').addEventListener('change', (e) => patchSettings({ compact: e.target.checked }).then(syncPanel));
    $('dev-home').addEventListener('change', (e) => patchSettings({ homeCurrency: e.target.value }).then(syncPanel));
    $('dev-restore-check').addEventListener('click', restoreCheck);
  }

  const setText = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  function updateStatus() {
    const badges = document.querySelectorAll('transprice-badge').length;
    const hidden = document.querySelectorAll('[data-transprice-hidden]').length;
    const dbg = window.__transprice && window.__transprice.debug;
    let info = '';
    if (dbg) {
      const p = dbg.pageInfo();
      const cur = Object.entries(p.currencies).map(([c, n]) => `${c}×${n}`).join(' ');
      const amb = p.ambiguous.map((a) => `${a.token}→${a.currency} (${a.reason}, ${a.count})`).join(', ');
      info = `active: ${p.active} · converted: ${p.count} [${cur}] · ambiguous: ${amb || '–'} · `;
    }
    setText($('dev-status'), `${info}badges: ${badges} · hidden pieces: ${hidden}`);
  }

  /* ---------------- restore check ---------------- */

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function restoreCheck() {
    const out = $('dev-restore-result');
    out.className = '';
    setText(out, 'turning TransPrice off…');
    await patchSettings({ enabled: false });
    for (let i = 0; i < 40 && document.querySelector('transprice-badge, [data-transprice-hidden]'); i++) await wait(100);
    await wait(300);
    const now = $('static').innerHTML;
    const same = now === INITIAL_STATIC;
    let detail = '';
    if (!same) {
      let i = 0;
      while (i < now.length && now[i] === INITIAL_STATIC[i]) i++;
      detail = ` — first difference at char ${i}: “${now.slice(Math.max(0, i - 40), i + 60)}”`;
    }
    out.className = same ? 'ok' : 'bad';
    setText(out, same ? '✓ #static restored byte-for-byte' : `✗ #static differs${detail}`);
    window.__demoRestoreResult = { same, length: now.length, initialLength: INITIAL_STATIC.length };
    syncPanel(await patchSettings({ enabled: true }));
  }

  /* ---------------- dynamic content ---------------- */

  const MORE = [
    ['Retro Ceramic Coffee Mug with Wooden Lid', '¥', '39', '.90', 'Free shipping'],
    ['Handmade Rattan Storage Basket, Large', '¥', '72', '', '7 off for every 6'],
    ['Linen Table Runner, Boho Fringe 180 cm', '¥', '25', '.80', '10 off over 198'],
    ['Mini Projector 1080p Home Cinema', '¥', '459', '', 'Return treasure'],
    ['Silk Pillowcase 2-Pack, Champagne', '¥', '118', '.50', '100 off 5'],
    ['Desk Plant Pot Set with Bamboo Tray', '¥', '19', '.99', 'Free shipping'],
  ];
  let moreCount = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function moreCard([title, unit, int, dec, promo], n) {
    const a = el('a', 'Card--doubleCardWrapper');
    a.href = `#more-${n}`;
    const pic = el('div', 'MainPic--mainPicWrapper');
    pic.append(el('div', `ph ph-${13 + (n % 6)}`));
    const desc = el('div', 'Title--descWrapper');
    const t = el('div', 'Title--title');
    t.append(el('span', '', title));
    desc.append(t);
    const sp = el('div', 'SalesPoint--subIconWrapper');
    sp.append(el('span', 'promo', promo));
    const price = el('div', 'Price--priceWrapper');
    price.append(el('span', 'Price--unit', unit), el('span', 'Price--priceInt', int));
    if (dec) price.append(el('span', 'Price--priceFloat', dec));
    const pc = el('div', 'Price--procity');
    pc.append(el('span', '', 'Zhejiang'));
    price.append(el('span', 'Price--realSales', `${3 + n} people bought`), pc);
    const shop = el('div', 'ShopInfo--shopInfo');
    shop.append(el('span', 'same', 'Same style'));
    a.append(pic, desc, sp, price, shop);
    return a;
  }

  function loadMore() {
    const grid = $('more-grid');
    const frag = document.createDocumentFragment();
    for (const item of MORE) frag.append(moreCard(item, moreCount++));
    grid.append(frag);
  }

  let tick = 0;
  function runTickers() {
    tick++;
    const v = (base) => (base + ((tick * 37) % 100) / 10).toFixed(2);
    // 1) React text child: element.textContent = '…' (replaces the text node — and our badge — wholesale)
    $('tick-plain').textContent = `¥${v(12)}`;
    // 2) React list re-render of a split price: brand-new piece elements
    const [int, dec] = v(88).split('.');
    $('tick-split').replaceChildren(
      el('span', 'Price--unit', '¥'),
      el('span', 'Price--priceInt', int),
      el('span', 'Price--priceFloat', `.${dec}`),
      el('span', 'Price--realSales', `${12 + tick} people bought`),
    );
    // 3) React text instance update: textNode.nodeValue = '…' (characterData on a node we converted)
    const host = $('tick-node');
    const textNode = [...host.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim()) || [...host.childNodes].find((n) => n.nodeType === 3);
    if (textNode) textNode.nodeValue = `¥${v(5)}`;
    setTimeout(() => {
      const count = (id) => $(id).querySelectorAll('transprice-badge').length;
      const status = `tick #${tick} · badges: plain ${count('tick-plain')} · split ${count('tick-split')} · node ${count('tick-node')}`;
      setText($('tick-status'), status);
      window.__demoTicker = { tick, plain: count('tick-plain'), split: count('tick-split'), node: count('tick-node') };
    }, 600);
  }

  /** Carousel-style copy of an already converted card (cloneNode copies our marks, not our closed shadow root). */
  function cloneCard() {
    const src = document.querySelector('#static .tb-grid > a:nth-child(2)');
    if (src) $('more-grid').append(src.cloneNode(true));
  }

  /** A web component with an OPEN shadow root (built before the content scripts run). */
  function buildShadowWidget() {
    const host = $('shadow-host');
    if (!host || !host.attachShadow) return;
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style', '', '.p{color:#e4393c;font-weight:700}.p .i{font-size:20px}.e{margin-left:12px;font-weight:600}');
    const p = el('span', 'p');
    p.append(el('span', 'u', '¥'), el('span', 'i', '59'), el('span', 'd', '.90'));
    root.append(style, p, el('span', 'e', '€12.50'));
  }

  /* ---------------- boot ---------------- */

  buildShadowWidget();
  wirePanel();
  $('load-more').addEventListener('click', loadMore);
  $('clone-card').addEventListener('click', cloneCard);
  if (params.get('cloneAfter')) setTimeout(cloneCard, Number(params.get('cloneAfter')) || 2500);
  if (params.get('more')) for (let i = 0; i < Number(params.get('more')); i++) loadMore();
  if (params.get('moreAfter')) setTimeout(loadMore, Number(params.get('moreAfter')) || 1500); // after the first scan
  if (params.get('ticker') !== '0') setInterval(runTickers, 2000);
  setInterval(updateStatus, 700);

  if (hasChrome) {
    patchSettings(initialPatch).then(syncPanel, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.settings && changes.settings.newValue) syncPanel(changes.settings.newValue);
    });
  } else {
    setText($('dev-status'), 'chrome.* mock missing — open this page through `npm run dev` (http://localhost:5180/dev/demo.html)');
  }
})();
