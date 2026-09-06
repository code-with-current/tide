//! git_repo — port of `app/core/agent/tools/git-repo.ts` ():
//! read-only access to any git repository — remote URL or local path —
//! without cloning into the workspace.
//!
//! Dual backend, exactly like the TS:
//! - REST fast path for `github.com` / `gitlab.com` remotes (repo API +
//!   raw CDN) with a session-pinned ref→sha cache; any REST failure falls
//!   back to the clone backend and annotates `meta` with the reason.
//! - Everything else (other hosts, local paths) runs against a cached
//!   bare clone under `<tmp>/tide-git-repo-cache/<sha1(url)[..16]>`,
//!   LRU-evicted beyond 10 entries. The TS shelled out to `git clone
//!   --bare --filter=blob:none` + plumbing; here it is git2: fetch into a
//!   bare repo (no blob filter — libgit2 has no partial clone; a full
//!   fetch is heavier but semantically identical) and tree/blob/revwalk
//!   reads in-process. Blame materializes the exact blob into a scratch
//!   repo that shares objects with the source via an alternates file,
//!   because libgit2 blame reads a working-directory file.
//!
//! Safety semantics ported EXACTLY:
//! - local repos must resolve inside the workspace root (same boundary as
//!   read_file — otherwise `ref:file` reads any tracked file on disk,
//!   auto-approved in every mode);
//! - refs are charset-validated (`SAFE_REF`) so they can never smuggle a
//!   `--flag` into a git invocation, paths are normalized and `..`-free.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use git2::{BlameOptions, FetchPrune, ObjectType, Repository, RepositoryInitOptions};
use regex::Regex;
use serde_json::{json, Value};

use crate::http::{self, HttpError};
use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_bool;
use super::arg_str;
use super::arg_u64;
use super::git::{
    clip_output, commits_touching_paths, diff_patch, log_line, short_oid, show_commit_patch,
};

const MAX_OUTPUT: usize = 512 * 1024;
const REST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CACHE_ENTRIES: usize = 10;
const TOUCH_FILE: &str = ".tide-cache-touch";

const OPS: &[&str] = &[
    "info", "branches", "files", "read", "log", "show", "blame", "search",
];

const DESCRIPTION: &str = "Read a git repository \u{2014} remote URL (https://, git@, ssh://) or local path \u{2014} without cloning into the workspace. Read-only. One op per call:\n- info: default branch, HEAD commit\n- branches: local/remote branches and tags\n- files: recursive file listing at a ref (optionally scoped to a path prefix)\n- read: single file contents at a ref\n- log: commit history (optionally path-scoped)\n- show: a commit's patch, or diff a base..head range\n- blame: per-line authorship of a file\n- search: literal or regex content search across the repo at a ref\nPrefer this over cloning via bash.";

struct RepoArgs {
    op: String,
    repo: String,
    ref_: String,
    commit: Option<String>,
    file: Option<String>,
    limit: Option<u64>,
    query: Option<String>,
    regex: bool,
}

impl RepoArgs {
    fn from_json(args: &Value) -> Self {
        Self {
            op: arg_str(args, "op"),
            repo: arg_str(args, "repo"),
            ref_: args
                .get("ref")
                .and_then(|v| v.as_str())
                .unwrap_or("HEAD")
                .to_string(),
            commit: args
                .get("commit")
                .and_then(|v| v.as_str())
                .map(String::from),
            file: args.get("file").and_then(|v| v.as_str()).map(String::from),
            limit: arg_u64(args, "limit"),
            query: args.get("query").and_then(|v| v.as_str()).map(String::from),
            regex: arg_bool(args, "regex"),
        }
    }
}

// ─── validation (ported verbatim) ──────────────────────────────────────

/// Refs reach git plumbing; the charset check blocks flag smuggling.
fn validate_ref(ref_: &str) -> Option<String> {
    static SAFE_REF: OnceLock<Regex> = OnceLock::new();
    let re = SAFE_REF.get_or_init(|| Regex::new(r"^[A-Za-z0-9._/@-]{1,128}$").unwrap());
    if ref_.is_empty()
        || ref_.starts_with('-')
        || ref_.contains("..")
        || ref_.contains(' ')
        || !re.is_match(ref_)
    {
        return None;
    }
    Some(ref_.to_string())
}

/// Normalize a repo-relative path arg: no leading `-`, no NUL, no `..`
/// component, leading slashes stripped. `None` input → `Some("")`.
fn validate_path_arg(p: Option<&str>) -> Option<String> {
    let Some(p) = p else {
        return Some(String::new());
    };
    if p.is_empty() || p.starts_with('-') || p.contains('\0') {
        return None;
    }
    let posix: String = p.replace('\\', "/");
    let norm = lexical_posix_normalize(&posix);
    if norm.split('/').any(|seg| seg == "..") {
        return None;
    }
    Some(norm.trim_start_matches('/').to_string())
}

fn lexical_posix_normalize(p: &str) -> String {
    let posix = p.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for seg in posix.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                // Like posix.normalize: a leading '..' survives so the
                // caller's containment check rejects the path.
                if out.pop().is_none() {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

// ─── remote parsing ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct RemoteTarget {
    host: String,
    owner: String,
    repo: String,
    url: String,
}

fn parse_remote(repo: &str) -> Option<RemoteTarget> {
    static HTTPS: OnceLock<Regex> = OnceLock::new();
    static SSH: OnceLock<Regex> = OnceLock::new();
    static SSH_URL: OnceLock<Regex> = OnceLock::new();
    let https = HTTPS
        .get_or_init(|| Regex::new(r"^https://([^/]+)/([^/]+)/([^/]+?)(?:\.git)?/?$").unwrap());
    let ssh = SSH.get_or_init(|| Regex::new(r"^git@([^:]+):([^/]+)/([^/]+?)(?:\.git)?$").unwrap());
    let ssh_url = SSH_URL
        .get_or_init(|| Regex::new(r"^ssh://git@([^/]+)/([^/]+)/([^/]+?)(?:\.git)?$").unwrap());
    let m = https
        .captures(repo)
        .or_else(|| ssh.captures(repo))
        .or_else(|| ssh_url.captures(repo))?;
    Some(RemoteTarget {
        host: m[1].to_lowercase(),
        owner: m[2].to_string(),
        repo: m[3].to_string(),
        url: repo.to_string(),
    })
}

fn is_remote_repo(repo: &str) -> bool {
    repo.starts_with("https://") || repo.starts_with("git@") || repo.starts_with("ssh://git@")
}

/// JS `encodeURIComponent`: unreserved set stays literal, the rest is
/// percent-encoded as UTF-8.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ─── REST fast path (github.com / gitlab.com) ─────────────────────────

/// Endpoint roots; overridable so the mock-server tests can point the
/// REST layer at a local TCP listener instead of the live APIs.
pub(crate) struct RestBases {
    pub github_api: String,
    pub github_raw: String,
    pub gitlab_api: String,
    pub gitlab_raw: String,
}

impl RestBases {
    fn live() -> Self {
        Self {
            github_api: "https://api.github.com".into(),
            github_raw: "https://raw.githubusercontent.com".into(),
            gitlab_api: "https://gitlab.com/api/v4".into(),
            gitlab_raw: "https://gitlab.com".into(),
        }
    }
}

#[derive(Debug)]
struct RestError(String);

impl RestError {
    fn reason(&self) -> String {
        self.0.clone()
    }
}

fn map_http_err(e: HttpError) -> RestError {
    RestError(e.to_string())
}

fn api_get(url: &str, bases_rest_headers: &[(&str, &str)]) -> Result<Value, RestError> {
    let mut headers: Vec<(&str, &str)> = vec![
        ("User-Agent", "Tide/1.0 (coding agent)"),
        ("Accept", "application/vnd.github+json"),
    ];
    headers.extend_from_slice(bases_rest_headers);
    let resp = http::get(url, &headers, REST_TIMEOUT).map_err(map_http_err)?;
    if !resp.is_ok() {
        return Err(RestError(format!("HTTP {}", resp.status)));
    }
    serde_json::from_str(&resp.body).map_err(|e| RestError(format!("bad JSON: {e}")))
}

fn raw_get(url: &str) -> Result<String, RestError> {
    let resp = http::get(
        url,
        &[("User-Agent", "Tide/1.0 (coding agent)")],
        REST_TIMEOUT,
    )
    .map_err(map_http_err)?;
    if !resp.is_ok() {
        return Err(RestError(format!("HTTP {}", resp.status)));
    }
    Ok(resp.body)
}

/// Session-scoped ref→sha pins (`${url}#${ref}` → commit sha).
fn pinned_refs() -> &'static Mutex<HashMap<String, String>> {
    static PINNED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    PINNED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rest_resolve_sha(t: &RemoteTarget, ref_: &str, bases: &RestBases) -> Result<String, RestError> {
    let key = format!("{}#{}", t.url, ref_);
    if let Some(pinned) = pinned_refs().lock().unwrap().get(&key) {
        return Ok(pinned.clone());
    }
    if ref_.len() == 40 && ref_.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(ref_.to_string());
    }
    let sha = if t.host == "github.com" {
        let j = api_get(
            &format!(
                "{}/repos/{}/{}/commits/{}",
                bases.github_api,
                t.owner,
                t.repo,
                encode_uri_component(ref_)
            ),
            &[],
        )?;
        j.get("sha").and_then(|v| v.as_str()).map(String::from)
    } else {
        let proj = encode_uri_component(&format!("{}/{}", t.owner, t.repo));
        let j = api_get(
            &format!(
                "{}/projects/{}/repository/commits/{}",
                bases.gitlab_api,
                proj,
                encode_uri_component(ref_)
            ),
            &[],
        )?;
        j.get("id").and_then(|v| v.as_str()).map(String::from)
    };
    let Some(sha) = sha else {
        return Err(RestError(format!("could not resolve ref '{}'", ref_)));
    };
    pinned_refs().lock().unwrap().insert(key, sha.clone());
    Ok(sha)
}

