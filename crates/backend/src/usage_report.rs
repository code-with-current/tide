//! The Usage report fold: reads the per-turn ledger (`store::usage`) and
//! aggregates it into the wire [`UsageReport`] — per provider, per
//! provider×model, per day, per month, per workspace. One bounded read of
//! a small table (one row per turn, pruned to the reporting horizon) plus
//! an in-memory pass; safe to run synchronously inside a daemon request.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use chrono::{Local, NaiveDate, TimeZone as _};
use protocol::usage_report::{
    self, DaySlice, ModelSlice, MonthSlice, ProjectSlice, ProviderSlice, ProviderUsage,
    TokenTotals, UsageReport, UsageWindow,
};
use store::usage::{self, UsageDelta, UsageEvent};

#[derive(Default)]
struct Bucket {
    cost_usd: f64,
    total_tokens: u64,
}

impl Bucket {
    fn add(&mut self, cost_usd: f64, total_tokens: u64) {
        self.cost_usd += cost_usd;
        self.total_tokens += total_tokens;
    }
}

fn local_date(ms: i64) -> Option<NaiveDate> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|datetime| datetime.date_naive())
}

/// Local midnight of `day`, in unix ms — the window's inclusive floor.
fn day_start_ms(day: NaiveDate) -> i64 {
    day.and_hms_opt(0, 0, 0)
        .and_then(|midnight| Local.from_local_datetime(&midnight).single())
        .map(|datetime| datetime.timestamp_millis())
        .unwrap_or(i64::MIN)
}

