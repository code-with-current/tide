/** Sessions RPC — port of the session-domain channels from
 *  electron/ipc/handlers.ts (tide:listSessions … tide:session:fork) plus the
 *  v2 list/messages pair from registerSessionV2Handlers. The legacy JSON store
 *  still drives the UI (dual-track); every create and user text message twins
 *  into the part-normalized v2 store exactly like the Electron shell did, via
 *  the shared sink. The legacy domain and both environment-bound lookups
 *  (workspace path, title model) are injectable so tests run against temp
 *  stores instead of the real ~/.tide-dev; the interface is hand-written
 *  (not Pick<typeof core module>) so this file's typecheck stays leaf-safe. */

import { createLogger } from '../core/logger.js';
import type { EventSink } from '../core/agent/event-sink.js';
import { newV2MessageId, newV2PartId, orchestratorEventToSink } from '../core/agent/orchestrator-events.js';
import type { TitleAttachment, TitleModelSource } from '../core/agent/title.js';
import { generateSessionTitle } from '../core/agent/title.js';
import type { SessionStoreV2 } from '../core/ipc-adjacent/session-store-v2.js';
import { listWorkspaces, listProviders, getGeneralSettings } from '../core/store.js';
import type {
  ArchivedSessionHeader,
  AssistantMessageInput,
  FinalizeAssistantMessageInput,
  HydratedSession,
  SessionCreateOpts,
  SessionHeader,
  SessionListOptsV2,
  SessionMessageExtra,
  SessionSettingsPatch,
  SessionUsageDelta,
  SessionWindowOptsV2,
  SessionWorktree,
} from '../../shared/rpc';

const log = createLogger('sessions-rpc');

/** The legacy-store surface the handlers touch — satisfied structurally by
 *  the core sessions module (the production default, passed by main.ts) and
 *  by test doubles. Param types are the wire shapes; `any[]` fields accept
 *  the schema's wider `unknown[]` payloads. */
export interface LegacySessionDomain {
  listSessions(workspaceId: string): SessionHeader[];
  listDispatches(parentId: string): SessionHeader[];
  getSession(id: string): HydratedSession | undefined;
  createSession(
    workspaceId: string,
    title: string,
    modelId: string,
    opts?: SessionCreateOpts,
  ): HydratedSession;
  updateSessionSettings(sessionId: string, patch: SessionSettingsPatch): void;
  addMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    extra?: SessionMessageExtra,
  ): void;
  addAssistantMessage(
    sessionId: string,
    message: {
      content: string;
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ): void;
  finalizeAssistantMessage(
    sessionId: string,
    messageId: string,
    message: {
      content: string;
      blocks?: any[];
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
      compactionInfo?: { tokensBefore: number; tokensAfter: number };
      stopReason?: string | null;
    },
  ): void;
  addUsage(sessionId: string, delta: SessionUsageDelta, lastStepUsage?: SessionUsageDelta): void;
  deleteSession(id: string): void;
  clearAllSessions(): void;
  renameSession(sessionId: string, title: string): void;
  archiveSession(sessionId: string): void;
  unarchiveSession(sessionId: string): void;
  listArchivedSessions(workspaceId: string): ArchivedSessionHeader[];
  forkWithSummary(
    sourceId: string,
    newModelId: string,
    opts?: SessionCreateOpts,
  ): Promise<HydratedSession>;
  createWorktree(
    sessionId: string,
    opts: { branchName: string; baseBranch: string; configFiles?: string[] },
  ): Promise<SessionWorktree>;
  removeWorktree(sessionId: string): Promise<void>;
}

export interface SessionsRpcOpts {
  /** Sink shared with the events domain — twins user text into v2 parts. */
  sink?: EventSink;
  /** Resolves a workspaceId to its on-disk path (v2 keys sessions by path). */
  workspacePathOf?: (workspaceId: string) => string;
  /** Resolves the chat model for title generation; null skips generation. */
  titleModelOf?: (session: HydratedSession) => TitleModelSource | null;
  /** The LLM title call — injectable so tests never hit the network. */
  generateTitle?: (firstMessage: string, source: TitleModelSource, attachments?: TitleAttachment[]) => Promise<string | null>;
}

/** Straight port of the provider resolution in the tide:generateSessionTitle
 *  handler: a pinned title model wins, else the session's provider, else any
 *  enabled provider carrying the session's model. */
function defaultTitleModelOf(session: HydratedSession): TitleModelSource | null {
  const providers = listProviders();
  const utility = getGeneralSettings().titleModel;
  let modelId = session.modelId;
  let provider = utility
    ? providers.find((p) => p.id === utility.providerId && p.enabled)
    : undefined;
  if (utility && provider) {
    modelId = utility.modelId;
  } else {
    provider = providers.find((p) => p.id === session.providerId);
    if (!provider && session.modelId) {
      provider = providers.find(
        (p) => p.enabled && p.models.some((m) => m.modelId === session.modelId),
      );
    }
  }
  return provider ? { provider, modelId } : null;
}

