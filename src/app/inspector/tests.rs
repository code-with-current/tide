use super::sections::{
    HeroStatus, PerfStats, config_data, diffstat_add_fraction, format_duration_ms, format_elapsed,
    git_section_data, hero_data, hero_status, mode_badge, stream_log_entry, tokens_per_sec,
    working_time_secs,
};
use super::*;
use crate::model::{InteractionMode, ProviderKind, RuntimeMode};
use client::tide::TideProviderWire;
use protocol::git_panel::{PanelAheadBehind, PanelFileChange};

#[test]
fn visibility_requires_all_three() {
    assert!(inspector_visible(true, true, 1400.0));
    assert!(!inspector_visible(false, true, 1600.0)); // no session
    assert!(!inspector_visible(true, false, 1600.0)); // right panel open
    assert!(!inspector_visible(true, true, 1399.0)); // too narrow
}

#[test]
fn consumed_width_is_the_full_floating_footprint_or_nothing() {
    // Card plus its insets on both sides: the transcript narrows by the
    // whole footprint, never just the card.
    assert_eq!(
        inspector_consumed_width(true),
        INSPECTOR_WIDTH + 2.0 * INSPECTOR_GAP
    );
    assert_eq!(inspector_consumed_width(false), 0.0);
}

#[test]
fn section_collapse_defaults_and_toggle() {
    // Every section starts expanded, matching upstream's defaultOpen.
    let mut state = InspectorState::new();
    assert!(!state.is_collapsed(SectionId::Session));
    assert!(!state.is_collapsed(SectionId::Config));
    assert!(!state.is_collapsed(SectionId::Git));

    state.toggle(SectionId::Config);
    assert!(state.is_collapsed(SectionId::Config));
    state.toggle(SectionId::Config);
    assert!(!state.is_collapsed(SectionId::Config));

    assert!(InspectorState::default().collapsed.is_empty());
}

// ── Session hero ──────────────────────────────────────────────────────────

#[test]
fn hero_status_maps_session_status() {
    use crate::model::SessionStatus;

    assert_eq!(hero_status(SessionStatus::Connecting), HeroStatus::Running);
    assert_eq!(hero_status(SessionStatus::Working), HeroStatus::Running);
    // Waiting is upstream's "Blocked": an answer is what unblocks the turn.
    assert_eq!(hero_status(SessionStatus::Waiting), HeroStatus::Blocked);
    assert_eq!(hero_status(SessionStatus::Failed), HeroStatus::Error);
    assert_eq!(hero_status(SessionStatus::Idle), HeroStatus::Idle);
}

#[test]
fn hero_stats_format_upstream_durations() {
    assert_eq!(format_elapsed(0), "0s");
    assert_eq!(format_elapsed(45), "45s");
    assert_eq!(format_elapsed(90), "1m 30s");
    assert_eq!(format_elapsed(3720), "1h 02m");
}

#[test]
fn working_time_sums_turns_and_runs_the_active_one() {
    let now = 1_000;
    // One settled 100s turn, one settled 50s turn, one 20s in flight.
    assert_eq!(
        working_time_secs(&[(100, Some(200)), (800, Some(850)), (980, None)], now),
        170
    );
    // A clock skew that inverts a turn's endpoints clamps at zero instead
    // of subtracting below it.
    assert_eq!(working_time_secs(&[(3_000, Some(2_000))], now), 0);
}

#[test]
fn hero_data_derives_durations_saturating() {
    let data = hero_data(
        crate::model::SessionStatus::Working,
        "Ship it".to_owned(),
        "zai/glm-5.3".to_owned(),
        3,
        360,
        1_000,
        Some(1_150),
        1_360,
        None,
    );
    assert_eq!(data.status, HeroStatus::Running);
    assert_eq!(data.title, "Ship it");
    assert_eq!(data.model_id, "zai/glm-5.3");
    assert_eq!(data.started_secs_ago, 360);
    assert_eq!(data.last_active_secs_ago, Some(210));
    // No usage recorded yet — none of the performance lines show.
    assert_eq!(data.perf, PerfStats::default());
}

