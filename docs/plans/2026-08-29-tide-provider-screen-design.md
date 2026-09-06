# Tide Providers Screen + Wizard — Exact-Match Design

Validated 2026-08-29 with Yogi. Scope: build tide's provider-management
experience inside the waku fork, plus the model-selector row anatomy, using
tide's own source as the specification.

## Decisions
- Settings keeps both surfaces (Yogi's call): the shipped provider page is
  renamed **CLI** (binary overrides, enable toggles — unchanged behavior);
  a new **Providers** page is tide's providers screen.
- The picker's "Open Provider Settings" routes to the new Providers page.
- Full behavioral clone: 4-step wizard, connection-test gate, auto-detect,
  catalog enrichment with prices/context/icons, review, edit, delete.

## Architecture
- **Catalogs ported** (waku-core): `model_metadata.rs` = tide's
  model_catalog.rs (models.dev + 2958-model bundled baseline + 7-day cache,
  match/resolve semantics with tests intact); `or_catalog.rs` = tide's
  OpenRouter enrichment. Blocking HTTP; lazy boot — bundled/cache load sync,
  refresh on a background thread, graceful degradation.
- **Protocol v6**: TideModelWire gains `matchState`/`priceLabel`/`vision`/
  `catalogId`; new commands TideDetectProtocol (races /models probes, OpenAI
  wins ties) + TideTestConnection (minimal completion POST); ProviderModel
  gains price_label/vision for picker rows. TS bindings regenerated.
- **Probe enrichment** (fetchAndEnrichModels port, server-side): rich
  provider entries → "live"; bare ids → models.dev resolve → "enriched";
  routing-excluded ids render under Other endpoint. Prices format exactly as
  tide's formatPriceRate; saved models persist priceLabel/vision/catalogId
  as tide-style extras.
- **Wizard** (`src/app/tide_wizard.rs`): overlay dialog, steps
  Choose (preset tiles + Added badges + dashed custom tiles) → Connect
  (name/key/base URL/protocol chips; Auto-Detect on custom; Continue gated
  on the detect race) → Models (auto-fetch, three sections, recommended
  pre-checks, brain/eye icons, ctx + price badges) → Review (card, keychain
  note, model chips). Edit mode reuses the wizard against
  TideUpdateProvider; blank key keeps the stored one.
- **Providers page** (`render_tide_settings`): caption, Add Provider card,
  empty state, provider cards (name, key status, base URL · style · model
  count, Edit / Enable / Delete), page-load triggers TideProviders.
- **Model selector**: tide rows show alias + brain (reasoning) + eye
  (vision) icons and the sub-line `provider · 200K ctx · $3 / $15 per Mtok`
  (tide's formatContext + formatPriceRate); effort tiers minimal…max.

## Deferred
- Wizard preset search field; per-provider usage limits editing;
  test-connection button on provider cards (command exists, no UI yet).
