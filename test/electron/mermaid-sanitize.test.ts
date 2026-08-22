import { describe, expect, it } from 'vitest';
import { sanitizeMermaid } from '@/components/chat/mermaid-diagram';

describe('sanitizeMermaid', () => {
  it('passes clean source through unchanged as the first candidate', () => {
    const src = 'flowchart TD\n  A --> B';
    expect(sanitizeMermaid(src)[0]).toBe(src);
  });

  it('normalizes CRLF and BOM before anything else', () => {
    const out = sanitizeMermaid('\uFEFFflowchart TD\r\nA --> B\r\n');
    expect(out[0]).toBe('flowchart TD\nA --> B\n');
  });

  it('decodes HTML entities in labels', () => {
    const out = sanitizeMermaid('flowchart TD\nA["a &amp; b"]');
    expect(out.some((c) => c.includes('a & b'))).toBe(true);
  });

  it('strips inline %% comments but keeps full-line comments', () => {
    const out = sanitizeMermaid('flowchart TD\n%% real comment\nA --> B %% trailing note');
    const fixed = out[out.length - 1];
    expect(fixed).toContain('%% real comment');
    expect(fixed).toContain('A --> B');
    expect(fixed).not.toContain('trailing note');
  });

  it('quotes flowchart labels containing parens and brackets', () => {
    const src = 'flowchart TD\nA[deploy (prod)] --> B{"x": 1}';
    const out = sanitizeMermaid(src);
    const fixed = out[out.length - 1];
    expect(fixed).toContain('A["deploy (prod)"]');
    expect(fixed).toContain('B{"\'x\': 1"}');
  });

  it('leaves already-quoted labels untouched', () => {
    const src = 'flowchart TD\nA["ok (as-is)"] --> B';
    const out = sanitizeMermaid(src);
    expect(out.every((c) => c.includes('A["ok (as-is)"]'))).toBe(true);
  });

  it('renames reserved `end` node ids but not subgraph closers', () => {
    const src = 'flowchart TD\nsubgraph S\n  A --> end[Finish]\nend\nB --> end';
    const out = sanitizeMermaid(src);
    const fixed = out[out.length - 1];
    expect(fixed).toContain('endNode[Finish]');
    expect(fixed).toContain('B --> endNode');
    // the bare subgraph closer must survive
    expect(fixed.split('\n').some((l) => l.trim() === 'end')).toBe(true);
  });

  it('quotes subgraph titles containing spaces', () => {
    const out = sanitizeMermaid('flowchart TD\nsubgraph main flow\nA --> B\nend');
    expect(out.some((c) => c.includes('subgraph "main flow"'))).toBe(true);
  });

  it('strips style/linkStyle lines referencing unknown nodes (last resort)', () => {
    const out = sanitizeMermaid('flowchart TD\nA --> B\nstyle missingNode fill:#f9f');
    const last = out[out.length - 1];
    expect(last).not.toContain('style');
    expect(last).toContain('A --> B');
  });

  it('sequence diagrams: strips braces from messages', () => {
    const out = sanitizeMermaid('sequenceDiagram\nA->>B: run {task}');
    expect(out.some((c) => c.includes('A->>B: run task'))).toBe(true);
  });

  it('builds candidates cumulatively — combined fixes land in one variant', () => {
    // Entity + trailing space + paren label all at once.
    const src = 'flowchart TD  \nA[deploy (prod) &amp; rollback] --> B';
    const out = sanitizeMermaid(src);
    const last = out[out.length - 1];
    expect(last).toContain('&');
    expect(last).toContain('A["deploy (prod) & rollback"]');
  });
});
