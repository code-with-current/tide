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
 *  `eventsSubscribe` replay pair), and the M4 T1 OS/window glue (window
 *  controls, dialogs, shell opener, clipboard persistence, log/env/
 *  diagnostics, macOS permission consent, pid liveness, mermaid repair,
 *  external/image reads, and the settings.json shortcut trio —
 *  `permissionRequest`'s `type` param remaps onto `permission_type` since
 *  `type` can't be a Rust identifier). Every OTHER TideRPC method resolves
 *  to an async rejection via the request Proxy — never a sync throw, so
 *  fire-and-forget `void` calls in client.ts can't escape a React commit.
 *  Agent/orchestrator pushes arrive on the single `chat_attach_channel`
 *  Channel and fan out through rpc.ts's emit* seams (the on*-registered
 *  single-slot callbacks); every other push channel (terminal output, git
 *  changed…) stays dormant until a later milestone wires it.
 *
 *  M4 T2 adds the session + workspace management domains (27 methods):
 *  session get/rename/archive/unarchive/delete/updateSettings/fork/
 *  listDispatches/addMessage/assistant trio/generateTitle/clearAll/
 *  worktree pair, and workspace get/add/update/archive/unarchive/delete/
 *  contextGet/fileRead/listBranches/listConfigFiles/workspacesExist.
 *  All pass their TideRPC params through verbatim — Tauri's camelCase →
 *  snake_case param mapping covers every one (no reserved words in this
 *  batch, unlike T1's permissionRequest remap).
 *
 *  M4 T3 adds the git panel domain (30 methods): status/diff/stagedDiff/log/
 *  commitFiles/commitFileDiff/commitMessage/bulk/stashList/stage/restoreFile/
 *  discardFile/commit/amend/revert/aheadBehind/headSha/branchInfo/
 *  branchesDetailed/createBranch/deleteBranch/checkout/recentBranches/
 *  mergeBranch/conflictFiles/resolveFile/fetch/pull/push — all git2 in the
 *  backend — plus gitRepoDetect (the workspaces-rpc detection entry). Every
 *  method passes its GitSessionScope params through verbatim; the gitChanged
 *  watcher push stays dormant (no bridge channel yet — the panel polls). */
import {
  activateRpcClient,
  emitAgentEvent,
  emitOrchestratorEvents,
  emitTodosUpdated,
  type TideRpcClient,
} from './rpc';
import type { AgentEvent } from '@/lib/agent/events';
import type {
  AgentSettingsWire,
  ArchivedSessionHeader,
  ChatSendResult,
  DiagnosticsInfo,
  EnvInfo,
  ExternalFileContent,
  FlushBatch,
  GeneralSettingsWire,
  GitAheadBehindResult,
  GitBranchDetailed,
  GitBranchInfoResult,
  GitCommit,
  GitCommitResult,
  GitConflictEntry,
  GitFileChange,
  GitMergeResult,
  GitOpResult,
  GitRevertResult,
  GitRepoInfo,
  GitStash,
  HydratedSession,
  ImageFileContent,
  MacPermissionStatus,
  MermaidRepairResult,
  Provider,
  SessionHeader,
  SessionMessageV2,
  SessionMetaV2,
  SessionWorktree,
  ShellOpResult,
  TodosUpdatedEvent,
  Workspace,
  WorkspaceFileReadResult,
} from '@shared/rpc';
import type { DiffHunk } from '@/types';

/** Must match BRIDGE_PROTOCOL in src-tauri/src/commands/bridge.rs. */
const BRIDGE_PROTOCOL = 1;

/** GitSessionScope is an interface (no implicit index signature), so the
 *  invoke args need this widening cast — the payload still passes through
 *  verbatim, like every other domain. */
const gitArgs = (params: object): Record<string, unknown> => params as Record<string, unknown>;

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
  | 'sessionGet'
  | 'sessionRename'
  | 'sessionArchive'
  | 'sessionUnarchive'
  | 'sessionDelete'
  | 'sessionUpdateSettings'
  | 'sessionFork'
  | 'sessionListDispatches'
  | 'sessionAddMessage'
  | 'sessionAddAssistantMessage'
  | 'sessionFinalizeAssistantMessage'
  | 'sessionAddUsage'
  | 'sessionGenerateTitle'
  | 'sessionClearAll'
  | 'sessionCreateWorktree'
  | 'sessionRemoveWorktree'
  | 'workspaceGet'
  | 'workspaceAdd'
  | 'workspaceUpdate'
  | 'workspaceArchive'
  | 'workspaceUnarchive'
  | 'workspaceDelete'
  | 'workspaceContextGet'
  | 'workspaceFileRead'
  | 'workspaceListBranches'
  | 'workspaceListConfigFiles'
  | 'workspacesExist'
  | 'chatSend'
  | 'chatAbort'
  | 'chatApproveTools'
  | 'chatRejectTools'
  | 'chatSubmitFollowup'
  | 'eventsSubscribe'
  | 'eventsUnsubscribe'
  | 'lastSessionGet'
  | 'lastSessionSet'
  | 'consentShouldShow'
  | 'windowClose'
  | 'windowMinimize'
  | 'windowToggleMaximize'
  | 'windowIsFullScreen'
  | 'dialogPickFiles'
  | 'dialogPickDirectory'
  | 'shellOpenExternal'
  | 'shellOpenPath'
  | 'shellShowItemInFolder'
  | 'clipboardFileSave'
  | 'logSend'
  | 'envInfoGet'
  | 'diagnosticsGet'
  | 'permissionStatusGet'
  | 'permissionRequest'
  | 'processIsAlive'
  | 'mermaidRepair'
  | 'externalFileRead'
  | 'imageFileRead'
  | 'settingsGet'
  | 'settingsSetShortcut'
  | 'settingsResetShortcuts'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitStagedDiff'
  | 'gitLog'
  | 'gitCommitFiles'
  | 'gitCommitFileDiff'
  | 'gitCommitMessage'
  | 'gitBulk'
  | 'gitStashList'
  | 'gitStage'
  | 'gitRestoreFile'
  | 'gitDiscardFile'
  | 'gitCommit'
  | 'gitAmend'
  | 'gitRevert'
  | 'gitAheadBehind'
  | 'gitHeadSha'
  | 'gitBranchInfo'
  | 'gitBranchesDetailed'
  | 'gitCreateBranch'
  | 'gitDeleteBranch'
  | 'gitCheckout'
  | 'gitRecentBranches'
  | 'gitMergeBranch'
  | 'gitConflictFiles'
  | 'gitResolveFile'
  | 'gitFetch'
  | 'gitPull'
  | 'gitPush'
  | 'gitRepoDetect'
>;

/** One message off the Rust ChatPush stream (`agent/events.rs`): the `channel`
 *  tag mirrors the webview message names in shared/rpc.ts so routing uses
 *  the same discriminator the Electrobun push did. Payload shapes are the
 *  shared/rpc.ts AgentEvent / FlushBatch / TodosUpdatedEvent verbatim. */
type ChatPush =
  | { channel: 'agentEvents'; event: AgentEvent }
  | { channel: 'orchestratorEvents'; batch: FlushBatch }
  | { channel: 'todosUpdated'; event: TodosUpdatedEvent };

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
    sessionGet: (params) => invoke<HydratedSession | null>('session_get', params),
    sessionRename: (params) => invoke('session_rename', params),
    sessionArchive: (params) => invoke('session_archive', params),
    sessionUnarchive: (params) => invoke('session_unarchive', params),
    sessionDelete: (params) => invoke('session_delete', params),
    sessionUpdateSettings: (params) => invoke('session_update_settings', params),
    sessionFork: (params) => invoke<HydratedSession>('session_fork', params),
    sessionListDispatches: (params) => invoke<SessionHeader[]>('session_list_dispatches', params),
    sessionAddMessage: (params) => invoke('session_add_message', params),
    sessionAddAssistantMessage: (params) => invoke('session_add_assistant_message', params),
    sessionFinalizeAssistantMessage: (params) => invoke('session_finalize_assistant_message', params),
    sessionAddUsage: (params) => invoke('session_add_usage', params),
    sessionGenerateTitle: (params) => invoke<{ title: string | null }>('session_generate_title', params),
    sessionClearAll: (params) => invoke<{ ok: boolean }>('session_clear_all', params),
    sessionCreateWorktree: (params) => invoke<SessionWorktree>('session_create_worktree', params),
    sessionRemoveWorktree: (params) => invoke('session_remove_worktree', params),
    workspaceGet: (params) => invoke<Workspace | null>('workspace_get', params),
    workspaceAdd: (params) => invoke<Workspace>('workspace_add', params),
    workspaceUpdate: (params) => invoke<Workspace | null>('workspace_update', params),
    workspaceArchive: (params) => invoke('workspace_archive', params),
    workspaceUnarchive: (params) => invoke('workspace_unarchive', params),
    workspaceDelete: (params) => invoke<{ ok: boolean; error?: string }>('workspace_delete', params),
    workspaceContextGet: (params) => invoke<string>('workspace_context_get', params),
    workspaceFileRead: (params) => invoke<WorkspaceFileReadResult>('workspace_file_read', params),
    workspaceListBranches: (params) => invoke<string[]>('workspace_list_branches', params),
    workspaceListConfigFiles: (params) => invoke<string[]>('workspace_list_config_files', params),
    workspacesExist: (params) => invoke<Record<string, boolean>>('workspaces_exist', params),
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
    chatSubmitFollowup: (params) =>
      invoke<{ resolved: boolean }>('chat_submit_followup', { args: params }),
    eventsSubscribe: (params) => invoke<{ batches: FlushBatch[] }>('events_subscribe', params),
    eventsUnsubscribe: (params) => invoke('events_unsubscribe', params),
    lastSessionGet: (params) => invoke<{ sessionId: string | null; workspaceId: string | null }>('last_session_get', params),
    lastSessionSet: (params) => invoke('last_session_set', params),
    consentShouldShow: (params) => invoke<{ shouldShow: boolean }>('consent_should_show', params),
    windowClose: (params) => invoke('window_close', params),
    windowMinimize: (params) => invoke('window_minimize', params),
    windowToggleMaximize: (params) => invoke<{ maximized: boolean }>('window_toggle_maximize', params),
    windowIsFullScreen: (params) => invoke<{ fullscreen: boolean }>('window_is_full_screen', params),
    dialogPickFiles: (params) => invoke<{ paths: string[] }>('dialog_pick_files', params),
    dialogPickDirectory: (params) => invoke<{ path: string | null }>('dialog_pick_directory', params),
    shellOpenExternal: (params) => invoke<{ ok: boolean }>('shell_open_external', params),
    shellOpenPath: (params) => invoke<ShellOpResult>('shell_open_path', params),
    shellShowItemInFolder: (params) => invoke('shell_show_item_in_folder', params),
    clipboardFileSave: (params) => invoke<{ path: string }>('clipboard_file_save', params),
    logSend: (params) => invoke('log_send', params),
    envInfoGet: (params) => invoke<EnvInfo>('env_info_get', params),
    diagnosticsGet: (params) => invoke<DiagnosticsInfo>('diagnostics_get', params),
    permissionStatusGet: (params) => invoke<MacPermissionStatus>('permission_status_get', params),
    permissionRequest: (params) =>
      invoke<{ result: 'opened' | 'unavailable' }>('permission_request', {
        permissionType: params.type,
      }),
    processIsAlive: (params) => invoke<{ alive: boolean }>('process_is_alive', params),
    mermaidRepair: (params) => invoke<MermaidRepairResult>('mermaid_repair', params),
    externalFileRead: (params) => invoke<ExternalFileContent | null>('external_file_read', params),
    imageFileRead: (params) => invoke<ImageFileContent | null>('image_file_read', params),
    settingsGet: (params) =>
      invoke<{ overrides: Record<string, string[]>; defaults: Record<string, string[]> }>('settings_get', params),
    settingsSetShortcut: (params) =>
      invoke<{ overrides: Record<string, string[]> }>('settings_set_shortcut', params),
    settingsResetShortcuts: (params) =>
      invoke<{ overrides: Record<string, string[]> }>('settings_reset_shortcuts', params),
    gitStatus: (params) => invoke<GitFileChange[]>('git_status', gitArgs(params)),
    gitDiff: (params) => invoke<DiffHunk[]>('git_diff', gitArgs(params)),
    gitStagedDiff: (params) => invoke<{ text: string }>('git_staged_diff', gitArgs(params)),
    gitLog: (params) => invoke<GitCommit[]>('git_log', gitArgs(params)),
    gitCommitFiles: (params) => invoke<GitFileChange[]>('git_commit_files', gitArgs(params)),
    gitCommitFileDiff: (params) => invoke<DiffHunk[]>('git_commit_file_diff', gitArgs(params)),
    gitCommitMessage: (params) => invoke<{ text: string }>('git_commit_message', gitArgs(params)),
    gitBulk: (params) => invoke<GitOpResult>('git_bulk', gitArgs(params)),
    gitStashList: (params) => invoke<GitStash[]>('git_stash_list', gitArgs(params)),
    gitStage: (params) => invoke<GitOpResult>('git_stage', gitArgs(params)),
    gitRestoreFile: (params) => invoke<GitOpResult>('git_restore_file', gitArgs(params)),
    gitDiscardFile: (params) => invoke<GitOpResult>('git_discard_file', gitArgs(params)),
    gitCommit: (params) => invoke<GitCommitResult>('git_commit', gitArgs(params)),
    gitAmend: (params) => invoke<GitCommitResult>('git_amend', gitArgs(params)),
    gitRevert: (params) => invoke<GitRevertResult>('git_revert', gitArgs(params)),
    gitAheadBehind: (params) =>
      invoke<GitAheadBehindResult | null>('git_ahead_behind', gitArgs(params)),
    gitHeadSha: (params) => invoke<{ sha: string | null }>('git_head_sha', gitArgs(params)),
    gitBranchInfo: (params) => invoke<GitBranchInfoResult>('git_branch_info', gitArgs(params)),
    gitBranchesDetailed: (params) =>
      invoke<GitBranchDetailed[]>('git_branches_detailed', gitArgs(params)),
    gitCreateBranch: (params) => invoke<GitOpResult>('git_create_branch', gitArgs(params)),
    gitDeleteBranch: (params) => invoke<GitOpResult>('git_delete_branch', gitArgs(params)),
    gitCheckout: (params) => invoke<GitOpResult>('git_checkout', gitArgs(params)),
    gitRecentBranches: (params) => invoke<string[]>('git_recent_branches', gitArgs(params)),
    gitMergeBranch: (params) => invoke<GitMergeResult>('git_merge_branch', gitArgs(params)),
    gitConflictFiles: (params) => invoke<GitConflictEntry[]>('git_conflict_files', gitArgs(params)),
    gitResolveFile: (params) => invoke<GitOpResult>('git_resolve_file', gitArgs(params)),
    gitFetch: (params) => invoke<GitOpResult>('git_fetch', gitArgs(params)),
    gitPull: (params) => invoke<GitOpResult>('git_pull', gitArgs(params)),
    gitPush: (params) => invoke<GitOpResult>('git_push', gitArgs(params)),
    gitRepoDetect: (params) => invoke<GitRepoInfo | null>('git_repo_detect', gitArgs(params)),
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
    else if (push.channel === 'todosUpdated') emitTodosUpdated(push.event);
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
