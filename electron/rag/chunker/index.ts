/**
 * AST-aware source chunker for the RAG ingestion pipeline (Phase B).
 *
 * Uses web-tree-sitter (WASM) with vendored TS / TSX / JS grammars.
 * Reads a source file, parses it, and emits one chunk per top-level
 * symbol (function/class/method/const-export). Files with no top-level
 * symbols — scripts, configs, JSON — become a single whole-file chunk.
 *
 * Chunk boundaries always fall on AST symbol nodes; chunks never split
 * a function body. Each chunk carries its symbol name (for FTS), its
 * source text, and its line range — enough metadata to render a hit.
 *
 * Scope: TypeScript + JavaScript for v1. Adding Python/Go/Rust/Java is
 * a mechanical follow-up — same algorithm, different grammar + node
 * type names.
 */
import { Parser, Language, type Node } from 'web-tree-sitter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the grammar directory. After vite bundles the chunker into
 * `dist-electron/main.mjs`, `__dirname` becomes `dist-electron/` and
 * the grammars are staged at `dist-electron/grammars/` (see
 * build/copy-tree-sitter-grammars.mjs --dist). In vitest, `__dirname`
 * is the source file's own dir and the grammars are co-located. In a
 * packaged app, `__dirname` is inside `app.asar` and the grammars ship
 * alongside main.mjs.
 *
 * Try the candidates in order; first one whose grammar set is complete
 * wins. Throws if none match — fail loudly rather than silently running
 * a chunker with no grammar.
 */
