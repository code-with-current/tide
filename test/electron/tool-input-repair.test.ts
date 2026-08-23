import { describe, expect, it } from 'vitest';
import { repairJsonToolInput } from '../../electron/agent/tool-input-repair';

const GLM_GARBAGE =
  '{"question": "It seems like you\'re testing functionality. How can I assist you today? Please provide specific details about what you\'re trying to test., "options": []{}"label": ""Web navigation testing}, {"label": ""API testing}, {"label": ""Codebase functionality testing}, {"label": ""Performance testing", "options": [{"label": "Web navigation testing"}, {"label": "API testing"}, {"label": "Codebase functionality testing"}, {"label": "Performance testing"}]}{"question": "It seems like you\'re testing functionality. How can I assist you today? Please provide specific details about what you\'re trying to test.", "options": [{"label": "Web navigation testing"}, {"label": "API testing"}, {"label": "Codebase functionality testing"}, {"label": "Performance testing"}]}';

describe('repairJsonToolInput', () => {
  it('passes clean JSON through unchanged', () => {
    expect(repairJsonToolInput('{"a": 1}')).toBe('{"a": 1}');
  });

  it('strips tool-call wrapper tags before parsing', () => {
    expect(repairJsonToolInput('<tool_call>{"a": 1}</tool_call>')).toBe('{"a": 1}');
  });

  it('recovers the last valid object from duplicated malformed fragments (GLM stream garbage)', () => {
    const out = repairJsonToolInput(GLM_GARBAGE);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.question).toContain('How can I assist you today?');
    expect(parsed.options).toHaveLength(4);
    expect(parsed.options[0].label).toBe('Web navigation testing');
  });

  it('skips nested-but-valid objects in favor of the outermost last attempt', () => {
    const out = repairJsonToolInput('{"label": "inner"} {"top": {"x": 1}}');
    expect(JSON.parse(out!)).toEqual({ top: { x: 1 } });
  });

  it('returns null when nothing parses', () => {
    expect(repairJsonToolInput('not json at all')).toBeNull();
    expect(repairJsonToolInput('{"broken": ')).toBeNull();
  });

  it('ignores braces inside string values', () => {
    expect(repairJsonToolInput('{"code": "if (a) { return }"}')).toBe(
      '{"code": "if (a) { return }"}',
    );
  });
});
