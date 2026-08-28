// Token colors reference CSS custom properties (`--md-syntax-*`) instead of
// concrete colors, so highlighted blocks are NOT re-tokenized on theme change —
// only the CSS variables update, keeping results cacheable across theme switches.
// Dependency-free (no `@pierre/diffs`, no React) so the Shiki Web Worker can
// import it without dragging in main-thread-only modules.

export const MARKDOWN_SHIKI_THEME = 'tide-md';

// Loosely typed on purpose: consumers (`@pierre/diffs` registration and the raw
// Shiki worker) each cast to their own theme type. The shape is a standard
// TextMate-style theme registration.
export const MARKDOWN_SHIKI_THEME_DEFINITION = {
  name: MARKDOWN_SHIKI_THEME,
  colors: {
    'editor.background': 'transparent',
    'editor.foreground': 'var(--md-syntax-foreground)',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: 'var(--md-syntax-comment)', fontStyle: 'italic' },
    },
    {
      scope: ['string', 'punctuation.definition.string', 'string.template'],
      settings: { foreground: 'var(--md-syntax-string)' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant'],
      settings: { foreground: 'var(--md-syntax-number)' },
    },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'],
      settings: { foreground: 'var(--md-syntax-keyword)' },
    },
    {
      scope: ['keyword.operator', 'punctuation.separator', 'punctuation.terminator'],
      settings: { foreground: 'var(--md-syntax-operator)' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call'],
      settings: { foreground: 'var(--md-syntax-function)' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type',
        'support.class',
        'entity.other.inherited-class',
      ],
      settings: { foreground: 'var(--md-syntax-type)' },
    },
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'],
      settings: { foreground: 'var(--md-syntax-variable)' },
    },
    {
      scope: ['variable.other.property', 'meta.property-name', 'support.type.property-name'],
      settings: { foreground: 'var(--md-syntax-property)' },
    },
    {
      scope: ['entity.name.tag', 'punctuation.definition.tag'],
      settings: { foreground: 'var(--md-syntax-keyword)' },
    },
    {
      scope: ['entity.other.attribute-name'],
      settings: { foreground: 'var(--md-syntax-property)' },
    },
    {
      scope: ['markup.bold', 'punctuation.definition.bold'],
      settings: { fontStyle: 'bold' },
    },
    {
      scope: ['markup.italic', 'punctuation.definition.italic'],
      settings: { fontStyle: 'italic' },
    },
    {
      scope: ['markup.heading', 'markup.heading entity.name'],
      settings: { foreground: 'var(--md-syntax-keyword)', fontStyle: 'bold' },
    },
    {
      scope: ['markup.inserted', 'punctuation.definition.inserted'],
      settings: { foreground: 'var(--md-syntax-inserted)' },
    },
    {
      scope: ['markup.deleted', 'punctuation.definition.deleted'],
      settings: { foreground: 'var(--md-syntax-deleted)' },
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: 'var(--md-syntax-deleted)' },
    },
  ],
} as const;
