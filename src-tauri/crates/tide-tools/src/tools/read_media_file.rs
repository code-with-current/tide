//! read_media_file — port of `app/core/agent/tools/read-media-file.ts`
//! (). Reads a binary/media file as a base64 data URL (extension-
//! based MIME detection, 10MB cap) and surfaces it as a `media` display
//! for the renderer's image block.

use base64::Engine as _;
use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const MAX_BYTES: u64 = 10 * 1024 * 1024;

const DESCRIPTION: &str = "Read a binary/media file (image, audio, video, PDF) as a base64 data URL. Use for viewing images, diagrams, or other non-text files. Supports: png, jpg, gif, webp, avif, svg, bmp, ico, mp3, wav, flac, mp4, webm, mov, pdf. Max 10MB.";

/// Extension → MIME, in the TS map's insertion order (the unsupported-type
/// error lists extensions in this order).
const MIME_MAP: &[(&str, &str)] = &[
    (".png", "image/png"),
    (".apng", "image/apng"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".jfif", "image/jpeg"),
    (".pjpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".svg", "image/svg+xml"),
    (".bmp", "image/bmp"),
    (".ico", "image/x-icon"),
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
    (".ogg", "audio/ogg"),
    (".opus", "audio/ogg"),
    (".flac", "audio/flac"),
    (".aac", "audio/aac"),
    (".m4a", "audio/mp4"),
    (".mp4", "video/mp4"),
    (".m4v", "video/mp4"),
    (".webm", "video/webm"),
    (".mov", "video/quicktime"),
    (".mkv", "video/x-matroska"),
    (".pdf", "application/pdf"),
];

/// MIME type for a media path (extension-based); `None` when unsupported.
pub fn media_mime_for(path: &str) -> Option<&'static str> {
    let ext = extension_of(path);
    MIME_MAP
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
}

fn extension_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

pub(crate) fn run_read_media_file(rel_path: &str, workspace_root: &std::path::Path) -> ToolOutcome {
    let abs = match resolve_inside_workspace(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let meta = match std::fs::metadata(&abs) {
        Ok(m) => m,
        Err(_) => return ToolOutcome::failed(format!("File not found: {rel_path}")),
    };
    if meta.is_dir() {
        return ToolOutcome::failed(format!("Path is a directory, not a file: {rel_path}"));
    }
    if meta.len() > MAX_BYTES {
        return ToolOutcome::failed(format!(
            "File is {:.1}MB — max is {}MB. Use a smaller file.",
            meta.len() as f64 / 1024.0 / 1024.0,
            MAX_BYTES / 1024 / 1024
        ));
    }

    let abs_str = abs.to_string_lossy();
    let Some(mime_type) = media_mime_for(&abs_str) else {
        let supported: Vec<&str> = MIME_MAP.iter().map(|(e, _)| *e).collect();
        return ToolOutcome::failed(format!(
            "Unsupported file type: {}. Supported: {}",
            extension_of(&abs_str),
            supported.join(", ")
        ));
    };

    let bytes = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => return ToolOutcome::failed(format!("Cannot read file: {e}")),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{mime_type};base64,{b64}");

    let kb = meta.len() as f64 / 1024.0;
    ToolOutcome::executed(format!("Read {rel_path} ({kb:.1}KB, {mime_type})"))
        .with_meta(format!("{mime_type} · {kb:.1}KB"))
        .with_display(ToolDisplay::Media {
            data_url,
            mime_type: mime_type.to_string(),
        })
}

pub struct ReadMediaFileTool;

impl Tool for ReadMediaFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_media_file".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to workspace root."
                    }
                },
                "required": ["path"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        Ok(run_read_media_file(&arg_str(&args, "path"), &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn detects_png_and_builds_data_url() {
        let tmp = tempfile::tempdir().unwrap();
        // 1x1 transparent PNG.
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49,
            0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
            0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89,
        ];
        std::fs::write(tmp.path().join("dot.png"), png).unwrap();

        let out = run_read_media_file("dot.png", tmp.path());
        assert_eq!(
            out.status,
            OutcomeStatus::Executed,
            "outcome: {}",
            out.output
        );
        assert_eq!(out.output, "Read dot.png (0.0KB, image/png)");
        assert_eq!(out.meta.as_deref(), Some("image/png · 0.0KB"));
        let ToolDisplay::Media { data_url, mime_type } = out.display.unwrap() else {
            panic!("media display");
        };
        assert_eq!(mime_type, "image/png");
        assert!(data_url.starts_with("data:image/png;base64,"));
        let payload = data_url.strip_prefix("data:image/png;base64,").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap();
        assert_eq!(decoded, png);
    }

    #[test]
    fn mime_map_covers_the_ts_extension_set() {
        assert_eq!(media_mime_for("a.JPG"), Some("image/jpeg"));
        assert_eq!(media_mime_for("a.svg"), Some("image/svg+xml"));
        assert_eq!(media_mime_for("a.pdf"), Some("application/pdf"));
        assert_eq!(media_mime_for("a.mov"), Some("video/quicktime"));
        assert_eq!(media_mime_for("a.txt"), None);
        assert_eq!(media_mime_for("noext"), None);
    }

    #[test]
    fn unsupported_extension_lists_supported_types() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "text").unwrap();
        let out = run_read_media_file("x.txt", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unsupported file type: .txt. Supported: .png, .apng, .jpg"));
        assert!(out.output.contains(".pdf"));
    }

    #[test]
    fn missing_file_and_directory_fail() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_read_media_file("ghost.png", tmp.path());
        assert_eq!(out.output, "File not found: ghost.png");
        std::fs::create_dir(tmp.path().join("dir.png")).unwrap();
        let out = run_read_media_file("dir.png", tmp.path());
        assert_eq!(out.output, "Path is a directory, not a file: dir.png");
    }

    #[test]
    fn size_cap_rejects_over_10mb() {
        let tmp = tempfile::tempdir().unwrap();
        let big = tmp.path().join("big.png");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        drop(file);
        let out = run_read_media_file("big.png", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("File is 10.0MB — max is 10MB."));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_read_media_file("../../etc/passwd.png", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("i.gif"), b"GIF89a").unwrap();
        let tool = ReadMediaFileTool;
        assert_eq!(tool.spec().name, "read_media_file");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "path": "i.gif" }),
            )
            .unwrap();
        assert!(out.output.contains("image/gif"));
    }
}
