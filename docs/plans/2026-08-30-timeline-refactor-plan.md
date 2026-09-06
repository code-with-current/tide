# Chat Timeline Refactor — Match tide's Component System

Status: PLAN (not started). Scope: restructure waku's GPUI transcript
PRESENTATION to mirror tide's block/part taxonomy and visual anatomy, while
keeping waku's proven infrastructure (ListState virtualization, fingerprinted
row model, streaming markdown engine, DriverEvent reducer + its 77 tests).

## 1. Component list (tide's timeline, the target catalog)

Shell: `chat-timeline` (root orchestrator, auto-follow + jump-to-bottom) ·
`virtualized-message-list` (tanstack-virtual, end-anchored, LRU measurement) ·
`use-chat-auto-follow` (follow/release state machine).

Turn level: `turn-item` · `turn-activity` · `turn-assistant-block` ·
turn-header/footer (model/agent/duration, copy/fork) · `turn-error-block`
(collapsible + Retry) · `file-changes` card · `compacted-divider` ·
`TurnWorkingFooter` (PixelLoader + elapsed) · `turn-skeleton`.

Message level: `chat-message` (user bubble: notched, clamped+expand, hover
pencil edit-and-resend with confirm dialog, timestamp, copy; assistant:
header/footer on first message per turn) · `message-body` (flat part loop).

Part level: `assistant-text-part` (markdown, streaming-throttled,
finalizes to `generated-json-result-card`) · `reasoning-part` (brain icon,
cycling-dots label, collapsed 80-char summary, expanded markdown, bounded
after done) · `ToolPart` (THE card: status icon column w/ spinner + icon⇄chevron
swap, shine display name, description column w/ FileTypeIcon + relative path,
diff-stat badge, hover panel actions; expanded = input section + per-family
result renderers: diff preview w/ unified/split, question options, agent
report, todo checklist, JSON summary/tree/raw viewer, streaming bash output;
error card) · `ProgressiveGroup`/`StaticToolRow`/`StaticGroupedToolRow`
(collapsible activity group w/ "+N more..." preview, left rail, per-family
static descriptions) · `QuestionCard` (inline follow-up) · user-side
`subtask`/`shellAction` parts · `user-ref-links` (attachment chips).

Support: `tool-helpers` (876-line metadata/display-name/language layer) ·
`typography`/`toolDisplayStyles` · `agent-colors` · `Icon`/`FileTypeIcon` ·
`panel-actions-context` (viewFile/viewDiff/openDispatch) ·
`tool-part-diff-preview` (lazy PatchDiff + plain fallback) ·
`tool-output-dialog` (full-screen image/code/mermaid) ·
`ToolPartErrorBoundary` · reveal/fade/shine animation primitives ·
`chat-timeline.css` token layer (status-success/warning/error/info,
tools-icon/title/description/border).

State: `stream-reducer` (blocks w/ stable ids: tool block id = toolCallId;
unchanged blocks keep references) · `block-state` (tool categories,
answer-marking, followup mode) · `tide-adapter` (Block→TimelinePart) ·
`render-compare` (memo comparators on part identity) · 50ms coalesced event
batching with urgent flushes.

Out-of-timeline surfaces that complete the anatomy: floating permission card
(risk badge, countdown, SplitButton allow/always/escalate, reject reason),
queued messages above composer (drag-reorderable), OptionsPopup follow-ups,
todo floating panel.

## 2. Mapping — what tide uses vs what waku will use

