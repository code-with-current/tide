//! Daemon-owned Git commit/push operations and one-shot agent generation
//! (commit messages, session titles). Every entry point performs process
//! I/O and must run on the background executor; render code consumes only
//! the returned snapshots.

use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use futures::StreamExt;

use engine::{
    EngineEvent, EngineModel, EngineModelConfig, HistoryMessage, HistoryPart, ThinkingLevel,
    TurnParams, TurnRequest, stream_step,
};
pub use protocol::git::{AgentInvocation, CommitSnapshot as Snapshot};

const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const AGENT_TIMEOUT: Duration = Duration::from_secs(180);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(40);
const MAX_DIFF_BYTES: usize = 96 * 1024;
const MAX_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 256 * 1024;
const MAX_ERROR_CHARS: usize = 4_000;

struct CapturedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

pub fn inspect(cwd: &Path) -> anyhow::Result<Snapshot> {
    ensure_repository(cwd)?;
    let branch = git_optional_stdout(cwd, &["branch", "--show-current"])?
        .filter(|branch| !branch.is_empty())
        .or_else(|| {
            git_optional_stdout(cwd, &["rev-parse", "--short", "HEAD"])
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| "HEAD".to_owned());
    let status = git_stdout(cwd, &["status", "--porcelain=v1", "--untracked-files=all"])?;
    let (has_staged, has_unstaged) = status_flags(&status);
    let (additions, deletions) = numstat(cwd, &["diff", "--numstat", "HEAD", "--"])
        .unwrap_or_else(|_| combined_numstat(cwd));
    let (staged_additions, staged_deletions) =
        numstat(cwd, &["diff", "--cached", "--numstat", "--"]).unwrap_or_default();
    let can_push = push_target(cwd, &branch)?
        .and_then(|target| {
            git_optional_stdout(cwd, &["rev-list", "--count", &format!("{target}..HEAD")])
                .ok()
                .flatten()
        })
        .and_then(|count| count.parse::<u64>().ok())
        .is_some_and(|count| count > 0)
        || (upstream(cwd)?.is_none() && remote_for_branch(cwd, &branch)?.is_some());
    Ok(Snapshot {
        branch,
        additions,
        deletions,
        staged_additions,
        staged_deletions,
        has_staged,
        has_unstaged,
        can_push,
    })
}

pub fn generate_message(
    cwd: &Path,
    include_unstaged: bool,
    invocation: &AgentInvocation,
) -> anyhow::Result<String> {
    generate_message_tide(cwd, include_unstaged, invocation.model.as_deref())
}

/// Generate a session title from the session's first user message with the
/// resolved background-model invocation. Same one-shot shape as the commit
/// message: a fixed classification over text already in the prompt.
pub fn generate_title(
    _cwd: &Path,
    first_user_message: &str,
    invocation: &AgentInvocation,
) -> anyhow::Result<String> {
    generate_title_tide(first_user_message, invocation.model.as_deref())
}

/// Tide has no CLI to spawn: the message comes from one plain model turn on
/// the vendored engine — no session, no tools, low thinking — the same shape
/// as upstream tide's hidden-session commit generator. The
/// `commitMessageModel` GeneralSettings override wins when its provider is
/// enabled and serves the model; otherwise the session's own selection
/// resolves exactly like a tide session turn.
pub fn generate_message_tide(
    cwd: &Path,
    include_unstaged: bool,
    session_model: Option<&str>,
) -> anyhow::Result<String> {
    let text = tide_one_shot(
        session_model,
        |effective| effective.commit_message_model.clone(),
        "commit message",
        commit_prompt(cwd, include_unstaged)?,
    )?;
    normalize_message(&text).ok_or_else(|| anyhow!("Tide returned no commit message"))
}

/// The title sibling of [`generate_message_tide`]: the `titleModel`
/// GeneralSettings override wins when live, else the session's model.
fn generate_title_tide(
    first_user_message: &str,
    session_model: Option<&str>,
) -> anyhow::Result<String> {
    let text = tide_one_shot(
        session_model,
        |effective| effective.title_model.clone(),
        "session title",
        title_prompt(first_user_message),
    )?;
    normalize_title(&text).ok_or_else(|| anyhow!("Tide returned no session title"))
}

/// The shared tide one-shot: load the config, resolve the model — the
/// task's GeneralSettings override when its provider is enabled and serves
/// the model, else the session's own selection exactly like a session turn —
/// and run one plain engine step (no tools, low thinking) under the
/// watchdog. `what` names the task for error messages.
fn tide_one_shot(
    session_model: Option<&str>,
    override_ref: impl FnOnce(
        &store::config::EffectiveGeneralSettings,
    ) -> Option<store::config::ModelRef>,
    what: &'static str,
    prompt: String,
) -> anyhow::Result<String> {
    let config = store::config::load(&store::paths::config_path())
        .map_err(|error| anyhow!("could not load the tide config: {error}"))?;
    let selection = resolve_one_shot_selection(
        &config,
        session_model,
        config
            .general_settings
            .as_ref()
            .and_then(|settings| override_ref(&settings.effective())),
    )?;
    let api_key = crate::driver::tide::tide_api_key(&config, &selection)?;
    let engine = EngineModel::from_config(&EngineModelConfig {
        api_style: selection.api_style,
        base_url: selection.base_url,
        api_key,
        model_id: selection.model_id,
    })
    .map_err(|error| anyhow!("tide engine: {error}"))?;
    let request = TurnRequest {
        messages: vec![HistoryMessage::user_text(prompt)],
        tools: Vec::new(),
        params: TurnParams {
            system: None,
            thinking_level: ThinkingLevel::Low,
            reasoning_contracts: Vec::new(),
            model_max_output_tokens: None,
        },
    };
    // This runs on a daemon request thread, so a dedicated single-thread
    // runtime is the bridge onto the engine's async_stream; the timeout
    // watchdog rides the same runtime via tokio::time.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .with_context(|| format!("could not start the tide {what} runtime"))?;
    runtime.block_on(async {
        tokio::time::timeout(
            AGENT_TIMEOUT,
            consume_one_shot(Box::pin(stream_step(engine, request))),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Tide could not generate a {what}: timed out after {} seconds",
                AGENT_TIMEOUT.as_secs()
            )
        })?
    })
}

