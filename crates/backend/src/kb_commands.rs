//! `/kb-*` command pack — the load → act → ship → persist loop ported
//! from OpenContext's command defs. Bodies are compile-time embedded
//! (no runtime resource lookup); install never overwrites user edits.

use std::path::Path;

const BODIES: &[(&str, &str)] = &[
    (
        "kb-context",
        include_str!("../../../resources/commands/kb-context.md"),
    ),
    (
        "kb-search",
        include_str!("../../../resources/commands/kb-search.md"),
    ),
    (
        "kb-capture",
        include_str!("../../../resources/commands/kb-capture.md"),
    ),
    (
        "kb-iterate",
        include_str!("../../../resources/commands/kb-iterate.md"),
    ),
];

/// (name, body) pairs that are not yet present in `dir`.
pub fn plan_installs(dir: &Path) -> Vec<(&'static str, &'static str)> {
    BODIES
        .iter()
        .filter(|(name, _)| !dir.join(format!("{name}.md")).is_file())
        .copied()
        .collect()
}

/// Copy missing commands into the user's commands dir; returns how many
/// were installed (0 = all present or dir created empty).
pub fn install_kb_commands() -> Result<usize, String> {
    let dir = tools::tools::slash_command::commands_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let plan = plan_installs(&dir);
    let n = plan.len();
    for (name, body) in plan {
        std::fs::write(dir.join(format!("{name}.md")), body).map_err(|e| e.to_string())?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::{BODIES, plan_installs};

    #[test]
    fn plan_never_overwrites_existing_commands() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("commands");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("kb-context.md"), "# existing").unwrap();
        let plan = plan_installs(&target);
        assert_eq!(plan.len(), 3); // the other three install, kb-context skips
        assert!(plan.iter().all(|(name, _)| *name != "kb-context"));
    }

    #[test]
    fn bodies_follow_description_and_content_contract() {
        let keywords: &[(&str, &str)] = &[
            ("kb-context", "memory"),
            ("kb-search", "memory"),
            ("kb-capture", "write_file"),
            ("kb-iterate", "docId"),
        ];
        assert_eq!(BODIES.len(), 4);
        for (name, keyword) in keywords {
            let (_, body) = BODIES
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("{name} missing"));
            let first = body
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or_else(|| panic!("{name} has no non-empty first line"));
            assert!(
                first.chars().count() <= 120,
                "{name} first line is {} chars (>120): {first}",
                first.chars().count()
            );
            assert!(
                body.contains(keyword),
                "{name} body missing keyword '{keyword}'"
            );
        }
    }
}
