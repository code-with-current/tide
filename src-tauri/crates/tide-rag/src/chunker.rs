//! AST-aware source chunker — port of `app/core/rag/chunker/index.ts` @
//! 91ec558. Parses a file with native tree-sitter grammars and emits one
//! chunk per top-level symbol (whole-file fallback otherwise); boundaries
//! never split a function body.
//!
//! The TS runtime loaded vendored grammar WASMs and silently skipped files
//! whose grammar was missing. Native crates replace the WASMs; ReScript has
//! no compatible crate today, so `.res`/`.resi` keep the TS missing-grammar
//! behavior (skipped). Grammar crates all expose the `tree-sitter-language`
//! `LanguageFn` contract, which converts into the runtime `Language`.

use std::collections::HashSet;
use std::path::Path;

use tree_sitter::{Language, Parser};

use crate::sha256_hex;

/// What the ingestion pipeline consumes.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    /// Stable id = sha256(path|symbol|startLine). Content-addressable per
    /// location so re-ingest can detect renames vs edits.
    pub id: String,
    /// Absolute path to the source file.
    pub path: String,
    /// Symbol name (function/class/method) — empty for whole-file chunks.
    pub symbol: String,
    /// Source text of the chunk, including signature + body.
    pub content: String,
    /// sha256(content) — used by ingestion to skip unchanged chunks.
    pub content_hash: String,
    /// 1-based start line.
    pub start_line: usize,
    /// 1-based end line (inclusive).
    pub end_line: usize,
}

/// Tree-sitter node types that count as a "top-level symbol" worth chunking
/// on (the TS set, verbatim — covers every supported grammar's naming).
const SYMBOL_NODE_TYPES: &[&str] = &[
    // TS/JS/TSX
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "class_declaration",
    "method_definition",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
    "type_alias_declaration",
    // Python
    "function_definition",
    "class_definition",
    "decorated_definition",
    // Go
    "method_declaration",
    "type_declaration",
    // Rust
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "macro_definition",
    "constant_item",
    "type_item",
    // Java / Kotlin / Scala
    "constructor_declaration",
    // C / C++
    "class_specifier",
    "struct_specifier",
    "enum_specifier",
    // C#
    "struct_declaration",
    "record_declaration",
    // Ruby
    "method",
    "class",
    "module",
    "singleton_method",
    // Swift
    "protocol_declaration",
    // Lua
    "function_definition_named",
    // Bash
    "function_definition",
    // Vue
    "element",
    // Dart
    "function_signature",
    "method_signature",
    "constructor_signature",
    // Elixir
    "call",
    // Elm / ReScript
    "value_declaration",
    // Solidity
    "contract_definition",
    // Zig
    "top_level_declaration",
    // OCaml
    "value_definition",
    "type_definition",
];

/// Identifier-ish child node types accepted as a symbol name (the TS
/// NAME_TYPES set — covers identifier/type_identifier/
/// property_identifier/constant/word across grammars).
const NAME_TYPES: &[&str] = &[
    "identifier",
    "type_identifier",
    "property_identifier",
    "constant",
    "word",
];