/// Resolve a one-shot's tide model: the task's GeneralSettings override
/// when its provider is enabled and serves the model, else the session's
/// own selection exactly like a session turn.
fn resolve_one_shot_selection(
    config: &store::config::Config,
    session_model: Option<&str>,
    r#override: Option<store::config::ModelRef>,
) -> anyhow::Result<crate::driver::tide::TideModelSelection> {
    r#override
        .and_then(|r#override| crate::driver::tide::override_tide_model(config, &r#override))
        .map_or_else(
            || crate::driver::tide::resolve_tide_model(config, session_model),
            Ok,
        )
}

/// Drain one completion step, aggregating its assistant text. Deltas are the
/// primary source; the StepEnd message's text parts back the result up when
/// a provider streamed nothing.
async fn consume_one_shot(
    mut stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = Result<EngineEvent, engine::EngineError>>>,
    >,
) -> anyhow::Result<String> {
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        match event.map_err(|error| anyhow!("tide engine: {error}"))? {
            EngineEvent::Delta { text: delta } => text.push_str(&delta),
            EngineEvent::StepEnd { message, .. } => {
                if text.is_empty() {
                    for part in &message.parts {
                        if let HistoryPart::Text { text: part_text } = part {
                            text.push_str(part_text);
                        }
                    }
                }
                break;
            }
            _ => {}
        }
    }
    Ok(text)
}

pub fn commit(cwd: &Path, message: &str, include_unstaged: bool) -> anyhow::Result<()> {
    ensure_repository(cwd)?;
    let message = normalize_message(message).ok_or_else(|| anyhow!("enter a commit message"))?;
    if include_unstaged {
        git_success(cwd, &["add", "-A", "--", "."])?;
    }
    let staged = git_capture(cwd, &["diff", "--cached", "--quiet", "--"])?;
    match staged.status.code() {
        Some(1) => {}
        Some(0) => bail!("there are no staged changes to commit"),
        _ => bail!(
            "could not inspect staged changes: {}",
            command_error(&staged)
        ),
    }
    let (message, envs) = attributed_commit(cwd, &message)?;
    git_success_env(cwd, &["commit", "-m", &message], &envs)?;
    Ok(())
}

