/** RPC bridge seam for the renderer. The Electrobun view client is gone with
 *  the backend (Tauri rewrite): `rpc` is null everywhere — including inside a
 *  Tauri webview — until the M1+ bridge module installs `window.__TIDE_BRIDGE__`
 *  over a real invoke channel, so every data call in client.ts takes its
 *  existing mock-store fallback until then. */
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

/** Bridge activation is NOT bare `__TAURI_INTERNALS__` presence: that would
 *  make every client.ts data call take the RPC path inside an unwired Tauri
 *  webview, and the first synchronous throw (splash's refreshModelCatalog,
 *  non-async) escapes React commit with no ErrorBoundary → white screen.
 *  The M1+ bridge module (tauri-bridge.ts) activates the real client itself
 *  via activateRpcClient once the bridge_version handshake validates; until
 *  then the app runs on the mock store even inside the webview. */
declare global {
  interface Window {
    __TIDE_BRIDGE__?: unknown;
  }
}

/** Live binding, flipped by activateRpcClient when the validated bridge
 *  installs. Must stay `let` (see `rpc` below). */
export let hasRpc =
  typeof window !== 'undefined' &&
  window.__TIDE_BRIDGE__ !== undefined;

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
// callback, and re-subscribing on session switch swaps it in. The M1 bridge
// will fan incoming Tauri Channel messages out through these same slots.
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
 *  webview — batches only ever arrive via the bridge once it exists.
 *  Returns an unregister that clears the slot (guarded so a stale cleanup
 *  from a previous subscription can't drop a newer consumer's callback). */
export function onOrchestratorEvents(cb: OrchestratorEventsCallback): () => void {
  orchestratorEventsCallback = cb;
  return () => {
    if (orchestratorEventsCallback === cb) orchestratorEventsCallback = null;
  };
}

/** Register the live agent-event consumer (the agent-event channel forward:
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

/** Register the live rag-progress consumer. One message carries both progress
 *  channels — consumers filter on msg.kind ('init' | 'download'). */
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

// Push-channel fan-out for the setter-registered slots (the on*-registered
// ones are consumed via their own closures). These replace the Electrobun
// message handlers as the slots' read side — the M1 bridge forwards incoming
// Tauri Channel messages through them.

export function emitTerminalOutput(event: TerminalOutputEvent): void {
  terminalOutputCallback?.(event);
}

export function emitTerminalExit(event: TerminalExitEvent): void {
  terminalExitCallback?.(event);
}

export function emitTerminalPorts(event: TerminalPortsEvent): void {
  terminalPortsCallback?.(event);
}

export function emitScriptOutput(event: ScriptOutputEvent): void {
  scriptOutputCallback?.(event);
}

export function emitScriptExit(event: ScriptExitEvent): void {
  scriptExitCallback?.(event);
}

export function emitScriptPorts(event: ScriptPortsEvent): void {
  scriptPortsCallback?.(event);
}

// The two chat push channels ride the on*-registered slots above — these
// emitters are their read side, fed by the M2 Tauri bridge's single
// chat_attach_channel Channel (ChatPush tagged `agentEvents`/`orchestratorEvents`).

/** Deliver one AgentEvent to the onAgentEvent consumer (ChatPush `agentEvents`). */
export function emitAgentEvent(event: AgentEvent): void {
  agentEventsCallback?.(event);
}

/** Deliver one event batch to the onOrchestratorEvents consumer (ChatPush
 *  `orchestratorEvents`). */
export function emitOrchestratorEvents(batch: FlushBatch): void {
  orchestratorEventsCallback?.(batch);
}

/** Deliver one todo-list update to the onTodosUpdated consumer (ChatPush
 *  `todosUpdated` — the todo_write tool's side-channel). */
export function emitTodosUpdated(event: TodosUpdatedEvent): void {
  todosUpdatedCallback?.(event);
}

/** Register the update-status consumer (the updater store). Same single-slot
 *  shape as the other push channels. */
export function onUpdateStatus(cb: UpdateStatusCallback): () => void {
  updateStatusCallback = cb;
  return () => {
    if (updateStatusCallback === cb) updateStatusCallback = null;
  };
}

/** Request surface derived from the wire schema: one async fn per bun-side
 *  request — `(params) => Promise<response>`, the shape client.ts consumes. */
export type TideRpcClient = {
  request: {
    [M in keyof TideRPC['bun']['requests']]: (
      params: TideRPC['bun']['requests'][M]['params'],
    ) => Promise<TideRPC['bun']['requests'][M]['response']>;
  };
};

function bridgeNotPorted(): never {
  throw new Error('[tide] RPC bridge not yet ported (Tauri rewrite M1)');
}

/** The bridge client — a LIVE binding, not an import-time snapshot. This
 *  module evaluates as part of the app's static import graph, long before
 *  main.tsx's bootstrap await can run the handshake, so a `const` here would
 *  freeze the pre-install value (null) forever. As `let`, ESM live bindings
 *  make every `if (rpc)` / `Boolean(rpc)` read in client.ts re-resolve to the
 *  current value: null (client.ts falls back to the mock store, including
 *  inside an unwired Tauri webview) until the validated installer calls
 *  activateRpcClient. A `__TIDE_BRIDGE__` that predates this module's
 *  evaluation (foreign or half-installed) still gets the loud throwing stub
 *  instead of silently rendering mock data. */
export let rpc: TideRpcClient | null = hasRpc
  ? new Proxy({} as TideRpcClient, { get: bridgeNotPorted })
  : null;

/** The ONLY activation path for the real client — tauri-bridge.ts calls this
 *  once the bridge_version handshake has validated the protocol. Reassigning
 *  here re-binds `rpc`/`hasRpc` for every importing module (live bindings) and
 *  records the client on the window global for observability/HMR re-eval. */
export function activateRpcClient(client: TideRpcClient): void {
  window.__TIDE_BRIDGE__ = client;
  rpc = client;
  hasRpc = true;
}

export type RuntimeInfo = { version: string; os: string; arch: string };

let runtimeInfoCache: RuntimeInfo | null = null;

/** Direct-to-invoke probe — deliberately independent of the rpc/__TIDE_BRIDGE__
 *  mechanism: works from the first M0 boot inside the Tauri webview while all
 *  data calls still run on the mock store. */
export async function getRuntimeInfo(): Promise<RuntimeInfo | null> {
  if (typeof globalThis.__TAURI_INTERNALS__ === 'undefined') return null;
  if (!runtimeInfoCache) {
    const { invoke } = await import('@tauri-apps/api/core');
    runtimeInfoCache = await invoke<RuntimeInfo>('tide_ping');
  }
  return runtimeInfoCache;
}