/// Grammar handle per language, resolved lazily once per process (native
/// grammars are compiled in — unlike the TS runtime, nothing can be missing
/// on disk, so the registry is total over the extension map).
fn language_for(lang: &str) -> Option<Language> {
    use tree_sitter_language::LanguageFn;
    let f: LanguageFn = match lang {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX,
        "javascript" => tree_sitter_javascript::LANGUAGE,
        "python" => tree_sitter_python::LANGUAGE,
        "go" => tree_sitter_go::LANGUAGE,
        "rust" => tree_sitter_rust::LANGUAGE,
        "java" => tree_sitter_java::LANGUAGE,
        "c" => tree_sitter_c::LANGUAGE,
        "cpp" => tree_sitter_cpp::LANGUAGE,
        "c_sharp" => tree_sitter_c_sharp::LANGUAGE,
        "ruby" => tree_sitter_ruby::LANGUAGE,
        "php" => tree_sitter_php::LANGUAGE_PHP,
        "swift" => tree_sitter_swift::LANGUAGE,
        "kotlin" => tree_sitter_kotlin_ng::LANGUAGE,
        "scala" => tree_sitter_scala::LANGUAGE,
        "bash" => tree_sitter_bash::LANGUAGE,
        "lua" => tree_sitter_lua::LANGUAGE,
        "vue" => tree_sitter_vue_next::LANGUAGE,
        "dart" => tree_sitter_dart::LANGUAGE,
        "html" => tree_sitter_html::LANGUAGE,
        "css" => tree_sitter_css::LANGUAGE,
        "elixir" => tree_sitter_elixir::LANGUAGE,
        "elm" => tree_sitter_elm::LANGUAGE,
        // ReScript: no compatible native crate — TS skipped missing grammars.
        "rescript" => return None,
        "solidity" => tree_sitter_solidity::LANGUAGE,
        "zig" => tree_sitter_zig::LANGUAGE,
        "ocaml" => tree_sitter_ocaml::LANGUAGE_OCAML,
        "objc" => tree_sitter_objc::LANGUAGE,
        _ => return None,
    };
    Some(f.into())
}

/// Extension → language (the TS EXTENSION_MAP, verbatim).
fn language_of_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        // JS/TS family
        "ts" | "mts" | "cts" => "typescript",
        "tsx" | "jsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        // Python
        "py" | "pyi" => "python",
        // Go
        "go" => "go",
        // Rust
        "rs" => "rust",
        // Java / Kotlin / Scala
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" | "sbt" => "scala",
        // C / C++
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        // C#
        "cs" => "c_sharp",
        // Ruby
        "rb" => "ruby",
        // PHP
        "php" => "php",
        // Swift
        "swift" => "swift",
        // Lua
        "lua" => "lua",
        // Bash / Shell
        "sh" | "bash" => "bash",
        // Vue
        "vue" => "vue",
        // Dart / Flutter
        "dart" => "dart",
        // Web markup / styling
        "html" | "htm" => "html",
        "css" | "scss" | "less" => "css",
        // Elixir
        "ex" | "exs" => "elixir",
        // Elm
        "elm" => "elm",
        // ReScript
        "res" | "resi" => "rescript",
        // Solidity
        "sol" => "solidity",
        // Zig
        "zig" => "zig",
        // OCaml
        "ml" => "ocaml",
        "mli" => "ocaml",
        // Objective-C
        "m" | "mm" => "objc",
        _ => return None,
    })
}

