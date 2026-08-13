/** Electron main process: window creation, lifecycle, and IPC registration (contextIsolation on, nodeIntegration off, custom frameless titleBar, external links in OS browser, navigation blocked). */

import { app, BrowserWindow, shell, ipcMain, protocol } from 'electron';

// Load .env before anything else reads process.env (system model + TIDE_DEBUG_SDK are read lazily via IPC, so this wins the race). Optional — its absence means system-model tasks no-op (title gen returns null). ESM hoists imports above this body but nothing below reads env at module-eval time.
try {
  process.loadEnvFile();
} catch {
  // cwd isn't the project root (some launch paths): fall back to <project>/.env
  // resolved from this module (dist-electron/main.mjs → ../.  env).
  try {
    process.loadEnvFile(`${import.meta.dirname}/../.env`);
  } catch {
    /* .env not present — fine; system-model no-ops when unconfigured. */
  }
}

// ── Suppress AI SDK warnings ─────────────────────────────────────────
// Some OpenAI-compatible providers (z.ai GLM via Anthropic protocol) return reasoning metadata the AI SDK's Anthropic adapter doesn't recognize, producing "unsupported reasoning metadata" warnings on every tool-call step. Noise — the response is correct; the adapter just doesn't know about z.ai's extra fields. Suppress globally before the AI SDK loads.
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

// ── GPU / Hardware Acceleration ──────────────────────────────────────
// Ensure hardware acceleration is enabled (it's on by default, but some
// environments disable it). These flags also help with the `transparent`
// window mode by forcing GPU compositing instead of software fallback.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.disableHardwareAcceleration = false;
import * as path from 'path';
import { fileURLToPath } from 'url';
import { initLogger, createLogger } from './logger.js';
import { registerIpcHandlers, bootstrapCatalog } from './ipc/handlers.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerAgentSdkHandlers, abortAllTurns } from './agent/orchestrator.js';
import { registerScriptHandlers, killAllScripts } from './ipc/scripts.js';
import { killAllBackgroundShells } from './agent/tools/background-shell.js';
import { registerOpenInAppHandlers } from './ipc/openInApp.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerExtensionsHandlers } from './ipc/extensions.js';
import { initModelCatalog, enrichModelFromCatalog, getActiveCatalog } from './agent/model-capabilities.js';
import { listProviders, updateProvider } from './store.js';
// Inlined bundled models.dev catalog — Vite bundles this JSON into main.mjs so
// the baseline ships with the app (electron/data isn't included in the build).
import bundledModelCatalog from './data/model-prices.json';
import { registerMcpHandlers } from './ipc/mcp.js';
import { syncAllWorkspaceHooks } from './git-coauthor.js';
import { initUserServers, initBuiltinServers } from './agent/mcp/pool.js';
import { migrateOAuthFiles } from './agent/mcp/config.js';
import { handleOAuthCallback } from './agent/mcp/oauth.js';
import { setUserDataPath, appDataDir } from './appPaths.js';

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

// The currently active workspace — the MCP pool uses its root for project-scoped servers (.mcp.json), and MCP IPC uses it to pick which config file to mutate. Set by the `tide:mcp:workspaceActivated` IPC handler when the active workspace changes.
let activeWorkspace: { id: string; root: string } | undefined;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // Minimum size that keeps the 3-panel shell usable: integrated sidebar
    // (300–500px) + chat (min 30% of the card) + right/Git panel (min 20%) +
    // composer. Below this the columns crush and the layout breaks.
    minWidth: 1080,
    minHeight: 680,
    // Frameless custom titlebar. macOS: keep the native traffic lights.
    // Windows/Linux: render native caption buttons (min/max/close) via
    // titleBarOverlay so the custom WindowTopBar has working controls.
    // (frame:false would hide those caption buttons on Windows — don't use it.)
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
    // Non-transparent window — transparent:true disables GPU compositing
    // on macOS (forces software rendering = slow streaming, slow scrolling).
    // The dark background color matches the app's card bg. The rounded
    // content card is handled in CSS — we don't need window-level transparency.
    transparent: false,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      // preload is relative to dist-electron/ (where this file lives after build)
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
      shell.openExternal(url);
    }
    return { action: 'deny' };
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

// ── App lifecycle ─────────────────────────────────────────────

