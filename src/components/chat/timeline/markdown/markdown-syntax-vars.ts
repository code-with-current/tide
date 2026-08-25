/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/markdown/markdownSyntaxVars.ts.
 *  Adaptation: upstream typed the palette against the upstream's runtime theme
 *  registry (`@/types/theme` Theme). Tide has no theme registry — it uses
 *  next-themes with static CSS tokens — so the seam is a local structural
 *  `MarkdownSyntaxPalette` type plus two exported palettes (light/dark) that
 *  mirror the `--md-syntax-*` values in chat-timeline.css. The renderer
 *  picks the palette from the resolved next-themes theme. Tide pins code
 *  blocks to the dark palette in both themes (product decision), so the light
 *  export aliases the dark palette. Keep this module free
 *  of `@pierre/diffs` imports — eager consumers must not pull that stack into
 *  the startup graph (upstream constraint, preserved).
 */

/** Structural slice of a theme palette consumed by the syntax CSS variables. */
export interface MarkdownSyntaxPalette {
  base: {
    foreground: string;
    comment: string;
    string: string;
    number: string;
    keyword: string;
    operator: string;
    function: string;
    type: string;
    variable: string;
  };
  tokens?: {
    variableProperty?: string;
  };
  status: {
    success: string;
    error: string;
  };
}

export const MARKDOWN_SYNTAX_PALETTE_DARK: MarkdownSyntaxPalette = {
  base: {
    foreground: 'hsl(226 30% 86%)',
    comment: 'hsl(222 14% 62%)',
    string: 'hsl(138 44% 66%)',
    number: 'hsl(268 60% 76%)',
    keyword: 'hsl(302 48% 74%)',
    operator: 'hsl(220 12% 70%)',
    function: 'hsl(207 82% 70%)',
    type: 'hsl(186 55% 64%)',
    variable: 'hsl(218 26% 82%)',
  },
  tokens: {
    variableProperty: 'hsl(184 46% 68%)',
  },
  status: {
    success: 'hsl(142 60% 52%)',
    error: 'hsl(0 68% 62%)',
  },
};

// Code blocks always render with the dark palette, even in light theme.
export const MARKDOWN_SYNTAX_PALETTE_LIGHT = MARKDOWN_SYNTAX_PALETTE_DARK;

/**
 * Build the `--md-syntax-*` CSS custom properties for the given palette.
 * Apply the result as inline styles on the markdown container so the static
 * Shiki theme resolves to the active palette.
 *
 * Lives apart from `markdownTheme.ts` because that module imports
 * `@pierre/diffs` for theme registration; eager consumers of these CSS vars
 * (tool output, code blocks) must not pull that stack into the startup graph.
 */
export const getMarkdownSyntaxVars = (theme: MarkdownSyntaxPalette): Record<string, string> => {
  const base = theme.base;
  const tokens = theme.tokens ?? {};
  const status = theme.status;

  return {
    '--md-syntax-foreground': base.foreground,
    '--md-syntax-comment': base.comment,
    '--md-syntax-string': base.string,
    '--md-syntax-number': base.number,
    '--md-syntax-keyword': base.keyword,
    '--md-syntax-operator': base.operator,
    '--md-syntax-function': base.function,
    '--md-syntax-type': base.type,
    '--md-syntax-variable': base.variable,
    '--md-syntax-property': tokens.variableProperty ?? base.variable,
    '--md-syntax-inserted': status.success,
    '--md-syntax-deleted': status.error,
  };
};