/// Chunk a source file by path; returns [] for unknown/binary/empty files,
/// otherwise at least one chunk (whole-file fallback).
pub fn chunk_file(abs_path: &Path) -> Vec<Chunk> {
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let Some(lang_name) = language_of_extension(&ext) else {
        return vec![];
    };
    let Some(language) = language_for(lang_name) else {
        return vec![]; // grammar unavailable — skip silently (TS parity)
    };

    let source = match std::fs::read(abs_path) {
        Ok(bytes) => bytes,
        Err(_) => return vec![],
    };
    // Binary files decode with replacement chars; treat those as
    // unparseable. Cheap heuristic: a NUL in the first 8KB means binary.
    if source.len() > 8192 && source[..8192].contains(&0) {
        return vec![];
    }
    if source.len() <= 8192 && source.contains(&0) {
        return vec![];
    }
    let source = String::from_utf8_lossy(&source).into_owned();
    if source.trim().is_empty() {
        return vec![];
    }

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return vec![];
    }
    // One incompatible grammar must not kill the run — parse errors skip
    // the file (the TS caught WASM ABI crashes the same way).
    let Some(tree) = parser.parse(&source, None) else {
        return vec![];
    };

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut seen_ranges: HashSet<(usize, usize)> = HashSet::new();

    let root = tree.root_node();
    let mut cursor = root.walk();
    if cursor.goto_first_child() {
        loop {
            let node = cursor.node();
            if SYMBOL_NODE_TYPES.contains(&node.kind()) {
                // For export statements, chunk the inner declaration's range
                // (skip `export`/`default`/`*`) so chunk text matches the
                // body, not the export prefix.
                let mut target = node;
                if node.kind() == "export_statement" {
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i as u32) {
                            if !matches!(child.kind(), "export" | "default" | "*") {
                                target = child;
                                break;
                            }
                        }
                    }
                }

                let start_byte = target.start_byte();
                let end_byte = target.end_byte();
                if !seen_ranges.insert((start_byte, end_byte)) {
                    continue;
                }

                let content = &source[start_byte..end_byte];
                if content.trim().is_empty() {
                    continue;
                }

                let symbol = extract_symbol_name(target, &source);
                let start_line = target.start_position().row + 1;
                let end_line = target.end_position().row + 1;

                chunks.push(Chunk {
                    id: chunk_id(&source_abs(abs_path), &symbol, start_line),
                    path: source_abs(abs_path),
                    symbol,
                    content: content.to_owned(),
                    content_hash: sha256_hex(content),
                    start_line,
                    end_line,
                });
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    drop(cursor);
    drop(tree);

    // Files with no recognized top-level symbols (scripts, configs, JSON
    // masquerading as JS) become a single whole-file chunk so the content is
    // still searchable.
    if chunks.is_empty() {
        let end_line = source.split('\n').count();
        chunks.push(Chunk {
            id: chunk_id(&source_abs(abs_path), "", 1),
            path: source_abs(abs_path),
            symbol: String::new(),
            content: source.clone(),
            content_hash: sha256_hex(&source),
            start_line: 1,
            end_line,
        });
    }

    chunks
}

/// Best-effort symbol name extraction across grammars: the first
/// identifier-like child, digging one level into variable declarators and
/// unwrapping Python @decorator nodes; '' for anonymous exports.
fn extract_symbol_name(node: tree_sitter::Node<'_>, source: &str) -> String {
    // Python: @decorator\ndef foo() — unwrap to the inner definition.
    let mut target = node;
    if node.kind() == "decorated_definition" {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i as u32) {
                if matches!(child.kind(), "function_definition" | "class_definition") {
                    target = child;
                    break;
                }
            }
        }
    }

    let text = |n: tree_sitter::Node<'_>| {
        n.utf8_text(source.as_bytes())
            .unwrap_or_default()
            .to_owned()
    };

    // TS/JS const/let/var: dig into the variable_declarator's name child.
    if matches!(
        target.kind(),
        "lexical_declaration" | "variable_declaration"
    ) {
        for i in 0..target.child_count() {
            if let Some(child) = target.child(i as u32) {
                if child.kind() == "variable_declarator" {
                    for j in 0..child.child_count() {
                        if let Some(grand) = child.child(j as u32) {
                            if NAME_TYPES.contains(&grand.kind()) {
                                return text(grand);
                            }
                        }
                    }
                }
            }
        }
    }

    for i in 0..target.child_count() {
        if let Some(child) = target.child(i as u32) {
            if NAME_TYPES.contains(&child.kind()) {
                return text(child);
            }
        }
    }
    String::new()
}