fn rest_op(
    op: &str,
    t: &RemoteTarget,
    a: &RepoArgs,
    bases: &RestBases,
) -> Result<ToolOutcome, RestError> {
    let ref_ = a.ref_.clone();
    let gh = format!("{}/repos/{}/{}", bases.github_api, t.owner, t.repo);
    let proj = encode_uri_component(&format!("{}/{}", t.owner, t.repo));
    let gl = format!("{}/projects/{}/repository", bases.gitlab_api, proj);
    let github = t.host == "github.com";

    match op {
        "info" => {
            let j = if github {
                api_get(
                    &format!("{}/repos/{}/{}", bases.github_api, t.owner, t.repo),
                    &[],
                )?
            } else {
                api_get(&format!("{}/projects/{}", bases.gitlab_api, proj), &[])?
            };
            let lines = if github {
                vec![
                    format!("repo: {}", j["full_name"].as_str().unwrap_or("")),
                    format!(
                        "default_branch: {}",
                        j["default_branch"].as_str().unwrap_or("")
                    ),
                    format!("description: {}", j["description"].as_str().unwrap_or("")),
                    format!(
                        "stars: {} · forks: {}",
                        j["stargazers_count"].as_u64().unwrap_or(0),
                        j["forks_count"].as_u64().unwrap_or(0)
                    ),
                    format!("pushed_at: {}", j["pushed_at"].as_str().unwrap_or("")),
                ]
            } else {
                vec![
                    format!("repo: {}", j["path_with_namespace"].as_str().unwrap_or("")),
                    format!(
                        "default_branch: {}",
                        j["default_branch"].as_str().unwrap_or("")
                    ),
                    format!("description: {}", j["description"].as_str().unwrap_or("")),
                    format!(
                        "stars: {} · forks: {}",
                        j["star_count"].as_u64().unwrap_or(0),
                        j["forks_count"].as_u64().unwrap_or(0)
                    ),
                    format!(
                        "last_activity_at: {}",
                        j["last_activity_at"].as_str().unwrap_or("")
                    ),
                ]
            };
            Ok(ToolOutcome::executed(lines.join("\n")).with_meta(format!("rest · {}", t.host)))
        }
        "branches" => {
            if github {
                let j = api_get(&format!("{gh}/branches?per_page=100"), &[])?;
                let list = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|b| {
                                let name = b["name"].as_str().unwrap_or("");
                                if b["protected"].as_bool().unwrap_or(false) {
                                    format!("{name} (protected)")
                                } else {
                                    name.to_string()
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                Ok(
                    ToolOutcome::executed(clip_output(&list, MAX_OUTPUT, "branch list"))
                        .with_meta("rest · github"),
                )
            } else {
                let j = api_get(&format!("{gl}/branches?per_page=100"), &[])?;
                let list = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|b| b["name"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                Ok(
                    ToolOutcome::executed(clip_output(&list, MAX_OUTPUT, "branch list"))
                        .with_meta("rest · gitlab"),
                )
            }
        }
        "files" => {
            let sha = rest_resolve_sha(t, &ref_, bases)?;
            if github {
                let j = api_get(&format!("{gh}/git/trees/{sha}?recursive=1"), &[])?;
                let filter = a
                    .file
                    .as_deref()
                    .map(|f| format!("{}/", f.trim_end_matches('/')))
                    .unwrap_or_default();
                let names: Vec<&str> = j["tree"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter(|e| e["type"].as_str() == Some("blob"))
                            .filter(|e| {
                                filter.is_empty()
                                    || e["path"].as_str().is_some_and(|p| p.starts_with(&filter))
                            })
                            .filter_map(|e| e["path"].as_str())
                            .collect()
                    })
                    .unwrap_or_default();
                let trunc = if j["truncated"].as_bool().unwrap_or(false) {
                    "\n[listing truncated by the API — large repo; scope with a file prefix]"
                } else {
                    ""
                };
                let out = if names.is_empty() {
                    "(no files)".to_string()
                } else {
                    format!("{}{trunc}", names.join("\n"))
                };
                Ok(
                    ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "file list"))
                        .with_meta(format!("rest · {} files", names.len())),
                )
            } else {
                let j = api_get(
                    &format!(
                        "{gl}/tree?ref={}&recursive=true&per_page=100",
                        encode_uri_component(&sha)
                    ),
                    &[],
                )?;
                let filter = a
                    .file
                    .as_deref()
                    .map(|f| format!("{}/", f.trim_end_matches('/')))
                    .unwrap_or_default();
                let names: Vec<&str> = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter(|e| e["type"].as_str() == Some("blob"))
                            .filter(|e| {
                                filter.is_empty()
                                    || e["path"].as_str().is_some_and(|p| p.starts_with(&filter))
                            })
                            .filter_map(|e| e["path"].as_str())
                            .collect()
                    })
                    .unwrap_or_default();
                let trunc = if names.len() >= 100 {
                    "\n[listing capped at the first 100 entries — scope with a file prefix]"
                } else {
                    ""
                };
                let out = if names.is_empty() {
                    "(no files)".to_string()
                } else {
                    format!("{}{trunc}", names.join("\n"))
                };
                Ok(
                    ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "file list"))
                        .with_meta(format!("rest · {} files", names.len())),
                )
            }
        }
        "read" => {
            let Some(clean) = validate_path_arg(a.file.as_deref()).filter(|p| !p.is_empty()) else {
                return Err(RestError("read requires a file path".into()));
            };
            let enc_path = clean
                .split('/')
                .map(encode_uri_component)
                .collect::<Vec<_>>()
                .join("/");
            let text = if github {
                raw_get(&format!(
                    "{}/{}/{}/{}/{}",
                    bases.github_raw,
                    t.owner,
                    t.repo,
                    encode_uri_component(&ref_),
                    enc_path
                ))?
            } else {
                raw_get(&format!(
                    "{}/{}/{}/raw/{}/{}",
                    bases.gitlab_raw,
                    t.owner,
                    t.repo,
                    encode_uri_component(&ref_),
                    enc_path
                ))?
            };
            Ok(
                ToolOutcome::executed(clip_output(&text, MAX_OUTPUT, "file contents"))
                    .with_meta(format!("rest · {} chars", text.chars().count())),
            )
        }
        "log" => {
            let n = a.limit.unwrap_or(30).min(100);
            if github {
                let mut u = format!("{gh}/commits?per_page={n}");
                if ref_ != "HEAD" {
                    u.push_str(&format!("&sha={}", encode_uri_component(&ref_)));
                }
                if let Some(file) = &a.file {
                    u.push_str(&format!("&path={}", encode_uri_component(file)));
                }
                let j = api_get(&u, &[])?;
                let out = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|c| {
                                format!(
                                    "{} {} {}\n  {}",
                                    &c["sha"].as_str().unwrap_or("")
                                        [..10.min(c["sha"].as_str().unwrap_or("").len())],
                                    c["commit"]["author"]["date"].as_str().unwrap_or(""),
                                    c["commit"]["author"]["name"].as_str().unwrap_or(""),
                                    c["commit"]["message"]
                                        .as_str()
                                        .unwrap_or("")
                                        .split('\n')
                                        .next()
                                        .unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                let count = j.as_array().map(|a| a.len()).unwrap_or(0);
                Ok(ToolOutcome::executed(clip_output(
                    &(if out.is_empty() {
                        "(no commits)".to_string()
                    } else {
                        out
                    }),
                    MAX_OUTPUT,
                    "log",
                ))
                .with_meta(format!("rest · {count} commits")))
            } else {
                let mut u = format!("{gl}/commits?per_page={n}");
                if ref_ != "HEAD" {
                    u.push_str(&format!("&ref_name={}", encode_uri_component(&ref_)));
                }
                if let Some(file) = &a.file {
                    u.push_str(&format!("&path={}", encode_uri_component(file)));
                }
                let j = api_get(&u, &[])?;
                let out = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|c| {
                                format!(
                                    "{} {} {}\n  {}",
                                    &c["id"].as_str().unwrap_or("")
                                        [..10.min(c["id"].as_str().unwrap_or("").len())],
                                    c["committed_date"].as_str().unwrap_or(""),
                                    c["author_name"].as_str().unwrap_or(""),
                                    c["title"].as_str().unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                let count = j.as_array().map(|a| a.len()).unwrap_or(0);
                Ok(ToolOutcome::executed(clip_output(
                    &(if out.is_empty() {
                        "(no commits)".to_string()
                    } else {
                        out
                    }),
                    MAX_OUTPUT,
                    "log",
                ))
                .with_meta(format!("rest · {count} commits")))
            }
        }
        "show" => {
            // TS: const commit = args.commit ?? args.base — base is unused in
            // practice (the schema has no base field); a missing commit throws
            // here and the caller falls back to the clone backend (which does
            // default to the ref).
            let Some(commit) = a.commit.clone() else {
                return Err(RestError(
                    "show requires a commit or base..head range".into(),
                ));
            };
            if github {
                let j = api_get(
                    &format!("{gh}/commits/{}", encode_uri_component(&commit)),
                    &[],
                )?;
                let files = j["files"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|f| {
                                let patch = f["patch"].as_str().unwrap_or("");
                                let indented = patch
                                    .lines()
                                    .map(|l| format!("  {l}"))
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                format!(
                                    "{:<10} {} {}\n{}",
                                    f["status"].as_str().unwrap_or(""),
                                    f["changes"].as_u64().unwrap_or(0),
                                    f["filename"].as_str().unwrap_or(""),
                                    indented
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                let head = format!(
                    "{}\n{} · {}\n\n{}\n",
                    j["sha"].as_str().unwrap_or(""),
                    j["commit"]["author"]["name"].as_str().unwrap_or(""),
                    j["commit"]["author"]["date"].as_str().unwrap_or(""),
                    j["commit"]["message"].as_str().unwrap_or("")
                );
                let body = if files.is_empty() {
                    "(no files)".to_string()
                } else {
                    files
                };
                Ok(ToolOutcome::executed(clip_output(
                    &format!("{head}\n{body}"),
                    MAX_OUTPUT,
                    "patch",
                ))
                .with_meta("rest · github"))
            } else {
                let j = api_get(
                    &format!("{gl}/commits/{}/diff", encode_uri_component(&commit)),
                    &[],
                )?;
                let out = j
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|d| {
                                format!(
                                    "{}\n{}",
                                    d["new_path"].as_str().unwrap_or(""),
                                    d["diff"].as_str().unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                Ok(ToolOutcome::executed(clip_output(
                    &(if out.is_empty() {
                        "(empty diff)".to_string()
                    } else {
                        out
                    }),
                    MAX_OUTPUT,
                    "patch",
                ))
                .with_meta("rest · gitlab"))
            }
        }
        "blame" => {
            let Some(clean) = validate_path_arg(a.file.as_deref()).filter(|p| !p.is_empty()) else {
                return Err(RestError("blame requires a file path".into()));
            };
            if github {
                return Err(RestError(
                    "github blame needs GraphQL+token — falling back to git".into(),
                ));
            }
            let sha = rest_resolve_sha(t, &ref_, bases)?;
            let j = api_get(
                &format!(
                    "{gl}/blame?ref={}&filepath={}",
                    encode_uri_component(&sha),
                    encode_uri_component(&clean)
                ),
                &[],
            )?;
            let out = j
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|b| {
                            let id = b["commit"]["id"].as_str().unwrap_or("");
                            let author = b["commit"]["author_name"].as_str().unwrap_or("");
                            let first = b["lines"]
                                .as_array()
                                .and_then(|l| l.first())
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let last = b["lines"]
                                .as_array()
                                .and_then(|l| l.last())
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            format!(
                                "{} ({author}) lines {first}-{last}",
                                &id[..10.min(id.len())]
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            Ok(ToolOutcome::executed(clip_output(
                &(if out.is_empty() {
                    "(no blame data)".to_string()
                } else {
                    out
                }),
                MAX_OUTPUT,
                "blame",
            ))
            .with_meta("rest · gitlab"))
        }
        "search" => {
            let Some(query) = &a.query else {
                return Err(RestError("search requires a query".into()));
            };
            if !github {
                return Err(RestError(
                    "gitlab code search unavailable via REST — falling back to git".into(),
                ));
            }
            let q = encode_uri_component(&format!("{query} repo:{}/{}", t.owner, t.repo));
            let j = api_get(
                &format!("{}/search/code?q={q}&per_page=30", bases.github_api),
                &[],
            )?;
            let out = j["items"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|i| i["path"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            Ok(ToolOutcome::executed(clip_output(
                &(if out.is_empty() {
                    "(no matches)".to_string()
                } else {
                    out
                }),
                MAX_OUTPUT,
                "results",
            ))
            .with_meta(format!(
                "rest · {} matches",
                j["total_count"].as_u64().unwrap_or(0)
            )))
        }
        _ => Err(RestError(format!("Invalid op '{op}'"))),
    }
}

// ─── clone backend (any remote, local paths) ──────────────────────────

fn cache_root() -> PathBuf {
    std::env::temp_dir().join("tide-git-repo-cache")
}

fn touch_entry(dir: &Path) {
    let _ = std::fs::write(dir.join(TOUCH_FILE), b"t");
}

fn entry_mtime(dir: &Path) -> std::time::SystemTime {
    std::fs::metadata(dir.join(TOUCH_FILE))
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// Best-effort LRU eviction: keep the newest MAX_CACHE_ENTRIES by touch-file
/// mtime.
pub(crate) fn evict_cache(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort_by_key(|p| std::cmp::Reverse(entry_mtime(p)));
    for p in dirs.iter().skip(MAX_CACHE_ENTRIES) {
        let _ = std::fs::remove_dir_all(p);
    }
}

fn fetch_into_bare(url: &str, dir: &Path) -> Result<(), String> {
    let repo = Repository::init_opts(dir, RepositoryInitOptions::new().bare(true).mkdir(true))
        .map_err(|e| e.to_string())?;
    let mut remote = repo.remote("origin", url).map_err(|e| e.to_string())?;
    let refspecs: &[&str] = &["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
    let mut fo = git2::FetchOptions::new();
    fo.prune(FetchPrune::On);
    remote
        .fetch(refspecs, Some(&mut fo), None)
        .map_err(|e| e.to_string())?;
    // Point HEAD at the advertised default branch (a bare `git clone` does
    // this, and `ref: HEAD` resolution depends on it).
    let head = {
        let conn = remote
            .connect_auth(git2::Direction::Fetch, None, None)
            .map_err(|e| e.to_string())?;
        conn.default_branch()
            .ok()
            .and_then(|b| b.as_str().ok().map(String::from))
    };
    if let Some(head) = head {
        let _ = repo.set_head(&head);
    }
    Ok(())
}

/// Bare-clone cache: `<root>/<sha1(url)[..16]>`; clones on first use, then
/// refreshes with a prune-fetch (a stale cache beats a failed op). Returns
/// the dir path.
pub(crate) fn clone_dir_for(url: &str, root: Option<&Path>) -> Result<PathBuf, String> {
    let root = root.map(|p| p.to_path_buf()).unwrap_or_else(cache_root);
    let digest = {
        use sha1_smol::Sha1;
        let mut h = Sha1::new();
        h.update(url.as_bytes());
        h.digest().to_string()
    };
    let dir = root.join(&digest[..16]);
    if !dir.exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        evict_cache(&root);
        if let Err(e) = fetch_into_bare(url, &dir) {
            let _ = std::fs::remove_dir_all(&dir);
            let last = e.lines().last().unwrap_or(&e);
            return Err(format!("clone failed: {last}"));
        }
        touch_entry(&dir);
    } else {
        let repo = Repository::open(&dir).ok();
        if let Some(repo) = repo {
            if let Ok(mut remote) = repo.find_remote("origin") {
                let refspecs: &[&str] = &["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
                let mut fo = git2::FetchOptions::new();
                fo.prune(FetchPrune::On);
                let _ = remote.fetch(refspecs, Some(&mut fo), None);
            }
        }
        touch_entry(&dir);
    }
    Ok(dir)
}

enum RepoSource {
    Local(PathBuf),
    Remote(String),
}

fn clone_op(
    op: &str,
    source: &RepoSource,
    a: &RepoArgs,
    cache_root_override: Option<&Path>,
) -> ToolOutcome {
    let (repo, is_local) = match source {
        RepoSource::Local(p) => match Repository::open(p) {
            Ok(r) => (Ok(r), true),
            Err(_) => return ToolOutcome::failed(format!("Not a git repository: {}", a.repo)),
        },
        RepoSource::Remote(url) => (
            clone_dir_for(url, cache_root_override)
                .and_then(|dir| Repository::open_bare(&dir).map_err(|e| e.to_string())),
            false,
        ),
    };
    let repo = match repo {
        Ok(r) => r,
        Err(e) => return ToolOutcome::failed(format!("git_repo {op} failed: {e}")),
    };
    let git_meta = if is_local {
        "git · local"
    } else {
        "git · clone"
    };

    let Some(vref) = validate_ref(&a.ref_) else {
        return ToolOutcome::failed(format!("Invalid ref: {}", a.ref_));
    };
    let Some(vfile) = validate_path_arg(a.file.as_deref()) else {
        return ToolOutcome::failed(format!(
            "Invalid path: {}",
            a.file.clone().unwrap_or_default()
        ));
    };
    let limit = a.limit.unwrap_or(30).clamp(1, 200);

    let resolve_commit = |r: &str| -> Option<git2::Commit<'_>> {
        repo.revparse_single(r)
            .ok()
            .and_then(|o| o.peel_to_commit().ok())
    };

    match op {
        "info" => {
            let Some(commit) = resolve_commit(&vref) else {
                return ToolOutcome::failed(format!("git log failed: unknown revision {vref}"));
            };
            let sig = commit.author();
            let out = format!(
                "{}\n{} <{}>\n{}\n{}",
                commit.id(),
                sig.name().unwrap_or("?"),
                sig.email().unwrap_or("?"),
                super::git::iso_time(sig.when().seconds(), sig.when().offset_minutes()),
                commit.summary().ok().flatten().unwrap_or("")
            );
            ToolOutcome::executed(out).with_meta(git_meta)
        }
        "branches" => {
            let mut lines = Vec::new();
            if let Ok(refs) = repo.references() {
                for r in refs.flatten() {
                    let Some(name) = r.name().ok().filter(|n| !n.is_empty()) else {
                        continue;
                    };
                    let short = name
                        .strip_prefix("refs/heads/")
                        .or_else(|| name.strip_prefix("refs/remotes/"))
                        .or_else(|| name.strip_prefix("refs/tags/"));
                    let Some(short) = short else { continue };
                    let Some(target) = r.target() else { continue };
                    lines.push(format!("{short} {}", short_oid(target)));
                }
            }
            lines.sort();
            let out = if lines.is_empty() {
                "(no output)".to_string()
            } else {
                lines.join("\n")
            };
            ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "branches")).with_meta(git_meta)
        }
        "files" => {
            let Some(commit) = resolve_commit(&vref) else {
                return ToolOutcome::failed(format!("git ls-tree failed: unknown revision {vref}"));
            };
            let Ok(tree) = commit.tree() else {
                return ToolOutcome::failed("git ls-tree failed: no tree".to_string());
            };
            let filter = if vfile.is_empty() {
                String::new()
            } else {
                format!("{}/", vfile.trim_end_matches('/'))
            };
            let mut names = Vec::new();
            collect_blobs(&repo, &tree, "", &mut |path, _id, kind| {
                if kind == ObjectType::Blob && (filter.is_empty() || path.starts_with(&filter)) {
                    names.push(path.to_string());
                }
            });
            names.sort();
            let out = if names.is_empty() {
                "(no output)".to_string()
            } else {
                names.join("\n")
            };
            ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "files")).with_meta(git_meta)
        }
        "read" => {
            if vfile.is_empty() {
                return ToolOutcome::failed("read requires a file path");
            }
            match repo.revparse_single(&format!("{vref}:{vfile}")) {
                Ok(obj) => match obj.peel_to_blob() {
                    Ok(blob) => {
                        let content = String::from_utf8_lossy(blob.content()).into_owned();
                        let len = content.chars().count();
                        ToolOutcome::executed(clip_output(&content, MAX_OUTPUT, "file contents"))
                            .with_meta(format!("git · {len} chars"))
                    }
                    Err(_) => {
                        ToolOutcome::failed(format!("git show failed: {vfile} is not a file"))
                    }
                },
                Err(e) => ToolOutcome::failed(format!("git show failed: {e}")),
            }
        }
        "log" => {
            let Some(start) = resolve_commit(&vref) else {
                return ToolOutcome::failed(format!("git log failed: unknown revision {vref}"));
            };
            let commits = if vfile.is_empty() {
                let mut walk = match repo.revwalk() {
                    Ok(w) => w,
                    Err(e) => return ToolOutcome::failed(format!("git log failed: {e}")),
                };
                if let Err(e) = walk.set_sorting(git2::Sort::TIME) {
                    return ToolOutcome::failed(format!("git log failed: {e}"));
                }
                if let Err(e) = walk.push(start.id()) {
                    return ToolOutcome::failed(format!("git log failed: {e}"));
                }
                walk.take(limit as usize)
                    .map(|o| {
                        o.map_err(|e| e.to_string())
                            .and_then(|oid| repo.find_commit(oid).map_err(|e| e.to_string()))
                    })
                    .collect::<Result<Vec<_>, String>>()
            } else {
                commits_touching_paths(
                    &repo,
                    start.id(),
                    std::slice::from_ref(&vfile),
                    limit as usize,
                )
                .map_err(|e| e.to_string())
            };
            let commits = match commits {
                Ok(c) => c,
                Err(e) => return ToolOutcome::failed(format!("git log failed: {e}")),
            };
            let out = commits
                .iter()
                .map(|c| {
                    let summary = c.summary().ok().flatten().unwrap_or("");
                    format!("{}\n  {summary}", log_line(c))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let out = if out.is_empty() {
                "(no output)".to_string()
            } else {
                out
            };
            ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "log")).with_meta(git_meta)
        }
        "show" => {
            let target = a.commit.clone().unwrap_or_else(|| vref.clone());
            if target.contains("..") {
                let parts: Vec<&str> = target.splitn(2, "..").collect();
                let [base, head] = parts[..] else {
                    unreachable!()
                };
                let (Some(base), Some(head)) = (resolve_commit(base), resolve_commit(head)) else {
                    return ToolOutcome::failed(format!("Invalid commit/range: {target}"));
                };
                let (base_tree, head_tree) = (base.tree().ok(), head.tree().ok());
                let diff = repo.diff_tree_to_tree(base_tree.as_ref(), head_tree.as_ref(), None);
                match diff {
                    Ok(diff) => {
                        let out = format!(
                            "{}\n{}\n\n{}",
                            log_line(&head),
                            log_line(&base),
                            diff_patch(&diff, MAX_OUTPUT)
                        );
                        ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "show"))
                            .with_meta(git_meta)
                    }
                    Err(e) => ToolOutcome::failed(format!("git show failed: {e}")),
                }
            } else {
                match resolve_commit(&target) {
                    Some(commit) => match show_commit_patch(&repo, &commit, MAX_OUTPUT) {
                        Ok(out) => ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "show"))
                            .with_meta(git_meta),
                        Err(e) => ToolOutcome::failed(format!("git show failed: {e}")),
                    },
                    None => ToolOutcome::failed(format!("Invalid commit/range: {target}")),
                }
            }
        }
        "blame" => {
            if vfile.is_empty() {
                return ToolOutcome::failed("blame requires a file path");
            }
            let Some(commit) = resolve_commit(&vref) else {
                return ToolOutcome::failed(format!("git blame failed: unknown revision {vref}"));
            };
            match blame_at(&repo, commit.id(), &vfile) {
                Ok(out) => ToolOutcome::executed(clip_output(&out, MAX_OUTPUT, "blame"))
                    .with_meta(git_meta),
                Err(e) => ToolOutcome::failed(format!("git blame failed: {e}")),
            }
        }
        "search" => {
            let Some(query) = &a.query else {
                return ToolOutcome::failed("search requires a query");
            };
            let Some(commit) = resolve_commit(&vref) else {
                return ToolOutcome::failed(format!("git grep failed: unknown revision {vref}"));
            };
            let Ok(tree) = commit.tree() else {
                return ToolOutcome::failed("git grep failed: no tree".to_string());
            };
            let re = if a.regex {
                match Regex::new(query) {
                    Ok(re) => Some(re),
                    Err(e) => return ToolOutcome::failed(format!("Invalid regex: {e}")),
                }
            } else {
                None
            };
            let mut matches = Vec::new();
            collect_blobs(&repo, &tree, "", &mut |path, id, kind| {
                if kind != ObjectType::Blob || matches.len() >= MAX_OUTPUT {
                    return;
                }
                if let Ok(blob) = repo.find_blob(id) {
                    let content = blob.content();
                    if content.len() <= MAX_OUTPUT && std::str::from_utf8(content).is_ok() {
                        for (i, line) in content.split(|&b| b == b'\n').enumerate() {
                            let line = String::from_utf8_lossy(line);
                            let hit = match &re {
                                Some(re) => re.is_match(&line),
                                None => line.contains(query.as_str()),
                            };
                            if hit {
                                matches.push(format!("{path}:{}:{line}", i + 1));
                            }
                        }
                    }
                }
            });
            if matches.is_empty() {
                return ToolOutcome::executed("(no matches)").with_meta("git · 0 matches");
            }
            ToolOutcome::executed(clip_output(&matches.join("\n"), MAX_OUTPUT, "search"))
                .with_meta(git_meta)
        }
        _ => ToolOutcome::failed(format!("Invalid op '{op}'. Valid: {}", OPS.join(", "))),
    }
}

fn collect_blobs<'repo>(
    repo: &'repo Repository,
    tree: &git2::Tree<'repo>,
    prefix: &str,
    sink: &mut dyn FnMut(&str, git2::Oid, ObjectType),
) {
    for entry in tree.iter() {
        let Some(name) = entry.name().ok() else {
            continue;
        };
        let path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        match entry.kind() {
            Some(ObjectType::Tree) => {
                if let Ok(sub) = repo.find_tree(entry.id()) {
                    collect_blobs(repo, &sub, &path, sink);
                }
            }
            Some(kind) => sink(&path, entry.id(), kind),
            None => {}
        }
    }
}

/// Blame the exact contents of `path` at `ref_oid` condensed to the TS
/// `--line-porcelain` shape: `sha (author date) line-text` per line.
///
/// libgit2 blame reads a working-directory file (there is no ref option in
/// git2), so blame runs in a throwaway non-bare repo that (a) shares the
/// source's object database via an alternates file and (b) contains the
/// blob materialized at the exact path. Nothing is checked out into the
/// workspace; the scratch dir is a tempdir.
fn blame_at(source: &Repository, ref_oid: git2::Oid, rel_path: &str) -> Result<String, String> {
    let commit = source.find_commit(ref_oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree
        .get_path(Path::new(rel_path))
        .map_err(|e| e.to_string())?;
    let blob = source.find_blob(entry.id()).map_err(|e| e.to_string())?;
    let content = blob.content().to_vec();

    let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
    let _drop = Repository::init(scratch.path()).map_err(|e| e.to_string())?;
    let alt_dir = scratch.path().join(".git/objects/info");
    std::fs::create_dir_all(&alt_dir).map_err(|e| e.to_string())?;
    let source_objects = source.path().join("objects");
    std::fs::write(
        alt_dir.join("alternates"),
        source_objects.display().to_string(),
    )
    .map_err(|e| e.to_string())?;
    let repo = Repository::open(scratch.path()).map_err(|e| e.to_string())?;

    let dest = scratch.path().join(rel_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&dest, &content).map_err(|e| e.to_string())?;
    repo.set_head_detached(ref_oid).map_err(|e| e.to_string())?;

    let mut blame_opts = BlameOptions::new();
    blame_opts.newest_commit(ref_oid);
    let blame = repo
        .blame_file(Path::new(rel_path), Some(&mut blame_opts))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut lines: Vec<&[u8]> = content.split(|&b| b == b'\n').collect();
    if content.ends_with(b"\n") {
        lines.pop();
    }
    for (i, raw) in lines.into_iter().enumerate() {
        let text = String::from_utf8_lossy(raw);
        let hunk = blame.get_line(i + 1);
        let (sha, author, date) = hunk
            .map(|h| {
                let sig = h.final_signature();
                (
                    h.final_commit_id().to_string(),
                    sig.as_ref()
                        .and_then(|s| s.name().ok().map(String::from))
                        .unwrap_or_else(|| "?".into()),
                    sig.as_ref()
                        .map(|s| super::git::iso_date(s.when().seconds()))
                        .unwrap_or_else(|| "?".into()),
                )
            })
            .unwrap_or_else(|| ("?".into(), "?".into(), "?".into()));
        out.push(format!(
            "{} ({author} {date}) {text}",
            &sha[..10.min(sha.len())]
        ));
    }
    if content.is_empty() {
        return Ok(String::new());
    }
    Ok(out.join("\n"))
}

// ─── dispatch: REST fast path → clone fallback ────────────────────────

pub(crate) fn run_git_repo(args: &Value, workspace_root: Option<&Path>) -> ToolOutcome {
    let a = RepoArgs::from_json(args);
    if a.repo.is_empty() {
        return ToolOutcome::failed("Missing required arg: repo");
    }
    if !OPS.contains(&a.op.as_str()) {
        return ToolOutcome::failed(format!("Invalid op '{}'. Valid: {}", a.op, OPS.join(", ")));
    }

    // Local repos are sandboxed to the workspace root — the same boundary
    // read_file enforces (kept EXACT from the TS).
    let source = if !is_remote_repo(&a.repo) {
        let Some(root) = workspace_root else {
            return ToolOutcome::failed(
                "Local repository access requires a workspace context. Use a remote URL instead.",
            );
        };
        match resolve_inside_workspace(root, &a.repo) {
            Ok(abs) => RepoSource::Local(abs),
            Err(_) => {
                return ToolOutcome::failed(format!(
                    "Local repository \"{}\" resolves outside the workspace root — git_repo only reads local repos inside the current workspace (remote URLs are unrestricted).",
                    a.repo
                ))
            }
        }
    } else {
        RepoSource::Remote(a.repo.clone())
    };

    let remote = if is_remote_repo(&a.repo) {
        match parse_remote(&a.repo) {
            Some(t) => Some(t),
            None => return ToolOutcome::failed(format!("Unrecognized remote URL: {}", a.repo)),
        }
    } else {
        None
    };

    if let Some(t) = remote.filter(|t| t.host == "github.com" || t.host == "gitlab.com") {
        match rest_op(&a.op, &t, &a, &RestBases::live()) {
            Ok(out) => return out,
            Err(e) => {
                let reason = e.reason();
                let r = clone_op(&a.op, &source, &a, None);
                return match r.status {
                    crate::OutcomeStatus::Executed => {
                        let meta = r.meta.clone().unwrap_or_default();
                        r.with_meta(
                            format!("{meta} · rest fallback ({reason})")
                                .trim()
                                .to_string(),
                        )
                    }
                    _ => ToolOutcome::failed(format!(
                        "REST failed ({reason}); clone fallback failed: {}",
                        r.output.lines().next().unwrap_or("")
                    )),
                };
            }
        }
    }

    clone_op(&a.op, &source, &a, None)
}

pub struct GitRepoTool;

impl Tool for GitRepoTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git_repo".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": OPS, "description": "Operation to run" },
                    "repo": { "type": "string", "description": "Remote URL or local repo path" },
                    "ref": { "type": "string", "description": "Branch/tag/sha (default HEAD)" },
                    "commit": { "type": "string", "description": "Commit sha for show" },
                    "file": { "type": "string", "description": "File path / prefix / filter" },
                    "limit": { "type": "number", "description": "Max commits for log" },
                    "query": { "type": "string", "description": "Search string" },
                    "regex": { "type": "boolean", "description": "Query is a regex" }
                },
                "required": ["op", "repo"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_git_repo(&args, Some(&ctx.workspace_root)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Seed: two commits (README.md modified in the second, notes.txt added),
    /// a feature branch and a tag — enough surface for every op.
    fn seed_repo() -> (tempfile::TempDir, Repository) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();
        let commit = |files: &[(&str, &str)], msg: &str| {
            for (p, c) in files {
                let path = tmp.path().join(p);
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).unwrap();
                }
                std::fs::write(path, c).unwrap();
            }
            let mut index = repo.index().unwrap();
            for (p, _) in files {
                index.add_path(Path::new(p)).unwrap();
            }
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
            let oid = repo
                .commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
                .unwrap();
            drop(tree);
            drop(index);
            oid
        };
        commit(
            &[
                ("README.md", "hello world\n"),
                ("src/main.rs", "fn main() {\n    println!(\"hi\");\n}\n"),
                ("docs/guide.md", "# guide\n"),
            ],
            "initial commit",
        );
        commit(
            &[
                ("README.md", "hello world\nsecond line\n"),
                ("notes.txt", "notes\n"),
            ],
            "update readme",
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        repo.tag("v1", head.as_object(), &sig, "tag v1", false)
            .unwrap();
        drop(head);
        (tmp, repo)
    }

    fn run(op: &str, repo: &str, extra: Value, ws: Option<&Path>) -> ToolOutcome {
        let mut args = json!({"op": op, "repo": repo});
        if let (Some(dst), Some(src)) = (args.as_object_mut(), extra.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        run_git_repo(&args, ws)
    }

    // ─── sandbox + deny semantics (EXACT from the TS) ──────────────────

    #[test]
    fn local_repo_outside_workspace_is_rejected() {
        let ws = tempfile::tempdir().unwrap();
        let (outside, _repo) = seed_repo();
        let out = run(
            "info",
            &outside.path().display().to_string(),
            json!({}),
            Some(ws.path()),
        );
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            format!(
                "Local repository \"{}\" resolves outside the workspace root — git_repo only reads local repos inside the current workspace (remote URLs are unrestricted).",
                outside.path().display()
            )
        );
        // Relative escape gets the same refusal.
        let out = run("info", "../escape", json!({}), Some(ws.path()));
        assert!(out.output.contains("resolves outside the workspace root"));
    }

    #[test]
    fn local_repo_requires_workspace_context() {
        let out = run("info", "/some/abs/path", json!({}), None);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Local repository access requires a workspace context. Use a remote URL instead."
        );
    }

    #[test]
    fn not_a_git_repository_message() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(ws.path().join("plain")).unwrap();
        let out = run("info", "plain", json!({}), Some(ws.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert_eq!(out.output, "Not a git repository: plain");
    }

    #[test]
    fn invalid_op_and_arg_validation() {
        let (ws, _repo) = seed_repo();
        let out = run("clone", ".", json!({}), Some(ws.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(
            out.output.starts_with("Invalid op 'clone'. Valid: "),
            "{}",
            out.output
        );
        assert!(out
            .output
            .contains("info, branches, files, read, log, show, blame, search"));

        // Ref charset block (flag smuggling) — kept exact from the TS.
        for bad_ref in ["-x", "a..b", "has space", "semi;colon"] {
            let out = run("log", ".", json!({"ref": bad_ref}), Some(ws.path()));
            assert_eq!(out.status, crate::OutcomeStatus::Failed, "{bad_ref}");
            assert!(
                out.output.starts_with("Invalid ref"),
                "{bad_ref}: {}",
                out.output
            );
        }
        // Path validation.
        for bad_file in ["-flag", "../escape", "a/../.."] {
            let out = run("files", ".", json!({"file": bad_file}), Some(ws.path()));
            assert_eq!(out.status, crate::OutcomeStatus::Failed, "{bad_file}");
            assert!(
                out.output.starts_with("Invalid path"),
                "{bad_file}: {}",
                out.output
            );
        }
        // read without a file.
        let out = run("read", ".", json!({}), Some(ws.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert_eq!(out.output, "read requires a file path");
        // missing repo arg entirely.
        let out = run_git_repo(&json!({"op": "info"}), Some(ws.path()));
        assert_eq!(out.output, "Missing required arg: repo");
    }

    #[test]
    fn unrecognized_remote_url_shape() {
        let out = run(
            "info",
            "https://only-owner",
            json!({}),
            Some(Path::new("/")),
        );
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unrecognized remote URL"));
    }

    // ─── clone backend over a local repo ───────────────────────────────

    #[test]
    fn local_ops_info_branches_files_read() {
        let (tmp, repo) = seed_repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();

        let out = run("info", ".", json!({}), Some(tmp.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        assert!(
            out.output.starts_with(&head.id().to_string()),
            "{}",
            out.output
        );
        assert!(
            out.output.contains("Tester <tester@example.com>"),
            "{}",
            out.output
        );
        assert!(out.output.contains("update readme"), "{}", out.output);
        assert_eq!(out.meta.as_deref(), Some("git · local"));

        let out = run("branches", ".", json!({}), Some(tmp.path()));
        assert!(
            out.output
                .contains(&format!("master {}", short_oid(head.id()))),
            "{}",
            out.output
        );
        assert!(out.output.contains("feature "), "{}", out.output);
        assert!(out.output.contains("v1 "), "{}", out.output);

        let out = run("files", ".", json!({}), Some(tmp.path()));
        assert!(out.output.contains("README.md"));
        assert!(out.output.contains("src/main.rs"));
        assert!(out.output.contains("docs/guide.md"));
        assert!(out.output.contains("notes.txt"));

        let out = run("files", ".", json!({"file": "src"}), Some(tmp.path()));
        assert_eq!(out.output.trim(), "src/main.rs", "{}", out.output);

        let out = run(
            "read",
            ".",
            json!({"file": "src/main.rs"}),
            Some(tmp.path()),
        );
        assert!(out.output.contains("fn main() {"), "{}", out.output);
        assert_eq!(out.meta.as_deref(), Some("git · 34 chars"));

        // Read at an explicit ref: the first commit's README has one line.
        // (`HEAD~1` is not in SAFE_REF — the TS charset rejects `~` too —
        // so address the parent by sha.)
        let first_sha = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .parent(0)
            .unwrap()
            .id()
            .to_string();
        let out = run(
            "read",
            ".",
            json!({"file": "README.md", "ref": first_sha}),
            Some(tmp.path()),
        );
        assert_eq!(out.output, "hello world\n", "{}", out.output);
    }

    #[test]
    fn local_ops_log_show() {
        let (tmp, repo) = seed_repo();
        let out = run("log", ".", json!({}), Some(tmp.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output.lines().count(), 4, "{}", out.output);
        assert!(out.output.contains("update readme"), "{}", out.output);
        assert!(out.output.contains("initial commit"), "{}", out.output);
        assert!(out.output.contains("  "), "{}", out.output);

        // limit + path filter.
        let out = run("log", ".", json!({"limit": 1}), Some(tmp.path()));
        assert!(out.output.contains("update readme"));
        assert!(!out.output.contains("initial commit"));
        let out = run("log", ".", json!({"file": "src/main.rs"}), Some(tmp.path()));
        assert!(out.output.contains("initial commit"), "{}", out.output);
        assert!(!out.output.contains("update readme"), "{}", out.output);

        // show: single commit patch.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let out = run(
            "show",
            ".",
            json!({ "commit": head.id().to_string() }),
            Some(tmp.path()),
        );
        assert!(out.output.contains("update readme"), "{}", out.output);
        assert!(out.output.contains("+second line"), "{}", out.output);
        assert!(out.output.contains("+++ b/notes.txt"), "{}", out.output);

        // show base..head range.
        let out = run(
            "show",
            ".",
            json!({"commit": "HEAD~1..HEAD"}),
            Some(tmp.path()),
        );
        assert!(out.output.contains("+second line"), "{}", out.output);
        assert!(
            !out.output.contains("hello world\nhello world"),
            "{}",
            out.output
        );
    }

    #[test]
    fn local_ops_blame_and_search() {
        let (tmp, _repo) = seed_repo();
        let out = run("blame", ".", json!({"file": "README.md"}), Some(tmp.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        let lines: Vec<&str> = out.output.lines().collect();
        assert_eq!(lines.len(), 2);
        // Both README lines are committed; each carries a real (Tester date).
        assert!(out.output.contains("(Tester "), "{}", out.output);

        let out = run("search", ".", json!({"query": "fn main"}), Some(tmp.path()));
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(
            out.output.starts_with("src/main.rs:1:fn main()"),
            "{}",
            out.output
        );

        let out = run(
            "search",
            ".",
            json!({"query": "fn +main", "regex": true}),
            Some(tmp.path()),
        );
        assert!(out.output.contains("src/main.rs:1:"), "{}", out.output);

        let out = run(
            "search",
            ".",
            json!({"query": "no-such-token"}),
            Some(tmp.path()),
        );
        assert_eq!(out.output, "(no matches)");
        assert_eq!(out.meta.as_deref(), Some("git · 0 matches"));

        // Invalid regex fails cleanly.
        let out = run(
            "search",
            ".",
            json!({"query": "([", "regex": true}),
            Some(tmp.path()),
        );
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
    }

    // ─── REST fast path against a mock API ─────────────────────────────

    struct MockApi {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    /// One-request-per-connection HTTP server answering from a route table;
    /// records every request path for URL-building assertions.
    fn mock_api(routes: Vec<(&'static str, &'static str)>) -> MockApi {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let req_log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .to_string();
                let query = req.split_whitespace().nth(1).unwrap_or("").to_string();
                req_log.lock().unwrap().push(query);
                let body = routes
                    .iter()
                    .find(|(p, _)| path == *p)
                    .map(|(_, b)| b.to_string());
                let resp = match body {
                    Some(b) => format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{b}", b.len()),
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string(),
                };
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        MockApi {
            base: format!("http://{addr}"),
            requests,
        }
    }

    fn mock_bases(api: &MockApi) -> RestBases {
        RestBases {
            github_api: api.base.clone(),
            github_raw: api.base.clone(),
            gitlab_api: format!("{}/api/v4", api.base),
            gitlab_raw: api.base.clone(),
        }
    }

    fn gh_target() -> RemoteTarget {
        RemoteTarget {
            host: "github.com".into(),
            owner: "acme".into(),
            repo: "widget".into(),
            url: "https://github.com/acme/widget".into(),
        }
    }

    fn args(op: &str, extra: Value) -> RepoArgs {
        let mut v = json!({"op": op, "repo": "https://github.com/acme/widget"});
        if let (Some(dst), Some(src)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in src {
                dst.insert(k.clone(), val.clone());
            }
        }
        RepoArgs::from_json(&v)
    }

    #[test]
    fn rest_github_info_branches_log_build_correct_urls() {
        let api = mock_api(vec![
            (
                "/repos/acme/widget",
                r#"{"full_name":"acme/widget","default_branch":"main","description":"widgets","stargazers_count":42,"forks_count":7,"pushed_at":"2026-08-01"}"#,
            ),
            (
                "/repos/acme/widget/branches",
                r#"[{"name":"main","protected":true},{"name":"dev"}]"#,
            ),
            (
                "/repos/acme/widget/commits",
                r#"[{"sha":"aaaaaaaaaabbbbbbbbbbccccccccccccdddddddd","commit":{"author":{"date":"2026-08-01T10:00:00Z","name":"Ann"},"message":"fix: thing\n\nbody"}}]"#,
            ),
        ]);
        let bases = mock_bases(&api);
        let t = gh_target();

        let out = rest_op("info", &t, &args("info", json!({})), &bases).unwrap();
        assert!(out.output.contains("repo: acme/widget"));
        assert!(out.output.contains("stars: 42 · forks: 7"));
        assert_eq!(out.meta.as_deref(), Some("rest · github.com"));
        assert_eq!(api.requests.lock().unwrap()[0], "/repos/acme/widget");

        let out = rest_op("branches", &t, &args("branches", json!({})), &bases).unwrap();
        assert_eq!(out.output, "main (protected)\ndev");
        assert_eq!(
            api.requests.lock().unwrap()[1],
            "/repos/acme/widget/branches?per_page=100"
        );

        let out = rest_op("log", &t, &args("log", json!({})), &bases).unwrap();
        assert!(out.output.contains("aaaaaaaaaa 2026-08-01T10:00:00Z Ann"));
        assert!(out.output.contains("  fix: thing"));
        assert_eq!(out.meta.as_deref(), Some("rest · 1 commits"));
        let reqs = api.requests.lock().unwrap();
        assert_eq!(reqs[2], "/repos/acme/widget/commits?per_page=30");
    }

    #[test]
    fn rest_github_files_and_read() {
        let api = mock_api(vec![
            (
                "/repos/acme/widget/commits/main",
                r#"{"sha":"1111111111222222222233333333334444444444"}"#,
            ),
            (
                "/repos/acme/widget/git/trees/1111111111222222222233333333334444444444",
                r#"{"truncated":true,"tree":[{"type":"blob","path":"src/a.rs"},{"type":"blob","path":"src/b.rs"},{"type":"tree","path":"src"}]}"#,
            ),
            ("/acme/widget/main/src/a.rs", "fn a() {}\n"),
        ]);
        let bases = mock_bases(&api);
        let t = gh_target();

        let out = rest_op("files", &t, &args("files", json!({"ref": "main"})), &bases).unwrap();
        assert_eq!(out.output, "src/a.rs\nsrc/b.rs\n[listing truncated by the API — large repo; scope with a file prefix]");
        assert_eq!(out.meta.as_deref(), Some("rest · 2 files"));

        let out = rest_op(
            "read",
            &t,
            &args("read", json!({"ref": "main", "file": "src/a.rs"})),
            &bases,
        )
        .unwrap();
        assert_eq!(out.output, "fn a() {}\n");
        assert_eq!(out.meta.as_deref(), Some("rest · 10 chars"));
        // Ref resolution was pinned — a second files call must not re-fetch
        // the commit list.
        let requests_before = api.requests.lock().unwrap().len();
        let out = rest_op("files", &t, &args("files", json!({"ref": "main"})), &bases).unwrap();
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(api.requests.lock().unwrap().len(), requests_before + 1);
    }

    #[test]
    fn rest_github_show_search_and_unsupported_fall_back() {
        let api = mock_api(vec![
            (
                "/repos/acme/widget/commits/abc",
                r#"{"sha":"cccc","commit":{"author":{"name":"Bo","date":"2026-08-02"},"message":"feat"},"files":[{"status":"modified","changes":3,"filename":"x.rs","patch":"@@ -1 +1 @@\n-old\n+new"}]}"#,
            ),
            (
                "/search/code",
                r#"{"total_count":2,"items":[{"path":"a.rs"},{"path":"b.rs"}]}"#,
            ),
        ]);
        let bases = mock_bases(&api);
        let t = gh_target();

        let out = rest_op("show", &t, &args("show", json!({"commit": "abc"})), &bases).unwrap();
        assert!(out.output.contains("Bo · 2026-08-02"));
        assert!(out.output.contains("modified   3 x.rs"), "{}", out.output);
        assert!(out.output.contains("  +new"));

        let out = rest_op(
            "search",
            &t,
            &args("search", json!({"query": "todo"})),
            &bases,
        )
        .unwrap();
        assert_eq!(out.output, "a.rs\nb.rs");
        assert_eq!(out.meta.as_deref(), Some("rest · 2 matches"));
        assert!(api
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .starts_with("/search/code?q=todo%20repo%3Aacme%2Fwidget"));

        // github blame has no REST path — the error names the fallback.
        let err =
            rest_op("blame", &t, &args("blame", json!({"file": "x.rs"})), &bases).unwrap_err();
        assert!(err.reason().contains("falling back to git"));
        // Non-2xx maps to an HTTP reason.
        let err = rest_op("info", &t, &args("info", json!({})), &bases).unwrap_err();
        assert!(
            err.reason() == "HTTP 404" || err.reason().contains("HTTP 4"),
            "{}",
            err.reason()
        );
    }

    #[test]
    fn rest_gitlab_read_and_blame() {
        let api = mock_api(vec![
            (
                "/api/v4/projects/acme%2Fgl/repository/blame",
                r#"[{"commit":{"id":"ddddddddddaaaaaaaaaabbbbbbbbbbcccccccccc","author_name":"Cy"},"lines":[1,3]}]"#,
            ),
            (
                "/api/v4/projects/acme%2Fgl/repository/commits/main",
                r#"{"id":"eeeeeeeeeeaaaaaaaaaabbbbbbbbbbcccccccccc"}"#,
            ),
            ("/acme/gl/raw/main/lib.rs", "pub fn lib() {}\n"),
        ]);
        let bases = mock_bases(&api);
        let t = RemoteTarget {
            host: "gitlab.com".into(),
            owner: "acme".into(),
            repo: "gl".into(),
            url: "https://gitlab.com/acme/gl".into(),
        };

        let out = rest_op(
            "read",
            &t,
            &args("read", json!({"ref": "main", "file": "lib.rs"})),
            &bases,
        )
        .unwrap();
        assert_eq!(out.output, "pub fn lib() {}\n");

        let out = rest_op(
            "blame",
            &t,
            &args("blame", json!({"ref": "main", "file": "lib.rs"})),
            &bases,
        )
        .unwrap();
        assert!(
            out.output.starts_with("dddddddddd (Cy) lines 1-3"),
            "{}",
            out.output
        );
        assert_eq!(out.meta.as_deref(), Some("rest · gitlab"));
        let reqs = api.requests.lock().unwrap();
        // Order: raw read, then the blame's ref resolve, then the blame
        // itself with the resolved sha.
        assert_eq!(reqs[0], "/acme/gl/raw/main/lib.rs");
        assert_eq!(
            reqs[1],
            "/api/v4/projects/acme%2Fgl/repository/commits/main"
        );
        assert!(reqs[2].starts_with("/api/v4/projects/acme%2Fgl/repository/blame?ref=eeeeeeeeee"));
    }

    // ─── bare-clone cache ──────────────────────────────────────────────

    #[test]
    fn bare_clone_cache_fetches_and_reuses() {
        let (seed, _repo) = seed_repo();
        let cache = tempfile::tempdir().unwrap();
        let url = seed.path().display().to_string();

        let dir = clone_dir_for(&url, Some(cache.path())).unwrap();
        assert!(dir.exists());
        assert!(cache.path().join(dir.file_name().unwrap()).exists());
        // Bare clone: HEAD resolves and all branches arrived.
        let bare = Repository::open_bare(&dir).unwrap();
        assert!(bare.is_bare());
        let head = bare
            .head()
            .expect("HEAD set to default branch")
            .peel_to_commit()
            .unwrap();
        assert_eq!(head.summary().ok().flatten().unwrap(), "update readme");

        // Second call reuses the dir (same digest, refresh path, no error).
        let dir2 = clone_dir_for(&url, Some(cache.path())).unwrap();
        assert_eq!(dir, dir2);

        // Ops through the clone backend work end-to-end for a "remote".
        let a = RepoArgs::from_json(&json!({"op": "read", "repo": url, "file": "README.md"}));
        let out = clone_op(
            "read",
            &RepoSource::Remote(url.clone()),
            &a,
            Some(cache.path()),
        );
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        assert!(out.output.contains("second line"), "{}", out.output);
        assert_eq!(out.meta.as_deref(), Some("git · 24 chars"));
    }

    #[test]
    fn cache_lru_eviction_keeps_newest_entries() {
        let cache = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cache.path()).unwrap();
        let mk = |name: &str, mtime_secs: u64| {
            let dir = cache.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let touch = dir.join(TOUCH_FILE);
            std::fs::write(&touch, b"t").unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(mtime_secs);
            let f = std::fs::File::options().write(true).open(&touch).unwrap();
            f.set_times(std::fs::FileTimes::new().set_modified(t))
                .unwrap();
        };
        for i in 0..(MAX_CACHE_ENTRIES + 2) {
            mk(&format!("entry{i:02}"), 1000 + i as u64);
        }
        evict_cache(cache.path());
        let mut left: Vec<String> = std::fs::read_dir(cache.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), MAX_CACHE_ENTRIES);
        assert!(
            !left.contains(&"entry00".to_string()),
            "oldest must go: {left:?}"
        );
        assert!(
            !left.contains(&"entry01".to_string()),
            "second-oldest must go: {left:?}"
        );
        assert!(
            left.contains(&"entry11".to_string()),
            "newest must stay: {left:?}"
        );
    }

    #[test]
    fn clone_failure_cleans_up_and_reports() {
        let cache = tempfile::tempdir().unwrap();
        let url = cache.path().join("not-a-repo-xyz").display().to_string();
        let err = clone_dir_for(&url, Some(cache.path())).unwrap_err();
        assert!(err.starts_with("clone failed:"), "{err}");
    }

    // ─── validation helpers, verbatim semantics ────────────────────────

    #[test]
    fn validate_ref_accepts_and_rejects() {
        assert_eq!(validate_ref("main").as_deref(), Some("main"));
        assert_eq!(
            validate_ref("refs/heads/x-y_z.1").as_deref(),
            Some("refs/heads/x-y_z.1")
        );
        assert_eq!(validate_ref("a@{b}").as_deref(), None); // '{' '}' outside charset
        assert_eq!(validate_ref("HEAD").as_deref(), Some("HEAD"));
        for bad in ["", "-flag", "a..b", "a b", &"x".repeat(129)] {
            assert!(validate_ref(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn validate_path_arg_semantics() {
        assert_eq!(validate_path_arg(None).as_deref(), Some(""));
        assert_eq!(validate_path_arg(Some("")).as_deref(), None);
        assert_eq!(validate_path_arg(Some("-flag")).as_deref(), None);
        assert_eq!(validate_path_arg(Some("a/../b")).as_deref(), Some("b"));
        assert_eq!(
            validate_path_arg(Some("/leading/slash")).as_deref(),
            Some("leading/slash")
        );
        assert_eq!(validate_path_arg(Some("..")).as_deref(), None);
        assert_eq!(validate_path_arg(Some("a/../../b")).as_deref(), None);
    }

    #[test]
    fn remote_parsing_shapes() {
        let t = parse_remote("https://github.com/O/R.git/").unwrap();
        assert_eq!(
            (t.host.as_str(), t.owner.as_str(), t.repo.as_str()),
            ("github.com", "O", "R")
        );
        let t = parse_remote("git@github.com:acme/widget.git").unwrap();
        assert_eq!((t.host.as_str(), t.repo.as_str()), ("github.com", "widget"));
        let t = parse_remote("ssh://git@gitlab.com/acme/widget").unwrap();
        assert_eq!(t.host, "gitlab.com");
        assert!(parse_remote("https://host/only-owner").is_none());
        assert!(is_remote_repo("git@host:o/r") && !is_remote_repo("/local/path"));
    }

    #[test]
    fn encode_component_matches_js() {
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a/b"), "a%2Fb");
        assert_eq!(encode_uri_component("x.y~z-*_!'()"), "x.y~z-*_!'()");
    }
}
