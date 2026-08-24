
import { app, BrowserWindow, shell, ipcMain, protocol } from 'electron';

try {
  process.loadEnvFile();
} catch {
  try {
    process.loadEnvFile(`${import.meta.dirname}/../.env`);
  } catch {
    /* .env not present — fine; system-model no-ops when unconfigured. */
  }
}

(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.disableHardwareAcceleration = false;
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { initLogger, createLogger } from './logger.js';
import { registerIpcHandlers, bootstrapCatalog } from './ipc/handlers.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerAgentSdkHandlers, abortAllTurns } from './agent/orchestrator.js';
import { getSessionStore, registerSessionV2Handlers } from './ipc/sessions.js';
import { createSessionStoreV2, type SessionStoreV2 } from './ipc/session-store-v2.js';
import { registerEventsIpc } from './ipc/events.js';
import type { EventSink } from './agent/event-sink.js';
import { registerScriptHandlers, killAllScripts } from './ipc/scripts.js';
import { killAllBackgroundShells } from './agent/tools/background-shell.js';
import { registerOpenInAppHandlers } from './ipc/openInApp.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerExtensionsHandlers } from './ipc/extensions.js';
import { initModelCatalog, enrichExistingModels } from './agent/model-capabilities.js';
// Inlined bundled models.dev catalog — Vite bundles this JSON into main.mjs so
// the baseline ships with the app (electron/data isn't included in the build).
import bundledModelCatalog from './data/model-prices.json';
import { registerMcpHandlers } from './ipc/mcp.js';
import { registerSourcesHandlers } from './ipc/sources.js';
import { syncAllWorkspaceHooks } from './git-coauthor.js';
import { initUserServers, initBuiltinServers } from './agent/mcp/pool.js';
import { migrateOAuthFiles } from './agent/mcp/config.js';
import { handleOAuthCallback } from './agent/mcp/oauth.js';
import { setUserDataPath, appDataDir } from './appPaths.js';
import { initUpdater, autoCheckForUpdates } from './updater.js';
import { clearBadge } from './badge.js';

// ESM doesn't provide __dirname — derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// Dev uses `tide-dev://` so OAuth callbacks route to the dev instance, not the
// installed Tide.app (which owns `tide://`). Prod keeps `tide://`.
const PROTOCOL = isDev ? 'tide-dev' : 'tide';
const OAUTH_CALLBACK = `${PROTOCOL}://oauth/callback`;

// Register the protocol scheme as privileged BEFORE app ready: `standard` parses it like a normal URL, `secure` gives a same-origin context (cookies), and `supportFetchAPI` lets the MCP SDK fetch against it during the PKCE metadata-exchange step. Must run before app.whenReady() or it throws.
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const log = createLogger('main');

let mainWindow: BrowserWindow | null = null;

// Stream-event sink for the part-normalized store — created on app ready,
// flushed on quit. Task 6 threads it into the orchestrator.
let eventSink: EventSink | null = null;
let sessionStoreV2: SessionStoreV2 | null = null;

// The currently active workspace — the MCP pool uses its root for project-scoped servers (.mcp.json), and MCP IPC uses it to pick which config file to mutate. Set by the `tide:mcp:workspaceActivated` IPC handler when the active workspace changes.
let activeWorkspace: { id: string; root: string } | undefined;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : {
          titleBarOverlay: {
            color: '#00000000',        // transparent — let the app top bar show through behind the glyphs
            symbolColor: '#8b94a3',    // matches --color-muted-foreground
            height: 40,                // matches WindowTopBar h-10
          },
        }),
    transparent: false,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // <webview> for the right-panel Browser tab. The webview runs with its
      // own isolated guest context — no node, no preload bridging.
      webviewTag: true,
      // Native overlay scrollbars (macOS-style auto-hide) for every frame.
      enableBlinkFeatures: 'OverlayScrollbars',
    },
  });

  mainWindow.once('ready-to-show', () => {
    log.info('window ready-to-show → visible');
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () =>
    log.info('renderer did-finish-load'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log.error('renderer did-fail-load', { code, desc, url }));

  // Open external links in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Rejection here (no default browser handler, OS refusal) would otherwise
      // surface as an unhandledRejection — log it instead.
      shell.openExternal(url).catch((e) =>
        log.warn('openExternal failed', { url, error: String(e) }));
    }
    return { action: 'deny' };
  });

  mainWindow.on('enter-full-screen', () =>
    mainWindow?.webContents.send('tide:window:fullscreen', true));
  mainWindow.on('leave-full-screen', () =>
    mainWindow?.webContents.send('tide:window:fullscreen', false));

  // Returning to the app reads every completed-turn notification — drop the
  // dock badge count.
  mainWindow.on('focus', () => clearBadge());
  mainWindow.on('show', () => {
    if (mainWindow?.isFocused()) clearBadge();
  });

  // Block navigation away from the app — except OAuth callbacks.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(OAUTH_CALLBACK)) {
      handleOAuthCallback(url);
      return; // don't preventDefault — let it fail silently
    }
    e.preventDefault();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    // dist/index.html is one level up from dist-electron/
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}