/// Normalize to the display form the ids hash (TS `path` was the JS string
/// — forward slashes on macOS/Linux, verbatim elsewhere).
fn source_abs(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn chunk_id(p: &str, symbol: &str, line: usize) -> String {
    sha256_hex(&format!("{p}|{symbol}|{line}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/chunker")
    }

    fn tmpfile(name: &str, content: &str) -> std::path::PathBuf {
        let p =
            std::env::temp_dir().join(format!("tide-rag-chunker-{}-{name}", std::process::id()));
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn returns_empty_for_unknown_extensions() {
        let p = tmpfile("unknown.txt", "function foo() {}\n");
        assert!(chunk_file(&p).is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn returns_empty_for_empty_and_binary_files() {
        let p = tmpfile("empty.ts", "");
        assert!(chunk_file(&p).is_empty());
        let _ = std::fs::remove_file(&p);

        let p = tmpfile("binary.ts", "\u{0}\u{0}\u{0}not really ts");
        assert!(chunk_file(&p).is_empty());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn chunks_a_typescript_fixture_at_symbol_boundaries() {
        let chunks = chunk_file(&fixtures().join("sample.ts"));
        assert!(chunks.len() > 5, "got {} chunks", chunks.len());

        let symbols: Vec<&str> = chunks.iter().map(|c| c.symbol.as_str()).collect();
        for expected in [
            "add",
            "counter",
            "Calculator",
            "VERSION",
            "User",
            "UserID",
            "Direction",
        ] {
            assert!(
                symbols.contains(&expected),
                "missing symbol {expected} in {symbols:?}"
            );
        }

        for c in &chunks {
            if c.symbol.is_empty() || c.symbol == "VERSION" {
                continue;
            }
            assert!(
                c.content.starts_with("export")
                    || c.content.starts_with("function")
                    || c.content.starts_with("class")
                    || c.content.starts_with("const")
                    || c.content.starts_with("let")
                    || c.content.starts_with("var")
                    || c.content.starts_with("interface")
                    || c.content.starts_with("type")
                    || c.content.starts_with("enum")
                    || c.content.starts_with("abstract")
                    || c.content.starts_with("generator"),
                "chunk for {} does not start at a signature: {:?}",
                c.symbol,
                &c.content[..c.content.len().min(40)]
            );
            assert_eq!(c.id.len(), 64);
            assert_eq!(c.content_hash.len(), 64);
            assert!(c.start_line > 0);
            assert!(c.end_line >= c.start_line);
        }
    }

    #[test]
    fn chunks_a_javascript_fixture() {
        let chunks = chunk_file(&fixtures().join("sample.js"));
        assert!(!chunks.is_empty());
        let symbols: Vec<&str> = chunks.iter().map(|c| c.symbol.as_str()).collect();
        assert!(symbols.contains(&"greet"));
        assert!(symbols.contains(&"Greeter"));
    }

    #[test]
    fn chunks_a_tsx_fixture() {
        let chunks = chunk_file(&fixtures().join("sample.tsx"));
        assert!(!chunks.is_empty());
        let symbols: Vec<&str> = chunks.iter().map(|c| c.symbol.as_str()).collect();
        assert!(symbols.contains(&"Button"));
        assert!(symbols.contains(&"Card"));
        let button = chunks.iter().find(|c| c.symbol == "Button").unwrap();
        assert!(button.content.contains("<button"));
        assert!(button.content.contains("</button>"));
    }

    #[test]
    fn chunks_python_rust_go_and_c_fixtures() {
        for (file, expected) in [
            ("sample.py", "Greeter"),
            ("sample.rs", "calculate"),
            ("sample.go", "Add"),
            ("sample.c", "point"), // C fn names live inside declarators — TS extraction left them '' too
        ] {
            let chunks = chunk_file(&fixtures().join(file));
            let symbols: Vec<&str> = chunks.iter().map(|c| c.symbol.as_str()).collect();
            assert!(
                symbols.contains(&expected),
                "{file}: missing {expected} in {symbols:?}"
            );
        }
    }

    #[test]
    fn falls_back_to_a_single_whole_file_chunk_without_symbols() {
        let p = tmpfile("nosymbols.ts", "console.log(\"hello\");\nfoo(bar);\n");
        let chunks = chunk_file(&p);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].symbol, "");
        assert!(chunks[0].content.contains("console.log"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn chunk_ids_are_stable_for_the_same_inputs() {
        let a = chunk_file(&fixtures().join("sample.ts"));
        let b = chunk_file(&fixtures().join("sample.ts"));
        assert_eq!(
            a.iter().map(|c| &c.id).collect::<Vec<_>>(),
            b.iter().map(|c| &c.id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn rescript_files_keep_the_missing_grammar_skip() {
        let p = tmpfile("sample.res", "let x = 1\n");
        assert!(chunk_file(&p).is_empty());
        let _ = std::fs::remove_file(&p);
    }
}
