/** Tauri bridge installer — the active half of the rpc seam. Runs the
 *  `bridge_version` handshake and, only on a protocol match, attaches the
 *  chat push Channel and installs the invoke-backed client via
 *  activateRpcClient (flipping the live `rpc`/`hasRpc` bindings, which routes
 *  client.ts off the mock store). Every failure mode is non-fatal: one
 *  console.warn and the app stays on the mock store — never a crash, never a
 *  half-installed bridge.
 *
 *  Command coverage is M1 (workspaces / sessions — the legacy sidebar list
 *  pair + the v2 readers — / settings / providers) plus the M2 chat domain
 *  (`sessionCreate`, `chatSend`→`chat_run_turn`, `chatAbort`,
 *  `chatApproveTools`/`chatRejectTools`→`permission_respond`, the
 *  `eventsSubscribe` replay pair). Every OTHER TideRPC method resolves to an
 *  async rejection via the request Proxy — never a sync throw, so
 *  fire-and-forget `void` calls in client.ts can't escape a React commit.
 *  Agent/orchestrator pushes arrive on the single `chat_attach_channel`
 *  Channel and fan out through rpc.ts's emit* seams (the on*-registered
 *  single-slot callbacks); every other push channel (terminal output, git
 *  changed…) stays dormant until a later milestone wires it. */
import {
  activateRpcClient,
  emitAgentEvent,
  emitOrchestratorEvents,
  type TideRpcClient,
} from './rpc';
import type { AgentEvent } from '@/lib/agent/events';
import type {
  AgentSettingsWire,
  ArchivedSessionHeader,
  ChatSendResult,
  FlushBatch,
  GeneralSettingsWire,
  HydratedSession,
  Provider,
  SessionHeader,
  SessionMessageV2,
  SessionMetaV2,
  Workspace,
} from '@shared/rpc';

/** Must match BRIDGE_PROTOCOL in src-tauri/src/commands/bridge.rs. */
const BRIDGE_PROTOCOL = 1;

const NOT_PORTED = '[tide] RPC method not ported yet (Tauri rewrite M2+)';

type CoreModule = typeof import('@tauri-apps/api/core');
type InvokeFn = CoreModule['invoke'];
type ChannelCtor = CoreModule['Channel'];

type BridgeMethods = Pick<
  TideRpcClient['request'],
  | 'workspaceList'
  | 'sessionList'
  | 'sessionListArchived'
  | 'sessionListV2'
  | 'sessionMessagesV2'
  | 'settingsGetAgent'
  | 'settingsUpdateAgent'
  | 'settingsGetGeneral'
  | 'settingsUpdateGeneral'
  | 'providerList'
  | 'sessionCreate'
  | 'chatSend'
  | 'chatAbort'
  | 'chatApproveTools'
  | 'chatRejectTools'
  | 'eventsSubscribe'
  | 'eventsUnsubscribe'
  | 'lastSessionGet'
  | 'lastSessionSet'
  | 'consentShouldShow'
>;

/** One message off the Rust ChatPush stream (`agent/events.rs`): the `channel`
 *  tag mirrors the two webview message names in shared/rpc.ts so routing uses
 *  the same discriminator the Electrobun push did. Payload shapes are the
 *  shared/rpc.ts AgentEvent / FlushBatch verbatim. */
type ChatPush =
  | { channel: 'agentEvents'; event: AgentEvent }
  | { channel: 'orchestratorEvents'; batch: FlushBatch };

/** Params pass through verbatim: Tauri v2 maps camelCase JSON keys onto the
 *  snake_case Rust command params (workspacePath → workspace_path), which is
 *  exactly the TideRPC wire shape client.ts already sends. The chat commands
 *  that take a single Rust `args` struct (`chat_run_turn`,
 *  `permission_respond`) get it wrapped under the `args` key, and the two
 *  Electrobun approve/reject methods collapse onto `permission_respond`'s
 *  approve flag. */
