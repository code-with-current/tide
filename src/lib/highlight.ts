/**
 * react-syntax-highlighter integration point.
 *
 * The actual highlighting is done inline in the component (HighlightedCode in
 * FileViewerPanel.tsx) using <SyntaxHighlighter>. This module just provides
 * the language-alias map so the component knows which language name to pass.
 */

const LANG_ALIAS: Record<string, string> = {
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  python: 'python',
  py: 'python',
  go: 'go',
  rust: 'rust',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  php: 'php',
  ruby: 'ruby',
  rb: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin',
  kt: 'kotlin',
  sql: 'sql',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  vue: 'html',
  svelte: 'html',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  diff: 'diff',
  plaintext: 'text',
  text: 'text',
};

/** Resolve a file extension or language name to a react-syntax-highlighter language. */
export function resolveLanguage(language: string): string {
  return LANG_ALIAS[language.toLowerCase()] ?? 'text';
}