| tide | waku today | decision |
|---|---|---|
| tanstack virtualizer + auto-follow hook | GPUI `ListState` + anchor/following trio (transcript.rs) | **KEEP** waku — already end-anchored, tail-remeasured, 120ms stream cadence |
| stream-reducer blocks + render-compare | streaming.rs DriverEvent→AgentSession + row fingerprint + FlatText cache | **KEEP** waku reducer; adopt tide's *identity* idea (already present via fingerprint) |
| markdown worker + shiki | md/ engine (incremental parser, mend, veil, selection, geometry-underlay) | **KEEP** waku engine; add variant metrics (tool-dimmed, reasoning-dimmed) |
| chat-message user bubble + pencil edit-and-resend | render_message user branch (bubble, timestamp, copy, rewind; edit UI inline) | **ALIGN**: pencil + confirm (N replies/M tool runs removed) + resend; keep rewind affordance |
| message-body part loop | inline in render_message + render_activities_row | **REBUILD** as part loop (part enum dispatch) |
| ToolPart card | activity item cards in render_activities_row (~600-line monolith) | **REBUILD** as `ToolPartCard` w/ tide anatomy — the centerpiece |
| ProgressiveGroup/StaticToolRow | TurnBlock cluster + TurnFold | **ALIGN**: "+N more…" preview, left rail, per-family static rows, label parity |
| reasoning-part | reasoning card (scroll viewport, fade rails, windowing) | **KEEP** viewport; ADD collapsed summary + cycling label + bounded-when-done |
| QuestionCard inline | render_user_input above composer only | **ADD** inline pending card under assistant message |
| file-changes card | render_changed_files_row | **ALIGN**: created/edited counts, per-file Review/Undo, 5+expander |
| turn-error-block + Retry | toast + assistant error message | **ADD** collapsible inline error block |
| TurnWorkingFooter PixelLoader | WorkingIndicator wave dots | **ALIGN** visuals (keep dots if preferred — decide in phase) |
| floating permission card | render_permission (allow/deny) | **ALIGN**: risk badge, countdown, allow+remember/escalate split, reject reason |
| tool-output-dialog | image preview only | **ADD** full-screen dialog (code/diff/mermaid later) |
| generated-json-result-card | — | **ADD** JSON-payload finalize detection |
| PatchDiff inline preview | render_diff_code_row (activity style) | **KEEP** rows; ADD unified/split toggle; word-level intraline = later |
| panel-actions-context | ad-hoc Waku reach-ins | **EXTRACT** `TranscriptActions` struct passed to rows |
| CSS token layer | Theme | **ADD** status + tools tokens to Theme |
| turn-skeleton | empty state only | **ADD** session-switch skeleton |
| React.memo comparators | fingerprint + Rc caches | **KEEP** |

## 3. Design plan — parallel build, one-seam switchover

**Strategy: do NOT touch the existing components.** transcript_view.rs,
transcript.rs (row model), components.rs renderers, and their tests stay
exactly as they are. The adopted timeline is built fresh in a new module
tree, reads the SAME state (the AgentSession projection produced by
streaming.rs — unchanged), and mounts at ONE seam: `render_transcript`
chooses between the legacy pane and the new pane. The legacy path remains
the fallback until the new one proves out; cutover is a flag flip, and
deleting the legacy path is a separate, final, low-risk commit.

**Toggle**: `Waku.timeline_v2: bool`, seeded from `WAKU_TIMELINE_V2=1`
(debug builds default ON so dev runs the new pane; release defaults OFF
until parity is signed off). Both panes bring their own scroll/nav
affordances and share only session state and Theme.

**Module tree** (all new files; nothing moves out of the old ones):

