/** Electrobun RPC bridge for the renderer. The Electroview client only exists inside a real Electrobun webview — plain-browser vite dev must keep the mock fallback, so construction is gated on the preload's `window.__electrobun` bridge (the exact global `new Electroview()` dereferences; absent in browsers and in the frozen Electron shell). */
import { Electroview } from 'electrobun/view';
import type {
  FlushBatch,
  McpEvent,
  RagProgressMessage,
  ScriptExitEvent,
  ScriptOutputEvent,
  ScriptPortsEvent,
  SourceProgressEvent,
  TerminalPort,
  TideRPC,
  TodosUpdatedEvent,
  UpdateStatusWire,
  WorkspaceProgressEvent,
} from '@shared/rpc';
import type { AgentEvent } from '@/lib/agent/events';

export const hasRpc =
  typeof window !== 'undefined' &&
  typeof window.__electrobun?.receiveMessageFromHost === 'function';

type OrchestratorEventsCallback = (batch: FlushBatch) => void;
type AgentEventsCallback = (event: AgentEvent) => void;
export type TerminalOutputEvent = { terminalId: string; data: string; seq: number };
export type TerminalExitEvent = { terminalId: string; code: number | null };
export type TerminalPortsEvent = { terminalId: string; ports: TerminalPort[] };
type TerminalOutputCallback = (event: TerminalOutputEvent) => void;
type TerminalExitCallback = (event: TerminalExitEvent) => void;
type TerminalPortsCallback = (event: TerminalPortsEvent) => void;
type McpEventsCallback = (event: McpEvent) => void;
type RagProgressCallback = (msg: RagProgressMessage) => void;
type SourcesProgressCallback = (event: SourceProgressEvent) => void;
type WorkspaceProgressCallback = (event: WorkspaceProgressEvent) => void;
type GitChangedCallback = (msg: { workspaceId: string }) => void;
type TodosUpdatedCallback = (event: TodosUpdatedEvent) => void;
type ScriptOutputCallback = (event: ScriptOutputEvent) => void;
type ScriptExitCallback = (event: ScriptExitEvent) => void;
type ScriptPortsCallback = (event: ScriptPortsEvent) => void;
type UpdateStatusCallback = (status: UpdateStatusWire) => void;

// Single-slot registries (replace-on-set): the active consumer owns the
// callback, and re-subscribing on session switch swaps it in.
let orchestratorEventsCallback: OrchestratorEventsCallback | null = null;
let agentEventsCallback: AgentEventsCallback | null = null;
let terminalOutputCallback: TerminalOutputCallback | null = null;
let terminalExitCallback: TerminalExitCallback | null = null;
let terminalPortsCallback: TerminalPortsCallback | null = null;
let mcpEventsCallback: McpEventsCallback | null = null;
let ragProgressCallback: RagProgressCallback | null = null;
let sourcesProgressCallback: SourcesProgressCallback | null = null;
let workspaceProgressCallback: WorkspaceProgressCallback | null = null;
let gitChangedCallback: GitChangedCallback | null = null;
let todosUpdatedCallback: TodosUpdatedCallback | null = null;
let scriptOutputCallback: ScriptOutputCallback | null = null;
let scriptExitCallback: ScriptExitCallback | null = null;
let scriptPortsCallback: ScriptPortsCallback | null = null;
let updateStatusCallback: UpdateStatusCallback | null = null;

/** Register the live orchestrator-events consumer. No-op outside a real
 *  webview — batches only ever arrive via the RPC message handler below.
 *  Returns an unregister that clears the slot (guarded so a stale cleanup
 *  from a previous subscription can't drop a newer consumer's callback). */
export function onOrchestratorEvents(cb: OrchestratorEventsCallback): () => void {
  orchestratorEventsCallback = cb;
  return () => {
    if (orchestratorEventsCallback === cb) orchestratorEventsCallback = null;
  };
}

/** Register the live agent-event consumer (the AGENT_EVENT_CHANNEL forward:
 *  permission_required, retry, compacting, turn_end, …). Same single-slot
 *  shape as onOrchestratorEvents. */
export function onAgentEvent(cb: AgentEventsCallback): () => void {
  agentEventsCallback = cb;
  return () => {
    if (agentEventsCallback === cb) agentEventsCallback = null;
  };
}

export function setTerminalOutputCallback(cb: TerminalOutputCallback | null): void {
  terminalOutputCallback = cb;
}

