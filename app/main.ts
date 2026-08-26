import { ApplicationMenu, BrowserWindow, BrowserView, Updater, Utils, app } from 'electrobun/main';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TideRPC } from '../shared/rpc';
import { registerSettingsRpc } from './rpc/settings';
import { registerEventsRpc } from './rpc/events';
import { registerSessionsRpc } from './rpc/sessions';
import { registerChatRpc } from './rpc/chat';
import { registerTerminalRpc } from './rpc/terminal';
import { registerMcpRpc } from './rpc/mcp';
import { registerRagRpc } from './rpc/rag';
import { registerSourcesRpc } from './rpc/sources';
import { registerWorkspacesRpc } from './rpc/workspaces';
import { registerProvidersRpc } from './rpc/providers';
import { registerGitRpc } from './rpc/git';
import { registerScriptsRpc } from './rpc/scripts';
import { registerExtensionsRpc } from './rpc/extensions';
import { registerOpenInAppRpc } from './rpc/open-in-app';
import { registerMiscRpc } from './rpc/misc';
import { registerUpdaterRpc } from './updater';
import { registerQuitLifecycle } from './quit-lifecycle';
import { abortAllTurns } from './core/agent/orchestrator';
import { setLocalEmbedderFactory } from './core/rag/resolve.js';
import { createBunLocalEmbedder } from './core/rag/bun-onnx-embedder.js';
import { createSessionStoreV2 } from './core/ipc-adjacent/session-store-v2.js';
import * as legacySessions from './core/ipc-adjacent/sessions.js';
import * as gitCore from './core/ipc-adjacent/git.js';
import * as store from './core/store.js';
import { createExtensionsStore } from './core/extensionsStore.js';
import { setTurnEndUiHooks } from './core/agent/orchestrator.js';
import { initModelCatalog, enrichExistingModels } from './core/agent/model-capabilities.js';
import { initUserServers, initBuiltinServers } from './core/agent/mcp/pool.js';
import { enableOAuthLoopback } from './core/agent/mcp/oauth.js';
import { setBrowserOpener } from './platform/browser';
import { appDataDir, ensureAppDataDir } from './platform/paths';
import { bootstrapProviderKeyMigration } from './platform/key-migration';
import bundledModelCatalog from './core/data/model-prices.json';

ensureAppDataDir();

// Provider-key migration: scans for Electron safeStorage v10 blobs left by
// installs of the retired Electron shell. Synchronous scan, then one async
// attempt off the boot path: the
// keychain read of the ACL-locked "tide Safe Storage" item triggers macOS's
// one-time GUI authorization; approving migrates every key to kcv2 handles
// through the normal store update path. A denied/failed attempt leaves the
// blobs untouched and surfaces keysNeedMigration.
bootstrapProviderKeyMigration({
  configPath: path.join(appDataDir(), 'config.json'),
  reencrypt: (providerId, apiKey) => {
    try {
      return store.updateProvider(providerId, { apiKey }) !== null;
    } catch {
      return false;
    }
  },
});

// Turn-end UI hooks (Electrobun side of the 2.3 seam): window focus is
// tracked from the global focus/blur events (single window), notifications
// ride Utils.showNotification. The Electron shell's badge/dock count and
// click-to-navigate are dropped by design.
let windowFocused = true;
app.on('focus', () => { windowFocused = true; });
app.on('blur', () => { windowFocused = false; });
setTurnEndUiHooks({
  isWindowFocused: () => windowFocused,
  isNotificationSupported: () => process.platform === 'darwin',
  showNotification: (_sender, _sessionId, title, body) => {
    Utils.showNotification({ title, body, silent: false });
  },
});

// One v2 connection for the whole process, shared by the events bridge and
// the sessions handlers (same ownership shape as the Electron shell, which
// hands a single storeV2 to both registrations).
const storeV2 = createSessionStoreV2(path.join(appDataDir(), 'sessions-v2.db'));

// Events domain: the orchestrator-stream bridge. Replay batches ride the
// eventsSubscribe response; live batches ride the orchestratorEvents message.
// The send closure only runs from sink flushes (>=50ms after the first emit),
// by which time rpc below is initialized.
const events = registerEventsRpc(
  () => storeV2,
  (batch) => rpc.send.orchestratorEvents({ params: batch }),
);

// Sessions domain: the legacy JSON store still drives the UI (dual-track);
// creates and user messages twin into the v2 store through the shared sink.
const sessionsHandlers = registerSessionsRpc(legacySessions, storeV2, { sink: events.sink });

// Chat domain: the turn loop. Job pattern — chatSend returns {accepted} while
// the turn runs detached; its durable parts ride the shared sink above and its
// control events (permission_required, retry, turn_end, …) ride the
// agentEvents message through this send closure.
const chatHandlers = registerChatRpc(
  {
    sink: events.sink,
    storeV2,
    send: (event) => rpc.send.agentEvents({ params: event }),
  },
);