/// Fold the ledger into the report for `window`, with `now_ms` as the
/// clock (a parameter so tests are deterministic).
pub fn build_report(data_dir: &Path, window: UsageWindow, now_ms: i64) -> UsageReport {
    let today = local_date(now_ms).unwrap_or_else(|| {
        NaiveDate::from_ymd_opt(1970, 1, 1).expect("1970-01-01 is a valid date")
    });
    let (since_day, until_day) = window.bounds(today);
    let since_ms = day_start_ms(since_day);
    let until_end_ms = day_start_ms(until_day.succ_opt().unwrap_or(until_day)) - 1;

    let all = usage::fetch_usage_events(data_dir, 0);
    let tracking_since = all.first().and_then(|event| local_date(event.time_ms));
    let events = all
        .iter()
        .filter(|event| event.time_ms >= since_ms && event.time_ms <= until_end_ms);

    let mut totals = TokenTotals::default();
    let mut cost_usd = 0.0_f64;
    let mut turns = 0u64;
    let mut sessions: HashSet<&str> = HashSet::new();
    let mut providers: BTreeMap<&str, Bucket> = BTreeMap::new();
    let mut models: HashMap<(&str, &str), Bucket> = HashMap::new();
    let mut days: BTreeMap<NaiveDate, (Bucket, BTreeMap<&str, Bucket>)> = BTreeMap::new();
    let mut months: BTreeMap<
        NaiveDate,
        (
            Bucket,
            BTreeMap<&str, Bucket>,
            HashSet<&str>,
            HashSet<NaiveDate>,
            HashMap<&str, f64>,
        ),
    > = BTreeMap::new();
    let mut projects: BTreeMap<
        &str,
        (
            Bucket,
            BTreeMap<&str, Bucket>,
            HashSet<&str>,
            Option<NaiveDate>,
            HashMap<&str, f64>,
        ),
    > = BTreeMap::new();

    for event in events {
        let event_tokens = (event.input_tokens
            + event.output_tokens
            + event.cache_read
            + event.cache_write)
            .max(0) as u64;
        turns += 1;
        if !event.session.is_empty() {
            sessions.insert(event.session.as_str());
        }
        totals.uncached_input += event.input_tokens.max(0) as u64;
        totals.cached_input += event.cache_read.max(0) as u64;
        totals.cache_creation += event.cache_write.max(0) as u64;
        totals.output += event.output_tokens.max(0) as u64;
        totals.reasoning += event.reasoning_tokens.max(0) as u64;
        cost_usd += event.cost_usd;

        let provider = event.provider_id.as_str();
        providers
            .entry(provider)
            .or_default()
            .add(event.cost_usd, event_tokens);
        models
            .entry((provider, event.model.as_str()))
            .or_default()
            .add(event.cost_usd, event_tokens);

        let Some(day) = local_date(event.time_ms) else {
            continue;
        };
        days.entry(day)
            .or_default()
            .0
            .add(event.cost_usd, event_tokens);
        days.entry(day)
            .or_default()
            .1
            .entry(provider)
            .or_default()
            .add(event.cost_usd, event_tokens);

        let month = usage_report::first_of_month(day);
        let month_entry = months.entry(month).or_default();
        month_entry.0.add(event.cost_usd, event_tokens);
        month_entry
            .1
            .entry(provider)
            .or_default()
            .add(event.cost_usd, event_tokens);
        if !event.session.is_empty() {
            month_entry.2.insert(event.session.as_str());
        }
        month_entry.3.insert(day);
        *month_entry.4.entry(event.model.as_str()).or_default() += event.cost_usd;

        if !event.workspace.is_empty() {
            let project_entry = projects.entry(event.workspace.as_str()).or_default();
            project_entry.0.add(event.cost_usd, event_tokens);
            project_entry
                .1
                .entry(provider)
                .or_default()
                .add(event.cost_usd, event_tokens);
            if !event.session.is_empty() {
                project_entry.2.insert(event.session.as_str());
            }
            project_entry.3 = Some(match project_entry.3 {
                Some(last) if last >= day => last,
                _ => day,
            });
            *project_entry.4.entry(event.model.as_str()).or_default() += event.cost_usd;
        }
    }

    let total_tokens = totals.total();
    let total_cost = cost_usd;
    let share = |value: f64, total: f64| if total > 0.0 { value / total } else { 0.0 };

    let mut provider_slices: Vec<ProviderSlice> = providers
        .iter()
        .map(|(provider_id, bucket)| ProviderSlice {
            provider_id: (*provider_id).to_owned(),
            cost_usd: bucket.cost_usd,
            total_tokens: bucket.total_tokens,
            cost_share: share(bucket.cost_usd, total_cost),
            token_share: share(bucket.total_tokens as f64, total_tokens as f64),
        })
        .collect();
    provider_slices.sort_by(|a, b| {
        b.cost_usd
            .total_cmp(&a.cost_usd)
            .then_with(|| a.provider_id.cmp(&b.provider_id))
    });

    let by_provider_slices = |map: &BTreeMap<&str, Bucket>| -> Vec<ProviderUsage> {
        let mut slices: Vec<ProviderUsage> = map
            .iter()
            .map(|(provider_id, bucket)| ProviderUsage {
                provider_id: (*provider_id).to_owned(),
                cost_usd: bucket.cost_usd,
                total_tokens: bucket.total_tokens,
            })
            .collect();
        slices.sort_by(|a, b| {
            b.cost_usd
                .total_cmp(&a.cost_usd)
                .then_with(|| a.provider_id.cmp(&b.provider_id))
        });
        slices
    };

    let mut model_slices: Vec<ModelSlice> = models
        .iter()
        .map(|((provider_id, model), bucket)| ModelSlice {
            provider_id: (*provider_id).to_owned(),
            model: (*model).to_owned(),
            cost_usd: bucket.cost_usd,
            total_tokens: bucket.total_tokens,
            cost_share: share(bucket.cost_usd, total_cost),
        })
        .collect();
    model_slices.sort_by(|a, b| {
        b.cost_usd
            .total_cmp(&a.cost_usd)
            .then_with(|| a.provider_id.cmp(&b.provider_id))
            .then_with(|| a.model.cmp(&b.model))
    });

    let daily = days
        .into_iter()
        .map(|(day, (bucket, by_provider))| DaySlice {
            day,
            cost_usd: bucket.cost_usd,
            total_tokens: bucket.total_tokens,
            by_provider: by_provider_slices(&by_provider),
        })
        .collect();

    let months = months
        .into_iter()
        .map(
            |(first_day, (bucket, by_provider, month_sessions, active, top))| MonthSlice {
                first_day,
                cost_usd: bucket.cost_usd,
                total_tokens: bucket.total_tokens,
                by_provider: by_provider_slices(&by_provider),
                sessions: month_sessions.len() as u64,
                active_days: active.len() as u32,
                top_models: sorted_model_costs(top),
            },
        )
        .collect();

    let projects = projects
        .into_iter()
        .map(
            |(workspace, (bucket, by_provider, project_sessions, last_day, top))| ProjectSlice {
                workspace: workspace.to_owned(),
                cost_usd: bucket.cost_usd,
                total_tokens: bucket.total_tokens,
                by_provider: by_provider_slices(&by_provider),
                sessions: project_sessions.len() as u64,
                cost_share: share(bucket.cost_usd, total_cost),
                last_day,
                top_models: sorted_model_costs(top),
            },
        )
        .collect();

    UsageReport {
        window,
        since_day,
        until_day,
        totals,
        total_tokens,
        cost_usd,
        turns,
        sessions: sessions.len() as u64,
        providers: provider_slices,
        models: model_slices,
        daily,
        months,
        projects,
        tracking_since,
    }
}

