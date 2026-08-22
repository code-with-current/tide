import { describe, expect, it } from 'vitest';
import { extractMermaidFromReply } from '../../electron/agent/mermaid-repair';

describe('extractMermaidFromReply', () => {
  it('extracts a fenced mermaid block', () => {
    const reply = 'Here is the fixed diagram:\n\n```mermaid\nflowchart TD\nA --> B\n```\nDone.';
    expect(extractMermaidFromReply(reply)).toBe('flowchart TD\nA --> B');
  });

  it('accepts a bare fence without the mermaid tag', () => {
    const reply = '```\nflowchart TD\nA --> B\n```';
    expect(extractMermaidFromReply(reply)).toBe('flowchart TD\nA --> B');
  });

  it('accepts a raw unfenced diagram source', () => {
    const reply = 'sequenceDiagram\nA->>B: hello';
    expect(extractMermaidFromReply(reply)).toBe('sequenceDiagram\nA->>B: hello');
  });

  it('rejects prose with no diagram', () => {
    expect(extractMermaidFromReply('Sorry, I could not fix that diagram.')).toBeNull();
  });

  it('rejects prose that only mentions mermaid in passing', () => {
    expect(extractMermaidFromReply('The flowchart directive goes at the top.')).toBeNull();
  });

  it('takes the first fence when several are present', () => {
    const reply = '```mermaid\nflowchart TD\nA --> B\n```\ntext\n```mermaid\nflowchart TD\nC --> D\n```';
    expect(extractMermaidFromReply(reply)).toBe('flowchart TD\nA --> B');
  });
});