/// The identity a commit here would use, per git's own resolution order
/// (repo-local then global config).
fn resolved_identity(cwd: &Path) -> Option<(String, String)> {
    let name = git_optional_stdout(cwd, &["config", "user.name"])
        .ok()
        .flatten();
    let email = git_optional_stdout(cwd, &["config", "user.email"])
        .ok()
        .flatten();
    match (name, email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => Some((name, email)),
        _ => None,
    }
}

/// The commit message + author env overrides the attribution setting calls
/// for — the same contract as the agent git tool (Co-author: repo identity
/// authors, Tide trails; Author: Tide authors, the applied identity trails).
fn attributed_commit(
    cwd: &Path,
    message: &str,
) -> anyhow::Result<(String, Vec<(&'static str, String)>)> {
    let Some(attribution) = store::config::current_attribution() else {
        return Ok((message.to_owned(), Vec::new()));
    };
    let user = resolved_identity(cwd);
    let message = match &user {
        Some((name, email)) => {
            store::config::append_trailer_once(message, &attribution.trailer(name, email))
        }
        // Without a resolvable identity there is no one to attribute, and the
        // commit itself would fail on missing identity — let git say so.
        None => message.to_owned(),
    };
    let mut envs = Vec::new();
    if let Some((name, email)) = attribution.author_override() {
        envs.push(("GIT_AUTHOR_NAME", name.to_owned()));
        envs.push(("GIT_AUTHOR_EMAIL", email.to_owned()));
    }
    Ok((message, envs))
}

pub fn push(cwd: &Path) -> anyhow::Result<()> {
    ensure_repository(cwd)?;
    if upstream(cwd)?.is_some() {
        git_success(cwd, &["push"])?;
        return Ok(());
    }
    let branch = git_optional_stdout(cwd, &["branch", "--show-current"])?
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| anyhow!("cannot push a detached HEAD"))?;
    let remote = remote_for_branch(cwd, &branch)?
        .ok_or_else(|| anyhow!("no Git remote is configured for this branch"))?;
    git_success(cwd, &["push", "--set-upstream", &remote, &branch])?;
    Ok(())
}

fn commit_prompt(cwd: &Path, include_unstaged: bool) -> anyhow::Result<String> {
    ensure_repository(cwd)?;
    let staged_status = git_stdout(cwd, &["diff", "--cached", "--name-status", "--"])?;
    let staged = git_stdout(
        cwd,
        &["diff", "--cached", "--no-ext-diff", "--no-color", "--"],
    )?;
    let (status, unstaged) = if include_unstaged {
        (
            git_stdout(cwd, &["status", "--short", "--untracked-files=all"])?,
            git_stdout(cwd, &["diff", "--no-ext-diff", "--no-color", "--"])?,
        )
    } else {
        (staged_status, String::new())
    };
    if status.trim().is_empty() && staged.trim().is_empty() && unstaged.trim().is_empty() {
        bail!("there are no changes to describe");
    }
    let mut context = format!("Git status:\n{status}\n\nStaged diff:\n{staged}");
    if include_unstaged {
        context.push_str("\n\nUnstaged diff (will be included):\n");
        context.push_str(&unstaged);
    }
    let (context, truncated) = truncate_utf8(context, MAX_DIFF_BYTES);
    Ok(format!(
        "Generate a Git commit message for the changes below in Conventional Commits format.\n\
         Return exactly two parts and nothing else — no quotes, Markdown fences, or explanations around them:\n\
         1. The subject line: `type[scope]: summary` — the type is one of feat, fix, refactor, docs, test, chore, style, perf, build, ci, revert, chosen to match the dominant change; the scope is an optional parenthesized area (e.g. `feat(panel): …`) naming the module the change touches — include it when the diff is clearly localized to one area, omit it otherwise. For a breaking change, append `!` after the type/scope (e.g. `feat(api)!: …`). Summary in imperative mood, lowercase, no trailing period, whole line at most 72 characters.\n\
         2. The body: a bullet list of the individual changes — one line per change, each prefixed `- ` and wrapped at 72 characters. When the changes span distinct areas or files, group them under `Area:` header lines (e.g. `Installer (install.sh):`), with the bullets of each group indented under it. Omit groups that have only one change unless an area name adds clarity. For a breaking change, end the body with a `BREAKING CHANGE:` line explaining the migration. No prose paragraphs, no trailing summary line.\n\
         Do not call tools; all context is included here.{}\n\n{}",
        if truncated {
            " The diff was truncated, so describe only what is supported by the visible context."
        } else {
            ""
        },
        context
    ))
}