#[test]
fn perf_durations_format_compact() {
    assert_eq!(format_duration_ms(840), "840ms");
    assert_eq!(format_duration_ms(2_100), "2.1s");
    assert_eq!(format_duration_ms(47_000), "47s");
    assert_eq!(format_duration_ms(224_000), "3m44s");
    assert_eq!(format_duration_ms(3_720_000), "1h02m");
}

#[test]
fn token_rate_needs_a_second_of_model_time() {
    assert_eq!(tokens_per_sec(100, 900), None);
    assert_eq!(tokens_per_sec(29, 1_000), Some(29));
    assert_eq!(tokens_per_sec(600, 20_000), Some(30));
}

#[test]
fn perf_stats_derive_from_usage_totals() {
    use crate::model::{SessionUsageTotals, UsageBreakdown};

    let mut totals = SessionUsageTotals::default();
    totals.apply_step(&UsageBreakdown {
        input_tokens: 1_000,
        output_tokens: 250,
        cache_read: 11_000,
        cache_write: 250,
        reasoning_tokens: 80,
        calls: 1,
        cost_usd: None,
        llm_ms: Some(3_000),
        ttft_ms: Some(2_500),
        tool_ms: Some(1_500),
    });
    totals.apply_step(&UsageBreakdown {
        input_tokens: 500,
        output_tokens: 100,
        cache_read: 0,
        cache_write: 0,
        reasoning_tokens: 20,
        calls: 1,
        cost_usd: None,
        llm_ms: Some(1_000),
        ttft_ms: None, // a step with no streamed delta samples no TTFT
        tool_ms: Some(600),
    });

    let data = hero_data(
        crate::model::SessionStatus::Idle,
        "Done".to_owned(),
        "m".to_owned(),
        2,
        10,
        0,
        None,
        100,
        Some(&totals),
    );
    assert_eq!(data.perf.steps, 2);
    assert_eq!(data.perf.llm_ms, 4_000);
    assert_eq!(data.perf.tool_ms, 2_100);
    // The TTFT average divides samples, not steps.
    assert_eq!(data.perf.ttft_ms, Some(2_500));
    // 350 output tokens over 4s of model time.
    assert_eq!(data.perf.tokens_per_sec, Some(87));
}

// ── Configuration ─────────────────────────────────────────────────────────

fn provider_wire(id: &str, name: &str, base_url: &str) -> TideProviderWire {
    TideProviderWire {
        id: id.to_owned(),
        name: name.to_owned(),
        api_style: "openai".to_owned(),
        base_url: base_url.to_owned(),
        enabled: true,
        has_key: true,
        models: Vec::new(),
    }
}

#[test]
fn config_data_resolves_tide_sub_provider_by_model_prefix() {
    let providers = [provider_wire("zai", "Z.AI", "https://api.z.ai/api/paas/v4")];
    let data = config_data(
        ProviderKind::Tide,
        Some("zai/glm-5.3"),
        "GLM-5.3".to_owned(),
        RuntimeMode::FullAccess,
        InteractionMode::Build,
        &providers,
    );
    assert_eq!(data.provider_name, "Z.AI");
    let (logo, _) = data.brand.expect("resolved tide providers carry a brand");
    assert_ne!(logo, "provider-tide");

    // An unresolvable prefix keeps the generic tide mark rather than nothing.
    let unresolved = config_data(
        ProviderKind::Tide,
        Some("ghost/glm-5.3"),
        "GLM-5.3".to_owned(),
        RuntimeMode::FullAccess,
        InteractionMode::Build,
        &providers,
    );
    assert_eq!(unresolved.brand, Some(("provider-tide", "#ffffff")));
}

#[test]
fn mode_badge_follows_the_gate_per_driver() {
    // Tide: the Plan/Build chip, mirrored from the composer control.
    let build = mode_badge(
        ProviderKind::Tide,
        RuntimeMode::FullAccess,
        InteractionMode::Build,
    );
    assert!(!build.highlighted);
    assert_eq!(build.icon, "icons/wrench.svg");

    let plan = mode_badge(
        ProviderKind::Tide,
        RuntimeMode::FullAccess,
        InteractionMode::Plan,
    );
    assert!(plan.highlighted);
    assert_eq!(plan.icon, "icons/list.svg");
}