// Model catalog (models.dev baseline): drives context-window budgets and
// capability lookups for turns; enrichment back-fills provider model entries.
void initModelCatalog({ bundled: bundledModelCatalog, cacheDir: appDataDir() })
  .then(enrichExistingModels)
  .catch(() => {});

// MCP OAuth (4.3): the devkit's urlSchemes registration is macOS-only and
// needs an /Applications install, so redirects go through a loopback HTTP
// server on an ephemeral 127.0.0.1 port instead — which also finally gives
// dev builds a working OAuth redirect. The consent page opens via the
// browser seam; without wiring it here the seam falls back to
// electron.shell, which doesn't exist in this shell.
setBrowserOpener((url) => { Utils.openExternal(url); });
void enableOAuthLoopback().catch((e) => {
  console.warn('[mcp] oauth loopback unavailable — remote-server sign-in degraded:', e);
});

// MCP pool — boot user-scoped + builtin servers, mirroring the Electron
// shell's fire-and-forget init. Failures leave an empty pool; turns simply
// run without MCP tools.
initUserServers().catch(() => {});
initBuiltinServers().catch(() => {});

// Terminal domain: PTY sessions through the platform seam (Bun terminal API
// on POSIX, patched node-pty on Windows), output coalesced per terminal and
// pushed via terminalOutput/terminalExit/terminalPorts messages.
const terminalHandlers = registerTerminalRpc({
  output: (msg) => rpc.send.terminalOutput({ params: msg }),
  exit: (msg) => rpc.send.terminalExit({ params: msg }),
  ports: (msg) => rpc.send.terminalPorts({ params: msg }),
});

// Local RAG embedder (Bun side of the resolve seam): in-process
// onnxruntime-node inference — spike 1.2 proved the native N-API binding
// under Bun, and ORT's session.run executes on a native thread pool, so the
// event loop (and every RPC request in flight) stays responsive while chunks
// embed. Replaces the Electron shell's utilityProcess child.
setLocalEmbedderFactory(createBunLocalEmbedder);

// MCP domain: server config CRUD + pool lifecycle + status. The pool here is
// the same singleton booted above; every connection-state mutation the UI
// cares about rides the mcpEvents message (renderer re-fetches via mcpList).
const mcpHandlers = registerMcpRpc({
  event: (msg) => rpc.send.mcpEvents({ params: msg }),
});

// RAG domain: Memory & RAG panel status/model download/workspace enablement.
// The two Electron progress channels ride the ragProgress message.
const ragHandlers = registerRagRpc({
  progress: (msg) => rpc.send.ragProgress({ params: msg }),
});

// Knowledge-sources domain: registry CRUD + reindex queue; live ingestion
// progress rides the sourcesProgress message.
const sourcesHandlers = registerSourcesRpc({
  progress: (e) => rpc.send.sourcesProgress({ params: e }),
});

// Workspaces domain: CRUD, the add-workspace flow (clone/scaffold/git-init
// with per-step milestones on the workspaceProgress message), file tree,
// workspace context, sandboxed reads, last-session persistence.
const workspacesHandlers = registerWorkspacesRpc(store, {
  progress: (e) => rpc.send.workspaceProgress({ params: e }),
  listBranches: (workspaceId) => legacySessions.listBranches(workspaceId),
  listConfigFiles: (workspaceId) => legacySessions.listConfigFiles(workspaceId),
});

// Providers domain: CRUD + /models probe + protocol detect + connection test
// + models.dev catalog resolve/refresh + usage metering. The OpenRouter
// enrichment catalog is booted fire-and-forget like the Electron shell did.
const providersHandlers = registerProvidersRpc(store, { dataDir: appDataDir() });

// Git domain: the Git Panel's status/log/branch/remote/conflict surface. The
// watcher's debounced change pings ride the gitChanged message; every op
// resolves its cwd worktree-first, exactly like the Electron handlers.
const gitHandlers = registerGitRpc(gitCore, {
  gitChanged: (msg) => rpc.send.gitChanged({ params: msg }),
  sessionWorktreeOf: (sessionId) => {
    try {
      return legacySessions.getSession(sessionId)?.worktree?.path;
    } catch {
      return undefined;
    }
  },
  workspacePathOf: (workspaceId) => store.listWorkspaces().find((w) => w.id === workspaceId)?.path,
});

// Scripts domain: workspace script spawn/stop with streamed output and
// detected dev-server ports (scriptOutput/scriptExit/scriptPorts messages —
// payload shapes match the Electron script:* channels verbatim).
const scriptsHandlers = registerScriptsRpc({
  events: {
    output: (e) => rpc.send.scriptOutput({ params: e }),
    exit: (e) => rpc.send.scriptExit({ params: e }),
    ports: (e) => rpc.send.scriptPorts({ params: e }),
  },
  workspacePathOf: (workspaceId) => {
    const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
    if (!ws) return null;
    return ws.path.startsWith('~/')
      ? path.join(process.env.HOME || os.homedir(), ws.path.slice(2))
      : ws.path;
  },
});