```
src/app/timeline_v2/
  mod.rs            — pane root: render_timeline_v2(waku, cx); owns its
                      ListState, follow/anchor state, disclosures, viewports
                      (a fresh TranscriptV2 state struct — NOT shared with
                      the legacy pane)
  actions.rs        — TranscriptActions { view_file, view_diff, open_dispatch,
                      copy, rewind } — tide's panel-actions-context equivalent
  labels.rs         — data-driven tool label/icon/language tables (tide's
                      tool-helpers vocabulary, written fresh)
  tokens.rs         — status + tools theme tokens (success/warning/error/info,
                      tools-icon/title/description/border)
  list.rs           — virtualized list + auto-follow machine (GPUI ListState
                      owned here; legacy transcript.rs is the reference, not
                      a shared dependency)
  parts/
    tool_part.rs        — ToolPartCard (header + expanded families + error)
    static_tool_row.rs  — per-family static descriptions + grouped rows
    reasoning_part.rs   — tide anatomy (summary collapse, cycling label,
                          bounded-when-done) over the md/ engine
    text_part.rs        — assistant text + generated-JSON finalize
    question_card.rs    — inline follow-up card
  rows/
    turn_item.rs        — sticky user header + assistant blocks
    activity_group.rs   — ProgressiveGroup parity (cluster + fold)
    changed_files.rs    — file-changes card parity
    error_block.rs      — collapsible turn error + retry
    working_footer.rs   — working indicator
    skeleton.rs         — session-switch skeleton
```

**Rules**: the new tree takes `(&TranscriptV2, &TranscriptActions, &Theme,
cx)` — zero Waku reach-ins beyond the actions struct. It REUSES read-only:
streaming.rs's AgentSession projection, the md/ markdown pipeline, the
DriverEvent contract, the event-wake cadence. The legacy TranscriptRowKind
enum, fingerprint machinery, and its tests stay untouched guarding the
legacy path; the new pane grows its own row-identity strategy (part-level
fingerprint keyed like tide's block ids — tool card id == tool_call id) with
its own test module.

## 4. Implementation plan (parallel build; legacy stays green throughout)

**Phase 0 — Scaffolding + the seam.**
Create timeline_v2/ (mod, actions, tokens, labels skeleton); add the
`timeline_v2` flag (env-seeded, debug-ON); `render_transcript` gains the
one-line branch mounting `render_timeline_v2` when enabled. The new pane
first renders plain text rows — proving the seam, ListState ownership, and
follow behavior with zero legacy edits.

**Phase 1 — List + follow machine.**
list.rs: end-anchored virtualized list, tail remeasure on the existing
120ms stream cadence, stick-to-bottom release/re-pin, disclosure-preserving
scroll. Fresh tests mirroring the legacy scroll suite's coverage shape.

**Phase 2 — ToolPartCard (the centerpiece).**
parts/tool_part.rs + labels.rs with tide's header anatomy (icon column w/
spinner + icon⇄chevron, display name, description column w/ file-type icon
+ relative path, diff-stat badge, hover actions) and expanded bodies (input
section; diff entries + toggle; question options; agent report; todo
checklist; JSON summary/tree/raw; streaming bash; error card). Built fresh
against ActivityItem data.

**Phase 3 — Activity group + turn rows.**
activity_group.rs (ProgressiveGroup parity: "+N more…" preview, left rail,
static rows), turn_item.rs, changed_files.rs, working_footer.rs,
error_block.rs + retry.

**Phase 4 — Message anatomy.**
User bubble (pencil edit-and-resend + confirm + resend via the existing
edit path, timestamp/copy), assistant part loop, reasoning_part, text_part
with generated-JSON finalize, question_card inline, skeleton.

**Phase 5 — Floating surfaces.**
Permission card parity (risk badge, countdown timer, SplitButton
allow/always/escalate, reject reason), tool-output full-screen dialog (code
first), search/nav affordances owned by the new pane.

**Phase 6 — Cutover + removal.**
Flip the release default after parity sign-off; A/B against legacy via the
toggle; delete the legacy pane (transcript_view.rs, the transcript.rs row
model, their renderers) in one final isolated commit — the legacy tests
retire with the legacy code.

**Risks**: two panes compile in parallel — keep timeline_v2 free of legacy
imports so deletion is clean; only one mounts at a time, so double state is
benign. Follow/anchor behavior must be re-earned in list.rs (reference:
transcript.rs's anchor trio). No screenshot harness — manual A/B via the
toggle is the acceptance gate; the intact legacy pane is the rollback plan.