function createBridgeClient(invoke: InvokeFn): TideRpcClient {
  const methods: BridgeMethods = {
    workspaceList: (params) => invoke<Workspace[]>('workspace_list', params),
    sessionList: (params) => invoke<SessionHeader[]>('session_list', params),
    sessionListArchived: (params) =>
      invoke<ArchivedSessionHeader[]>('session_list_archived', params),
    sessionListV2: (params) =>
      invoke<{ sessions: SessionMetaV2[]; nextCursor: string | null }>('session_list_v2', params),
    sessionMessagesV2: (params) =>
      invoke<{ messages: SessionMessageV2[]; nextBefore: string | null }>('session_messages_v2', params),
    settingsGetAgent: (params) => invoke<AgentSettingsWire>('settings_get_agent', params),
    settingsUpdateAgent: (params) => invoke<AgentSettingsWire>('settings_update_agent', params),
    settingsGetGeneral: (params) => invoke<GeneralSettingsWire>('settings_get_general', params),
    settingsUpdateGeneral: (params) => invoke<GeneralSettingsWire>('settings_update_general', params),
    providerList: (params) => invoke<Provider[]>('provider_list', params),
    sessionCreate: (params) => invoke<HydratedSession>('session_create', params),
    chatSend: (params) => invoke<ChatSendResult>('chat_run_turn', { args: params }),
    chatAbort: (params) => invoke('chat_abort', params),
    chatApproveTools: (params) =>
      invoke('permission_respond', {
        args: {
          sessionId: params.sessionId,
          toolCallIds: params.toolCallIds,
          approve: true,
          newMode: params.newMode,
          remember: params.remember,
        },
      }),
    chatRejectTools: (params) =>
      invoke('permission_respond', {
        args: {
          sessionId: params.sessionId,
          toolCallIds: params.toolCallIds,
          approve: false,
          reason: params.reason,
        },
      }),
    eventsSubscribe: (params) => invoke<{ batches: FlushBatch[] }>('events_subscribe', params),
    eventsUnsubscribe: (params) => invoke('events_unsubscribe', params),
    lastSessionGet: (params) => invoke<{ sessionId: string | null; workspaceId: string | null }>('last_session_get', params),
    lastSessionSet: (params) => invoke('last_session_set', params),
    consentShouldShow: (params) => invoke<{ shouldShow: boolean }>('consent_should_show', params),
  };
  return {
    request: new Proxy(methods as TideRpcClient['request'], {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return () => Promise.reject(new Error(NOT_PORTED));
      },
    }),
  };
}

/** Attach the single push Channel and route every ChatPush to its rpc.ts
 *  seam. Called ONCE per install, before the client activates, so no turn
 *  can start (and no eventsSubscribe replay can race) before the Rust
 *  forwarder exists; a rejected attach fails the whole install — a client
 *  that accepts turns but never receives events would stream into nothing. */
async function attachChatChannel(invoke: InvokeFn, Channel: ChannelCtor): Promise<void> {
  const channel = new Channel<ChatPush>();
  channel.onmessage = (push) => {
    if (push.channel === 'agentEvents') emitAgentEvent(push.event);
    else if (push.channel === 'orchestratorEvents') emitOrchestratorEvents(push.batch);
    else console.warn('[tide] unknown ChatPush channel tag — dropped:', push);
  };
  await invoke('chat_attach_channel', { channel });
}

/** Try to install the real bridge. True once the handshake validated and the
 *  client went live; false — never a throw — outside the webview, on a missing
 *  or old backend, or on any other failure (boot resilience: the renderer must
 *  keep running on the mock store). */
export async function installTauriBridge(): Promise<boolean> {
  if (typeof globalThis.__TAURI_INTERNALS__ === 'undefined') return false;
  try {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const handshake = await invoke<{ version: string; protocol: number }>('bridge_version');
    if (!handshake || handshake.protocol !== BRIDGE_PROTOCOL) {
      console.warn('[tide] bridge protocol mismatch — staying on the mock store:', handshake);
      return false;
    }
    await attachChatChannel(invoke, Channel);
    activateRpcClient(createBridgeClient(invoke));
    return true;
  } catch (err) {
    console.warn('[tide] bridge install failed — staying on the mock store:', err);
    return false;
  }
}