/// A title is a fixed classification over the first user message, so the
/// prompt carries only that — truncated, with the truncation marked.
fn title_prompt(first_user_message: &str) -> String {
    const MAX_PROMPT_CHARS: usize = 2_000;
    let trimmed = first_user_message.trim();
    let mut message: String = trimmed.chars().take(MAX_PROMPT_CHARS).collect();
    if message.chars().count() < trimmed.chars().count() {
        message.push('…');
    }
    format!(
        "Generate a short title for the task described by the user message below.\n\
         Return only the title as a single line of plain text: 2 to 5 words, no quotes, \
         no punctuation embellishment, no explanation.\n\nUser message:\n{message}"
    )
}

/// A usable commit message: an optional `type: summary` subject line plus an
/// optional explanation body. CLI chrome (ANSI, fences, tool/thinking lines)
/// is stripped; a `Commit message:`/`Commit subject:` label and wrapping
/// quotes are dropped from the subject; the subject keeps its trailing
/// punctuation except a bare period, and is capped at 100 characters; the
/// body keeps its lines and the whole message stays under 2000 characters.
/// `None` means nothing usable came back.
fn normalize_message(output: &str) -> Option<String> {
    let clean = strip_ansi(output);
    let mut lines = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && *line != "```")
        .filter(|line| !line.starts_with("[tool]") && !line.starts_with("[thinking]"));
    let subject = lines.next()?.trim().to_owned();
    let subject = subject
        .strip_prefix("Commit message:")
        .or_else(|| subject.strip_prefix("Commit subject:"))
        .unwrap_or(&subject)
        .trim()
        .trim_matches(['\"', '\'', '`'])
        .trim()
        .trim_end_matches('.')
        .trim();
    if subject.is_empty() {
        return None;
    }
    let subject: String = subject.chars().take(100).collect();
    let body: Vec<String> = lines
        .map(|line| line.trim_matches('`').trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect();
    let mut message = subject;
    if !body.is_empty() {
        message.push_str("\n\n");
        message.push_str(&body.join("\n"));
    }
    Some(message.chars().take(2000).collect())
}

/// One line of plain text: strip CLI chrome, drop a `Title:` prefix and
/// wrapping quotes, collapse whitespace, cap at the same 54 characters
/// `set_title_from_prompt` uses. `None` means nothing usable came back.
fn normalize_title(output: &str) -> Option<String> {
    let clean = strip_ansi(output);
    let candidate = clean
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "```")?
        .trim_matches('`')
        .trim();
    let candidate = candidate.strip_prefix("Title:").unwrap_or(candidate).trim();
    let candidate = candidate.trim_matches(['\"', '\'', '`']).trim();
    let title = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(54).collect())
}

fn strip_ansi(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            clean.push(character);
        }
    }
    clean
}

fn truncate_utf8(mut value: String, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value, false);
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value.push_str("\n\n[diff truncated]");
    (value, true)
}

fn ensure_repository(cwd: &Path) -> anyhow::Result<()> {
    git_success(cwd, &["rev-parse", "--git-dir"]).map(|_| ())
}

fn status_flags(status: &str) -> (bool, bool) {
    status
        .lines()
        .fold((false, false), |(staged, unstaged), line| {
            let bytes = line.as_bytes();
            if bytes.len() < 2 {
                return (staged, unstaged);
            }
            let x = bytes[0];
            let y = bytes[1];
            (
                staged || (x != b' ' && x != b'?'),
                unstaged || y != b' ' || x == b'?',
            )
        })
}

fn combined_numstat(cwd: &Path) -> (u64, u64) {
    let staged = numstat(cwd, &["diff", "--cached", "--numstat", "--"]).unwrap_or_default();
    let unstaged = numstat(cwd, &["diff", "--numstat", "--"]).unwrap_or_default();
    (staged.0 + unstaged.0, staged.1 + unstaged.1)
}

fn numstat(cwd: &Path, args: &[&str]) -> anyhow::Result<(u64, u64)> {
    let output = git_stdout(cwd, args)?;
    Ok(output.lines().fold((0, 0), |(additions, deletions), line| {
        let mut fields = line.splitn(3, '\t');
        let added = fields.next().and_then(|value| value.parse::<u64>().ok());
        let deleted = fields.next().and_then(|value| value.parse::<u64>().ok());
        match (added, deleted) {
            (Some(added), Some(deleted)) => (additions + added, deletions + deleted),
            _ => (additions, deletions),
        }
    }))
}

