/** Minimal ambient types for html-to-text v10 (ships no .d.ts; the fetcher
 *  only uses convert). Keep in sync with the call site in ./url.ts. */
declare module 'html-to-text' {
  export interface HtmlToTextOptions {
    wordWrap?: number | false | null;
    [key: string]: unknown;
  }
  export function convert(html: string, options?: HtmlToTextOptions, metadata?: unknown): string;
}
