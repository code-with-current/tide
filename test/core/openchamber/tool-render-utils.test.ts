/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/chat/message/parts/toolRenderUtils.test.ts.
 *  bun:test converted to vitest; imports repointed at the Tide port. */
import { describe, expect, test } from 'vitest';

import {
    isActiveToolStatus,
    isExpandableTool,
    isFinalizedToolStatus,
    isStaticTool,
} from '../../../src/components/chat/timeline/message/tool-render-utils';

describe('Tide tool-status classification', () => {
    test('finalized statuses cover the Tide vocabulary without state.time', () => {
        expect(isFinalizedToolStatus('executed')).toBe(true);
        expect(isFinalizedToolStatus('failed')).toBe(true);
        expect(isFinalizedToolStatus('rejected')).toBe(true);
        expect(isFinalizedToolStatus('timeout')).toBe(true);
        expect(isFinalizedToolStatus('aborted')).toBe(true);
        expect(isFinalizedToolStatus('partial')).toBe(true);
    });

    test('active statuses stay unfinalized, including awaiting_input', () => {
        expect(isFinalizedToolStatus('pending')).toBe(false);
        expect(isFinalizedToolStatus('running')).toBe(false);
        expect(isFinalizedToolStatus('awaiting_input')).toBe(false);
        expect(isFinalizedToolStatus(undefined)).toBe(false);
    });

    test('isActiveToolStatus covers pending, running, and awaiting_input only', () => {
        expect(isActiveToolStatus('pending')).toBe(true);
        expect(isActiveToolStatus('running')).toBe(true);
        expect(isActiveToolStatus('awaiting_input')).toBe(true);
        expect(isActiveToolStatus('executed')).toBe(false);
        expect(isActiveToolStatus('started')).toBe(false);
    });
});

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('todowrite')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });
});
