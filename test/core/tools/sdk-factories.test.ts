/**
 * Consolidated smoke test for the SDK tool factories (Phase 2).
 *
 * For each converted tool, verifies the factory:
 *   • returns an SDK-shaped tool (description, inputSchema, execute)
 *   • does NOT duplicate risk metadata (that lives in toolMeta now)
 *   • has a Zod inputSchema that accepts a valid input and rejects garbage
 *
 * This is the regression net for the factory envelope. The actual execute
 * bodies are covered by each tool's own behavioral tests (e.g. bash.test.ts);
 * here we only assert the SDK contract holds for every factory.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { toolMeta } from '../../../app/core/agent/tools/tool-meta.js';
import type { ToolContext } from '../../../app/core/agent/tools/tool-context.js';

import { createBashTool } from '../../../app/core/agent/tools/bash.js';
import { createReadFileTool } from '../../../app/core/agent/tools/read-file.js';
import { createReadMediaFileTool } from '../../../app/core/agent/tools/read-media-file.js';
import { createListDirTool } from '../../../app/core/agent/tools/list-dir.js';
import { createWriteFileTool } from '../../../app/core/agent/tools/write-file.js';
import { createEditFileTool } from '../../../app/core/agent/tools/edit-file.js';
import { createGlobTool } from '../../../app/core/agent/tools/glob.js';
import { createGrepTool } from '../../../app/core/agent/tools/grep.js';
import { createWebFetchTool } from '../../../app/core/agent/tools/web-fetch.js';
import { createWebSearchTool } from '../../../app/core/agent/tools/web-search.js';
import { createMultiEditTool } from '../../../app/core/agent/tools/multi-edit.js';
import { createNotebookEditTool } from '../../../app/core/agent/tools/notebook-edit.js';
import { createGitTool } from '../../../app/core/agent/tools/git.js';
import { createGitRepoTool } from '../../../app/core/agent/tools/git-repo.js';
import { createBashOutputTool, createKillShellTool } from '../../../app/core/agent/tools/background-shell.js';
import { createTodoWriteTool } from '../../../app/core/agent/tools/todo-write.js';
import { createExitPlanModeTool } from '../../../app/core/agent/tools/exit-plan-mode.js';
import { createSlashCommandTool } from '../../../app/core/agent/tools/slash-command.js';
import { createDispatchAgentTool } from '../../../app/core/agent/tools/dispatch-agent.js';
import { createAskFollowupTool } from '../../../app/core/agent/tools/ask-followup.js';
import { createCompactTool } from '../../../app/core/agent/tools/compact.js';
import { createDirectoryTreeTool } from '../../../app/core/agent/tools/directory-tree.js';
import { createLoadSkillTool } from '../../../app/core/agent/tools/load-skill.js';
import { createInitTool } from '../../../app/core/agent/tools/init.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's_factory',
    workspaceRoot: '/tmp',
    autonomyMode: 'full',
    modelId: 'm',
    provider: { id: 'p', name: 'p', apiStyle: 'anthropic', baseUrl: '', enabled: true, models: [] } as any,
    compactionSettings: { enabled: true, threshold: 0.75, keepRecentTurns: 3, onFailure: 'truncate' },
    onUsage: () => {},
    emit: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

/** Each entry: toolName → factory + a representative valid input. */
const FACTORIES: Array<{
  name: string;
  factory: (ctx: ToolContext) => any;
  valid: Record<string, unknown>;
}> = [
  { name: 'bash', factory: createBashTool, valid: { command: 'ls' } },
  { name: 'read_file', factory: createReadFileTool, valid: { path: 'a.ts' } },
  { name: 'read_media_file', factory: createReadMediaFileTool, valid: { path: 'img.png' } },
  { name: 'list_dir', factory: createListDirTool, valid: { path: 'src' } },
  { name: 'write_file', factory: createWriteFileTool, valid: { path: 'a.ts', content: 'x' } },
  { name: 'edit_file', factory: createEditFileTool, valid: { path: 'a.ts', old_string: 'x', new_string: 'y' } },
  { name: 'glob', factory: createGlobTool, valid: { pattern: '**/*.ts' } },
  { name: 'grep', factory: createGrepTool, valid: { pattern: 'foo' } },
  { name: 'web_fetch', factory: createWebFetchTool, valid: { url: 'https://example.com' } },
  { name: 'web_search', factory: createWebSearchTool, valid: { query: 'how to x' } },
  { name: 'multi_edit', factory: createMultiEditTool, valid: { path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] } },
  { name: 'notebook_edit', factory: createNotebookEditTool, valid: { path: 'n.ipynb', edit_mode: 'append', source: 'code' } },
  { name: 'git', factory: createGitTool, valid: { args: ['status'] } },
  { name: 'git_repo', factory: createGitRepoTool, valid: { op: 'info', repo: 'https://github.com/o/r' } },
  { name: 'bash_output', factory: createBashOutputTool, valid: { shell_id: 'sh1' } },
  { name: 'kill_shell', factory: createKillShellTool, valid: { shell_id: 'sh1' } },
  { name: 'todo_write', factory: createTodoWriteTool, valid: { todos: [{ content: 'do thing', status: 'pending' }] } },
  { name: 'exit_plan_mode', factory: createExitPlanModeTool, valid: { plan: 'step 1' } },
  { name: 'slash_command', factory: createSlashCommandTool, valid: { command: 'refactor' } },
  { name: 'dispatch_agent', factory: createDispatchAgentTool, valid: { name: 'general-purpose', title: 'Test dispatch', task: 'find x' } },
  { name: 'ask_followup_question', factory: createAskFollowupTool, valid: { question: 'which?', options: [{ label: 'A' }] } },
  { name: 'compact', factory: createCompactTool, valid: { keep_last: 6 } },
  { name: 'directory_tree', factory: createDirectoryTreeTool, valid: { path: 'src' } },
  { name: 'load_skill', factory: createLoadSkillTool, valid: { path: '/abs/path/SKILL.md' } },
  { name: 'init', factory: createInitTool, valid: {} },
];

