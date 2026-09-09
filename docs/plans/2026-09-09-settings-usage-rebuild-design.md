# Settings → Usage rebuild: per-provider, per-model stats from Tide's own ledger

Date: 2026-09-09
Status: design validated with user

## Problem

The Usage page is built around a CLI-transcript scanner: it walks Claude Code
and Codex session files, attributes usage to a hardcoded two-provider enum,
and presents a flat per-model table. It says nothing about the requests Tide
itself makes through its configured providers.

## Decision

Rebuild the page around Tide's own usage, sourced from a per-turn ledger,
with the whole page organized so per-provider, per-model stats are first
class. The CLI-transcript pipeline is deleted, not kept alongside.

Agreed in brainstorming:

1. **Data source:** extend the existing (currently unwired) `usage.db`
   `usage_event` ledger — add model, workspace, and token-class columns;
   record per turn; keep ~13 months of history. No session-store backfill:
   stats accrue from the moment recording ships.
2. **Scope:** replace the CLI-scan pipeline entirely.
3. **UI shape:** keep the Daily / Monthly / Projects view structure,
   re-sourced from the ledger.

## The ledger

`crates/store/src/usage.rs`, `usage.db`:

```sql
CREATE TABLE usage_event (
  time INTEGER NOT NULL,          -- unix ms, one row per turn
  provider_id TEXT NOT NULL,      -- Tide provider config id (p_…)
  model TEXT NOT NULL,            -- wire model_id as used in the turn
  workspace TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_usage_provider_time ON usage_event(provider_id, time);
CREATE INDEX idx_usage_time ON usage_event(time);
```

An existing 4-column table migrates via `ALTER TABLE … ADD COLUMN` with
defaults (defensive; nothing writes to it today).

Prune horizon moves from 8 days to 372 days (12-month Monthly window plus
slack). The rolling-window meter reads keep working against the same table.

Recording lands in the Tide driver at the turn boundary next to
`emit_step_usage` (`crates/backend/src/driver/tide.rs`): provider id and
model come from the turn's actual engine configuration so mid-session model
switches attribute correctly; workspace comes from the session.
`record_provider_usage` — currently dead code — becomes the live API,
extended with the new fields. Zero-usage turns write nothing.

## Aggregation and protocol

The daemon answers `LoadUsageReport { window }` (replacing
`LoadUsageHistory`) with a new `UsageReport` in `crates/protocol`:

```rust
struct UsageReport {
    window: UsageWindow, since_day: NaiveDate, until_day: NaiveDate,
    totals: TokenTotals, cost_usd: f64, turns: u64, sessions: u64,
    providers: Vec<ProviderSlice>,     // keyed by provider_id: String
    models:    Vec<ModelSlice>,        // keyed by (provider_id, model)
    daily:     Vec<DaySlice>,          // by_provider: Vec<ProviderDay>
    months:    Vec<MonthSlice>,
    projects:  Vec<ProjectSlice>,      // keyed by workspace
}
```

`UsageWindow`, `TokenTotals`, and the date-enumeration helpers survive from
the old module. Aggregation runs on the daemon's background executor as a
handful of `GROUP BY` queries — the table is one row per turn, pruned to 13
months, so this is milliseconds.

Deleted with the CLI pipeline: the `UsageProvider` enum, `PricingStatus`,
`CostQuality`, the LiteLLM rate-table fetch and cache, the scanned/skipped
files footer, and the `http_get` helper if nothing else consumes it. Cost is
whatever the engine reported per turn; the cost-vs-tokens ranking toggle
falls back to tokens when there is no cost data.

Provider labels and colors resolve UI-side: join `provider_id` against the
configured Tide provider list the app already loads; fall back to the raw id
for deleted providers; colors from a fixed palette assigned by sorted
provider id.

## Page UI

The page skeleton stays — header with view switcher, window selector,
refresh; the entity's snapshot/generation/stale-while-revalidate machinery is
data-source-agnostic and unchanged.

- **Daily:** headline and layered chart stack N provider series from the
  dynamic palette. Metric strip keeps the token-class tiles (processed,
  cached input, uncached input, output); the rate-table-dependent
  cache-savings tile becomes cache-read share. The Breakdown section is the
  centerpiece: the Model side renders provider groups — a provider header
  row (dot, label, subtotal cost/tokens, share bar) followed by that
  provider's models sorted by cost with per-model cost, share, and tokens.
  The Day table's per-provider columns become dynamic.
- **Monthly:** month cards unchanged in shape — split bar per provider,
  sessions, active days, top-models popover — fed by ledger months.
- **Projects:** virtualized list unchanged, keyed by workspace.
- **Empty state:** until the first turn is recorded the page says so plainly
  ("Tide tracks usage from version X; stats appear as you use it").
- New UI strings land in `locales/{app,ja,zh-CN}.yml`.

## Failure modes

Recording is best-effort: a failed insert never fails a turn — it logs and
moves on, matching how the window meter already degrades to zeroed reads on
a locked or corrupt db. Query failures surface through the existing error
toast path. A missing or mid-migration `usage.db` opens with defaults.

## Testing

- **store:** extend ledger tests for the new columns, 13-month prune, and an
  old-schema migration test.
- **backend:** aggregation tests seeding `usage_event` rows and asserting
  the report — provider subtotals, provider×model grouping, day/month/
  workspace slices, window bounds, empty-table report.
- **UI:** pure helpers (label truncation, palette assignment, subtotal
  math) stay unit-tested.
- Checks per `AGENTS.md`: focused `cargo fmt`/`check`/`test` first, then
  validation in the watcher-managed debug app against a real provider turn.

## Sequencing

1. Store: schema + migration + prune change.
2. Driver: recording wiring.
3. Daemon: aggregation + `UsageReport` protocol.
4. UI: page rewrite.
5. Deletion pass (scanner, old protocol types, rate table, generated TS,
   dead locale keys).

Each step compiles and tests on its own.
