#!/usr/bin/env node
// Fetches the models.dev catalog (https://models.dev/api.json), flattens it to
// the slim { catalogId: { reasoning, tool_call, attachment, limit, cost } }
// shape the loader consumes, and writes a single wrapper file
// ({ fetchedAt, source, count, models }) into app/core/data/. Run manually via
// `npm run update:model-prices` to refresh the vendored snapshot.
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL_ = 'https://models.dev/api.json';
const OUT_DIR = resolve(__dirname, '..', 'app', 'core', 'data');

const res = await fetch(URL_, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const json = await res.json();

// Flatten the nested { provider: { models: { id: {...} } } } into a flat
// { catalogId: slimModel } map, keeping only the fields the loader reads.
// Mirrors flattenModelsDevApi() in app/core/agent/model-prices.ts.
const models = {};
let providerCount = 0;
for (const provider of Object.values(json)) {
  if (!provider || typeof provider !== 'object') continue;
  providerCount++;
  const providerModels = provider.models;
  if (!providerModels || typeof providerModels !== 'object') continue;
  for (const [id, model] of Object.entries(providerModels)) {
    if (!model || typeof model !== 'object') continue;
    models[id] = {
      reasoning: model.reasoning,
      reasoning_options: model.reasoning_options,
      tool_call: model.tool_call,
      attachment: model.attachment,
      limit: model.limit,
      cost: model.cost,
    };
  }
}

const count = Object.keys(models).length;
if (count < 100) {
  console.error(`Suspiciously small catalog (${count} models) — aborting.`);
  process.exit(1);
}

const wrapper = {
  fetchedAt: new Date().toISOString(),
  source: URL_,
  count,
  models,
};
await writeFile(resolve(OUT_DIR, 'model-prices.json'), JSON.stringify(wrapper), 'utf8');
console.log(
  `Wrote model-prices.json (${count} models across ${providerCount} providers) at ${wrapper.fetchedAt}`,
);
