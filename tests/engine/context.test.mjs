/**
 * resolveContext(): what $ / ¥ / kr mean on a page and which decimal mark it uses.
 * Order (first hit wins): site pin → domain → <html lang> → script of the sample text → user default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P } from './helpers.mjs';

const JA_TEXT = 'これは日本語の商品ページです。送料無料、価格は¥1,980です。';
const ZH_TEXT = '夏季新款连衣裙，包邮，已售5件，价格¥189';
const VI_TEXT = 'Giá sản phẩm này rất rẻ, chỉ một trăm nghìn đồng, miễn phí vận chuyển';

/** [label, input, expected subset of the context (reasons flattened as rDollar / rYen / rDecimal)] */
const CASES = [
  // domains
  ['taobao subdomain → CNY', { hostname: 'item.taobao.com' }, { yen: 'CNY', rYen: 'domain', decimal: '.' }],
  ['tmall → CNY', { hostname: 'detail.tmall.com' }, { yen: 'CNY', rYen: 'domain' }],
  ['1688 even with lang=en → CNY', { hostname: '1688.com', lang: 'en' }, { yen: 'CNY', rYen: 'domain' }],
  ['jd.com → CNY', { hostname: 'item.jd.com' }, { yen: 'CNY', rYen: 'domain' }],
  ['aliexpress → CNY', { hostname: 'www.aliexpress.com' }, { yen: 'CNY', rYen: 'domain' }],
  ['*.cn → CNY', { hostname: 'shop.example.cn' }, { yen: 'CNY', rYen: 'domain' }],
  ['amazon.co.jp → JPY', { hostname: 'www.amazon.co.jp' }, { yen: 'JPY', rYen: 'domain' }],
  ['rakuten.co.jp → JPY', { hostname: 'item.rakuten.co.jp' }, { yen: 'JPY', rYen: 'domain' }],
  ['*.jp → JPY', { hostname: 'zozo.jp' }, { yen: 'JPY', rYen: 'domain' }],
  ['.ca → CAD', { hostname: 'amazon.ca' }, { dollar: 'CAD', rDollar: 'domain' }],
  ['.com.au → AUD', { hostname: 'shop.com.au' }, { dollar: 'AUD', rDollar: 'domain' }],
  ['.co.nz → NZD', { hostname: 'trademe.co.nz' }, { dollar: 'NZD', rDollar: 'domain' }],
  ['.sg → SGD', { hostname: 'lazada.sg' }, { dollar: 'SGD', rDollar: 'domain' }],
  ['.com.hk → HKD', { hostname: 'shop.com.hk' }, { dollar: 'HKD', rDollar: 'domain' }],
  ['.tw → TWD', { hostname: 'shopee.tw' }, { dollar: 'TWD', rDollar: 'domain' }],
  ['.com.mx → MXN', { hostname: 'amazon.com.mx' }, { dollar: 'MXN', rDollar: 'domain' }],
  ['.se → SEK', { hostname: 'blocket.se' }, { kr: 'SEK', decimal: ',' }],
  ['.no → NOK', { hostname: 'finn.no' }, { kr: 'NOK' }],
  ['.dk → DKK', { hostname: 'dba.dk' }, { kr: 'DKK' }],
  ['.is → ISK', { hostname: 'verslun.is' }, { kr: 'ISK' }],
  ['.vn → decimal comma', { hostname: 'tiki.vn', lang: 'en' }, { decimal: ',', rDecimal: 'domain' }],
  ['look-alike host is not a match', { hostname: 'nottaobao.com' }, { yen: 'CNY', rYen: 'default' }],
  // lang
  ['lang ja → JPY', { hostname: 'example.com', lang: 'ja' }, { yen: 'JPY', rYen: 'lang', decimal: '.' }],
  ['lang zh_CN (underscore) → CNY', { lang: 'zh_CN' }, { yen: 'CNY', rYen: 'lang' }],
  ['lang zh-TW → TWD dollar', { lang: 'zh-TW' }, { dollar: 'TWD', rDollar: 'lang' }],
  ['lang en-CA → CAD', { lang: 'en-CA' }, { dollar: 'CAD', rDollar: 'lang', decimal: '.' }],
  ['lang fr-CA → CAD + comma', { lang: 'fr-CA' }, { dollar: 'CAD', decimal: ',', rDecimal: 'lang' }],
  ['lang es-MX → MXN', { lang: 'es-MX' }, { dollar: 'MXN', decimal: '.' }],
  ['lang en (no region) keeps the default dollar', { lang: 'en', settings: { defaultDollar: 'AUD' } }, { dollar: 'AUD', rDollar: 'default' }],
  ['lang de → comma', { lang: 'de-DE' }, { decimal: ',', rDecimal: 'lang' }],
  ['lang de-CH → point', { lang: 'de-CH' }, { decimal: '.' }],
  ['lang sv → SEK', { lang: 'sv' }, { kr: 'SEK' }],
  ['lang nb → NOK', { lang: 'nb-NO' }, { kr: 'NOK' }],
  ['lang da → DKK', { lang: 'da' }, { kr: 'DKK' }],
  ['garbage lang is ignored', { lang: '!!not a tag' }, { yen: 'CNY', rYen: 'default', decimal: null }],
  // script
  ['kana → JPY', { hostname: 'example.com', sampleText: JA_TEXT }, { yen: 'JPY', rYen: 'script', decimal: '.', rDecimal: 'script' }],
  ['Han without kana → CNY', { hostname: 'example.com', sampleText: ZH_TEXT, settings: { defaultYen: 'JPY' } }, { yen: 'CNY', rYen: 'script' }],
  ['Chinese text with a few の stays CNY', { sampleText: `${ZH_TEXT.repeat(4)}日系の` }, { yen: 'CNY', rYen: 'script' }],
  ['Vietnamese text → comma', { sampleText: VI_TEXT }, { decimal: ',', rDecimal: 'script' }],
  ['domain beats script', { hostname: 'amazon.co.jp', sampleText: ZH_TEXT }, { yen: 'JPY', rYen: 'domain' }],
  ['lang beats script', { lang: 'zh-CN', sampleText: JA_TEXT }, { yen: 'CNY', rYen: 'lang' }],
  // site pins
  ['site pin beats domain (subdomain)', { hostname: 'world.taobao.com', settings: { siteCurrency: { 'taobao.com': { yen: 'JPY' } } } }, { yen: 'JPY', rYen: 'site-pin' }],
  ['site pin key with www. and capitals', { hostname: 'shop.example.com', settings: { siteCurrency: { 'www.Example.com': { dollar: 'SGD' } } } }, { dollar: 'SGD', rDollar: 'site-pin' }],
  ['host www. is stripped', { hostname: 'www.example.com', settings: { siteCurrency: { 'example.com': { dollar: 'HKD' } } } }, { dollar: 'HKD', rDollar: 'site-pin' }],
  ['most specific pin wins', { hostname: 'a.b.example.com', settings: { siteCurrency: { 'example.com': { dollar: 'HKD' }, 'b.example.com': { dollar: 'NZD' } } } }, { dollar: 'NZD' }],
  ['pin on another site does not apply', { hostname: 'badexample.com', settings: { siteCurrency: { 'example.com': { dollar: 'SGD' } } } }, { dollar: 'USD', rDollar: 'default' }],
  ['pin for $ only leaves ¥ to the domain', { hostname: 'taobao.com', settings: { siteCurrency: { 'taobao.com': { dollar: 'HKD' } } } }, { dollar: 'HKD', yen: 'CNY', rYen: 'domain' }],
  ['invalid pin code is ignored', { hostname: 'taobao.com', settings: { siteCurrency: { 'taobao.com': { yen: 'XXX' } } } }, { yen: 'CNY', rYen: 'domain' }],
  // defaults
  ['user defaults', { hostname: 'example.com', settings: { defaultDollar: 'AUD', defaultYen: 'JPY' } }, { dollar: 'AUD', yen: 'JPY', rDollar: 'default', rYen: 'default' }],
  ['no input at all', undefined, { dollar: 'USD', yen: 'CNY', kr: 'SEK', decimal: null, rDollar: 'default', rYen: 'default', rDecimal: 'default' }],
];

for (const [label, input, expected] of CASES) {
  test(`resolveContext: ${label}`, () => {
    const c = P.resolveContext(input);
    const flat = { dollar: c.dollar, yen: c.yen, kr: c.kr, decimal: c.decimal, rDollar: c.reasons.dollar, rYen: c.reasons.yen, rDecimal: c.reasons.decimal };
    for (const [k, v] of Object.entries(expected)) assert.equal(flat[k], v, k);
  });
}

test('resolveContext output feeds findPrices: the same "¥1,980" is CNY on Taobao and JPY on Rakuten', () => {
  const cn = P.findPrices('¥1,980', P.resolveContext({ hostname: 'taobao.com' }));
  const jp = P.findPrices('¥1,980', P.resolveContext({ hostname: 'rakuten.co.jp' }));
  assert.equal(cn[0].currency, 'CNY');
  assert.equal(jp[0].currency, 'JPY');
  assert.equal(cn[0].amount, 1980);
});