/// Model costs largest-first, cost then name for stability — the month and
/// project rows' "top models" caption vocabulary.
fn sorted_model_costs(models: HashMap<&str, f64>) -> Vec<(String, f64)> {
    let mut models: Vec<(String, f64)> = models
        .into_iter()
        .map(|(model, cost_usd)| (model.to_owned(), cost_usd))
        .collect();
    models.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tide-usage-report-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(
        dir: &Path,
        provider: &str,
        model: &str,
        workspace: &str,
        session: &str,
        day: NaiveDate,
        hour: u32,
        input: i64,
        output: i64,
        cost: f64,
    ) {
        // A fixed local wall-clock time, converted the same way the fold
        // does, so the test holds in any timezone.
        let ms = day
            .and_hms_opt(hour, 0, 0)
            .and_then(|time| Local.from_local_datetime(&time).single())
            .map(|datetime| datetime.timestamp_millis())
            .unwrap();
        usage::record_provider_usage(
            dir,
            provider,
            model,
            workspace,
            session,
            &UsageDelta {
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
                ..UsageDelta::default()
            },
            ms,
        )
        .unwrap();
    }

    fn today_local(now_ms: i64) -> NaiveDate {
        local_date(now_ms).unwrap()
    }

    fn noon_ms(day: NaiveDate) -> i64 {
        day.and_hms_opt(12, 0, 0)
            .and_then(|time| Local.from_local_datetime(&time).single())
            .map(|datetime| datetime.timestamp_millis())
            .unwrap()
    }

    #[test]
    fn empty_ledger_reports_zeroed_window() {
        let dir = temp_dir("empty");
        let now = noon_ms(NaiveDate::from_ymd_opt(2026, 9, 9).unwrap());
        let report = build_report(&dir, UsageWindow::TrailingDays(30), now);
        assert_eq!(report.turns, 0);
        assert_eq!(report.providers.len(), 0);
        assert_eq!(report.models.len(), 0);
        assert_eq!(report.tracking_since, None);
        assert_eq!(report.since_day, today_local(now) - chrono::Days::new(29));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn groups_by_provider_and_model_with_shares() {
        let dir = temp_dir("groups");
        let day = NaiveDate::from_ymd_opt(2026, 9, 8).unwrap();
        record(&dir, "p_a", "m-big", "/w", "s1", day, 1, 1_000, 0, 2.0);
        record(&dir, "p_a", "m-big", "/w", "s1", day, 2, 1_000, 0, 1.0);
        record(&dir, "p_a", "m-small", "/w", "s1", day, 3, 100, 0, 0.1);
        record(&dir, "p_b", "m-big", "/w", "s2", day, 4, 500, 0, 0.5);

        let now = noon_ms(NaiveDate::from_ymd_opt(2026, 9, 9).unwrap());
        let report = build_report(&dir, UsageWindow::TrailingDays(7), now);

        assert_eq!(report.turns, 4);
        assert_eq!(report.sessions, 2);
        assert_eq!(report.total_tokens, 2_600);
        assert!((report.cost_usd - 3.6).abs() < 1e-9);

        // Providers sorted by cost: p_a (3.1) before p_b (0.5).
        assert_eq!(report.providers[0].provider_id, "p_a");
        assert!((report.providers[0].cost_share - 3.1 / 3.6).abs() < 1e-9);
        assert_eq!(report.providers[1].provider_id, "p_b");

        // Models: same model id under different providers stays separate.
        assert_eq!(report.models.len(), 3);
        assert_eq!(report.models[0].model, "m-big");
        assert_eq!(report.models[0].provider_id, "p_a");
        assert!((report.models[0].cost_usd - 3.0).abs() < 1e-9);
        assert_eq!(report.models[1].provider_id, "p_b");
        assert_eq!(report.models[2].model, "m-small");
        assert!((report.models[2].cost_share - 0.1 / 3.6).abs() < 1e-9);

        // One active day, layered per provider.
        assert_eq!(report.daily.len(), 1);
        assert_eq!(report.daily[0].by_provider.len(), 2);
        assert_eq!(report.daily[0].by_provider[0].provider_id, "p_a");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn months_projects_and_window_floor() {
        let dir = temp_dir("months");
        let aug = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let sep = NaiveDate::from_ymd_opt(2026, 9, 5).unwrap();
        record(&dir, "p_a", "m-1", "/alpha", "s1", aug, 1, 100, 0, 1.0);
        record(&dir, "p_a", "m-2", "/alpha", "s1", aug, 2, 100, 0, 1.0);
        record(&dir, "p_a", "m-1", "/beta", "s2", sep, 3, 100, 0, 1.0);

        let now = noon_ms(NaiveDate::from_ymd_opt(2026, 9, 9).unwrap());
        let report = build_report(&dir, UsageWindow::Months(12), now);

        assert_eq!(report.months.len(), 2);
        let august = report
            .month(NaiveDate::from_ymd_opt(2026, 8, 1).unwrap())
            .unwrap();
        assert_eq!(august.sessions, 1);
        assert_eq!(august.active_days, 1);
        assert_eq!(august.top_models.len(), 2);
        assert_eq!(august.top_models[0].0, "m-1");

        // Projects rank by cost; each keeps its sessions and last day.
        assert_eq!(report.projects.len(), 2);
        assert_eq!(report.projects[0].workspace, "/alpha");
        assert_eq!(report.projects[0].sessions, 1);
        assert_eq!(report.projects[0].last_day, Some(aug));
        assert!((report.projects[0].cost_share - 2.0 / 3.0).abs() < 1e-9);

        // A 7-day trailing window floors August out but keeps September.
        let week = build_report(&dir, UsageWindow::TrailingDays(7), now);
        assert_eq!(week.turns, 1);
        assert_eq!(week.months.len(), 1);
        // The full-history tracking date survives the floor.
        assert_eq!(week.tracking_since, Some(aug));
        fs::remove_dir_all(&dir).unwrap();
    }
}
