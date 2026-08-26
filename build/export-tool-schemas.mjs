#!/usr/bin/env bun
/**
 * Temporary scaffolding for the Tauri rewrite (deleted once app/ is removed):
 * imports the TS backend's tool registry read-only and writes permanent
 * reference fixtures for the Rust tide-engine crate:
 *
 *   src-tauri/crates/tide-engine/fixtures/schemas/tools.json      — tool name/description/schema
 *   src-tauri/crates/tide-engine/fixtures/schemas/mcp-config.json — ~/.tide/config.json shape (secrets redacted)
 *
 * Run: bun build/export-tool-schemas.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src-tauri/crates/tide-engine/fixtures/schemas');

const registry = await import('../app/core/agent/tools/registry.ts');
const { loadSkillTool } = await import('../app/core/agent/tools/load-skill.ts');
const { z } = await import('zod');

// ─── tools.json ────────────────────────────────────────────────────────
// Primary source: the legacy REGISTRY hand-written Anthropic wire-format
// definitions ({name, description, input_schema}) — plain JSON, passed through.
// Cross-check: the LIVE SDK factory path (buildToolset → zod inputSchema),
// converted to JSON Schema via zod v4's z.toJSONSchema, recorded as sdkSchema.
const entries = [];

for (const def of registry.getAnthropicTools()) {
  entries.push({ name: def.name, description: def.description, schema: def.input_schema });
}

// load_skill exists only on the SDK factory path but ships a legacy
// registration with a hand-written schema — same pass-through treatment.
if (!entries.some((e) => e.name === loadSkillTool.definition.name)) {
  entries.push({
    name: loadSkillTool.definition.name,
    description: loadSkillTool.definition.description,
    schema: loadSkillTool.definition.input_schema,
  });
}

let sdkTools = null;
try {
  sdkTools = registry.buildToolset({ skills: [] });
} catch (e) {
  console.warn(`SDK toolset build failed (${e.message}); sdkSchema omitted for all tools`);
}

let sdkOk = 0;
let sdkFail = 0;
for (const entry of entries) {
  const t = sdkTools?.[entry.name];
  if (!t) {
    entry.sdkSchema = null;
    entry.sdkNote = 'no SDK factory for this tool (legacy-only registration)';
    sdkFail++;
    continue;
  }
  try {
    const s = t.inputSchema ?? t.parameters;
    if (!s) throw new Error('no inputSchema on built tool');
    entry.sdkSchema = z.toJSONSchema(s);
    sdkOk++;
  } catch (e) {
    entry.sdkSchema = null;
    entry.sdkNote = `zod→JSON conversion failed: ${e.message}`;
    sdkFail++;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'tools.json'), JSON.stringify(entries, null, 2) + '\n');
console.log(`tools.json: ${entries.length} tools (${sdkOk} sdk schemas extracted, ${sdkFail} failed)`);

// ─── mcp-config.json ───────────────────────────────────────────────────
// The SHAPE of ~/.tide/config.json is the fixture; every value whose key
// matches /token|secret|key|credential/i is redacted to "***" so credentials
// can never be committed.
// authorization added beyond the task spec: mcpServers.*.headers.Authorization
// carries live "Bearer <api-key>" values the base regex misses.
const SECRET_KEY = /token|secret|key|credential|authorization/i;
// mcpOAuth holds client secrets + PKCE verifiers keyed by server name, so the
// leaf keys don't match SECRET_KEY. Keep the key structure, redact every leaf.
const OAUTH_CONTAINER = /oauth/i;

function redact(value, key = '', inherited = false) {
  const secretHere = inherited || SECRET_KEY.test(key) || OAUTH_CONTAINER.test(key);
  if (Array.isArray(value)) return value.map((v) => redact(v, '', secretHere));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, secretHere);
    return out;
  }
  // Scalars under (or at) a secret-ish key redact; containers above keep their
  // shape so the fixture still documents the nesting.
  return secretHere && typeof value === 'string' && value !== '' ? '***' : value;
}

const configPath = join(homedir(), '.tide', 'config.json');
if (existsSync(configPath)) {
  const redacted = redact(JSON.parse(readFileSync(configPath, 'utf8')));
  writeFileSync(join(OUT_DIR, 'mcp-config.json'), JSON.stringify(redacted, null, 2) + '\n');
  console.log(`mcp-config.json: copied from ${configPath} (secrets redacted)`);
} else {
  writeFileSync(join(OUT_DIR, 'mcp-config.json'), JSON.stringify({}, null, 2) + '\n');
  console.log(`mcp-config.json: ${configPath} not found — wrote {} placeholder`);
}