// In dev, skip the single-instance lock so a dev server can run alongside the
// installed Tide.app (which holds the prod lock). Prod still enforces one instance.
const gotLock = isDev || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Register open-url BEFORE whenReady — on macOS, an OAuth callback that
  // launches the app fires open-url during launch, before ready. If we
  // register inside whenReady, the event is missed and OAuth fails in dev.
  // Queue any URLs that arrive before the handler is ready.
  const earlyOAuthUrls: string[] = [];
  app.on('open-url', (event, url) => {
    if (url.startsWith(OAUTH_CALLBACK)) {
      event.preventDefault();
      log.info('open-url: OAuth callback received', { url: url.slice(0, 50) + '…' });
      earlyOAuthUrls.push(url);
    }
  });

  app.on('second-instance', (_event, argv, _workingDirectory, _additionalData) => {
    // On Windows/Linux the OS relaunches the app with the OAuth callback URL
    // as the last argv arg (macOS uses `open-url` instead). Forward OAuth
    // callbacks to the primary instance's handler; non-oauth second launches
    // just focus the window.
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

  /** One-time migration: enrich existing provider-config models with
   *  authoritative contextWindow, max output, reasoning, and pricing from the
   *  models.dev catalog. Runs after initModelCatalog() at boot. Idempotent —
   *  models with a catalogId are skipped, so user edits are preserved. */
  async function enrichExistingModels() {
    const catalog = getActiveCatalog();
    if (!catalog || catalog.size === 0) return;
    let enriched = 0;
    for (const p of listProviders()) {
      let changed = false;
      const models = p.models.map((m) => {
        const e = enrichModelFromCatalog(m, catalog);
        if (e) { changed = true; enriched++; return e; }
        return m;
      });
      if (changed) updateProvider(p.id, { models });
    }
    if (enriched > 0) log.info('enriched models from catalog', { count: enriched });
  }

  app.whenReady().then(() => {
    const t0 = Date.now();
    // Set userData to ~/.tide (~/.tide-dev in dev) before any handler
    // registers — handlers create config/session stores that read
    // getPath('userData') at registration time. Fresh start, no migration.
    setUserDataPath(isDev);

    // Set the AppUserModelID so Windows notifications display with the correct
    // app name + icon. Required for toast notifications to appear at all on
    // Windows; harmless on macOS/Linux. electron-builder sets this for
    // production installs, but we need it for dev/unsigned builds too.
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.tide.app');
    }

    // Claim the protocol for OAuth callbacks. In dev this registers
    // `tide-dev://` — safe because it doesn't collide with the installed
    // Tide.app's `tide://`. Prod registers `tide://`.
    app.setAsDefaultProtocolClient(PROTOCOL);

    // Intercept the protocol at the protocol level — catches in-app navigations.
    protocol.handle(PROTOCOL, (request) => {
      log.info('protocol.handle: OAuth intercepted', { url: request.url.slice(0, 50) + '…' });
      handleOAuthCallback(request.url);
      return new Response('OK', { status: 200 });
    });
    // Drain any OAuth callbacks that arrived before whenReady (macOS launches
    // a new process → open-url fires during startup → the early handler above
    // queued them).
    for (const url of earlyOAuthUrls) {
      handleOAuthCallback(url);
    }
    earlyOAuthUrls.length = 0;
    // Subsequent open-url events (same-session) go directly to the handler.
    app.on('open-url', (event, url) => {
      if (url.startsWith(OAUTH_CALLBACK)) {
        event.preventDefault();
        log.info('open-url: OAuth callback received (post-ready)', { url: url.slice(0, 50) + '…' });
        handleOAuthCallback(url);
      }
    });

    // Initialize logging AFTER userData is set (so log files land in
    // ~/.tide/logs) but BEFORE handler registration. Sync file writes,
    // global error capture — runs once.
    initLogger(path.join(appDataDir(), 'logs'));
    log.info('app ready', { dev: isDev, userData: appDataDir() });

    registerIpcHandlers();
    // Settings handlers MUST be ready before the window shows — the renderer
    // hydrates shortcuts on mount via tide:settings:get. Deferring it would
    // leave the user with hardcoded macOS defaults until a restart.
    registerSettingsHandlers();
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
      registerAgentSdkHandlers(ipcMain);
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
  abortAllTurns();
  killAllScripts();
  killAllBackgroundShells();
});
