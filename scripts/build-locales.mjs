#!/usr/bin/env node
/**
 * TransPrice — build extension/_locales/<locale>/messages.json from the i18n/*.json fragments.
 *
 * Fragment format:  { "key": { "en": "Text with $1", "vi": "Văn bản $1", "description": "context for translators" } }
 *  - `$1`..`$9` become Chrome placeholders automatically.
 *  - Keys must be unique across all fragments and match [A-Za-z0-9_].
 *  - Required locales (en, vi) must be present for every key; other locales are optional
 *    (Chrome falls back to default_locale "en").
 *  - Placeholders must match between locales; Chrome Web Store length limits apply to extName/extShortName/extDescription.
 *
 * Usage:
 *   node scripts/build-locales.mjs          # write files            (npm run i18n)
 *   node scripts/build-locales.mjs --check  # verify generated files are up to date (CI, npm run check)
 *
 * The pure helpers below are exported for tests (tests/tooling/build-locales.test.mjs).
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_LOCALES = Object.freeze(['en', 'vi']);
/** Chrome Web Store limits (characters). */
export const STORE_LIMITS = Object.freeze({ extName: 75, extShortName: 12, extDescription: 132 });

const KEY_RE = /^[A-Za-z0-9_]+$/;
const placeholderSet = (s) => [...new Set((s || '').match(/\$[1-9]/g) || [])].sort().join(',');

/**
 * Merge parsed fragments and validate them. PURE.
 * @param {Array<{file: string, data: any}>} fragments  parsed i18n/*.json files (in a stable order)
 * @param {{requiredLocales?: string[], limits?: Record<string, number>}} [options]
 * @returns {{messages: Map<string, {file: string, entry: object}>, locales: Set<string>, errors: string[], warnings: string[]}}
 */
export function mergeFragments(fragments, { requiredLocales = REQUIRED_LOCALES, limits = STORE_LIMITS } = {}) {
  const errors = [];
  const warnings = [];
  const messages = new Map();
  const locales = new Set(requiredLocales);

  for (const { file, data } of fragments) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${file}: top level must be an object of { key: { en, vi, description? } }`);
      continue;
    }
    for (const [key, entry] of Object.entries(data)) {
      if (!KEY_RE.test(key)) errors.push(`${file}: invalid key "${key}" (use [A-Za-z0-9_])`);
      if (messages.has(key)) {
        errors.push(`${file}: duplicate key "${key}" (already defined in ${messages.get(key).file})`);
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${file}: "${key}" must be an object`);
        continue;
      }
      for (const loc of Object.keys(entry)) {
        if (loc === 'description') continue;
        if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(loc)) errors.push(`${file}: "${key}" has an invalid locale "${loc}" (Chrome codes: en, vi, pt_BR…)`);
        else if (typeof entry[loc] !== 'string') errors.push(`${file}: "${key}".${loc} must be a string`);
        else locales.add(loc);
      }
      messages.set(key, { file, entry });
    }
  }

  for (const [key, { file, entry }] of messages) {
    for (const loc of requiredLocales) {
      if (typeof entry[loc] !== 'string' || !entry[loc].trim()) errors.push(`${file}: "${key}" is missing "${loc}"`);
    }
    for (const loc of locales) {
      if (requiredLocales.includes(loc) || entry[loc] !== undefined) continue;
      warnings.push(`${file}: "${key}" has no "${loc}" translation (falls back to en)`);
    }
    const enPh = placeholderSet(entry.en);
    for (const loc of locales) {
      if (typeof entry[loc] === 'string' && placeholderSet(entry[loc]) !== enPh) {
        errors.push(`${file}: "${key}" placeholders differ between en (${enPh || 'none'}) and ${loc} (${placeholderSet(entry[loc]) || 'none'})`);
      }
    }
  }

  for (const [key, max] of Object.entries(limits)) {
    const e = messages.get(key)?.entry;
    if (!e) {
      errors.push(`missing required key "${key}"`);
      continue;
    }
    for (const loc of locales) {
      if (typeof e[loc] === 'string' && e[loc].length > max) errors.push(`"${key}" (${loc}) is ${e[loc].length} chars, max ${max}`);
    }
  }

  return { messages, locales, errors, warnings };
}

/** One fragment text → a Chrome messages.json entry (`$1` → `$P1$` + placeholders). PURE. */
export function toChromeMessage(text, description) {
  const out = {};
  const nums = [...new Set((text.match(/\$[1-9]/g) || []).map((m) => m.slice(1)))];
  out.message = nums.length ? text.replace(/\$([1-9])/g, (_, n) => `$P${n}$`) : text;
  if (description) out.description = description;
  if (nums.length) out.placeholders = Object.fromEntries(nums.sort().map((n) => [`p${n}`, { content: `$${n}` }]));
  return out;
}

/**
 * Build every locale's messages.json object (keys sorted; descriptions only in en). PURE.
 * @returns {Record<string, Record<string, object>>}  locale → messages
 */
export function buildLocaleFiles(messages, locales) {
  const files = {};
  for (const loc of [...locales].sort()) {
    const result = {};
    for (const key of [...messages.keys()].sort()) {
      const { entry } = messages.get(key);
      if (typeof entry[loc] !== 'string') continue;
      result[key] = toChromeMessage(entry[loc], loc === 'en' ? entry.description : undefined);
    }
    files[loc] = result;
  }
  return files;
}

/** Serialized file content (stable, trailing newline). */
export const serializeMessages = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/** Read + parse every i18n/*.json fragment (parse errors are returned, not thrown). */
export async function readFragments(srcDir) {
  const errors = [];
  const fragments = [];
  const files = existsSync(srcDir) ? (await readdir(srcDir)).filter((f) => f.endsWith('.json')).sort() : [];
  for (const file of files) {
    try {
      fragments.push({ file, data: JSON.parse(await readFile(path.join(srcDir, file), 'utf8')) });
    } catch (e) {
      errors.push(`${file}: invalid JSON — ${e.message}`);
    }
  }
  return { fragments, errors };
}

async function main() {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const SRC_DIR = path.join(ROOT, 'i18n');
  const OUT_DIR = path.join(ROOT, 'extension', '_locales');
  const CHECK = process.argv.includes('--check');

  const read = await readFragments(SRC_DIR);
  if (!read.fragments.length && !read.errors.length) {
    console.error(`✖ no fragments found in ${path.relative(ROOT, SRC_DIR)}/`);
    process.exit(1);
  }
  const { messages, locales, errors, warnings } = mergeFragments(read.fragments);
  errors.unshift(...read.errors);
  if (errors.length) {
    console.error(`✖ i18n build failed:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }

  let stale = false;
  for (const [loc, obj] of Object.entries(buildLocaleFiles(messages, locales))) {
    const outFile = path.join(OUT_DIR, loc, 'messages.json');
    const json = serializeMessages(obj);
    if (CHECK) {
      const current = existsSync(outFile) ? await readFile(outFile, 'utf8') : '';
      if (current !== json) {
        stale = true;
        console.error(`✖ ${path.relative(ROOT, outFile)} is out of date — run: npm run i18n`);
      }
    } else {
      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, json);
    }
  }

  if (warnings.length) console.warn(`⚠ ${warnings.length} warning(s):\n  - ${warnings.slice(0, 20).join('\n  - ')}`);
  if (stale) process.exit(1);
  console.log(
    `✔ i18n ${CHECK ? 'up to date' : 'built'}: ${messages.size} keys × ${locales.size} locales (${[...locales].sort().join(', ')}) from ${read.fragments.length} fragment(s)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