export function registerSessionsRpc(
  legacy: LegacySessionDomain,
  storeV2: SessionStoreV2,
  opts: SessionsRpcOpts = {},
) {
  const sink = opts.sink;
  const workspacePathOf =
    opts.workspacePathOf ?? ((workspaceId) => listWorkspaces().find((w) => w.id === workspaceId)?.path ?? '');
  const titleModelOf = opts.titleModelOf ?? defaultTitleModelOf;
  const generateTitle = opts.generateTitle ?? generateSessionTitle;

  const twinV2Session = (
    id: string,
    workspaceId: string,
    title: string,
    modelId: string,
    providerId?: string | null,
  ) => {
    try {
      storeV2.createSession({
        id,
        workspacePath: workspacePathOf(workspaceId),
        title,
        modelId,
        providerId: providerId ?? null,
        parentId: null,
      });
    } catch (e) {
      log.warn('v2 twin createSession failed', { id, err: e instanceof Error ? e.message : String(e) });
    }
  };

  const twinV2TextMessage = (sessionId: string, role: 'user' | 'assistant', text: string) => {
    if (!sink || !text.trim()) return;
    try {
      const messageId = newV2MessageId();
      storeV2.insertMessage({ id: messageId, sessionId, role, model: null });
      const part = orchestratorEventToSink(sessionId, messageId, newV2PartId(), { type: 'text-end', text }, 0);
      if (part) sink.emit(part);
    } catch (e) {
      log.warn('v2 twin message failed', { sessionId, err: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    sessionList: ({ workspaceId }: { workspaceId: string }) => legacy.listSessions(workspaceId),

    sessionListDispatches: ({ parentId }: { parentId: string }) => legacy.listDispatches(parentId),

    sessionGet: ({ sessionId }: { sessionId: string }) => legacy.getSession(sessionId) ?? null,

    sessionCreate: ({ workspaceId, title, modelId, opts }: { workspaceId: string; title: string; modelId: string; opts?: SessionCreateOpts }) => {
      const s = legacy.createSession(workspaceId, title, modelId, opts);
      log.info('session created', { id: s.id, workspace: workspaceId, model: modelId });
      twinV2Session(s.id, workspaceId, s.title, modelId, opts?.providerId);
      return s;
    },

    sessionUpdateSettings: ({ sessionId, patch }: { sessionId: string; patch: SessionSettingsPatch }) => {
      legacy.updateSessionSettings(sessionId, patch);
      return {};
    },

    sessionAddMessage: ({ sessionId, role, content, extra }: { sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; extra?: SessionMessageExtra }) => {
      legacy.addMessage(sessionId, role, content, extra);
      if (role === 'user') twinV2TextMessage(sessionId, 'user', content);
      return {};
    },

    sessionAddAssistantMessage: ({ sessionId, message }: { sessionId: string; message: AssistantMessageInput }) => {
      legacy.addAssistantMessage(sessionId, message);
      return {};
    },

    sessionFinalizeAssistantMessage: ({ sessionId, messageId, message }: { sessionId: string; messageId: string; message: FinalizeAssistantMessageInput }) => {
      legacy.finalizeAssistantMessage(sessionId, messageId, message);
      return {};
    },

    sessionAddUsage: ({ sessionId, delta, lastStepUsage }: { sessionId: string; delta: SessionUsageDelta; lastStepUsage?: SessionUsageDelta }) => {
      legacy.addUsage(sessionId, delta, lastStepUsage);
      return {};
    },

    sessionDelete: ({ sessionId }: { sessionId: string }) => {
      legacy.deleteSession(sessionId);
      log.info('session deleted', { id: sessionId });
      return {};
    },

    sessionClearAll: (_: Record<string, never>) => {
      legacy.clearAllSessions();
      log.info('all sessions cleared');
      return { ok: true };
    },

    sessionRename: ({ sessionId, title }: { sessionId: string; title: string }) => {
      legacy.renameSession(sessionId, title);
      return {};
    },

    sessionGenerateTitle: async ({ sessionId }: { sessionId: string }) => {
      try {
        const session = legacy.getSession(sessionId);
        if (!session) return { title: null };
        const firstUser = session.messages.find((m) => m.role === 'user');
        if (!firstUser) return { title: null };
        // Attachment-only sends (files, long pastes → virtual attachments)
        // persist empty content — the title comes from the attachment names.
        const firstText = String(firstUser.content ?? '');
        const attachments = (firstUser.attachments ?? []) as TitleAttachment[];
        if (!firstText.trim() && attachments.length === 0) return { title: null };
        const source = titleModelOf(session);
        if (!source) return { title: null };
        const title = await generateTitle(firstText, source, attachments);
        if (title) legacy.renameSession(sessionId, title);
        return { title };
      } catch (e) {
        log.warn('sessionGenerateTitle failed', { err: e instanceof Error ? e.message : String(e) });
        return { title: null };
      }
    },

    sessionArchive: ({ sessionId }: { sessionId: string }) => {
      legacy.archiveSession(sessionId);
      return {};
    },

    sessionUnarchive: ({ sessionId }: { sessionId: string }) => {
      legacy.unarchiveSession(sessionId);
      return {};
    },

    sessionListArchived: ({ workspaceId }: { workspaceId: string }) => legacy.listArchivedSessions(workspaceId),

    sessionCreateWorktree: ({ sessionId, opts }: { sessionId: string; opts: { branchName: string; baseBranch: string; configFiles?: string[] } }) =>
      legacy.createWorktree(sessionId, opts),

    sessionRemoveWorktree: async ({ sessionId }: { sessionId: string }) => {
      await legacy.removeWorktree(sessionId);
      return {};
    },

    sessionFork: async ({ sourceId, newModelId, opts }: { sourceId: string; newModelId: string; opts?: SessionCreateOpts }) => {
      const forked = await legacy.forkWithSummary(sourceId, newModelId, opts);
      log.info('session forked', { source: sourceId, fork: forked.id, model: newModelId });
      return forked;
    },

    sessionListV2: ({ workspacePath, opts }: { workspacePath: string; opts?: SessionListOptsV2 }) =>
      storeV2.listSessions(workspacePath, opts ?? {}),

    sessionMessagesV2: ({ sessionId, opts }: { sessionId: string; opts?: SessionWindowOptsV2 }) =>
      storeV2.sessionMessages(sessionId, opts ?? {}),
  };
}
