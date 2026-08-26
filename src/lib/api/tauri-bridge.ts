/** Tauri bridge installer — the active half of the rpc seam. Runs the
 *  `bridge_version` handshake and, only on a protocol match, installs the
 *  invoke-backed client via activateRpcClient (flipping the live `rpc`/
 *  `hasRpc` bindings, which routes client.ts off the mock store). Every
 *  failure mode is non-fatal: one console.warn and the app stays on the mock
 *  store — never a crash, never a half-installed bridge.
 *
 *  Command coverage is M1-scoped (workspaces / sessions-v2 / settings /
 *  providers). Every OTHER TideRPC method resolves to an async rejection via
 *  the request Proxy — never a sync throw, so fire-and-forget `void` calls in
 *  client.ts can't escape a React commit. Push channels (terminal output,
 *  orchestrator/agent events, git changed…) stay on rpc.ts's single-slot
 *  registries: nothing forwards into them until M2 wires Tauri Channels to
 *  the emit* seams. */
import { activateRpcClient, type TideRpcClient } from './rpc';
import type {
  AgentSettingsWire,
  GeneralSettingsWire,
  Provider,
  SessionMessageV2,
  SessionMetaV2,
  Workspace,
} from '@shared/rpc';

/** Must match BRIDGE_PROTOCOL in src-tauri/src/commands/bridge.rs. */
const BRIDGE_PROTOCOL = 1;

const NOT_PORTED = '[tide] RPC method not ported yet (Tauri rewrite M2+)';

type InvokeFn = typeof import('@tauri-apps/api/core').invoke;

type M1Methods = Pick<
  TideRpcClient['request'],
  | 'workspaceList'
  | 'sessionListV2'
  | 'sessionMessagesV2'
  | 'settingsGetAgent'
  | 'settingsUpdateAgent'
  | 'settingsGetGeneral'
  | 'settingsUpdateGeneral'
  | 'providerList'
>;

/** Params pass through verbatim: Tauri v2 maps camelCase JSON keys onto the
 *  snake_case Rust command params (workspacePath → workspace_path), which is
 *  exactly the TideRPC wire shape client.ts already sends. */
function createBridgeClient(invoke: InvokeFn): TideRpcClient {
  const methods: M1Methods = {
    workspaceList: (params) => invoke<Workspace[]>('workspace_list', params),
    sessionListV2: (params) =>
      invoke<{ sessions: SessionMetaV2[]; nextCursor: string | null }>('session_list_v2', params),
    sessionMessagesV2: (params) =>
      invoke<{ messages: SessionMessageV2[]; nextBefore: string | null }>('session_messages_v2', params),
    settingsGetAgent: (params) => invoke<AgentSettingsWire>('settings_get_agent', params),
    settingsUpdateAgent: (params) => invoke<AgentSettingsWire>('settings_update_agent', params),
    settingsGetGeneral: (params) => invoke<GeneralSettingsWire>('settings_get_general', params),
    settingsUpdateGeneral: (params) => invoke<GeneralSettingsWire>('settings_update_general', params),
    providerList: (params) => invoke<Provider[]>('provider_list', params),
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

/** Try to install the real bridge. True once the handshake validated and the
 *  client went live; false — never a throw — outside the webview, on a missing
 *  or old backend, or on any other failure (boot resilience: the renderer must
 *  keep running on the mock store). */
export async function installTauriBridge(): Promise<boolean> {
  if (typeof globalThis.__TAURI_INTERNALS__ === 'undefined') return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const handshake = await invoke<{ version: string; protocol: number }>('bridge_version');
    if (!handshake || handshake.protocol !== BRIDGE_PROTOCOL) {
      console.warn('[tide] bridge protocol mismatch — staying on the mock store:', handshake);
      return false;
    }
    activateRpcClient(createBridgeClient(invoke));
    return true;
  } catch (err) {
    console.warn('[tide] bridge install failed — staying on the mock store:', err);
    return false;
  }
}
