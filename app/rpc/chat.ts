/** Chat RPC — port of the agent turn loop's command surface
 *  (registerAgentSdkHandlers: runTurn/abort/approve/reject/submitFollowup/
 *  updateMode — electron/ipc/chat.ts itself is a dead raw-SSE fallback with no
 *  renderer callers). The job pattern is mandatory under Electrobun RPC:
 *  chatSend pre-flights the cheap failure modes (provider/key) and returns
 *  {accepted} immediately — the turn runs detached and all of its streaming
 *  (deltas via the v2 sink + orchestratorEvents, control events like
 *  permission_required/retry/turn_end via the agentEvents message) arrives as
 *  pushes. The core registration is reused verbatim through the AgentIpc
 *  adapter, so permission gating, abort propagation, and followup resolution
 *  have exactly one implementation. The core registration and provider lookup
 *  are injectable so tests drive a fake turn loop. */

import { AGENT_COMMANDS, AGENT_EVENT_CHANNEL } from '../../src/lib/agent/events.js';
import type { AgentEvent, RunTurnPayload } from '../../src/lib/agent/events.js';
import { registerAgentSdkHandlers } from '../core/agent/orchestrator.js';
import type { AgentIpc, EventSender } from '../core/agent/orchestrator.js';
import type { EventSink } from '../core/agent/event-sink.js';
import type { SessionStoreV2 } from '../core/ipc-adjacent/session-store-v2.js';
import { listProviders } from '../core/store.js';
import { createLogger } from '../core/logger.js';
import type { Provider } from '../../src/types/index.js';
import type {
  ChatSubmitFollowupParams,
  ChatSendParams,
  ChatSendResult,
} from '../../shared/rpc';

const log = createLogger('chat-rpc');

export interface ChatRpcDeps {
  /** Forwards one agent event to the webview (the agentEvents message). */
  send: (event: AgentEvent) => void;
  /** Sink shared with the events domain — the turn's durable v2 emissions. */
  sink?: EventSink;
  storeV2?: SessionStoreV2;
}

export interface ChatRpcOpts {
  /** Provider lookup for the chatSend pre-flight — injectable for tests. */
  listProviders?: () => Provider[];
  /** Core agent registration — injectable so tests run a fake turn loop. */
  registerCore?: (ipc: AgentIpc, opts: { sink?: EventSink; storeV2?: SessionStoreV2 }) => void;
}

/** Structural slice of Provider the pre-flight reads — keeps fakes narrow
 *  while the production default returns full Provider rows. */
interface ProviderLike {
  id: string;
  name: string;
  enabled?: boolean;
  apiKey?: string;
  models: { modelId: string }[];
}

export function registerChatRpc(deps: ChatRpcDeps, opts: ChatRpcOpts = {}) {
  const providersOf: () => ProviderLike[] = opts.listProviders ?? listProviders;
  const registerCore = opts.registerCore ?? registerAgentSdkHandlers;

  // The registry behind the AgentIpc adapter: one listener per agent command
  // channel, exactly as ipcMain would hold them in the Electron shell.
  const listeners = new Map<string, (event: { sender: EventSender }, ...args: any[]) => any>();
  registerCore(
    {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    { sink: deps.sink, storeV2: deps.storeV2 },
  );

  // The shell's EventSender: the orchestrator funnels every UI event through
  // send(AGENT_EVENT_CHANNEL, event); anything else on the wire is dropped.
  // Seqs are observed on the way through so the fallback emission below can
  // continue the per-session sequence monotonically.
  const lastSeq = new Map<string, number>();
  const sender: EventSender = {
    send: (channel, ...args) => {
      if (channel !== AGENT_EVENT_CHANNEL) return;
      const event = args[0] as AgentEvent;
      lastSeq.set(event.sessionId, Math.max(lastSeq.get(event.sessionId) ?? 0, event.seq));
      deps.send(event);
    },
    isDestroyed: () => false,
  };
  const nextFallbackSeq = (sessionId: string): number => {
    const n = (lastSeq.get(sessionId) ?? 0) + 1;
    lastSeq.set(sessionId, n);
    return n;
  };

  const dispatch = (channel: string, ...args: unknown[]) => {
    listeners.get(channel)?.({ sender }, ...args);
  };

  // Pre-flight mirrors runTurn's early throws so an immediate, typed error
  // comes back in the response instead of an async error+turn_end pair. The
  // same resolution order: pinned providerId, then any enabled provider
  // serving the modelId (orphaned sessions whose provider was deleted).
  const resolveProvider = (payload: ChatSendParams): ProviderLike | undefined => {
    const providers = providersOf() as ProviderLike[];
    return (
      providers.find((p) => p.id === payload.providerId) ??
      (payload.modelId
        ? providers.find((p) => p.enabled && p.models.some((m) => m.modelId === payload.modelId))
        : undefined)
    );
  };

  return {
    chatSend: (payload: ChatSendParams): ChatSendResult => {
      const provider = resolveProvider(payload);
      if (!provider) return { accepted: false, error: `Provider ${payload.providerId} not found` };
      if (!provider.apiKey) return { accepted: false, error: `No API key for ${provider.name}` };
      // Job pattern: the registered listener already guards the turn with its
      // own error → error+turn_end emission, so a detached invocation can only
      // reject if that guard itself threw — e.g. a send failure inside the
      // catch path. The fallback below re-emits the pair directly so the
      // renderer's isStreaming still clears instead of hanging the composer.
      void Promise.resolve(
        listeners.get(AGENT_COMMANDS.runTurn)?.({ sender }, payload as RunTurnPayload),
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const sid = payload.sessionId;
        log.warn('detached turn rejected', { sessionId: sid, err: message });
        deps.send({
          type: 'error', sessionId: sid, seq: nextFallbackSeq(sid),
          message: message || 'Turn failed',
        });
        deps.send({
          type: 'turn_end', sessionId: sid, seq: nextFallbackSeq(sid),
          messageId: `m_${Date.now().toString(36)}`,
          stopReason: 'refusal', content: '', timeline: [], blocks: [], totalMs: 0,
        });
      });
      return { accepted: true };
    },

    chatAbort: ({ sessionId }: { sessionId: string }) => {
      dispatch(AGENT_COMMANDS.abort, sessionId);
      return {};
    },

    chatApproveTools: ({ sessionId, toolCallIds, newMode, remember }: { sessionId: string; toolCallIds: string[]; newMode?: 'plan' | 'ask' | 'edit' | 'full'; remember?: boolean }) => {
      dispatch(AGENT_COMMANDS.approve, sessionId, toolCallIds, newMode, remember);
      return {};
    },

    chatRejectTools: ({ sessionId, toolCallIds, reason }: { sessionId: string; toolCallIds: string[]; reason?: string }) => {
      dispatch(AGENT_COMMANDS.reject, sessionId, toolCallIds, reason);
      return {};
    },

    chatSubmitFollowup: async ({ sessionId, toolCallId, answer }: ChatSubmitFollowupParams) => {
      // Boolean reaches the renderer: true = live resolver resolved; false =
      // no pending ask (turn already ended).
      const resolved = listeners.get(AGENT_COMMANDS.submitFollowup)?.({ sender }, sessionId, toolCallId, answer);
      return { resolved: resolved === true };
    },

    chatUpdateMode: ({ sessionId, mode }: { sessionId: string; mode: 'plan' | 'ask' | 'edit' | 'full' }) => {
      dispatch('agent:updateMode', sessionId, mode);
      return {};
    },
  };
}
