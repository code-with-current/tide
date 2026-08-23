import { describe, expect, it } from 'vitest';
import { showInspectorColumn } from '@/lib/inspector-visibility';

describe('showInspectorColumn', () => {
  it('visible when wide, panel closed, session exists', () =>
    expect(showInspectorColumn({ width: 1600, rightPanelOpen: false, hasSession: true })).toBe(true));
  it('hidden when right panel open', () =>
    expect(showInspectorColumn({ width: 1600, rightPanelOpen: true, hasSession: true })).toBe(false));
  it('hidden below breakpoint', () =>
    expect(showInspectorColumn({ width: 1200, rightPanelOpen: false, hasSession: true })).toBe(false));
  it('hidden without session', () =>
    expect(showInspectorColumn({ width: 1600, rightPanelOpen: false, hasSession: false })).toBe(false));
});
