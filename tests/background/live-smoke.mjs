#!/usr/bin/env node
/**
 * LIVE smoke test (real network, not part of `npm test`): fetch and normalise EACH rate source on its own, so a dead
 * source is noticed even though the runtime fallback would hide it.
 *
 *   node tests/background/live-smoke.mjs
 */
import { RATE_SOURCES } from '../../extension/src/shared/constants.js';
import { fetchSource } from '../../extension/src/background/rates.js';

let failed = 0;
for (const source of RATE_SOURCES) {
  const started = Date.now();
  try {
    const t = await fetchSource(source, { fetch: globalThis.fetch });
    const ms = Date.now() - started;
    console.log(`✔ ${source.id.padEnd(20)} ${t.date}  ${String(Object.keys(t.rates).length).padStart(3)} codes  1 USD = ${t.rates.VND} VND, ${t.rates.CNY} CNY  (${ms} ms)`);
  } catch (err) {
    failed++;
    console.log(`✖ ${source.id.padEnd(20)} [${err.code}] ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
