#!/usr/bin/env node
/**
 * TransPrice — refresh the bundled offline rate table (extension/src/background/rates-snapshot.js).
 *
 *   node scripts/update-rates-snapshot.mjs            (or: npm run rates:snapshot)
 *   node scripts/update-rates-snapshot.mjs --dry-run  print what would be written, don't touch the file
 *
 * Uses the extension's own fetch + normalisation (src/background/rates.js): same source order, same filtering to
 * the currencies TransPrice knows, same sanity checks. Zero dependencies (Node ≥ 22 global fetch).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_FILE = path.join(ROOT, 'extension/src/background/rates-snapshot.js');

const HEADER = `/**
 * TransPrice — bundled exchange-rate snapshot (offline fallback, used only when every live source fails).
 * Units per 1 USD. GENERATED — regenerate with \`npm run rates:snapshot\` (scripts/update-rates-snapshot.mjs).
 */
`;

/**
 * Source text of rates-snapshot.js for a RatesTable (keys: base, date, source 'snapshot', rates sorted by code and
 * rounded to 8 significant digits — plenty for display, and keeps the diff of a refresh readable).
 * @param {{date: string, rates: Record<string, number>}} table
 * @returns {string}
 */
export function renderSnapshot(table) {
  const rates = Object.fromEntries(
    Object.keys(table.rates)
      .sort()
      .map((code) => [code, Number(table.rates[code].toPrecision(8))]),
  );
  const body = JSON.stringify({ base: 'USD', date: table.date, source: 'snapshot', rates }, null, 2);
  return `${HEADER}export const RATES_SNAPSHOT = Object.freeze(${body});\n`;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const { fetchLatestRates } = await import('../extension/src/background/rates.js');
  let previous = null;
  try {
    previous = (await import(`${pathToFileURL(SNAPSHOT_FILE).href}?t=${Date.now()}`)).RATES_SNAPSHOT;
  } catch {
    /* no previous snapshot */
  }

  const table = await fetchLatestRates({ fetch: globalThis.fetch });
  const source = renderSnapshot(table);
  const count = Object.keys(table.rates).length;
  console.log(`Fetched ${count} currencies from ${table.source} (data date ${table.date}).`);
  if (previous) {
    for (const code of ['EUR', 'CNY', 'JPY', 'VND']) {
      const before = previous.rates?.[code];
      const after = table.rates[code];
      const delta = before ? `${(((after - before) / before) * 100).toFixed(2)}%` : 'new';
      console.log(`  ${code}: ${before ?? '—'} → ${after} (${delta})`);
    }
    const dropped = Object.keys(previous.rates || {}).filter((code) => !(code in table.rates));
    if (dropped.length) console.log(`  dropped (not in currency-data.js or not served): ${dropped.join(' ')}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: not writing. First lines:\n');
    console.log(source.split('\n').slice(0, 12).join('\n'));
    return;
  }
  const current = await readFile(SNAPSHOT_FILE, 'utf8').catch(() => '');
  if (current === source) {
    console.log(`${path.relative(ROOT, SNAPSHOT_FILE)} is already up to date.`);
    return;
  }
  await writeFile(SNAPSHOT_FILE, source);
  console.log(`Wrote ${path.relative(ROOT, SNAPSHOT_FILE)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Failed to update the rate snapshot: ${err?.message || err}`);
    for (const a of err?.details?.attempts || []) console.error(`  - ${a.source}: [${a.code}] ${a.message}`);
    process.exit(1);
  });
}