function resolveGrammarDir(): string {
  const candidates = [
    path.join(__dirname, 'grammars'), // bundled (dist-electron or asar)
    path.join(__dirname, '..', 'electron', 'rag', 'chunker', 'grammars'), // dev from project root
    path.join(__dirname, '..', '..', 'electron', 'rag', 'chunker', 'grammars'), // dev from subfolder
  ];
  for (const dir of candidates) {
    // Just check for one core grammar — if it's there, the dir is valid.
    if (fs.existsSync(path.join(dir, 'tree-sitter-typescript.wasm'))) {
      return dir;
    }
  }
  throw new Error(
    `tree-sitter grammar directory not found. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

const GRAMMAR_DIR = resolveGrammarDir();

/** What the ingestion pipeline consumes. */
export interface Chunk {
  /** Stable id = sha256(path|symbol|startLine). Content-addressable per
   *  location so re-ingest can detect renames vs edits. */
  id: string;
  /** Absolute path to the source file. */
  path: string;
  /** Symbol name (function/class/method) — empty for whole-file chunks. */
  symbol: string;
  /** Source text of the chunk, including signature + body. */
  content: string;
  /** sha256(content) — used by ingestion to skip unchanged chunks. */
  contentHash: string;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
}

/** Tree-sitter node types that count as a "top-level symbol" worth
 *  chunking on. Covers all supported grammars. Node type names vary
 *  slightly across languages but most fall into a few buckets:
 *  function-like, class-like, variable/assignment, type/enum. */
const SYMBOL_NODE_TYPES = new Set([
  // TS/JS/TSX
  'function_declaration', 'function_expression', 'generator_function_declaration',
  'class_declaration', 'method_definition', 'lexical_declaration',
  'variable_declaration', 'export_statement', 'abstract_class_declaration',
  'interface_declaration', 'enum_declaration', 'type_alias_declaration',
  // Python
  'function_definition', 'class_definition', 'decorated_definition',
  // Go
  'function_declaration', 'method_declaration', 'type_declaration',
  // Rust
  'function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
  'macro_definition', 'constant_item', 'type_item',
  // Java / Kotlin / Scala
  'method_declaration', 'constructor_declaration',
  // C / C++
  'function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier',
  // C#
  'class_declaration', 'interface_declaration', 'enum_declaration',
  'struct_declaration', 'record_declaration',
  // Ruby
  'method', 'class', 'module', 'singleton_method',
  // PHP
  'function_definition', 'class_declaration', 'interface_declaration',
  // Swift
  'function_declaration', 'class_declaration', 'struct_declaration',
  'protocol_declaration', 'enum_declaration',
  // Lua
  'function_declaration', 'function_definition_named',
  // Bash
  'function_definition',
  // Vue
  'element',
  // Dart
  'function_signature', 'method_signature', 'class_definition', 'constructor_signature',
  // Elixir
  'call', 'def', 'defp', 'defmodule',
  // Elm
  'value_declaration', 'type_declaration',
  // ReScript
  'let_declaration', 'type_declaration',
  // Solidity
  'function_definition', 'contract_definition',
  // Zig
  'function_declaration', 'top_level_declaration',
  // OCaml
  'value_definition', 'type_definition',
]);

type LanguageName =
  | 'typescript' | 'tsx' | 'javascript'
  | 'python' | 'go' | 'rust' | 'java'
  | 'c' | 'cpp' | 'c_sharp'
  | 'ruby' | 'php' | 'swift' | 'kotlin'
  | 'scala' | 'bash' | 'lua'
  | 'vue' | 'dart' | 'html' | 'css'
  | 'elixir' | 'elm' | 'rescript'
  | 'solidity' | 'zig' | 'ocaml' | 'objc';

const EXTENSION_MAP: Record<string, LanguageName> = {
  // JS/TS family
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'tsx', '.mjs': 'javascript', '.cjs': 'javascript',
  // Python
  '.py': 'python', '.pyi': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // Java / Kotlin / Scala
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.sbt': 'scala',
  // C / C++
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  // C#
  '.cs': 'c_sharp',
  // Ruby
  '.rb': 'ruby',
  // PHP
  '.php': 'php',
  // Swift
  '.swift': 'swift',
  // Lua
  '.lua': 'lua',
  // Bash / Shell
  '.sh': 'bash', '.bash': 'bash',
  // Vue
  '.vue': 'vue',
  // Dart / Flutter
  '.dart': 'dart',
  // Web markup / styling
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css', '.less': 'css',
  // Elixir
  '.ex': 'elixir', '.exs': 'elixir',
  // Elm
  '.elm': 'elm',
  // ReScript
  '.res': 'rescript', '.resi': 'rescript',
  // Solidity
  '.sol': 'solidity',
  // Zig
  '.zig': 'zig',
  // OCaml
  '.ml': 'ocaml', '.mli': 'ocaml',
  // Objective-C
  '.m': 'objc', '.mm': 'objc',
};

/** Maps LanguageName to the grammar wasm filename in grammars/ dir. */
const GRAMMAR_FILES: Record<LanguageName, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  scala: 'tree-sitter-scala.wasm',
  bash: 'tree-sitter-bash.wasm',
  lua: 'tree-sitter-lua.wasm',
  vue: 'tree-sitter-vue.wasm',
  dart: 'tree-sitter-dart.wasm',
  html: 'tree-sitter-html.wasm',
  css: 'tree-sitter-css.wasm',
  elixir: 'tree-sitter-elixir.wasm',
  elm: 'tree-sitter-elm.wasm',
  rescript: 'tree-sitter-rescript.wasm',
  solidity: 'tree-sitter-solidity.wasm',
  zig: 'tree-sitter-zig.wasm',
  ocaml: 'tree-sitter-ocaml.wasm',
  objc: 'tree-sitter-objc.wasm',
};

let parserPromise: Promise<Partial<Record<LanguageName, Parser>>> | null = null;

/** Lazy-load web-tree-sitter + the three grammars. Memoized — the WASM
 *  runtime + ~5MB of grammars load once per process. */
async function getParsers(): Promise<Partial<Record<LanguageName, Parser>>> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      // Load every grammar that has a wasm file on disk. Grammars that
      // are missing (not vendored) are silently skipped — the EXTENSION_MAP
      // may reference them but chunkFile returns [] if the parser isn't
      // available. This makes the system resilient to partial grammar sets.
      const entries = await Promise.all(
        (Object.entries(GRAMMAR_FILES) as [LanguageName, string][]).map(
          async ([lang, file]) => {
            const wasmPath = path.join(GRAMMAR_DIR, file);
            if (!fs.existsSync(wasmPath)) return [lang, null] as const;
            try {
              const language = await Language.load(wasmPath);
              const parser = new Parser();
              parser.setLanguage(language);
              return [lang, parser] as const;
            } catch {
              return [lang, null] as const;
            }
          },
        ),
      );
      const parsers: Partial<Record<LanguageName, Parser>> = {};
      for (const [lang, parser] of entries) {
        if (parser) parsers[lang] = parser;
      }
      return parsers;
    })();
  }
  return parserPromise;
}

/** Bust the parser memo. Test-only — production has no reason to reset. */
export function _resetParsersForTests(): void {
  parserPromise = null;
}

/** Chunk a source file by absolute path. Returns [] for:
 *  - unknown extensions
 *  - unreadable / binary files (decode error)
 *  - empty files
 *  Otherwise returns at least one chunk (whole-file fallback if no
 *  top-level symbols are found). */
export async function chunkFile(absPath: string): Promise<Chunk[]> {
  const ext = path.extname(absPath).toLowerCase();
  const lang = EXTENSION_MAP[ext];
  if (!lang) return [];

  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }
  // Binary files (or non-UTF8) decode with replacement chars; treat
  // those as unparseable. Cheap heuristic: if the first 8KB has a NUL,
  // it's binary.
  if (source.slice(0, 8192).includes('\u0000')) return [];
  if (source.trim().length === 0) return [];

  const parsers = await getParsers();
  const parser = parsers[lang];
  if (!parser) return []; // grammar not loaded — skip silently

  // Some grammars (compiled against newer tree-sitter ABI) crash inside
  // WASM during parse with "resolved is not a function". Catch + skip
  // so one incompatible grammar doesn't kill the entire ingestion run.
  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return [];
  }
  if (!tree) return [];

  const chunks: Chunk[] = [];
  const seenRanges = new Set<string>(); // dedupe overlapping declarations

  // Walk top-level statements of the root (program). For each child
  // matching a SYMBOL_NODE_TYPE, slice its source text + line range.
  // This guarantees chunks fall on symbol boundaries — never mid-body.
  const cursor = tree.walk();
  cursor.gotoFirstChild();
  do {
    const node = cursor.currentNode;
    if (!SYMBOL_NODE_TYPES.has(node.type)) continue;

    // For export statements, the exported declaration is the non-keyword
    // child — find it by skipping `export`/`default`/`*` keyword nodes.
    // We chunk the inner declaration's range so the chunk text matches
    // what the user thinks of as the function/class body, NOT the
    // `export` keyword prefix.
    let targetNode = node;
    if (node.type === 'export_statement') {
      const inner = node.children.find(
        (c) => !['export', 'default', '*'].includes(c.type),
      );
      if (inner) targetNode = inner;
    }

    const startByte = targetNode.startIndex;
    const endByte = targetNode.endIndex;
    const rangeKey = `${startByte}-${endByte}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);

    const content = source.slice(startByte, endByte);
    if (content.trim().length === 0) continue;

    const symbol = extractSymbolName(targetNode);
    const startLine = targetNode.startPosition.row + 1;
    const endLine = targetNode.endPosition.row + 1;

    chunks.push({
      id: chunkId(absPath, symbol, startLine),
      path: absPath,
      symbol,
      content,
      contentHash: sha256(content),
      startLine,
      endLine,
    });
  } while (cursor.gotoNextSibling());

  tree.delete();

  // Files with no recognized top-level symbols (scripts, configs, JSON
  // masquerading as JS, etc.) become a single whole-file chunk so the
  // content is still searchable. Skip if the file is trivially small.
  if (chunks.length === 0) {
    chunks.push({
      id: chunkId(absPath, '', 1),
      path: absPath,
      symbol: '',
      content: source,
      contentHash: sha256(source),
      startLine: 1,
      endLine: source.split('\n').length,
    });
  }

  return chunks;
}

