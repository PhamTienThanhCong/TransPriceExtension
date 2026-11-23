/**
 * Entry point for `node --test tests/engine/`: Node 24 resolves a directory argument like a module path (→ this
 * index.js) instead of searching it for tests. Importing every *.test.mjs here keeps that command working.
 * `npm test` globs the *.test.mjs files directly and never loads this file, so nothing runs twice.
 */
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) await import(new URL(file, dir));