export function setTerminalExitCallback(cb: TerminalExitCallback | null): void {
  terminalExitCallback = cb;
}

export function setTerminalPortsCallback(cb: TerminalPortsCallback | null): void {
  terminalPortsCallback = cb;
}

/** Register the live MCP-event consumer (pool statusChanged today — the MCP
 *  panel re-fetches via mcpList). Same single-slot shape as onAgentEvent. */
export function onMcpEvent(cb: McpEventsCallback): () => void {
  mcpEventsCallback = cb;
  return () => {
    if (mcpEventsCallback === cb) mcpEventsCallback = null;
  };
}

/** Register the live rag-progress consumer. One message carries both Electron
 *  progress channels — consumers filter on msg.kind ('init' | 'download'). */
export function onRagProgress(cb: RagProgressCallback): () => void {
  ragProgressCallback = cb;
  return () => {
    if (ragProgressCallback === cb) ragProgressCallback = null;
  };
}

/** Register the live knowledge-sources ingestion-progress consumer. */
export function onSourcesProgress(cb: SourcesProgressCallback): () => void {
  sourcesProgressCallback = cb;
  return () => {
    if (sourcesProgressCallback === cb) sourcesProgressCallback = null;
  };
}

/** Register the add-workspace progress consumer (clone/folder/scaffold steps). */
export function onWorkspaceProgress(cb: WorkspaceProgressCallback): () => void {
  workspaceProgressCallback = cb;
  return () => {
    if (workspaceProgressCallback === cb) workspaceProgressCallback = null;
  };
}

/** Register the git-watcher change consumer (refetch trigger for the Git Panel). */
export function onGitChanged(cb: GitChangedCallback): () => void {
  gitChangedCallback = cb;
  return () => {
    if (gitChangedCallback === cb) gitChangedCallback = null;
  };
}

/** Register the todo-update consumer (todo_write tool pushes). */
export function onTodosUpdated(cb: TodosUpdatedCallback): () => void {
  todosUpdatedCallback = cb;
  return () => {
    if (todosUpdatedCallback === cb) todosUpdatedCallback = null;
  };
}

export function setScriptOutputCallback(cb: ScriptOutputCallback | null): void {
  scriptOutputCallback = cb;
}

export function setScriptExitCallback(cb: ScriptExitCallback | null): void {
  scriptExitCallback = cb;
}

export function setScriptPortsCallback(cb: ScriptPortsCallback | null): void {
  scriptPortsCallback = cb;
}

/** Register the update-status consumer (the updater store). Same single-slot
 *  shape as the other push channels. */
export function onUpdateStatus(cb: UpdateStatusCallback): () => void {
  updateStatusCallback = cb;
  return () => {
    if (updateStatusCallback === cb) updateStatusCallback = null;
  };
}

export const rpc = hasRpc
  ? Electroview.defineRPC<TideRPC>({
      handlers: {
        messages: {
          orchestratorEvents: ({ params }) => {
            orchestratorEventsCallback?.(params);
          },
          agentEvents: ({ params }) => {
            agentEventsCallback?.(params);
          },
          terminalOutput: ({ params }) => {
            terminalOutputCallback?.(params);
          },
          terminalExit: ({ params }) => {
            terminalExitCallback?.(params);
          },
          terminalPorts: ({ params }) => {
            terminalPortsCallback?.(params);
          },
          mcpEvents: ({ params }) => {
            mcpEventsCallback?.(params);
          },
          ragProgress: ({ params }) => {
            ragProgressCallback?.(params);
          },
          sourcesProgress: ({ params }) => {
            sourcesProgressCallback?.(params);
          },
          workspaceProgress: ({ params }) => {
            workspaceProgressCallback?.(params);
          },
          gitChanged: ({ params }) => {
            gitChangedCallback?.(params);
          },
          todosUpdated: ({ params }) => {
            todosUpdatedCallback?.(params);
          },
          scriptOutput: ({ params }) => {
            scriptOutputCallback?.(params);
          },
          scriptExit: ({ params }) => {
            scriptExitCallback?.(params);
          },
          scriptPorts: ({ params }) => {
            scriptPortsCallback?.(params);
          },
          updateStatus: ({ params }) => {
            updateStatusCallback?.(params);
          },
        },
      },
    })
  : null;

if (hasRpc && rpc) new Electroview({ rpc });