describe('SDK tool factories (Phase 2)', () => {
  it('covers every entry in toolMeta (no factory left unwired)', () => {
    // `memory` (Phase 6 Task 6.2) and `mcp` (reserved, dynamic per-server) have
    // toolMeta entries but no static factory yet. Every other toolMeta key must
    // have a factory smoke-test.
    const EXPECTED_UNCONVERTED = new Set(['memory', 'mcp']);
    const factoryNames = new Set(FACTORIES.map((f) => f.name));
    for (const name of Object.keys(toolMeta)) {
      if (EXPECTED_UNCONVERTED.has(name)) continue;
      expect(factoryNames.has(name), `no factory smoke-test for toolMeta.${name}`).toBe(true);
    }
  });

  for (const { name, factory, valid } of FACTORIES) {
    describe(`${name} factory`, () => {
      it('returns an SDK-shaped tool with description + execute', () => {
        const t = factory(makeCtx());
        expect(typeof t.description).toBe('string');
        expect(t.description.length).toBeGreaterThan(0);
        expect(t.inputSchema).toBeDefined();
        expect(typeof t.execute).toBe('function');
      });

      it('keeps risk metadata in toolMeta, not on the tool', () => {
        const t = factory(makeCtx()) as any;
        expect(t.riskTier).toBeUndefined();
        expect(t.autoApproveIn).toBeUndefined();
        expect(toolMeta[name as keyof typeof toolMeta]).toBeDefined();
      });

      it('inputSchema accepts the valid input', () => {
        const t = factory(makeCtx());
        const schema = t.inputSchema as unknown as { safeParse: (x: unknown) => { success: boolean } };
        expect(schema.safeParse(valid).success).toBe(true);
      });

      it('inputSchema rejects non-object input', () => {
        const t = factory(makeCtx());
        const schema = t.inputSchema as unknown as { safeParse: (x: unknown) => { success: boolean } };
        // Every tool's input is a z.object — a non-object must be rejected.
        // Catches degenerate schemas (e.g. accidentally z.any()) that would
        // otherwise accept anything the model emits.
        expect(schema.safeParse('not-an-object').success).toBe(false);
        expect(schema.safeParse(42).success).toBe(false);
      });
    });
  }
});

// Ensure the unused-import linter doesn't drop the z type import (referenced
// indirectly via the schema shape assertions above).
export type _ZodRef = z.ZodType;