/** Best-effort symbol name extraction. Returns '' if no name is found
 *  (anonymous default exports, type aliases without names, etc.).
 *
 *  web-tree-sitter 0.25 doesn't expose `childForFieldName` reliably
 *  across grammars, so we iterate child nodes by type — robust across
 *  TS/JS/TSX. */
/** Generic symbol name extraction. Works across all supported grammars
 *  by looking for the first identifier-like child of the symbol node.
 *  Most tree-sitter grammars name the function/class identifier as
 *  `identifier` or `type_identifier` — we accept both plus a few
 *  language-specific variants. For decorated definitions (Python
 *  @decorator), we unwrap to the inner definition first. */
function extractSymbolName(node: Node): string {
  // Python: @decorator\ndef foo() — unwrap to the inner definition.
  let target = node;
  if (node.type === 'decorated_definition') {
    const inner = node.children.find(
      (c) => c.type === 'function_definition' || c.type === 'class_definition',
    );
    if (inner) target = inner;
  }

  // Universal: find the first identifier-like child. Covers:
  // TS/JS (identifier, type_identifier, property_identifier)
  // Python (identifier)
  // Go (identifier, type_identifier)
  // Rust (identifier, type_identifier)
  // Java/Kotlin/Scala (identifier)
  // C/C++ (identifier, type_identifier)
  // C# (identifier)
  // Ruby (identifier, constant)
  // PHP (identifier)
  // Swift (identifier, type_identifier)
  // Lua (identifier)
  // Bash (identifier, word)
  const NAME_TYPES = new Set([
    'identifier', 'type_identifier', 'property_identifier',
    'constant', 'word',
  ]);

  // For variable_declarator nodes (TS/JS const/let/var), dig one level deeper.
  if (target.type === 'lexical_declaration' || target.type === 'variable_declaration') {
    for (const child of target.children) {
      if (child.type === 'variable_declarator') {
        for (const grand of child.children) {
          if (NAME_TYPES.has(grand.type)) return grand.text;
        }
      }
    }
  }

  for (const child of target.children) {
    if (NAME_TYPES.has(child.type)) {
      return child.text;
    }
  }

  return '';
}

function chunkId(p: string, symbol: string, line: number): string {
  return sha256(`${p}|${symbol}|${line}`);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