fn upstream(cwd: &Path) -> anyhow::Result<Option<String>> {
    git_optional_stdout(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
}

fn remote_for_branch(cwd: &Path, branch: &str) -> anyhow::Result<Option<String>> {
    let remotes = git_stdout(cwd, &["remote"])?;
    let mut remotes = remotes.lines().filter(|remote| !remote.is_empty());
    if remotes.clone().any(|remote| remote == "origin") {
        return Ok(Some("origin".to_owned()));
    }
    let _ = branch;
    Ok(remotes.next().map(str::to_owned))
}

fn push_target(cwd: &Path, branch: &str) -> anyhow::Result<Option<String>> {
    if let Some(upstream) = upstream(cwd)? {
        return Ok(Some(upstream));
    }
    let Some(remote) = remote_for_branch(cwd, branch)? else {
        return Ok(None);
    };
    let target = format!("{remote}/{branch}");
    let exists = git_capture(
        cwd,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{target}"),
        ],
    )?;
    Ok(exists.status.success().then_some(target))
}

fn git_stdout(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git_success(cwd, args)?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned())
}

fn git_optional_stdout(cwd: &Path, args: &[&str]) -> anyhow::Result<Option<String>> {
    let output = git_capture(cwd, args)?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        ));
    }
    if output.status.code() == Some(1) || output.status.code() == Some(128) {
        return Ok(None);
    }
    bail!("Git command failed: {}", command_error(&output))
}

fn git_success(cwd: &Path, args: &[&str]) -> anyhow::Result<CapturedOutput> {
    let output = git_capture(cwd, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        bail!("Git command failed: {}", command_error(&output))
    }
}

fn git_success_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&'static str, String)],
) -> anyhow::Result<CapturedOutput> {
    let output = git_capture_env(cwd, args, envs)?;
    if output.status.success() {
        Ok(output)
    } else {
        bail!("Git command failed: {}", command_error(&output))
    }
}

fn git_capture_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&'static str, String)],
) -> anyhow::Result<CapturedOutput> {
    let mut command = crate::command_env::command("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    for (key, value) in envs {
        command.env(key, value);
    }
    run_capture(&mut command, GIT_TIMEOUT)
}

