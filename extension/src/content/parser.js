/**
 * TransPrice — price parser → globalThis.TransPriceParser (docs/ARCHITECTURE.md §4.2, algorithm: docs/ALGORITHM.md).
 *
 * CLASSIC SCRIPT, PURE: no import/export, no DOM, no chrome.*. Needs globalThis.TransPriceCurrencies
 * (src/shared/currency-data.js, loaded first). Works as a content script, as a side-effect import and via <script src>.
 *
 * Pipeline: normalise (1:1, offsets preserved) → find currency TOKENS with one prebuilt regex → around each token try
 * the shapes `TOKEN NUMBER` / `NUMBER TOKEN` (+ multipliers, ranges) → read the number with the separator rules →
 * resolve ambiguous symbols ($ ¥ kr) through the page context.
 */
(() => {
  'use strict';

  const C = globalThis.TransPriceCurrencies;
  if (!C) throw new Error('TransPriceParser: load src/shared/currency-data.js before parser.js');

  // ───────────────────────────── characters ─────────────────────────────
  // "Word letters": scripts that separate words with spaces (Latin incl. Vietnamese, Greek, Cyrillic, Arabic).
  // A Latin token glued to such a letter is part of a word ("USDT", "Skr", "abc$5"); CJK/Thai text is not a word
  // boundary problem ("价格¥189" is fine).
  const WL = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0300-\\u04FF\\u0600-\\u06FF\\u1E00-\\u1EFF';
  const isWL = (c) =>
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) ||
    (c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) ||
    (c >= 0x300 && c <= 0x4ff) || (c >= 0x600 && c <= 0x6ff) || (c >= 0x1e00 && c <= 0x1eff);
  const isDigit = (c) => c >= 48 && c <= 57;
  /** Typographic spaces used as thousands separators (kept distinct from plain spaces, see readNumber). */
  const isTypoSpace = (c) => c === 0xa0 || c === 0x202f || (c >= 0x2002 && c <= 0x200a);
  const DASH = new Set(['-', '–', '—', '~', '〜', '至']);

  // ───────────────────────────── normalisation ─────────────────────────────
  // Every replacement is ONE UTF-16 unit → ONE unit, so offsets in the normalised string are offsets in the original.
  const NORM_RE = /[\u00A0\u2002-\u200B\u202F\u3000\uFEFF\uFF01-\uFF5E\uFFE0-\uFFE6]/g;
  const NORM_TEST = /[\u00A0\u2002-\u200B\u202F\u3000\uFEFF\uFF01-\uFF5E\uFFE0-\uFFE6]/;
  const NORM_MAP = { '\uFFE0': '\u00A2', '\uFFE1': '\u00A3', '\uFFE2': '\u00AC', '\uFFE3': '\u00AF', '\uFFE4': '\u00A6', '\uFFE5': '\u00A5', '\uFFE6': '\u20A9' };
  const normChar = (ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0); // fullwidth ASCII: １２ → 12, ＄ → $
    return NORM_MAP[ch] || ' '; // NBSP, narrow NBSP, thin/em spaces, ideographic space, ZWSP, BOM → space
  };
  const normalize = (text) => (NORM_TEST.test(text) ? text.replace(NORM_RE, normChar) : text);

  // ───────────────────────────── tokens ─────────────────────────────
  /** @type {Map<string, {token:string, currencies:string[], kind:string, prefix:boolean, suffix:boolean}>} */
  const TOKEN_INFO = new Map(C.TOKENS.map((t) => [t.token, t]));
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const DOLLAR_LIST = TOKEN_INFO.get('$').currencies;
  const YEN_LIST = TOKEN_INFO.get('¥').currencies;
  const KR_LIST = TOKEN_INFO.get('kr').currencies;
  /** Tokens whose currency comes from the page context: token → 'dollar' | 'yen' | 'kr'. */
  const FAMILY = new Map();
  for (const t of C.TOKENS) {
    if (sameList(t.currencies, DOLLAR_LIST)) FAMILY.set(t.token, 'dollar');
    else if (sameList(t.currencies, YEN_LIST)) FAMILY.set(t.token, 'yen');
    else if (sameList(t.currencies, KR_LIST)) FAMILY.set(t.token, 'kr');
  }
  // With equal gaps and equal "price-likeness", these prefer the number BEFORE them ("12,99 € 5,99 €").
  const SUFFIX_FIRST = (info) => info.kind === 'code' || /^(?:€|kr|₫)$/.test(info.token);

  // One regex for every token, longest first ("US$" before "$", "CN¥" before "¥", "日元" before "元"), escaped.
  // Tokens starting/ending with a word letter get letter boundaries ("USD" yes, "USDT"/"Skr" no).
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const TOKEN_SOURCE = [...TOKEN_INFO.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((tok) =>
      (isWL(tok.charCodeAt(0)) ? `(?<![${WL}])` : '') + escapeRe(tok) + (isWL(tok.charCodeAt(tok.length - 1)) ? `(?![${WL}])` : ''))
    .join('|');
  const TOKEN_G = new RegExp(TOKEN_SOURCE, 'g'); // scanning (findPrices)
  const TOKEN_Y = new RegExp(TOKEN_SOURCE, 'y'); // "is there a token exactly here?"
  const TOKEN_TEST = new RegExp(TOKEN_SOURCE); // stateless test (quickTest / hasToken)
  const DIGIT_TEST = /[0-9\uFF10-\uFF19]/;

  const tokenAt = (s, i) => {
    TOKEN_Y.lastIndex = i;
    const m = TOKEN_Y.exec(s);
    return m ? m[0] : null;
  };

  // ───────────────────────────── multipliers ─────────────────────────────
  // [text, factor, max spaces between the number and the multiplier]. Only read next to a currency token.
  const MULTS = [
    ['万', 1e4, 1], ['萬', 1e4, 1], ['亿', 1e8, 1], ['億', 1e8, 1], ['千', 1e3, 1],
    ['만', 1e4, 1], ['억', 1e8, 1], ['천', 1e3, 1],
    ['k', 1e3, 0], ['K', 1e3, 0], ['M', 1e6, 0], ['m', 1e6, 0], ['B', 1e9, 0], ['bn', 1e9, 1], ['mn', 1e6, 0],
    ['tr', 1e6, 1], ['triệu', 1e6, 1], ['tỷ', 1e9, 1], ['tỉ', 1e9, 1], ['nghìn', 1e3, 1], ['ngàn', 1e3, 1],
    ['thousand', 1e3, 1], ['million', 1e6, 1], ['millions', 1e6, 1], ['billion', 1e9, 1], ['billions', 1e9, 1],
    ['trillion', 1e12, 1], ['lakh', 1e5, 1], ['lakhs', 1e5, 1], ['crore', 1e7, 1], ['crores', 1e7, 1],
    ['Mio.', 1e6, 1], ['Mio', 1e6, 1], ['Mrd.', 1e9, 1], ['Mrd', 1e9, 1], ['mln', 1e6, 1],
  ].sort((a, b) => b[0].length - a[0].length);
  const MULT_FIRST = new Set(MULTS.map((m) => m[0][0]));
  const MULT_LAST = new Set(MULTS.map((m) => m[0][m[0].length - 1]));

  /** Multiplier starting at/after `e` (forward). → { end, factor } | null */
  function multAfter(s, e) {
    for (let g = 0; g <= 1; g++) {
      if (g === 1 && s[e] !== ' ') break;
      const p = e + g;
      if (!MULT_FIRST.has(s[p])) continue;
      for (const [text, factor, maxGap] of MULTS) {
        if (g > maxGap || !s.startsWith(text, p)) continue;
        const end = p + text.length;
        if (isWL(text.charCodeAt(text.length - 1)) && end < s.length && isWL(s.charCodeAt(end))) continue; // "5 months"
        return { end, factor };
      }
    }
    return null;
  }

  /** Multiplier ending at `p` (backward), preceded by a digit. → { numEnd, factor } | null */
  function multBefore(s, p, min) {
    if (!MULT_LAST.has(s[p - 1])) return null;
    for (const [text, factor, maxGap] of MULTS) {
      const ms = p - text.length;
      if (ms <= min || !s.startsWith(text, ms)) continue;
      for (let g = 0; g <= maxGap; g++) {
        const ne = ms - g;
        if (ne <= min) break;
        if (g === 1 && s[ne] !== ' ') break;
        if (isDigit(s.charCodeAt(ne - 1))) return { numEnd: ne, factor };
      }
    }
    return null;
  }

  const scale = (v, f) => (f === 1 ? v : Number((v * f).toPrecision(12)));

  // ───────────────────────────── gaps ─────────────────────────────
  // HTML collapses any whitespace run into one space, so a short run (≤ 16 chars, ≤ 1 line break) counts as "a space".
  const MAX_GAP = 16;
  function gapAfter(s, i, max = MAX_GAP) {
    let j = i;
    let nl = 0;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 13) j++;
      else if (c === 10) { if (++nl > 1) return -1; j++; } else break;
      if (j - i > max) return -1;
    }
    return j;
  }
  function gapBefore(s, i, min, max = MAX_GAP) {
    let j = i;
    let nl = 0;
    while (j > min) {
      const c = s.charCodeAt(j - 1);
      if (c === 32 || c === 9 || c === 13) j--;
      else if (c === 10) { if (++nl > 1) return -1; j--; } else break;
      if (i - j > max) return -1;
    }
    return j;
  }

  // ───────────────────────────── numbers ─────────────────────────────
  /**
   * Read digit runs separated by single separators starting at s[i] (a digit). Separators: . , ' ’ and spaces
   * between digits. Plain spaces are 'sp', typographic ones (NBSP, U+202F, thin space…) 'nb' — checked on the
   * ORIGINAL text since normalisation turned them into plain spaces.
   * @returns {{runs: number[], seps: string[]}} runs = flat [start0, end0, start1, end1, …]
   */
  function scanNumber(s, orig, i) {
    const runs = [];
    const seps = [];
    let j = i;
    for (;;) {
      const st = j;
      while (j < s.length && isDigit(s.charCodeAt(j))) j++;
      runs.push(st, j);
      if (runs.length >= 32 || !isDigit(s.charCodeAt(j + 1))) break;
      const ch = s[j];
      if (ch === '.' || ch === ',' || ch === "'" || ch === '’') seps.push(ch);
      else if (ch === ' ') seps.push(isTypoSpace(orig.charCodeAt(j)) ? 'nb' : 'sp');
      else break;
      j++;
    }
    return { runs, seps };
  }

  /**
   * Separator rule for "1.234" / "1,234" (single mark followed by exactly 3 digits): is the mark a decimal point?
   * 0-decimal currencies (VND, JPY, KRW, IDR…) → never; the page's decimal mark decides when known; otherwise it is
   * a thousands group (3 fraction digits are rare for 2-decimal currencies), except for 3-decimal ones (KWD, BHD…).
   */
  function threeDigitsIsDecimal(mark, decimals, ctxDecimal) {
    if (decimals === 0) return false;
    if (ctxDecimal === mark) return true;
    if (ctxDecimal === '.' || ctxDecimal === ',') return false;
    return decimals === 3;
  }

  /**
   * Value of the first `n` runs, or null if they do not form a valid number.
   * @param {boolean} plainSpaceOK plain-space grouping ("1 234") allowed without a decimal part
   */
  function valueOf(s, runs, seps, n, decimals, ctxDecimal, plainSpaceOK) {
    const len = (k) => runs[2 * k + 1] - runs[2 * k];
    const digits = (k) => s.slice(runs[2 * k], runs[2 * k + 1]);
    if (n === 1) return len(0) <= 15 ? Number(digits(0)) : null;
    const m = n - 1; // separators used
    let dots = 0;
    let commas = 0;
    let last = -1;
    for (let k = 0; k < m; k++) {
      if (seps[k] === '.') { dots++; last = k; } else if (seps[k] === ',') { commas++; last = k; }
    }
    let dec = -1; // index of the decimal separator
    if (dots && commas) {
      // both present → the last one is the decimal mark ("1.234,56", "1,234.56") and must appear once, last
      if (last !== m - 1 || (seps[last] === '.' ? dots : commas) !== 1) return null;
      dec = last;
    } else if (dots + commas === 1) {
      if (last !== m - 1) return null; // "1,5 000"
      if (len(n - 1) !== 3 || threeDigitsIsDecimal(seps[last], decimals, ctxDecimal)) dec = last;
    }
    // (one kind repeated, or only spaces/apostrophes → all grouping)
    const intRuns = dec === -1 ? n : dec + 1;
    let intDigits = digits(0);
    if (intRuns > 1) {
      const kind = (sep) => (sep === 'nb' ? 'sp' : sep);
      const g = kind(seps[0]);
      for (let k = 1; k < intRuns - 1; k++) if (kind(seps[k]) !== g) return null; // "1.234 567"
      if (g === 'sp' && dec === -1 && !plainSpaceOK && seps.slice(0, intRuns - 1).includes('sp')) return null;
      let western = len(0) <= 3;
      for (let k = 1; k < intRuns && western; k++) western = len(k) === 3;
      let indian = !western && g === ',' && intRuns >= 3 && len(0) <= 2 && len(intRuns - 1) === 3; // 12,34,567
      for (let k = 1; k < intRuns - 1 && indian; k++) indian = len(k) === 2;
      if (!western && !indian) return null;
      for (let k = 1; k < intRuns; k++) intDigits += digits(k);
    }
    if (intDigits.length > 15) return null;
    if (dec === -1) return Number(intDigits);
    if (len(n - 1) > 8) return null;
    return Number(`${intDigits}.${digits(n - 1)}`);
  }

  /**
   * Read the number starting at s[i] (a digit): longest valid prefix of the scanned runs.
   * @returns {{value:number, end:number, formatted:boolean} | null}
   */
  function readNumber(s, orig, i, decimals, ctxDecimal, plainSpaceOK) {
    const { runs, seps } = scanNumber(s, orig, i);
    // A leading zero followed by more digits is a phone number / code ("0912 345 678", "007"), never a price.
    if (runs[1] - runs[0] > 1 && s.charCodeAt(runs[0]) === 48) return null;
    for (let n = runs.length / 2; n >= 1; n--) {
      const value = valueOf(s, runs, seps, n, decimals, ctxDecimal, plainSpaceOK);
      if (value !== null) return { value, end: runs[2 * n - 1], formatted: n > 1 };
    }
    return null;
  }

  /** What may follow a number: not a digit, not a word letter (unless a suffix token starts there), not "1.2.3",
   * "5:30", "12/25" or "5%". */
  function rightEdgeOK(s, e) {
    if (e >= s.length) return true;
    const c = s.charCodeAt(e);
    if (isDigit(c) || c === 37) return false;
    if ((c === 46 || c === 44 || c === 58 || c === 47) && isDigit(s.charCodeAt(e + 1))) return false;
    if (isWL(c)) {
      const tok = tokenAt(s, e);
      return !!tok && TOKEN_INFO.get(tok).suffix;
    }
    return true;
  }

  /** Can s[k] start a number? Not glued to a word ("x2"), a phone "+", a ".5" fraction, a time "5:30" or a
   * date "12/25". */
  function leftEdgeOK(s, k) {
    if (k === 0) return true;
    const c = s.charCodeAt(k - 1);
    if (isWL(c) || isDigit(c) || c === 43 || c === 46 || c === 44) return false;
    return !((c === 58 || c === 47) && isDigit(s.charCodeAt(k - 2)));
  }

  const decimalsOf = (code) => (C.CURRENCIES[code] ? C.CURRENCIES[code].decimals : 2);

  // ───────────────────────────── context ─────────────────────────────
  const DEFAULT_CTX = Object.freeze({
    dollar: 'USD', yen: 'CNY', kr: 'SEK', decimal: null,
    reasons: Object.freeze({ dollar: 'default', yen: 'default', decimal: 'default' }),
  });

  /** Currency of a token on this page. Ambiguous = it came from the context (bare $, ¥, kr). */
  function resolveToken(info, ctx) {
    const fam = FAMILY.get(info.token);
    if (fam) return { currency: ctx[fam] || DEFAULT_CTX[fam], ambiguous: true };
    return { currency: info.currencies[0], ambiguous: false };
  }

  /** Two tokens around one number ("$5 USD", "USD $5", "¥189元"): the specific one wins if they agree. */
  function combine(a, b, ctx) {
    const ra = resolveToken(a, ctx);
    const rb = resolveToken(b, ctx);
    if (ra.ambiguous && !rb.ambiguous && a.currencies.includes(rb.currency)) return { ...rb, info: b };
    if (!ra.ambiguous && rb.ambiguous && b.currencies.includes(ra.currency)) return { ...ra, info: a };
    if (ra.currency === rb.currency) return { ...ra, ambiguous: ra.ambiguous && rb.ambiguous, info: ra.ambiguous ? b : a };
    return null;
  }

  // ───────────────────────────── shapes ─────────────────────────────
  /** ",-" / ".–" after a number = "no minor units" (Scandinavian "kr 1 299,-", Swiss "Fr. 12.–"). */
  const wholeMarkAt = (s, e) =>
    (s[e] === ',' || s[e] === '.') && (s[e + 1] === '-' || s[e + 1] === '–') && !isDigit(s.charCodeAt(e + 2));

  /** `TOKEN␣NUMBER` (+ multiplier, + range "¥10-20"). Starts after the token end `te`. */
  function prefixShape(s, orig, te, decimals, ctx) {
    const ns = gapAfter(s, te);
    if (ns < 0 || !isDigit(s.charCodeAt(ns))) return null;
    let n1 = readNumber(s, orig, ns, decimals, ctx.decimal, false);
    if (!n1) return null;
    let end = n1.end;
    // A whole-unit mark plays the role of a decimal part, so it also validates plain-space groups ("kr 1 299,-").
    const loose = readNumber(s, orig, ns, decimals, ctx.decimal, true);
    if (loose && wholeMarkAt(s, loose.end)) { n1 = loose; end = loose.end + 2; } else if (wholeMarkAt(s, end)) end += 2;
    let f1 = 1;
    const mu = multAfter(s, end);
    if (mu) { end = mu.end; f1 = mu.factor; }
    if (!rightEdgeOK(s, end)) return null;
    const cand = { numStart: ns, end, amount: scale(n1.value, f1), gap: ns - te, formatted: n1.formatted };
    // range: "¥10-20", "$10 – 20", "¥1-2万" (the second multiplier applies to both)
    const d = gapAfter(s, end, 3);
    if (d >= 0 && DASH.has(s[d])) {
      const n2s = gapAfter(s, d + 1, 3);
      if (n2s >= 0 && isDigit(s.charCodeAt(n2s))) {
        const n2 = readNumber(s, orig, n2s, decimals, ctx.decimal, false);
        if (n2) {
          let e2 = n2.end;
          let f2 = f1;
          const mu2 = multAfter(s, e2);
          if (mu2) { e2 = mu2.end; f2 = mu2.factor; }
          const lo = scale(n1.value, mu ? f1 : f2);
          const hi = scale(n2.value, f2);
          if (rightEdgeOK(s, e2) && hi > lo) Object.assign(cand, { end: e2, amount: lo, amountMax: hi });
        }
      }
    }
    return cand;
  }

  /**
   * Number ending exactly at `numEnd` (backward search, never before `min`). Tries the longest candidate first
   * ("1 234,56"), then the ones after a space ("Lot 5 100 €" → 5100; "Qty 2 100 €" is inherently ambiguous).
   * @returns {{start:number, value:number, formatted:boolean} | null}
   */
  function numberEndingAt(s, orig, numEnd, min, decimals, ctxDecimal) {
    let k = numEnd;
    while (k > min) {
      const c = s.charCodeAt(k - 1);
      if (isDigit(c)) { k--; continue; }
      const sep = s[k - 1];
      if ((sep === '.' || sep === ',' || sep === "'" || sep === '’' || sep === ' ') && k - 2 >= min &&
          isDigit(s.charCodeAt(k - 2)) && isDigit(s.charCodeAt(k))) { k--; continue; }
      break;
    }
    for (let st = k; st < numEnd; st++) {
      if (!isDigit(s.charCodeAt(st)) || (st > k && s[st - 1] !== ' ')) continue;
      if (st === k && !leftEdgeOK(s, st)) continue;
      const n = readNumber(s, orig, st, decimals, ctxDecimal, true);
      if (n && n.end === numEnd) return { start: st, value: n.value, formatted: n.formatted };
    }
    return null;
  }

  /** `NUMBER␣TOKEN` (+ multiplier "1.5万円", + range "10–20 €"). Ends at the token start `ti`. */
  function suffixShape(s, orig, ti, min, decimals, ctx) {
    const p = gapBefore(s, ti, min);
    if (p < 0 || p <= min) return null;
    let numEnd = p;
    let factor = 1;
    if (p - 3 >= min && wholeMarkAt(s, p - 2) && isDigit(s.charCodeAt(p - 3))) numEnd = p - 2; // "1 299,- kr"
    else if (!isDigit(s.charCodeAt(p - 1))) {
      const mu = multBefore(s, p, min);
      if (!mu) return null;
      numEnd = mu.numEnd;
      factor = mu.factor;
    }
    const n2 = numberEndingAt(s, orig, numEnd, min, decimals, ctx.decimal);
    if (!n2) return null;
    const cand = { start: n2.start, amount: scale(n2.value, factor), gap: ti - p, formatted: n2.formatted };
    // range: "10–20 €", "10 - 20 €", "1-2 triệu đ"
    const d = gapBefore(s, n2.start, min, 3);
    if (d > min && DASH.has(s[d - 1])) {
      const e1 = gapBefore(s, d - 1, min, 3);
      if (e1 > min && isDigit(s.charCodeAt(e1 - 1))) {
        const n1 = numberEndingAt(s, orig, e1, min, decimals, ctx.decimal);
        const lo = n1 && scale(n1.value, factor);
        if (n1 && cand.amount > lo) Object.assign(cand, { start: n1.start, amount: lo, amountMax: cand.amount });
      }
    }
    return cand;
  }

  /**
   * Try to build a price around the token found at `ti`.
   * @returns {object|null} internal match { start, end, amount, amountMax?, currency, ambiguous, tokStart, tokEnd }
   */
  function priceAt(s, orig, ti, tok, ctx, lastEnd, pending) {
    const info = TOKEN_INFO.get(tok);
    const te = ti + tok.length;
    // A symbol glued to a preceding word cannot start a price ("abc$5"), unless that word is a token ("USD$5").
    // The suffix shape is still possible: then the letter before is a multiplier ("99k€").
    const glued = !isWL(tok.charCodeAt(0)) && ti > 0 && isWL(s.charCodeAt(ti - 1)) && !(pending && pending.end === ti);
    const lastWL = isWL(tok.charCodeAt(tok.length - 1));
    const res = resolveToken(info, ctx);
    const decimals = decimalsOf(res.currency);

    let S = null;
    if (info.suffix && (lastWL || te >= s.length || !isWL(s.charCodeAt(te)))) S = suffixShape(s, orig, ti, lastEnd, decimals, ctx);
    const P = info.prefix && !glued ? prefixShape(s, orig, te, decimals, ctx) : null;
    // "50 Ft hose" is a length in feet; forint prices are practically never below 100 Ft.
    if (tok === 'Ft' && S && S.amount < 100) S = null;

    // What follows P's number? Another token: either the same price spelled twice ("$5 USD", "¥189元") or the next
    // price's suffix token, in which case P would steal that price's number ("12,99 € 5,99 €").
    let trail = null;
    if (P) {
      const g = gapAfter(s, P.end, 3);
      const t2 = g >= 0 ? tokenAt(s, g) : null;
      if (t2) {
        const i2 = TOKEN_INFO.get(t2);
        const e2 = g + t2.length;
        const clean = isWL(t2.charCodeAt(t2.length - 1)) || e2 >= s.length || !isWL(s.charCodeAt(e2));
        if (i2.suffix && clean) {
          const after = gapAfter(s, e2, 3);
          const startsNext = i2.prefix && after >= 0 && isDigit(s.charCodeAt(after));
          if (t2 !== tok && !startsNext && combine(info, i2, ctx)) trail = { info: i2, start: g, end: e2 };
          else P.steals = true;
        }
      }
    }

    let pick = null;
    if (S && P) {
      if (P.steals) pick = 'S';
      else if (trail) pick = 'P';
      else if (S.gap !== P.gap && (S.gap === 0 || P.gap === 0)) pick = S.gap === 0 ? 'S' : 'P';
      else if (S.formatted !== P.formatted) pick = S.formatted ? 'S' : 'P';
      else pick = SUFFIX_FIRST(info) ? 'S' : 'P';
    } else pick = S ? 'S' : P ? 'P' : null;
    if (!pick) return null;

    if (pick === 'S') {
      return { start: S.start, end: te, amount: S.amount, amountMax: S.amountMax, ...res, tokStart: ti, tokEnd: te };
    }
    const m = { start: ti, end: P.end, amount: P.amount, amountMax: P.amountMax, ...res, tokStart: ti, tokEnd: te };
    let lead = info; // the token that currently decides the currency
    // "USD $5", "RMB ¥189": a token right before a symbol it disambiguates.
    if (pending && pending.start >= lastEnd && gapBefore(s, ti, pending.end, 3) === pending.end) {
      const pi = TOKEN_INFO.get(pending.tok);
      const both = pi.prefix && combine(pi, info, ctx);
      if (both) {
        Object.assign(m, { start: pending.start, currency: both.currency, ambiguous: both.ambiguous });
        if (both.info === pi) Object.assign(m, { tokStart: pending.start, tokEnd: pending.end });
        lead = both.info;
      }
    }
    // "$5 USD", "¥189元": a trailing token naming the same currency is part of the price.
    const both = trail && combine(lead, trail.info, ctx);
    if (both) {
      Object.assign(m, { end: trail.end, currency: both.currency, ambiguous: both.ambiguous });
      if (both.info === trail.info) Object.assign(m, { tokStart: trail.start, tokEnd: trail.end });
    }
    return m;
  }

  /** "$10 - $20", "10€ – 20€": two adjacent prices in the same currency joined by a dash become one range. */
  function mergeRanges(s, list) {
    const out = [];
    for (const m of list) {
      const prev = out[out.length - 1];
      if (prev && prev.amountMax === undefined && m.amountMax === undefined && prev.currency === m.currency &&
          m.amount > prev.amount && /^\s{0,3}[-–—~〜至]\s{0,3}$/.test(s.slice(prev.end, m.start))) {
        prev.end = m.end;
        prev.amountMax = m.amount;
        prev.ambiguous = prev.ambiguous && m.ambiguous;
        continue;
      }
      out.push(m);
    }
    return out;
  }

  // ───────────────────────────── public API ─────────────────────────────
  /**
   * Every price inside free text, non-overlapping, left → right.
   * @param {string} text
   * @param {object} [ctx] from resolveContext() (defaults: $ = USD, ¥ = CNY, kr = SEK, decimal unknown)
   * @returns {Array<{start:number,end:number,raw:string,amount:number,amountMax?:number,currency:string,token:string,ambiguous:boolean}>}
   */
  function findPrices(text, ctx) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const cx = ctx || DEFAULT_CTX;
    const s = normalize(text);
    const found = [];
    let lastEnd = 0;
    let pending = null; // last token that produced no price (may disambiguate the next one: "USD $5")
    TOKEN_G.lastIndex = 0;
    let m;
    while ((m = TOKEN_G.exec(s))) {
      const ti = m.index;
      if (ti < lastEnd) { TOKEN_G.lastIndex = lastEnd; continue; }
      let tok = m[0];
      let hit = priceAt(s, text, ti, tok, cx, lastEnd, pending);
      // "99 kr." / "Rs." at a sentence end: retry the dotted token without its dot
      if (!hit && tok.endsWith('.') && TOKEN_INFO.has(tok.slice(0, -1))) {
        tok = tok.slice(0, -1);
        hit = priceAt(s, text, ti, tok, cx, lastEnd, pending);
      }
      if (hit) {
        found.push(hit);
        lastEnd = hit.end;
        pending = null;
        if (TOKEN_G.lastIndex < lastEnd) TOKEN_G.lastIndex = lastEnd;
      } else {
        pending = { start: ti, end: ti + tok.length, tok };
      }
    }
    return mergeRanges(s, found).map((h) => {
      const out = { start: h.start, end: h.end, raw: text.slice(h.start, h.end), amount: h.amount };
      if (h.amountMax !== undefined) out.amountMax = h.amountMax;
      out.currency = h.currency;
      out.token = text.slice(h.tokStart, h.tokEnd);
      out.ambiguous = h.ambiguous;
      return out;
    });
  }

  /**
   * The WHOLE string (trimmed, whitespace-normalised) is exactly one price — used for split prices whose parts live
   * in sibling elements (`<span>¥</span><span>43</span><span>.65</span>` → textContent "¥43.65").
   * @returns {object|null} a Match whose start/end cover the trimmed text
   */
  function parsePrice(text, ctx) {
    if (typeof text !== 'string') return null;
    let a = 0;
    let b = text.length;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a === b || b - a > 200) return null;
    const direct = findPrices(text, ctx);
    if (direct.length === 1 && direct[0].start === a && direct[0].end === b) return direct[0];
    // Split prices often carry formatting whitespace between their parts ("¥\n  43\n  .65").
    const core = normalize(text.slice(a, b)).replace(/\s+/g, ' ').replace(/(\d) ?([.,]) ?(?=\d)/g, '$1$2');
    const ms = findPrices(core, ctx);
    if (ms.length !== 1 || ms[0].start !== 0 || ms[0].end !== core.length) return null;
    return { ...ms[0], start: a, end: b, raw: text.slice(a, b) };
  }

  /**
   * Parse a bare number ("1.234,56", "1,5 triệu", "12,800") with the same rules as prices.
   * @param {string} str
   * @param {{currency?: string, decimal?: '.'|','|null}} [opts]
   * @returns {number|null}
   */
  function parseNumber(str, opts) {
    if (str === null || str === undefined) return null;
    const s = normalize(String(str)).trim();
    if (!isDigit(s.charCodeAt(0))) return null;
    const o = opts || {};
    const n = readNumber(s, s, 0, decimalsOf(o.currency), o.decimal === '.' || o.decimal === ',' ? o.decimal : null, true);
    if (!n) return null;
    let end = n.end;
    let factor = 1;
    const mu = multAfter(s, end);
    if (mu) { end = mu.end; factor = mu.factor; }
    return end === s.length ? scale(n.value, factor) : null;
  }

  /** Very cheap prefilter (runs on every text node): a digit AND a currency token. */
  function quickTest(text) {
    return typeof text === 'string' && DIGIT_TEST.test(text) && TOKEN_TEST.test(text);
  }

  /** Contains any currency token (starts split-price climbing in the content script). */
  function hasToken(text) {
    return typeof text === 'string' && TOKEN_TEST.test(text);
  }

  // ── context resolution ──
  // Host suffix → hints. `locale` only feeds the decimal-separator hint.
  const CN = { yen: 'CNY', locale: 'zh-CN' };
  const JP = { yen: 'JPY', locale: 'ja-JP' };
  const DOMAIN_RULES = Object.entries({
    'taobao.com': CN, 'tmall.com': CN, 'tmall.hk': CN, '1688.com': CN, 'jd.com': CN, 'aliexpress.com': CN,
    'alibaba.com': CN, 'pinduoduo.com': CN, 'yangkeduo.com': CN, 'weidian.com': CN, 'goofish.com': CN,
    'vip.com': CN, 'suning.com': CN, 'dangdang.com': CN, 'dewu.com': CN, cn: CN,
    'amazon.co.jp': JP, 'rakuten.co.jp': JP, 'jp.mercari.com': JP, 'dmm.com': JP, jp: JP,
    ca: { dollar: 'CAD' }, au: { dollar: 'AUD', locale: 'en-AU' }, nz: { dollar: 'NZD', locale: 'en-NZ' },
    sg: { dollar: 'SGD', locale: 'en-SG' }, hk: { dollar: 'HKD', locale: 'zh-HK' }, tw: { dollar: 'TWD', locale: 'zh-TW' },
    mx: { dollar: 'MXN', locale: 'es-MX' },
    se: { kr: 'SEK', locale: 'sv-SE' }, no: { kr: 'NOK', locale: 'nb-NO' }, dk: { kr: 'DKK', locale: 'da-DK' },
    is: { kr: 'ISK', locale: 'is-IS' },
    vn: { locale: 'vi-VN' }, de: { locale: 'de-DE' }, at: { locale: 'de-AT' }, fr: { locale: 'fr-FR' },
    it: { locale: 'it-IT' }, es: { locale: 'es-ES' }, pt: { locale: 'pt-PT' }, br: { locale: 'pt-BR' },
    ru: { locale: 'ru-RU' }, ua: { locale: 'uk-UA' }, pl: { locale: 'pl-PL' }, cz: { locale: 'cs-CZ' },
    sk: { locale: 'sk-SK' }, nl: { locale: 'nl-NL' }, be: { locale: 'nl-BE' }, fi: { locale: 'fi-FI' },
    tr: { locale: 'tr-TR' }, id: { locale: 'id-ID' }, ro: { locale: 'ro-RO' }, hu: { locale: 'hu-HU' },
    gr: { locale: 'el-GR' }, kr: { locale: 'ko-KR' }, uk: { locale: 'en-GB' }, in: { locale: 'en-IN' },
    th: { locale: 'th-TH' }, my: { locale: 'ms-MY' }, ph: { locale: 'en-PH' }, ar: { locale: 'es-AR' },
    cl: { locale: 'es-CL' }, 'com.co': { locale: 'es-CO' }, ie: { locale: 'en-IE' },
  }).sort((a, b) => b[0].split('.').length - a[0].split('.').length);

  const normHost = (h) => String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const hostMatch = (host, rule) => host === rule || host.endsWith(`.${rule}`);

  const decimalCache = new Map();
  /** Decimal mark of a locale via Intl ('vi' → ',', 'en' → '.', 'de-CH' → '.'); null if neither. */
  function decimalOf(locale) {
    if (decimalCache.has(locale)) return decimalCache.get(locale);
    let mark = null;
    try {
      const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal');
      if (part && (part.value === '.' || part.value === ',')) mark = part.value;
    } catch { /* invalid locale */ }
    decimalCache.set(locale, mark);
    return mark;
  }

  function parseLang(lang) {
    if (typeof lang !== 'string' || !lang.trim()) return null;
    try {
      const loc = new Intl.Locale(lang.trim().replace(/_/g, '-'));
      return { tag: loc.toString(), language: loc.language, region: loc.region || '' };
    } catch {
      return null;
    }
  }

  const LANG_DOLLAR = { CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', TW: 'TWD', MX: 'MXN' };
  const LANG_KR = { sv: 'SEK', nb: 'NOK', nn: 'NOK', no: 'NOK', da: 'DKK', fo: 'DKK', is: 'ISK' };
  const REGION_KR = { SE: 'SEK', NO: 'NOK', DK: 'DKK', FO: 'DKK', GL: 'DKK', IS: 'ISK' };
  const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;

  /** Script statistics of the sample text (kana → Japanese, Han without kana → Chinese …). */
  function scriptOf(sample) {
    const t = typeof sample === 'string' ? sample.slice(0, 5000) : '';
    if (!t) return null;
    const count = (re) => (t.match(re) || []).length;
    const kana = count(/[\u3040-\u30FF]/g);
    const han = count(/[\u4E00-\u9FFF]/g);
    if (kana >= 3 && kana >= (kana + han) * 0.1) return 'ja';
    if (han >= 5) return 'zh';
    if (count(/[\uAC00-\uD7AF]/g) >= 5) return 'ko';
    if (count(VI_CHARS) >= 5) return 'vi';
    if (count(/[\u0400-\u04FF]/g) >= 20) return 'ru';
    return null;
  }

  /**
   * Page context for ambiguous symbols and separators. For each field the first hit wins:
   * site pin → domain → <html lang> → script of the sample text → user default.
   * @param {{hostname?: string, lang?: string, sampleText?: string, settings?: object}} input
   * @returns {{dollar:string, yen:string, kr:string, decimal:'.'|','|null, reasons:{dollar:string, yen:string, decimal:string}}}
   */
  function resolveContext(input) {
    const { hostname, lang, sampleText, settings } = input || {};
    const st = settings || {};
    const host = normHost(hostname);
    const valid = (code) => typeof code === 'string' && !!C.CURRENCIES[code];

    let pin = null;
    if (host && st.siteCurrency && typeof st.siteCurrency === 'object') {
      let best = '';
      for (const key of Object.keys(st.siteCurrency)) {
        const k = normHost(key);
        if (k && hostMatch(host, k) && k.length > best.length) { best = k; pin = st.siteCurrency[key]; }
      }
    }
    const rules = host ? DOMAIN_RULES.filter(([suffix]) => hostMatch(host, suffix)).map(([, r]) => r) : [];
    const fromRules = (key) => rules.find((r) => r[key]);
    const L = parseLang(lang);
    let script; // computed lazily (only if needed)
    const getScript = () => (script === undefined ? (script = scriptOf(sampleText)) : script);

    // $
    let dollar;
    let rDollar;
    if (pin && valid(pin.dollar)) { dollar = pin.dollar; rDollar = 'site-pin'; } else if (fromRules('dollar')) {
      dollar = fromRules('dollar').dollar; rDollar = 'domain';
    } else if (L && LANG_DOLLAR[L.region]) { dollar = LANG_DOLLAR[L.region]; rDollar = 'lang'; } else {
      dollar = valid(st.defaultDollar) ? st.defaultDollar : 'USD'; rDollar = 'default';
    }

    // ¥
    let yen;
    let rYen;
    if (pin && valid(pin.yen)) { yen = pin.yen; rYen = 'site-pin'; } else if (fromRules('yen')) {
      yen = fromRules('yen').yen; rYen = 'domain';
    } else if (L && (L.language === 'ja' || L.language === 'zh')) {
      yen = L.language === 'ja' ? 'JPY' : 'CNY'; rYen = 'lang';
    } else if (getScript() === 'ja' || getScript() === 'zh') {
      yen = getScript() === 'ja' ? 'JPY' : 'CNY'; rYen = 'script';
    } else { yen = valid(st.defaultYen) ? st.defaultYen : 'CNY'; rYen = 'default'; }

    // kr (no user setting / pin: Scandinavian sites are reliably identified by domain or lang)
    const kr = (fromRules('kr') && fromRules('kr').kr) || (L && (LANG_KR[L.language] || REGION_KR[L.region])) || 'SEK';

    // decimal mark hint
    let decimal = null;
    let rDecimal = 'default';
    const ruleLocale = fromRules('locale');
    const fromDomain = ruleLocale ? decimalOf(ruleLocale.locale) : null;
    const fromLang = L ? decimalOf(L.tag) : null;
    if (fromDomain) { decimal = fromDomain; rDecimal = 'domain'; } else if (fromLang) { decimal = fromLang; rDecimal = 'lang'; } else {
      const sc = getScript();
      if (sc === 'ja' || sc === 'zh' || sc === 'ko') { decimal = '.'; rDecimal = 'script'; }
      else if (sc === 'vi' || sc === 'ru') { decimal = ','; rDecimal = 'script'; }
    }

    return { dollar, yen, kr, decimal, reasons: { dollar: rDollar, yen: rYen, decimal: rDecimal } };
  }

  // ── conversion & formatting ──
  /**
   * amount / rates[from] * rates[to] (USD-based table, units per 1 USD). null if a rate is unknown.
   * @param {number} amount @param {string} from @param {string} to @param {{rates: Record<string, number>}} table
   */
  function convert(amount, from, to, table) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    if (from === to) return amount;
    const rates = table && table.rates;
    if (!rates) return null;
    const a = rates[from];
    const b = rates[to];
    if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return (amount / a) * b;
  }

  const fmtCache = new Map();
  function formatter(locale, code, mode) {
    const key = `${locale}|${code}|${mode}`;
    let f = fmtCache.get(key);
    if (!f) {
      const d = decimalsOf(code);
      const opts = { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' };
      if (mode === 'compact') opts.notation = 'compact';
      else if (mode === 'sig') opts.maximumSignificantDigits = 2;
      else if (mode === 'rate') opts.maximumSignificantDigits = 4;
      else if (mode === 'int') { opts.minimumFractionDigits = 0; opts.maximumFractionDigits = 0; } else {
        opts.minimumFractionDigits = d;
        opts.maximumFractionDigits = d;
      }
      f = new Intl.NumberFormat(locale, opts);
      if (fmtCache.size > 200) fmtCache.clear();
      fmtCache.set(key, f);
    }
    return f;
  }

  function safeFormat(value, code, locale, mode) {
    try {
      return formatter(locale || C.localeFor(code, []), code, mode).format(value);
    } catch {
      try {
        return formatter(C.localeFor(code, []), code, mode).format(value);
      } catch {
        return `${value.toFixed(Math.min(decimalsOf(code), 3))} ${code}`;
      }
    }
  }

  /**
   * Format money with Intl ('currency' style, narrow symbol, the currency's own fraction digits).
   * Tiny non-zero values keep 2 significant digits instead of rounding to 0 ($0.0039, not $0.00).
   * @param {number} value @param {string} code
   * @param {{locale?: string, compact?: boolean}} [opts] compact → "730 N ₫", "$1.2K"
   */
  function formatMoney(value, code, opts) {
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof code !== 'string') return '';
    const o = opts || {};
    const d = decimalsOf(code);
    let mode = o.compact ? 'compact' : 'fixed';
    if (!o.compact && value !== 0 && Math.abs(value) < 0.5 * 10 ** -d) mode = 'sig';
    return safeFormat(value, code, o.locale, mode);
  }

  /** Below this, "1 from = x to" is flipped to "1 to = y from" (the literal line would start with "0.00…"). */
  const FLIP_BELOW = 0.01;

  /**
   * Exchange-rate line, e.g. '1 CNY = 3.865 ₫'. The amount keeps 4 significant digits (whole units from 10 000 up).
   *
   * Readability rule: when 1 `from` is worth less than 0.01 `to`, the line is flipped — rateText('VND', 'CNY')
   * reads '1 CNY = 3.865 ₫' instead of '1 VND = ¥0.0002588'. The amount is then in `from`, formatted with
   * localeFor(from, [opts.locale]) (the caller's locale if its region uses `from`, else `from`'s home locale).
   * Pass `{ flip: false }` to always get the literal direction '1 from = x to'.
   * @param {string} from @param {string} to @param {object} table
   * @param {{locale?: string, flip?: boolean}} [opts]
   * @returns {string} '' if a rate is unknown
   */
  function rateText(from, to, table, opts) {
    const rate = convert(1, from, to, table);
    if (rate === null) return '';
    const o = opts || {};
    if (o.flip !== false && rate > 0 && rate < FLIP_BELOW) {
      const back = 1 / rate;
      const locale = C.localeFor(from, o.locale ? [o.locale] : []);
      return `1 ${to} = ${safeFormat(back, from, locale, back >= 1e4 ? 'int' : 'rate')}`;
    }
    return `1 ${from} = ${safeFormat(rate, to, o.locale, rate >= 1e4 ? 'int' : 'rate')}`;
  }

  globalThis.TransPriceParser = Object.freeze({
    resolveContext,
    quickTest,
    hasToken,
    findPrices,
    parsePrice,
    parseNumber,
    convert,
    formatMoney,
    rateText,
  });
})();