const gotLock = isDev || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const earlyOAuthUrls: string[] = [];
  app.on('open-url', (event, url) => {
    if (url.startsWith(OAUTH_CALLBACK)) {
      event.preventDefault();
      log.info('open-url: OAuth callback received', { url: url.slice(0, 50) + '…' });
      earlyOAuthUrls.push(url);
    }
  });

  app.on('second-instance', (_event, argv, _workingDirectory, _additionalData) => {
    const lastArg = argv[argv.length - 1];
    if (lastArg?.startsWith(OAUTH_CALLBACK)) {
      log.info('second-instance: OAuth callback received', { url: lastArg.slice(0, 50) + '…' });
      handleOAuthCallback(lastArg);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const t0 = Date.now();
    setUserDataPath(isDev);

    if (process.platform === 'win32') {
      app.setAppUserModelId('com.tide.app');
    }

    app.setAsDefaultProtocolClient(PROTOCOL);

    protocol.handle(PROTOCOL, (request) => {
      log.info('protocol.handle: OAuth intercepted', { url: request.url.slice(0, 50) + '…' });
      handleOAuthCallback(request.url);
      return new Response('OK', { status: 200 });
    });
    for (const url of earlyOAuthUrls) {
      handleOAuthCallback(url);
    }
    earlyOAuthUrls.length = 0;
    app.on('open-url', (event, url) => {
      if (url.startsWith(OAUTH_CALLBACK)) {
        event.preventDefault();
        log.info('open-url: OAuth callback received (post-ready)', { url: url.slice(0, 50) + '…' });
        handleOAuthCallback(url);
      }
    });

    initLogger(path.join(appDataDir(), 'logs'));
    log.info('app ready', { dev: isDev, userData: appDataDir() });

    // Part-normalized sessions (v2): rename the legacy JSON sessions/ dir
    // aside BEFORE any code path can read it — the legacy store mkdirs an
    // empty dir on first load, so it simply degrades to an empty store.
    const legacySessionsDir = path.join(appDataDir(), 'sessions');
    if (fs.existsSync(legacySessionsDir)) {
      const legacyDest = path.join(appDataDir(), 'sessions.legacy');
      if (!fs.existsSync(legacyDest)) fs.renameSync(legacySessionsDir, legacyDest);
    }
    const storeV2 = createSessionStoreV2(path.join(appDataDir(), 'sessions-v2.db'));
    sessionStoreV2 = storeV2;
    registerSessionV2Handlers(ipcMain, storeV2);
    eventSink = registerEventsIpc(ipcMain, storeV2);

    registerIpcHandlers({ sink: eventSink ?? undefined, storeV2: sessionStoreV2 ?? undefined });
    // Settings handlers MUST be ready before the window shows — the renderer
    registerSettingsHandlers();
    // Read-side companion to the fullscreen events sent from createWindow —
    ipcMain.handle('tide:window:isFullScreen', () => mainWindow?.isFullScreen() ?? false);
    log.info('core IPC handlers registered', { ms: Date.now() - t0 });

    // Sync co-author hooks for all workspaces (settings may have changed
    // while the app was closed).
    try { syncAllWorkspaceHooks(); } catch { /* non-fatal */ }

    // Create the window NOW — don't block first paint on the remaining handlers. Renderer needs core IPC (workspaces/sessions/settings, registered above) on mount; chat/agent/MCP/extensions are only used on user action, so deferred to next tick via setImmediate. Cuts time-to-first-paint by the cost of loading + registering ~6 handler modules.
    createWindow();
    log.info('window created', { ms: Date.now() - t0 });

    // Deferred (non-critical) registration — runs before the next event-loop turn so handlers are ready by the time the renderer bundle loads and the user can interact. Order within this block doesn't matter (none call each other at registration time).
    setImmediate(() => {
      const t1 = Date.now();
      // Bootstrap the OpenRouter catalog — the universal metadata source. When
      // a provider's /models returns bare ids (z.ai, OpenAI direct), we enrich
      // them from this catalog. Fire-and-forget; cached to disk, refreshed weekly.
      void bootstrapCatalog();
      // Load the models.dev catalog (bundled baseline, refreshed weekly) so the
      // runtime token budget + capability lookups resolve real limits for models
      // whose provider-config entry omits contextWindow / max_completion_tokens.
      void initModelCatalog({ bundled: bundledModelCatalog, cacheDir: appDataDir() })
        .then(enrichExistingModels);
      registerChatHandlers();
      registerAgentSdkHandlers(ipcMain, { sink: eventSink ?? undefined, storeV2: sessionStoreV2 ?? undefined });
      registerScriptHandlers();
      registerOpenInAppHandlers();
      registerExtensionsHandlers();
      // Migrate old separate OAuth files into unified mcp.json (one-time).
      migrateOAuthFiles();

      // Apply Start at Login setting from stored config on boot — the toggle
      // in Settings applies it immediately, but if the user reinstalls or
      // edits config.json directly, the OS login item could drift. This
      // sync ensures the login item always matches the stored preference.
      try {
        const { createConfigStore } = require('./configStore.js') as typeof import('./configStore.js');
        const cfgStore = createConfigStore(appDataDir());
        const gs = cfgStore.getGeneralSettings();
        app.setLoginItemSettings({ openAtLogin: gs.startAtLogin });
      } catch (e) {
        log.warn('failed to apply startAtLogin on boot', { err: String(e) });
      }
      // Auto-updater: register IPC handlers + begin checking if enabled.
      // In dev, initUpdater no-ops (no app-update.yml).
      initUpdater();
      try {
        const { createConfigStore } = require('./configStore.js') as typeof import('./configStore.js');
        const gs = createConfigStore(appDataDir()).getGeneralSettings();
        if (gs.autoUpdateCheck !== false) {
          // Delay so it doesn't compete with startup network activity.
          setTimeout(() => void autoCheckForUpdates(), 8_000);
        }
      } catch { /* non-fatal */ }
      // MCP pool — boot user-scoped servers (~/.tide/mcp.json). Project-scoped
      // servers are connected lazily when the renderer signals the active
      // workspace via `tide:mcp:workspaceActivated`. Init is fire-and-forget;
      // failures (e.g. no config yet) just log and leave an empty pool.
      initUserServers().catch((e) =>
        log.warn('mcp pool init failed', { error: String(e) }),
      );
      initBuiltinServers().catch((e) =>
        log.warn('mcp builtin init failed', { error: String(e) }),
      );
      registerMcpHandlers(() => activeWorkspace);
      // Knowledge sources: global registry + ingestion manager. The manager is
      // created here (singleton per app run); the db opens lazily on first use.
      registerSourcesHandlers();
      // The renderer pushes the active workspace whenever it changes so the
      // main process can keep `activeWorkspace` fresh for the MCP handlers
      // and (re)connect project-scoped servers in the pool.
      ipcMain.on(
        'tide:mcp:workspaceActivated',
        (_e, workspaceId: string, workspaceRoot: string) => {
          activeWorkspace = { id: workspaceId, root: workspaceRoot };
        },
      );
      log.info('deferred handlers registered', { ms: Date.now() - t1, total: Date.now() - t0 });
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  killAllScripts();
  killAllBackgroundShells();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Abort active turns BEFORE disposing the sink — their final v2 emissions
  // (message.end/turn.end) buffer now and the dispose flush persists them;
  // after dispose+close the buffer would never flush and the db is gone.
  abortAllTurns();
  eventSink?.dispose();
  sessionStoreV2?.close();
  killAllScripts();
  killAllBackgroundShells();
  // Background dispatches outlive their turn — mark still-running ones
  // interrupted so their rows don't read "running" after restart. They are
  // NOT resumed; interrupted dispatches inject nothing on next launch.
  try {
    for (const s of getSessionStore().listAllDispatches()) {
      if (s.kind === 'subagent' && s.dispatch?.status === 'running') {
        getSessionStore().setDispatchStatus(s.id, 'interrupted');
      }
    }
  } catch { /* store unavailable — nothing to mark */ }
});