// Extensions domain: the disabled-set store in appData + the agents/skills
// catalogs (built-ins merged with the workspace scan).
const extensionsHandlers = registerExtensionsRpc(createExtensionsStore(appDataDir()));

// Open-in-app domain: session-folder resolution (worktree → workspace → HOME)
// + launching Finder/Terminal/editors. OS app icons aren't extractable via
// the devkit — the renderer falls back to lucide icons (4.x gap).
const openInAppHandlers = registerOpenInAppRpc({
  resolveSessionPath: (sessionId) => {
    try {
      if (sessionId) {
        const workspaces = store.listWorkspaces();
        const session = legacySessions.getSession(sessionId);
        if (session?.worktree?.path && fs.existsSync(session.worktree.path)) {
          return session.worktree.path;
        }
        if (session?.workspaceId) {
          const ws = workspaces.find((w) => w.id === session.workspaceId);
          if (ws?.path && fs.existsSync(ws.path)) return ws.path;
        }
        const ws = workspaces.find((w) => w.id === sessionId);
        if (ws?.path && fs.existsSync(ws.path)) return ws.path;
      }
    } catch {
      /* fall through to HOME */
    }
    return os.homedir();
  },
});

// The version source is electrobun.config.ts's app.version, baked by hutch
// into the bundle's version.json — Updater.getLocalInfo() reads it in dev and
// packaged builds alike, so the splash badge flips correctly after updates.
// package.json lookups remain as dev-only fallbacks.
let cachedVersion: string | null = null;
async function readAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const info = await Updater.getLocalInfo();
    if (info?.version) return (cachedVersion = info.version);
  } catch { /* fall through */ }
  for (const candidate of [path.join(import.meta.dir, '../../package.json'), path.join(process.cwd(), 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version) return (cachedVersion = pkg.version);
    } catch { /* try next */ }
  }
  return '0.0.0-dev';
}

// Updater domain: the devkit Updater's status stream reduced to the UI phase
// model and pushed via the updateStatus message; the auto schedule keeps the
// Electron shell's boot-delayed cadence (gated on the autoUpdateCheck
// setting) plus the 4h periodic re-check. The dev channel never reports
// updates, so dev boots are no-ops by construction.
const updaterRpc = registerUpdaterRpc({
  send: (status) => rpc.send.updateStatus({ params: status }),
});

// Misc domain: dialogs, attachment file reads, clipboard persistence, env/
// diagnostics, macOS consent, mermaid repair, log forwarding, shell ops,
// fullscreen query, agent/general settings, agents/projects/todos catalog
// (todo pushes ride the todosUpdated message).
const miscHandlers = registerMiscRpc(store, {
  dataDir: appDataDir(),
  getWindow: () => mainWindow ?? null,
  todosUpdated: (e) => rpc.send.todosUpdated({ params: e }),
  appVersion: readAppVersion,
});

const rpc = BrowserView.defineRPC<TideRPC>({
  handlers: {
    requests: {
      ...registerSettingsRpc(),
      ...events.handlers,
      ...sessionsHandlers,
      ...chatHandlers,
      ...terminalHandlers,
      ...mcpHandlers,
      ...ragHandlers,
      ...sourcesHandlers,
      ...workspacesHandlers,
      ...providersHandlers,
      ...gitHandlers,
      ...scriptsHandlers,
      ...extensionsHandlers,
      ...openInAppHandlers,
      ...miscHandlers,
      ...updaterRpc.handlers,
    },
    messages: {},
  },
});

// Quit lifecycle: every quit path (native quit request, signals, and the
// updater's applyUpdate handoff) emits before-quit synchronously — abort and
// persist turns, kill PTYs, then final-flush the event sink before shutdown.
registerQuitLifecycle({
  abortAllTurns,
  disposeTerminals: () => { terminalHandlers.terminalDispose({}); },
  disposeSink: () => { events.sink.dispose(); },
});

// Start the updater's status stream + automatic schedule after the RPC
// bridge exists (its sends ride rpc above).
updaterRpc.start();

const mainWindow = new BrowserWindow({
  title: 'Tide',
  url: 'views://mainview/index.html',
  frame: {
    width: 1440,
    height: 900,
  },
  titleBarStyle: 'hiddenInset' as const,
  ...(process.platform === 'darwin' ? { trafficLightOffset: { x: 12, y: 12 } } : {}),
  rpc,
});

ApplicationMenu.setApplicationMenu([
  { label: 'File', submenu: [{ role: 'quit' }] },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
]);