// ── Git ───────────────────────────────────────────────────────────────────

fn file_change(path: &str, staged: bool, additions: u64, deletions: u64) -> PanelFileChange {
    PanelFileChange {
        path: path.to_owned(),
        status: "modified".to_owned(),
        staged,
        additions,
        deletions,
    }
}

#[test]
fn git_section_aggregates_and_splits_staged() {
    let changes = [
        file_change("src/a.rs", false, 10, 2),
        file_change("src/b.rs", false, 4, 0),
        file_change("src/c.rs", true, 30, 5),
    ];
    let data = git_section_data(
        // Snapshot aggregates are superseded by the live status query.
        Some((Some("main".to_owned()), 999, 111)),
        None,
        Some("abc1234".to_owned()),
        Some(&changes),
        Some(PanelAheadBehind {
            ahead: 2,
            behind: 1,
        }),
        "/repo".to_owned(),
    )
    .expect("a named branch shows the section");
    assert_eq!(data.branch, "main");
    assert_eq!(data.head.as_deref(), Some("abc1234"));
    assert_eq!(data.changed, Some(2));
    assert_eq!(data.staged, Some(1));
    assert_eq!(data.files, Some(3));
    assert_eq!(data.additions, 44);
    assert_eq!(data.deletions, 7);
    assert_eq!(data.ahead, Some(2));
    assert_eq!(data.behind, Some(1));
    assert_eq!(data.repo_path, "/repo");

    // Cold status falls back to the snapshot's diffstat, counts unknown.
    let cold = git_section_data(
        Some((Some("main".to_owned()), 12, 3)),
        None,
        None,
        None,
        None,
        "/repo".to_owned(),
    )
    .unwrap();
    assert_eq!(cold.changed, None);
    assert_eq!(cold.files, None);
    assert_eq!(cold.additions, 12);
    assert_eq!(cold.deletions, 3);

    // No branch from any source hides the section entirely; the panel's
    // branch info alone is enough to show it.
    assert!(git_section_data(None, None, None, Some(&changes), None, "/r".into()).is_none());
    assert_eq!(
        git_section_data(None, Some("dev".to_owned()), None, None, None, "/r".into())
            .unwrap()
            .branch,
        "dev"
    );
}

#[test]
fn diffstat_fraction_shares_and_even_split() {
    assert_eq!(diffstat_add_fraction(30, 10), 0.75);
    assert_eq!(diffstat_add_fraction(0, 8), 0.0);
    assert_eq!(diffstat_add_fraction(8, 0), 1.0);
    // An empty tree reads as an even split, not all-red.
    assert_eq!(diffstat_add_fraction(0, 0), 0.5);
}

#[test]
fn stream_log_classifies_and_formats_time_at_capture() {
    let started = stream_log_entry(&DriverEvent::TurnStarted, 1_700_000_000_000).unwrap();
    assert_eq!(started.label.as_ref(), "turn started");
    assert!(!started.error);
    // The time label is precomputed at capture, HH:MM:SS-shaped — never
    // formatted per frame.
    assert_eq!(started.time.chars().filter(|c| *c == ':').count(), 2);

    let failed = stream_log_entry(
        &DriverEvent::TurnFinished {
            success: false,
            summary: None,
        },
        0,
    )
    .unwrap();
    assert_eq!(failed.label.as_ref(), "turn failed");
    assert!(failed.error);

    let delta = stream_log_entry(&DriverEvent::TextDelta("hello".into()), 0).unwrap();
    assert_eq!(delta.label.as_ref(), "text +5c");

    // An occupancy-less usage update and the subagent firehose stay out.
    assert!(
        stream_log_entry(
            &DriverEvent::UsageUpdated {
                context_tokens: None,
                context_window: None,
                breakdown: None,
            },
            0,
        )
        .is_none()
    );
}
