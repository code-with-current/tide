/** In-memory mock data store — seed dataset for the mock API in ../api/client.ts, visually matching mockup.html. Replaced entirely by IPC calls in Electron; components don't change. */

import type {
  FileNode,
  Provider,
  Session,
  Workspace,
} from '@/types';

// ============================================================
// Workspaces
// ============================================================

// Start empty — user adds workspaces via the dialog with a real file picker.
export const workspaces: Workspace[] = [];

// ============================================================
// Sessions
// ============================================================

// Start empty — created when the user starts chatting.
export const sessionsByWorkspace: Record<string, Session[]> = {};

export const allSessions: Session[] = [];

// ============================================================
// Providers & models
// ============================================================

export const providers: Provider[] = [
  {
    id: 'p_anthropic',
    name: 'Anthropic',
    apiStyle: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-api03-xB9k2Lm7vQr4ZzZt8N1pYwEczABCdef',
    enabled: true,
    models: [
      {
        id: 'm_sonnet',
        alias: 'Sonnet 4.5',
        modelId: 'claude-sonnet-4-5',
        contextWindow: 200_000,
        providerId: 'p_anthropic',
        role: 'main',
      },
      {
        id: 'm_opus',
        alias: 'Opus 4.1',
        modelId: 'claude-opus-4-1',
        contextWindow: 200_000,
        providerId: 'p_anthropic',
      },
      {
        id: 'm_haiku',
        alias: 'Haiku 4',
        modelId: 'claude-haiku-4',
        contextWindow: 200_000,
        providerId: 'p_anthropic',
        role: 'summarization',
      },
    ],
  },
  {
    id: 'p_openai',
    name: 'OpenAI',
    apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-proj-ABCdefGHIjklMNOpqrsTUVwxyz1234567890abcd',
    enabled: true,
    models: [
      {
        id: 'm_gpt5',
        alias: 'GPT-5',
        modelId: 'gpt-5',
        contextWindow: 200_000,
        providerId: 'p_openai',
      },
      {
        id: 'm_o3',
        alias: 'o3',
        modelId: 'o3',
        contextWindow: 200_000,
        providerId: 'p_openai',
      },
    ],
  },
  {
    id: 'p_ollama',
    name: 'Ollama (local)',
    apiStyle: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    enabled: true,
    models: [
      {
        id: 'm_llama33',
        alias: 'Llama 3.3',
        modelId: 'llama3.3',
        contextWindow: 128_000,
        providerId: 'p_ollama',
      },
      {
        id: 'm_qwen25',
        alias: 'Qwen 2.5',
        modelId: 'qwen2.5',
        contextWindow: 32_000,
        providerId: 'p_ollama',
      },
    ],
  },
  {
    id: 'p_openrouter',
    name: 'OpenRouter',
    apiStyle: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-v1-xB9k2Lm7vQr4ZzZt8N1pYwEczABCdef',
    enabled: false,
    models: [],
  },
];

// ============================================================
// File tree (for File Explorer tab)
// ============================================================

export const fileTree: FileNode[] = [
  {
    name: '.agent',
    path: '.agent',
    kind: 'dir',
    expanded: true,
    children: [
      {
        name: 'worktrees',
        path: '.agent/worktrees',
        kind: 'dir',
        children: [
          { name: 's_01J', path: '.agent/worktrees/s_01J', kind: 'dir' },
        ],
      },
    ],
  },
  {
    name: 'src',
    path: 'src',
    kind: 'dir',
    expanded: true,
    children: [
      { name: 'parser.ts', path: 'src/parser.ts', kind: 'file', gitStatus: 'M' },
      { name: 'parser.test.ts', path: 'src/parser.test.ts', kind: 'file', gitStatus: 'A' },
      { name: 'index.ts', path: 'src/index.ts', kind: 'file' },
      { name: 'router.ts', path: 'src/router.ts', kind: 'file' },
      { name: 'utils.ts', path: 'src/utils.ts', kind: 'file' },
    ],
  },
  { name: 'tests', path: 'tests', kind: 'dir' },
  { name: 'docs', path: 'docs', kind: 'dir' },
  {
    name: 'config',
    path: 'config',
    kind: 'dir',
    expanded: true,
    children: [
      { name: 'tsconfig.json', path: 'config/tsconfig.json', kind: 'file' },
      { name: 'package.json', path: 'config/package.json', kind: 'file' },
    ],
  },
  { name: '.gitignore', path: '.gitignore', kind: 'file' },
  { name: 'README.md', path: 'README.md', kind: 'file' },
];

// ============================================================
// Terminal seed output
// ============================================================

export interface TerminalLine {
  kind: 'prompt' | 'cwd' | 'cmd' | 'ok' | 'err' | 'dim' | 'text';
  text: string;
}

export const terminalLines: TerminalLine[] = [
  { kind: 'prompt', text: '➜' },
  { kind: 'cwd', text: '~/dev/tideCODE/.agent/worktrees/s_01J' },
  { kind: 'cmd', text: 'git status' },
  { kind: 'dim', text: 'On branch ' },
  { kind: 'ok', text: 'agent/s_01J' },
  { kind: 'dim', text: 'Changes not staged for commit:' },
  { kind: 'dim', text: '  modified:   ' },
  { kind: 'text', text: 'src/parser.ts' },
  { kind: 'dim', text: '  new file:   ' },
  { kind: 'text', text: 'src/parser.test.ts' },
  { kind: 'prompt', text: '➜' },
  { kind: 'cwd', text: '~/dev/tideCODE/.agent/worktrees/s_01J' },
  { kind: 'cmd', text: 'npm test -- parser.test.ts' },
  { kind: 'dim', text: ' ' },
  { kind: 'ok', text: '✓ parser.test.ts' },
  { kind: 'dim', text: ' (8 tests) 412ms' },
  { kind: 'ok', text: '  ✓ handles non-string input' },
  { kind: 'ok', text: '  ✓ handles empty string' },
  { kind: 'dim', text: '    // ← new test' },
  { kind: 'ok', text: '  ✓ handles whitespace-only' },
  { kind: 'dim', text: '    // ← new test' },
  { kind: 'ok', text: '  ✓ parses valid input' },
  { kind: 'dim', text: '  … 4 more' },
  { kind: 'ok', text: 'Test Files  1 passed (1)' },
  { kind: 'ok', text: 'Tests       8 passed (8)' },
  { kind: 'prompt', text: '➜' },
  { kind: 'cwd', text: '~/dev/tideCODE/.agent/worktrees/s_01J' },
];

export const rightPanelDefaultTabs = [
  { kind: 'inspector' as const, locked: true },
];

export const rightPanelAddableTabs = ['files', 'review', 'changes', 'terminal'] as const;
