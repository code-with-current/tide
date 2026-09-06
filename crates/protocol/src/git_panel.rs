//! Wire types for the Git panel port, mirroring tide's `shared/rpc.ts`
//! git section and the mirror structs in tide's `commands/git.rs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One entry in the working-tree change list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelFileChange {
    pub path: String,
    /// `"modified"` | `"added"` | `"deleted"` | `"untracked"` | `"renamed"`.
    pub status: String,
    pub staged: bool,
    pub additions: u64,
    pub deletions: u64,
}

/// The identity the next commit at a path would use — local user.name/email
/// with global fallback — plus the matching profile id when the resolved
/// pair equals a stored profile. Port of tide's `GitCurrentIdentityWire`.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelCurrentIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub profile_id: Option<String>,
}

/// One commit in the panel's history list, optionally decorated.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelCommit {
    pub sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub parents: Vec<String>,
    pub is_head: bool,
    pub branch_heads: Vec<String>,
    pub tags: Vec<String>,
}

/// One stash entry from the stash list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PanelStash {
    #[serde(rename = "ref")]
    pub stash_ref: String,
    pub message: String,
}

/// One conflicted path reported by a merge.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelConflict {
    pub path: String,
    /// `"both-modified"` | `"both-added"` | `"both-deleted"` |
    /// `"added-by-us"` | `"added-by-them"` | `"deleted-by-us"` |
    /// `"deleted-by-them"`.
    pub state: String,
}

/// The panel's current branch snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelBranchInfo {
    pub branch: Option<String>,
    pub head_commit: Option<String>,
}

/// Ahead/behind counts against the branch's upstream.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelAheadBehind {
    pub ahead: u64,
    pub behind: u64,
}

/// One hunk of a file diff.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelDiffHunk {
    pub header: String,
    pub lines: Vec<PanelDiffLine>,
}

/// One line of a diff hunk; `text` carries the leading origin char
/// (`+` / `-` / space), matching upstream's byte shape.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelDiffLine {
    /// `"context"` | `"add"` | `"del"`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_no: Option<u32>,
    pub text: String,
}

/// Result of a plain git operation — `{ok}` or `{ok: false, error}`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelOpResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl PanelOpResult {
    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
    }
}

/// Result of a commit attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelCommitResult {
    pub ok: bool,
    pub sha: Option<String>,
    pub error: Option<String>,
}

/// Result of a revert attempt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelRevertResult {
    pub ok: bool,
    pub new_sha: Option<String>,
    pub error: Option<String>,
}

/// Result of a merge attempt; on conflict, the conflicted paths.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PanelMergeResult {
    pub ok: bool,
    pub conflicts: Vec<String>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_round_trips_with_camel_case_keys() {
        let commit = PanelCommit {
            sha: "abc123".into(),
            author: "Ada".into(),
            date: "2026-09-02T00:00:00Z".into(),
            subject: "wire types".into(),
            parents: vec!["def456".into()],
            is_head: true,
            branch_heads: vec!["main".into()],
            tags: vec!["v1.0".into()],
        };
        let json = serde_json::to_string(&commit).unwrap();
        assert!(json.contains("\"isHead\""), "{json}");
        assert!(json.contains("\"branchHeads\""), "{json}");
        let back: PanelCommit = serde_json::from_str(&json).unwrap();
        assert_eq!(back, commit);
    }

    #[test]
    fn stash_ref_serializes_as_ref() {
        let stash = PanelStash {
            stash_ref: "refs/stash@{0}".into(),
            message: "wip".into(),
        };
        let json = serde_json::to_string(&stash).unwrap();
        assert!(json.contains("\"ref\""), "{json}");
        assert!(!json.contains("\"stashRef\""), "{json}");
        let back: PanelStash = serde_json::from_str(&json).unwrap();
        assert_eq!(back, stash);
    }

    #[test]
    fn diff_and_results_round_trip() {
        let hunk = PanelDiffHunk {
            header: "@@ -1,2 +1,2 @@".into(),
            lines: vec![
                PanelDiffLine {
                    kind: "context".into(),
                    old_no: Some(1),
                    new_no: Some(1),
                    text: " same".into(),
                },
                PanelDiffLine {
                    kind: "add".into(),
                    old_no: None,
                    new_no: Some(2),
                    text: "+new".into(),
                },
            ],
        };
        let json = serde_json::to_string(&hunk).unwrap();
        assert!(json.contains("\"oldNo\""), "{json}");
        assert!(json.contains("\"newNo\""), "{json}");
        assert_eq!(serde_json::from_str::<PanelDiffHunk>(&json).unwrap(), hunk);

        let merge = PanelMergeResult {
            ok: false,
            conflicts: vec!["src/lib.rs".into()],
            error: Some("conflict".into()),
        };
        let json = serde_json::to_string(&merge).unwrap();
        assert_eq!(
            serde_json::from_str::<PanelMergeResult>(&json).unwrap(),
            merge
        );

        assert_eq!(
            PanelOpResult::err("boom"),
            serde_json::from_str(&serde_json::to_string(&PanelOpResult::err("boom")).unwrap())
                .unwrap()
        );
    }
}