fn git_capture(cwd: &Path, args: &[&str]) -> anyhow::Result<CapturedOutput> {
    let mut command = crate::command_env::command("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    run_capture(&mut command, GIT_TIMEOUT)
}

fn run_capture(command: &mut Command, timeout: Duration) -> anyhow::Result<CapturedOutput> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // Agent CLIs can start helpers. Give the invocation its own group so
        // a timeout does not leave those descendants running in the workspace.
        command.process_group(0);
    }
    let command = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::command_env::spawn(command).context("could not start process")?;
    let stdout = child.stdout.take().context("process stdout unavailable")?;
    let stderr = child.stderr.take().context("process stderr unavailable")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_STDOUT_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().context("could not wait for process")? {
            break status;
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            bail!("process timed out after {} seconds", timeout.as_secs());
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    };
    Ok(CapturedOutput {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

fn read_bounded(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut chunk) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    kept
}

fn command_error(output: &CapturedOutput) -> String {
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let stderr = stderr.trim();
    if stderr.is_empty() {
        format!("process exited with {}", output.status)
    } else {
        let mut displayed = stderr.chars().take(MAX_ERROR_CHARS).collect::<String>();
        if displayed.len() < stderr.len() {
            displayed.push_str("\n…output truncated");
        }
        displayed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = crate::command_env::plain_command("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository() -> PathBuf {
        let root = std::env::temp_dir().join(format!("tide-commit-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init", "-b", "main"]);
        run_git(&root, &["config", "user.name", "Tide Tests"]);
        run_git(&root, &["config", "user.email", "tide@example.com"]);
        fs::write(root.join("README.md"), "one\n").unwrap();
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "initial"]);
        root
    }

    #[test]
    fn inspect_and_commit_include_unstaged_changes() {
        let root = repository();
        fs::write(root.join("README.md"), "one\ntwo\n").unwrap();
        let snapshot = inspect(&root).unwrap();
        assert_eq!(snapshot.branch, "main");
        assert!(snapshot.has_unstaged);
        assert_eq!(snapshot.additions, 1);

        commit(&root, "Update readme", true).unwrap();
        assert!(!inspect(&root).unwrap().has_unstaged);
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--pretty=%s"]).unwrap(),
            "Update readme"
        );
    }

    #[test]
    fn staged_only_commit_leaves_later_worktree_edit() {
        let root = repository();
        fs::write(root.join("README.md"), "one\ntwo\n").unwrap();
        run_git(&root, &["add", "README.md"]);
        fs::write(root.join("README.md"), "one\ntwo\nthree\n").unwrap();

        commit(&root, "Stage one change", false).unwrap();
        let snapshot = inspect(&root).unwrap();
        assert!(!snapshot.has_staged);
        assert!(snapshot.has_unstaged);
    }

    #[test]
    fn staged_only_prompt_excludes_unstaged_edits() {
        let root = repository();
        fs::write(root.join("README.md"), "one\nstaged line\n").unwrap();
        run_git(&root, &["add", "README.md"]);
        fs::write(root.join("README.md"), "one\nstaged line\nunstaged line\n").unwrap();

        let staged_prompt = commit_prompt(&root, false).unwrap();
        assert!(staged_prompt.contains("staged line"));
        assert!(!staged_prompt.contains("unstaged line"));
        let all_prompt = commit_prompt(&root, true).unwrap();
        assert!(all_prompt.contains("unstaged line"));
    }

    /// TIDE_DATA_DIR is process-global, so attribution tests serialize on it.

    fn with_scratch_tide_dir(config_json: Option<&str>) -> PathBuf {
        let scratch = std::env::temp_dir().join(format!("tide-commit-tide-{}", Uuid::new_v4()));
        fs::create_dir_all(&scratch).unwrap();
        if let Some(json) = config_json {
            fs::write(scratch.join("config.json"), json).unwrap();
        }
        unsafe { std::env::set_var(store::paths::DATA_DIR_ENV, &scratch) };
        scratch
    }

    fn clear_tide_dir(scratch: &Path) {
        unsafe { std::env::remove_var(store::paths::DATA_DIR_ENV) };
        let _ = fs::remove_dir_all(scratch);
    }

    #[test]
    fn commit_applies_attribution_in_both_modes_and_off() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let root = repository();
        run_git(&root, &["config", "user.name", "Tester"]);
        run_git(&root, &["config", "user.email", "tester@example.com"]);
        let author_cfg = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;

        // Author mode: Tide authors, the applied identity trails.
        fs::write(root.join("a.txt"), "one\n").unwrap();
        run_git(&root, &["add", "a.txt"]);
        let scratch = with_scratch_tide_dir(Some(author_cfg));
        commit(&root, "author mode", false).unwrap();
        clear_tide_dir(&scratch);
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%an"]).unwrap(),
            "Tide"
        );
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%cn"]).unwrap(),
            "Tester"
        );
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%b"])
                .unwrap()
                .trim(),
            "Co-authored-by: Tester <tester@example.com>"
        );

        // Co-author mode: the repo identity authors, Tide trails.
        let co_cfg = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"co-author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;
        fs::write(root.join("b.txt"), "two\n").unwrap();
        run_git(&root, &["add", "b.txt"]);
        let scratch = with_scratch_tide_dir(Some(co_cfg));
        commit(&root, "co-author mode", false).unwrap();
        clear_tide_dir(&scratch);
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%an"]).unwrap(),
            "Tester"
        );
        assert!(
            git_stdout(&root, &["log", "-1", "--format=%b"])
                .unwrap()
                .contains("Co-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>")
        );

        // Off / config absent: the message is untouched.
        fs::write(root.join("c.txt"), "three\n").unwrap();
        run_git(&root, &["add", "c.txt"]);
        let scratch = with_scratch_tide_dir(None);
        commit(&root, "plain", false).unwrap();
        clear_tide_dir(&scratch);
        assert_eq!(
            git_stdout(&root, &["log", "-1", "--format=%B"])
                .unwrap()
                .trim(),
            "plain"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normalizes_plain_or_wrapped_agent_output() {
        assert_eq!(
            normalize_message("\u{1b}[32m`Fix task UI.`\u{1b}[0m\n").as_deref(),
            Some("Fix task UI")
        );
        assert_eq!(
            normalize_message("Commit message: Add commit dialog\n").as_deref(),
            Some("Add commit dialog")
        );
    }

    #[test]
    fn normalize_keeps_conventional_subject_and_body() {
        assert_eq!(
            normalize_message(
                "feat: add git panel\n\nAdds a per-session git client\nwith staging.\n"
            )
            .as_deref(),
            Some("feat: add git panel\n\nAdds a per-session git client\nwith staging.")
        );
        // Fenced reply: fences dropped, both parts survive.
        assert_eq!(
            normalize_message(
                "```\nfix: crash on open\n\nNull deref when the list\nwas empty.\n```"
            )
            .as_deref(),
            Some("fix: crash on open\n\nNull deref when the list\nwas empty.")
        );
        // Subject-only replies still work.
        assert_eq!(
            normalize_message("chore: bump deps").as_deref(),
            Some("chore: bump deps")
        );
    }

    #[test]
    fn normalizes_title_output_to_one_plain_line() {
        assert_eq!(
            normalize_title("\u{1b}[32m\"Fix the parser\"\u{1b}[0m\n").as_deref(),
            Some("Fix the parser")
        );
        // Extra lines are dropped, a `Title:` prefix and fences are stripped.
        assert_eq!(
            normalize_title("Title: `Add commit dialog`\nHere is why.\n").as_deref(),
            Some("Add commit dialog")
        );
        // Whitespace collapses, the cap matches set_title_from_prompt's 54.
        assert_eq!(
            normalize_title("Fix   the \t parser\nsecond line\n").as_deref(),
            Some("Fix the parser")
        );
        let long = "x".repeat(80);
        assert_eq!(normalize_title(&long).as_deref().map(charcount), Some(54));
        // Nothing usable → None, never an empty title.
        assert_eq!(normalize_title("```\n\"  \"\n\n"), None);
        assert_eq!(normalize_title(""), None);
    }

    fn charcount(value: &str) -> usize {
        value.chars().count()
    }

    #[test]
    fn title_prompt_carries_a_truncated_first_message() {
        let prompt = title_prompt("  Fix the flaky parser  ");
        assert!(prompt.contains("User message:\nFix the flaky parser"));
        assert!(prompt.contains("2 to 5 words"));

        let long = "word ".repeat(600);
        let prompt = title_prompt(&long);
        assert!(prompt.chars().count() < long.chars().count() + 500);
        assert!(prompt.ends_with('…'));
    }

    /// The title one-shot consults the `titleModel` override — not
    /// `commitMessageModel`: with both set, the title task resolves its own
    /// field, and with only the commit override set, the title task falls
    /// through to the session model.
    #[test]
    fn tide_title_override_resolves_from_the_title_field() {
        let mut config = tide_config();
        config.general_settings = Some(store::config::GeneralSettings {
            title_model: Some(store::config::ModelRef {
                provider_id: "p1".into(),
                model_id: "model-b".into(),
            }),
            commit_message_model: Some(store::config::ModelRef {
                provider_id: "p1".into(),
                model_id: "model-a".into(),
            }),
            ..Default::default()
        });
        let general = config.general_settings.as_ref().unwrap();
        let title_override = general.effective().title_model.clone();
        let commit_override = general.effective().commit_message_model.clone();

        let title_selection =
            resolve_one_shot_selection(&config, Some("p1/model-a"), title_override).unwrap();
        assert_eq!(title_selection.model_id, "model-b");
        let commit_selection =
            resolve_one_shot_selection(&config, Some("p1/model-b"), commit_override).unwrap();
        assert_eq!(commit_selection.model_id, "model-a");

        // No title override: the session's own model resolves, untouched by
        // the commit override.
        let session = resolve_one_shot_selection(&config, Some("p1/model-b"), None).unwrap();
        assert_eq!(session.model_id, "model-b");
    }

    fn tide_config() -> store::config::Config {
        serde_json::from_str(
            r#"{
                "providers": [
                    {
                        "id": "p1", "name": "One", "apiStyle": "anthropic", "baseUrl": "",
                        "models": [
                            {"id": "m-a", "alias": "", "modelId": "model-a", "contextWindow": 1000, "providerId": "p1"},
                            {"id": "m-b", "alias": "", "modelId": "model-b", "contextWindow": 2000, "providerId": "p1"}
                        ]
                    },
                    {
                        "id": "p2", "name": "Two", "apiStyle": "openai", "baseUrl": "https://p2.example",
                        "enabled": false,
                        "models": [
                            {"id": "m-c", "alias": "", "modelId": "model-c", "contextWindow": 3000, "providerId": "p2"}
                        ]
                    }
                ]
            }"#,
        )
        .unwrap()
    }

    /// Selection resolves exactly like a tide session turn: explicit
    /// provider/model, bare model id across enabled providers, and the
    /// first enabled provider's default when nothing was selected.
    #[test]
    fn tide_model_selection_matches_session_resolution() {
        let config = tide_config();
        let explicit =
            crate::driver::tide::resolve_tide_model(&config, Some("p1/model-b")).unwrap();
        assert_eq!(explicit.model_id, "model-b");
        assert_eq!(explicit.provider_id, "p1");
        assert_eq!(explicit.context_window, Some(2000));

        let bare = crate::driver::tide::resolve_tide_model(&config, Some("m-a")).unwrap();
        assert_eq!(
            (bare.provider_id.as_str(), bare.model_id.as_str()),
            ("p1", "model-a")
        );

        let default = crate::driver::tide::resolve_tide_model(&config, None).unwrap();
        assert_eq!(
            (default.provider_id.as_str(), default.model_id.as_str()),
            ("p1", "model-a")
        );

        // A disabled provider's model is unreachable, explicitly or bare.
        assert!(crate::driver::tide::resolve_tide_model(&config, Some("p2/model-c")).is_err());
        assert!(crate::driver::tide::resolve_tide_model(&config, Some("model-c")).is_err());
    }

    /// The commitMessageModel override wins only while its provider is
    /// enabled and serves the named model; anything stale falls through.
    #[test]
    fn tide_commit_model_override_gates_on_a_live_provider_model() {
        let mut config = tide_config();
        config.general_settings = Some(store::config::GeneralSettings {
            commit_message_model: Some(store::config::ModelRef {
                provider_id: "p2".into(),
                model_id: "model-c".into(),
            }),
            ..Default::default()
        });
        // p2 is disabled: the override is skipped, the session selection wins.
        let selection =
            crate::driver::tide::resolve_tide_model(&config, Some("p1/model-b")).unwrap();
        assert_eq!(selection.model_id, "model-b");

        let reference = store::config::ModelRef {
            provider_id: "p1".into(),
            model_id: "model-b".into(),
        };
        assert_eq!(
            crate::driver::tide::override_tide_model(&config, &reference)
                .unwrap()
                .model_id,
            "model-b"
        );
        // Not served by the (enabled) provider → no override.
        let stale = store::config::ModelRef {
            provider_id: "p1".into(),
            model_id: "model-x".into(),
        };
        assert!(crate::driver::tide::override_tide_model(&config, &stale).is_none());
        let disabled = store::config::ModelRef {
            provider_id: "p2".into(),
            model_id: "model-c".into(),
        };
        assert!(crate::driver::tide::override_tide_model(&config, &disabled).is_none());
    }

    /// The one-shot consumer aggregates streamed deltas and falls back to the
    /// StepEnd message's text when a provider streamed nothing. The engine's
    /// mock SSE transport is crate-private to engine, so the stream is
    /// synthesized here — this covers aggregation, not the wire.
    #[test]
    fn tide_one_shot_consumer_aggregates_deltas_and_step_end_text() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let step_end = |text: &str| {
            Ok(EngineEvent::StepEnd {
                stop_reason: engine::EngineStopReason::EndTurn,
                message: HistoryMessage {
                    role: engine::HistoryRole::Assistant,
                    parts: vec![HistoryPart::Text {
                        text: text.to_owned(),
                    }],
                },
            })
        };
        let streamed = futures::stream::iter(vec![
            Ok(EngineEvent::Delta {
                text: "Fix ".into(),
            }),
            Ok(EngineEvent::Reasoning {
                delta: "thinking".into(),
            }),
            Ok(EngineEvent::Delta {
                text: "the parser".into(),
            }),
            step_end("Fix the parser"),
        ]);
        assert_eq!(
            runtime
                .block_on(consume_one_shot(Box::pin(streamed)))
                .unwrap(),
            "Fix the parser"
        );

        let aggregated_only = futures::stream::iter(vec![step_end("Add commit dialog")]);
        assert_eq!(
            runtime
                .block_on(consume_one_shot(Box::pin(aggregated_only)))
                .unwrap(),
            "Add commit dialog"
        );
    }
}
