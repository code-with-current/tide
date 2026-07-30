#!/usr/bin/env node
// Fetches the latest LiteLLM model_prices_and_context_window.json and writes
// it + a version file into electron/data/. Run manually via
// `npm run update:model-prices` to refresh the vendored snapshot.
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_ =
  'https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/litellm_internal_staging/model_prices_and_context_window.json';
const OUT_DIR = resolve(__dirname, '..', 'electron', 'data');

const res = await fetch(URL_, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();

// Validate it parses before writing — never write a broken catalog.
let parsed;
try {
  parsed = JSON.parse(text);
} catch (e) {
  console.error('Fetched content is not valid JSON:', e.message);
  process.exit(1);
}
const keys = Object.keys(parsed);
if (keys.length < 100) {
  console.error(`Suspiciously small catalog (${keys.length} keys) — aborting.`);
  process.exit(1);
}

await writeFile(resolve(OUT_DIR, 'model-prices.json'), text, 'utf8');
const version = {
  fetchedAt: new Date().toISOString(),
  source: URL_,
  count: keys.length,
};
await writeFile(
  resolve(OUT_DIR, 'model-prices-version.json'),
  JSON.stringify(version, null, 2) + '\n',
  'utf8',
);
console.log(`Wrote model-prices.json (${keys.length} models) at ${version.fetchedAt}`);
