/**
 * Shared loader for the engine tests. The engine files are classic scripts (no exports): importing them for their
 * side effect sets globalThis.TransPriceCurrencies / globalThis.TransPriceParser — exactly how the service worker and
 * extension pages use them.
 */
import '../../extension/src/shared/currency-data.js';
import '../../extension/src/content/parser.js';

export { RATES_SNAPSHOT } from '../../extension/src/background/rates-snapshot.js';
export const C = globalThis.TransPriceCurrencies;
export const P = globalThis.TransPriceParser;

/** Contexts used across the tables. */
export const CTX = {
  none: P.resolveContext({}), //                                  $ USD · ¥ CNY · decimal unknown
  taobao: P.resolveContext({ hostname: 'item.taobao.com', lang: 'zh-CN' }),
  jp: P.resolveContext({ hostname: 'www.amazon.co.jp', lang: 'ja-JP' }),
  en: P.resolveContext({ hostname: 'example.com', lang: 'en-US' }),
  de: P.resolveContext({ hostname: 'example.de', lang: 'de-DE' }),
  vn: P.resolveContext({ hostname: 'shopee.vn', lang: 'vi' }),
  ca: P.resolveContext({ hostname: 'amazon.ca', lang: 'en-CA' }),
  no: P.resolveContext({ hostname: 'finn.no', lang: 'nb' }),
};

/** Intl puts NBSP / narrow NBSP between number and symbol; compare with plain spaces. */
export const spaces = (s) => s.replace(/[\u00A0\u202F]/g, ' ');
