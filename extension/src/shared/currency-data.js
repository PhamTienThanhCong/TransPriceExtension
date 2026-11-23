/**
 * TransPrice — currency reference data → globalThis.TransPriceCurrencies (docs/ARCHITECTURE.md §4.1).
 *
 * CLASSIC SCRIPT (no import/export): the same file runs as a content script (manifest order: before parser.js),
 * as a side-effect `import` in the service worker / extension pages / Node tests, and via <script src> on dev pages.
 * Pure data + Intl helpers: no DOM, no chrome.*.
 *
 * Everything is built eagerly but cheaply (no Intl calls at load — 161 NumberFormat constructions cost ~15 ms,
 * too much for a script injected into every page). Intl is only used lazily by the helper functions, with caches.
 */
(() => {
  'use strict';

  // ───────────────────────────── currencies ─────────────────────────────
  // `CODE:decimals:symbol` for every code of the bundled rate snapshot (rates-snapshot.js).
  // decimals = minor units used on real price tags: ISO 4217 / CLDR, but 0 where the minor unit is obsolete
  // (IDR, HUF, TWD, COP, CRC, KHR, TZS, UZS, MNT, AMD, KZT …). It drives both display (fraction digits) and the
  // separator rule "1.234 is a thousands group for 0-decimal currencies" (docs/ALGORITHM.md §4).
  // symbol = preferred display symbol (narrow, but disambiguated for the many "$" currencies: CA$, A$, NT$ …).
  const TABLE = `
    AED:2:د.إ   AFN:0:؋     ALL:0:ALL   AMD:0:֏     ANG:2:ANG   AOA:2:Kz    ARS:2:AR$   AUD:2:A$
    AWG:2:AWG   AZN:2:₼     BAM:2:KM    BBD:2:BB$   BDT:2:৳     BGN:2:BGN   BHD:3:BHD   BIF:0:BIF
    BMD:2:BM$   BND:2:BN$   BOB:2:Bs    BRL:2:R$    BSD:2:BS$   BTN:2:BTN   BWP:2:P     BYN:2:BYN
    BZD:2:BZ$   CAD:2:CA$   CDF:2:CDF   CHF:2:CHF   CLP:0:CL$   CNY:2:¥     COP:0:CO$   CRC:0:₡
    CUC:2:CUC   CUP:2:CU$   CVE:2:CVE   CZK:2:Kč    DJF:0:DJF   DKK:2:kr    DOP:2:RD$   DZD:2:DZD
    EGP:2:E£    ERN:2:ERN   ETB:2:ETB   EUR:2:€     FJD:2:FJ$   FKP:2:FKP   GBP:2:£     GEL:2:₾
    GHS:2:GH₵   GIP:2:GIP   GMD:2:GMD   GNF:0:FG    GTQ:2:Q     GYD:2:GY$   HKD:2:HK$   HNL:2:L
    HRK:2:kn    HTG:2:HTG   HUF:0:Ft    IDR:0:Rp    ILS:2:₪     INR:2:₹     IQD:0:IQD   IRR:0:IRR
    ISK:0:kr    JMD:2:J$    JOD:3:JOD   JPY:0:¥     KES:2:KSh   KGS:2:KGS   KHR:0:៛     KMF:0:CF
    KPW:0:KPW   KRW:0:₩     KWD:3:KWD   KYD:2:KY$   KZT:0:₸     LAK:0:₭     LBP:0:L£    LKR:2:Rs
    LRD:2:LR$   LSL:2:LSL   LYD:3:LYD   MAD:2:MAD   MDL:2:MDL   MGA:0:Ar    MKD:2:MKD   MMK:0:K
    MNT:0:₮     MOP:2:MOP   MRU:2:MRU   MUR:2:Rs    MVR:2:MVR   MWK:2:MWK   MXN:2:MX$   MYR:2:RM
    MZN:2:MZN   NAD:2:N$    NGN:2:₦     NIO:2:C$    NOK:2:kr    NPR:2:Rs    NZD:2:NZ$   OMR:3:OMR
    PAB:2:PAB   PEN:2:S/    PGK:2:PGK   PHP:2:₱     PKR:2:Rs    PLN:2:zł    PYG:0:₲     QAR:2:QAR
    RON:2:lei   RSD:0:RSD   RUB:2:₽     RWF:0:RF    SAR:2:ر.س   SBD:2:SB$   SCR:2:SCR   SDG:2:SDG
    SEK:2:kr    SGD:2:S$    SHP:2:SHP   SLE:2:SLE   SLL:0:SLL   SOS:0:SOS   SRD:2:SR$   SSP:2:SSP
    STN:2:Db    SVC:2:SVC   SYP:0:SYP   SZL:2:SZL   THB:2:฿     TJS:2:TJS   TMT:2:TMT   TND:3:TND
    TOP:2:T$    TRY:2:₺     TTD:2:TT$   TWD:0:NT$   TZS:0:TZS   UAH:2:₴     UGX:0:UGX   USD:2:$
    UYU:2:UY$   UZS:0:UZS   VES:2:VES   VND:0:₫     VUV:0:VUV   WST:2:WST   XAF:0:FCFA  XCD:2:EC$
    XCG:2:Cg.   XDR:2:XDR   XOF:0:CFA   XPF:0:CFPF  YER:0:YER   ZAR:2:R     ZMW:2:ZK    ZWG:2:ZWG
    ZWL:2:ZWL`;

  /** @type {Record<string, {code: string, decimals: number, symbol: string}>} */
  const CURRENCIES = {};
  for (const entry of TABLE.trim().split(/\s+/)) {
    const [code, decimals, symbol] = entry.split(':');
    CURRENCIES[code] = Object.freeze({ code, decimals: Number(decimals), symbol });
  }
  Object.freeze(CURRENCIES);
  const CODES = Object.freeze(Object.keys(CURRENCIES).sort());

  // ───────────────────────────── tokens ─────────────────────────────
  // Symbols that only make sense through the page context (docs/ALGORITHM.md §5).
  const DOLLARS = ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'MXN']; // = AMBIGUOUS_SYMBOLS.dollar (constants.js)
  const YENS = ['CNY', 'JPY'];
  const KRONOR = ['SEK', 'NOK', 'DKK', 'ISK'];
  const AMBIGUOUS = Object.freeze({ dollar: Object.freeze(['$', '＄']), yen: Object.freeze(['¥', '￥']) });

  // [token, currencies, kind, where] — where: 'ps' prefix+suffix, 'p' prefix only ("US$5"), 's' suffix only ("5元").
  // Order does not matter: the parser sorts tokens longest-first ("US$" before "$", "日元" before "元").
  const T = [
    // dollars — bare $ is ambiguous; prefixed forms are not
    ['$', DOLLARS, 'symbol', 'ps'], ['＄', DOLLARS, 'symbol', 'ps'],
    ['US$', ['USD'], 'symbol', 'ps'], ['US $', ['USD'], 'symbol', 'p'], ['U$S', ['USD'], 'symbol', 'p'],
    ['CA$', ['CAD'], 'symbol', 'ps'], ['C$', ['CAD'], 'symbol', 'ps'], ['C $', ['CAD'], 'symbol', 'p'],
    ['A$', ['AUD'], 'symbol', 'ps'], ['AU$', ['AUD'], 'symbol', 'ps'], ['AU $', ['AUD'], 'symbol', 'p'],
    ['NZ$', ['NZD'], 'symbol', 'ps'], ['S$', ['SGD'], 'symbol', 'ps'], ['SG$', ['SGD'], 'symbol', 'ps'],
    ['HK$', ['HKD'], 'symbol', 'ps'], ['NT$', ['TWD'], 'symbol', 'ps'], ['MX$', ['MXN'], 'symbol', 'ps'],
    ['R$', ['BRL'], 'symbol', 'ps'], ['RD$', ['DOP'], 'symbol', 'p'], ['J$', ['JMD'], 'symbol', 'p'],
    ['dollars', DOLLARS, 'word', 's'],
    // yen / yuan — bare ¥ is ambiguous (CNY on Taobao, JPY on Amazon.co.jp)
    ['¥', YENS, 'symbol', 'ps'], ['￥', YENS, 'symbol', 'ps'],
    ['CN¥', ['CNY'], 'symbol', 'ps'], ['JP¥', ['JPY'], 'symbol', 'ps'], ['RMB', ['CNY'], 'code', 'ps'],
    ['元', ['CNY'], 'word', 's'], ['圆', ['CNY'], 'word', 's'], ['块钱', ['CNY'], 'word', 's'],
    ['人民币', ['CNY'], 'word', 'ps'], ['yuan', ['CNY'], 'word', 's'],
    ['円', ['JPY'], 'word', 's'], ['日元', ['JPY'], 'word', 's'], ['日圆', ['JPY'], 'word', 's'], ['yen', ['JPY'], 'word', 's'],
    ['美元', ['USD'], 'word', 's'], ['欧元', ['EUR'], 'word', 's'], ['英镑', ['GBP'], 'word', 's'],
    ['港元', ['HKD'], 'word', 's'], ['港币', ['HKD'], 'word', 's'], ['新台币', ['TWD'], 'word', 's'],
    ['台币', ['TWD'], 'word', 's'], ['韩元', ['KRW'], 'word', 's'], ['越南盾', ['VND'], 'word', 's'],
    ['泰铢', ['THB'], 'word', 's'],
    // Vietnamese đồng
    ['₫', ['VND'], 'symbol', 'ps'], ['đ', ['VND'], 'symbol', 's'], ['Đ', ['VND'], 'symbol', 's'],
    ['VNĐ', ['VND'], 'code', 'ps'], ['VNđ', ['VND'], 'code', 'ps'], ['Vnđ', ['VND'], 'code', 'ps'],
    ['vnđ', ['VND'], 'code', 'ps'], ['vnd', ['VND'], 'code', 'ps'], ['đồng', ['VND'], 'word', 's'],
    // Europe
    ['€', ['EUR'], 'symbol', 'ps'], ['euro', ['EUR'], 'word', 's'], ['euros', ['EUR'], 'word', 's'],
    ['£', ['GBP'], 'symbol', 'ps'], ['￡', ['GBP'], 'symbol', 'ps'],
    ['CHF', ['CHF'], 'code', 'ps'], ['Fr.', ['CHF'], 'symbol', 'p'],
    ['kr', KRONOR, 'symbol', 'ps'], ['kr.', KRONOR, 'symbol', 'p'],
    ['zł', ['PLN'], 'symbol', 's'], ['Kč', ['CZK'], 'symbol', 's'], ['Ft', ['HUF'], 'symbol', 's'],
    ['lei', ['RON'], 'symbol', 's'], ['лв', ['BGN'], 'symbol', 's'], ['лв.', ['BGN'], 'symbol', 's'],
    ['₽', ['RUB'], 'symbol', 'ps'], ['руб', ['RUB'], 'symbol', 's'], ['руб.', ['RUB'], 'symbol', 's'],
    ['₴', ['UAH'], 'symbol', 'ps'], ['грн', ['UAH'], 'symbol', 's'],
    ['₺', ['TRY'], 'symbol', 'ps'], ['TL', ['TRY'], 'symbol', 's'],
    // Asia / Pacific
    ['₩', ['KRW'], 'symbol', 'ps'], ['￦', ['KRW'], 'symbol', 'ps'], ['원', ['KRW'], 'word', 's'],
    ['₹', ['INR'], 'symbol', 'ps'], ['₨', ['INR', 'PKR', 'LKR', 'NPR'], 'symbol', 'ps'],
    ['Rs', ['INR', 'PKR', 'LKR', 'NPR'], 'symbol', 'p'], ['Rs.', ['INR', 'PKR', 'LKR', 'NPR'], 'symbol', 'p'],
    ['฿', ['THB'], 'symbol', 'ps'], ['บาท', ['THB'], 'word', 's'], ['baht', ['THB'], 'word', 's'],
    ['₱', ['PHP'], 'symbol', 'ps'], ['RM', ['MYR'], 'symbol', 'p'],
    ['Rp', ['IDR'], 'symbol', 'p'], ['Rp.', ['IDR'], 'symbol', 'p'],
    ['៛', ['KHR'], 'symbol', 's'], ['₭', ['LAK'], 'symbol', 'ps'], ['₮', ['MNT'], 'symbol', 'ps'],
    ['৳', ['BDT'], 'symbol', 'ps'], ['₸', ['KZT'], 'symbol', 'ps'],
    // Middle East / Africa / Americas
    ['₪', ['ILS'], 'symbol', 'ps'], ['د.إ', ['AED'], 'symbol', 'ps'], ['ر.س', ['SAR'], 'symbol', 'ps'],
    ['﷼', ['SAR', 'IRR', 'YER', 'OMR', 'QAR'], 'symbol', 'ps'], ['E£', ['EGP'], 'symbol', 'p'],
    ['₦', ['NGN'], 'symbol', 'ps'], ['₵', ['GHS'], 'symbol', 'ps'], ['KSh', ['KES'], 'symbol', 'p'],
    ['₼', ['AZN'], 'symbol', 'ps'], ['₾', ['GEL'], 'symbol', 'ps'], ['₡', ['CRC'], 'symbol', 'ps'],
    ['₲', ['PYG'], 'symbol', 'ps'], ['S/', ['PEN'], 'symbol', 'p'], ['S/.', ['PEN'], 'symbol', 'p'],
  ];

  // Every ISO code is a token too ("USD 12.99", "12.99 USD"), except the few that are common English words in
  // upper-case text ("TOP 10", "ALL 5", "CVE-2024", "XDR"): those stay recognisable only through their symbols.
  // A handful of others are suffix-only ("TRY 7 DAYS FREE" must not be 7 lira, "150 TRY" is fine).
  const CODE_BLOCK = new Set(['ALL', 'TOP', 'CUP', 'SOS', 'BOB', 'BAM', 'ANG', 'CVE', 'SVC', 'XDR', 'ERN', 'CUC']);
  const CODE_SUFFIX_ONLY = new Set(['TRY', 'AMD', 'MAD', 'GEL', 'MOP', 'NAD', 'PEN', 'IRR']);

  const seen = new Set();
  const TOKENS = [];
  const add = (token, currencies, kind, where) => {
    if (seen.has(token)) return;
    seen.add(token);
    TOKENS.push(Object.freeze({
      token,
      currencies: Object.freeze(currencies.slice()),
      kind,
      prefix: where.includes('p'),
      suffix: where.includes('s'),
    }));
  };
  for (const [token, currencies, kind, where] of T) add(token, currencies, kind, where);
  for (const code of CODES) {
    if (!CODE_BLOCK.has(code)) add(code, [code], 'code', CODE_SUFFIX_ONLY.has(code) ? 's' : 'ps');
  }
  Object.freeze(TOKENS);

  // ───────────────────────────── regions ─────────────────────────────
  // Currency → regions using it. Default: the first two letters of the ISO code are the ISO 3166 region
  // (VND → VN). Listed here: shared currencies and codes whose region now uses something else.
  const REGIONS = {
    EUR: 'AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM VA XK YT',
    USD: 'US AS BQ EC FM GU IO MH MP PR PW SV TC TL UM VG VI',
    AUD: 'AU CC CX HM KI NF NR TV', NZD: 'NZ CK NU PN TK', GBP: 'GB GG IM JE', CHF: 'CH LI',
    DKK: 'DK FO GL', NOK: 'NO BV SJ', ILS: 'IL PS', MAD: 'MA EH', XCG: 'CW SX',
    XOF: 'BF BJ CI GW ML NE SN TG', XAF: 'CF CG CM GA GQ TD', XPF: 'NC PF WF', XCD: 'AG AI DM GD KN LC MS VC',
    // obsolete / replaced: no region of their own any more
    ANG: '', BGN: '', HRK: '', SLL: '', ZWL: '', CUC: '', XDR: '',
  };
  /** @type {Map<string, string>} region → currency (first writer wins: explicit table, then code prefixes) */
  const REGION_CURRENCY = new Map();
  for (const [code, list] of Object.entries(REGIONS)) {
    for (const region of list.split(' ').filter(Boolean)) if (!REGION_CURRENCY.has(region)) REGION_CURRENCY.set(region, code);
  }
  for (const code of CODES) {
    const region = code.slice(0, 2);
    if (!(code in REGIONS) && code[0] !== 'X' && !REGION_CURRENCY.has(region)) REGION_CURRENCY.set(region, code);
  }
  const regionsOf = (code) => (code in REGIONS ? REGIONS[code].split(' ').filter(Boolean) : code[0] === 'X' ? [] : [code.slice(0, 2)]);

  // Locale used to format a currency when no browser locale matches (the currency's "home" formatting).
  const HOME_LOCALE = {
    USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', INR: 'en-IN', CHF: 'de-CH', CAD: 'en-CA', AUD: 'en-AU', NZD: 'en-NZ',
    SGD: 'en-SG', HKD: 'zh-HK', CNY: 'zh-CN', TWD: 'zh-TW', VND: 'vi-VN', JPY: 'ja-JP', KRW: 'ko-KR', NOK: 'nb-NO',
    PHP: 'en-PH', MYR: 'ms-MY', ZAR: 'en-ZA', NGN: 'en-NG', KES: 'en-KE', AED: 'en-AE', SAR: 'en-SA', PKR: 'en-PK',
  };

  // ───────────────────────────── helpers ─────────────────────────────
  /** Region of a BCP 47 tag ('vi' → 'VN', 'en-GB' → 'GB'), '' if unknown. Cached. */
  const regionCache = new Map();
  function regionOf(tag) {
    if (typeof tag !== 'string' || !tag) return '';
    if (regionCache.has(tag)) return regionCache.get(tag);
    let region = '';
    try {
      const loc = new Intl.Locale(tag.replace(/_/g, '-'));
      region = loc.region || loc.maximize().region || '';
    } catch { /* invalid tag */ }
    regionCache.set(tag, region);
    return region;
  }

  /**
   * Guess the user's home currency from browser locales (first locale with a known region wins).
   * @param {string[]} locales e.g. [chrome.i18n.getUILanguage(), ...navigator.languages]
   * @returns {string} ISO code — 'vi' → 'VND', 'ja' → 'JPY', 'en-GB' → 'GBP', 'en' → 'USD', fallback 'USD'
   */
  function guessHomeCurrency(locales) {
    for (const tag of Array.isArray(locales) ? locales : [locales]) {
      const code = REGION_CURRENCY.get(regionOf(tag));
      if (code && CURRENCIES[code]) return code;
    }
    return 'USD';
  }

  const namesCache = new Map();
  /**
   * Localised currency name via Intl.DisplayNames ('CNY', 'vi' → 'Nhân dân tệ'). Falls back to the code.
   * @param {string} code @param {string} [locale]
   */
  function currencyName(code, locale) {
    const key = locale || 'en';
    try {
      let dn = namesCache.get(key);
      if (!dn) namesCache.set(key, (dn = new Intl.DisplayNames([key], { type: 'currency' })));
      return dn.of(code) || code;
    } catch {
      return String(code || '');
    }
  }

  /**
   * Emoji flag for a currency ('VND' → 🇻🇳, 'EUR' → 🇪🇺), '' for supranational codes (XOF, XDR …).
   * @param {string} code
   */
  function flag(code) {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return '';
    const region = code === 'EUR' ? 'EU' : code === 'ANG' ? 'CW' : code[0] === 'X' ? '' : code.slice(0, 2);
    if (!region) return '';
    return String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  const localeCache = new Map();
  /**
   * Locale used to FORMAT amounts of `code`: the first preferred (browser) locale whose region uses `code`,
   * else the currency's home locale (VND → 'vi-VN' → "730.373 ₫", JPY → 'ja-JP', USD → 'en-US', EUR → 'de-DE').
   * @param {string} code @param {string[]} [preferred]
   */
  function localeFor(code, preferred) {
    const regions = regionsOf(code);
    for (const tag of Array.isArray(preferred) ? preferred : []) {
      if (regions.includes(regionOf(tag))) return tag;
    }
    if (localeCache.has(code)) return localeCache.get(code);
    let locale = HOME_LOCALE[code] || 'en-US';
    if (!HOME_LOCALE[code] && regions.length) {
      try {
        const max = new Intl.Locale(`und-${regions[0]}`).maximize();
        locale = `${max.language}-${regions[0]}`;
        // Keep Latin digits for locales that default to another numbering system (ar-EG → ١٢٣).
        if (new Intl.NumberFormat(locale).resolvedOptions().numberingSystem !== 'latn') locale += '-u-nu-latn';
      } catch { /* keep en-US */ }
    }
    localeCache.set(code, locale);
    return locale;
  }

  globalThis.TransPriceCurrencies = Object.freeze({
    CURRENCIES,
    CODES,
    TOKENS,
    AMBIGUOUS,
    guessHomeCurrency,
    currencyName,
    flag,
    localeFor,
  });
})();
