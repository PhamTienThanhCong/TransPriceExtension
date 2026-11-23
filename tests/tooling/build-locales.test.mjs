import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocaleFiles, mergeFragments, serializeMessages, STORE_LIMITS, toChromeMessage } from '../../scripts/build-locales.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NO_LIMITS = { limits: {} };
const frag = (file, data) => ({ file, data });

test('mergeFragments merges keys from several fragments', () => {
  const { messages, locales, errors, warnings } = mergeFragments(
    [frag('a.json', { a_one: { en: 'One', vi: 'Một' } }), frag('b.json', { b_two: { en: 'Two $1', vi: 'Hai $1', description: 'd' } })],
    NO_LIMITS,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual([...messages.keys()], ['a_one', 'b_two']);
  assert.deepEqual([...locales].sort(), ['en', 'vi']);
  assert.equal(messages.get('b_two').file, 'b.json');
});

test('mergeFragments rejects duplicate keys across fragments', () => {
  const { errors } = mergeFragments([frag('a.json', { k: { en: 'A', vi: 'A' } }), frag('b.json', { k: { en: 'B', vi: 'B' } })], NO_LIMITS);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /b\.json: duplicate key "k" \(already defined in a\.json\)/);
});

test('mergeFragments requires en and vi for every key', () => {
  const { errors } = mergeFragments([frag('a.json', { k1: { en: 'Only English' }, k2: { vi: 'Chỉ tiếng Việt' }, k3: { en: ' ', vi: 'x' } })], NO_LIMITS);
  assert.ok(errors.some((e) => /"k1" is missing "vi"/.test(e)));
  assert.ok(errors.some((e) => /"k2" is missing "en"/.test(e)));
  assert.ok(errors.some((e) => /"k3" is missing "en"/.test(e)), 'blank strings count as missing');
});

test('mergeFragments rejects invalid keys, non-object entries and bad locales', () => {
  const { errors } = mergeFragments(
    [frag('a.json', { 'bad-key': { en: 'x', vi: 'x' }, notObj: 'text', k: { en: 'x', vi: 'x', 'pt-BR': 'x' }, n: { en: 'x', vi: 1 } })],
    NO_LIMITS,
  );
  assert.ok(errors.some((e) => /invalid key "bad-key"/.test(e)));
  assert.ok(errors.some((e) => /"notObj" must be an object/.test(e)));
  assert.ok(errors.some((e) => /invalid locale "pt-BR"/.test(e)));
  assert.ok(errors.some((e) => /"n"\.vi must be a string/.test(e)));
  assert.ok(mergeFragments([frag('arr.json', [])], NO_LIMITS).errors[0].includes('top level must be an object'));
});

test('mergeFragments checks placeholder parity between locales', () => {
  const { errors } = mergeFragments([frag('a.json', { k: { en: '$1 of $2', vi: '$1' } })], NO_LIMITS);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /placeholders differ between en \(\$1,\$2\) and vi \(\$1\)/);
});

test('optional locales: allowed, missing ones only warn', () => {
  const { errors, warnings, locales } = mergeFragments([frag('a.json', { k1: { en: 'a', vi: 'a', fr: 'a' }, k2: { en: 'b', vi: 'b' } })], NO_LIMITS);
  assert.deepEqual(errors, []);
  assert.ok(locales.has('fr'));
  assert.deepEqual(warnings, ['a.json: "k2" has no "fr" translation (falls back to en)']);
});

test('Chrome Web Store limits are enforced and required', () => {
  const long = 'x'.repeat(STORE_LIMITS.extName + 1);
  const ok = { extShortName: { en: 'TransPrice', vi: 'TransPrice' }, extDescription: { en: 'd', vi: 'd' } };
  const { errors } = mergeFragments([frag('meta.json', { extName: { en: long, vi: 'ok' }, ...ok })]);
  assert.deepEqual(errors, [`"extName" (en) is ${long.length} chars, max ${STORE_LIMITS.extName}`]);
  const missing = mergeFragments([frag('meta.json', ok)]).errors;
  assert.deepEqual(missing, ['missing required key "extName"']);
});

test('toChromeMessage converts $n to named placeholders', () => {
  assert.deepEqual(toChromeMessage('Plain'), { message: 'Plain' });
  assert.deepEqual(toChromeMessage('Rates of $1', 'date'), {
    message: 'Rates of $P1$',
    description: 'date',
    placeholders: { p1: { content: '$1' } },
  });
  assert.deepEqual(toChromeMessage('$2 → $1 ($2)').placeholders, { p1: { content: '$1' }, p2: { content: '$2' } });
  assert.equal(toChromeMessage('$2 → $1 ($2)').message, '$P2$ → $P1$ ($P2$)');
});

test('buildLocaleFiles: keys sorted, descriptions only in en, optional locales partial', () => {
  const { messages, locales } = mergeFragments(
    [frag('a.json', { zeta: { en: 'Z', vi: 'Z', description: 'last' }, alpha: { en: 'A $1', vi: 'A $1', fr: 'A $1' } })],
    NO_LIMITS,
  );
  const files = buildLocaleFiles(messages, locales);
  assert.deepEqual(Object.keys(files), ['en', 'fr', 'vi']);
  assert.deepEqual(Object.keys(files.en), ['alpha', 'zeta']);
  assert.equal(files.en.zeta.description, 'last');
  assert.equal(files.vi.zeta.description, undefined);
  assert.deepEqual(Object.keys(files.fr), ['alpha']);
  assert.equal(serializeMessages({ a: 1 }), '{\n  "a": 1\n}\n');
});

test('the foundation fragments (i18n/common.json + meta.json) are valid and within store limits', async () => {
  const read = async (f) => frag(f, JSON.parse(await readFile(path.join(ROOT, 'i18n', f), 'utf8')));
  const { errors, messages } = mergeFragments([await read('common.json'), await read('meta.json')]);
  assert.deepEqual(errors, []);
  for (const k of ['extName', 'extShortName', 'extDescription', 'actionTitle', 'cmdToggleEnabled']) assert.ok(messages.has(k), k);
  for (const k of messages.keys()) {
    if (!['extName', 'extShortName', 'extDescription', 'actionTitle', 'cmdToggleEnabled'].includes(k)) assert.match(k, /^common_/);
  }
  assert.equal(messages.get('extName').entry.en, 'TransPrice — Currency Converter for Shopping');
  assert.equal(messages.get('extName').entry.vi, 'TransPrice — Quy đổi giá tiền khi mua sắm');
});
