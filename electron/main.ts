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

// Register the `tide://` scheme as privileged BEFORE app ready: `standard` parses it like a normal URL, `secure` gives a same-origin context (cookies), and `supportFetchAPI` lets the MCP SDK fetch against it during the PKCE metadata-exchange step. Must run before app.whenReady() or it throws.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tide', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const log = createLogger('main');

let mainWindow: BrowserWindow | null = null;

// The currently active workspace — the MCP pool uses its root for project-scoped servers (.mcp.json), and MCP IPC uses it to pick which config file to mutate. Set by the `tide:mcp:workspaceActivated` IPC handler when the active workspace changes.
let activeWorkspace: { id: string; root: string } | undefined;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
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

  // Block navigation away from the app.
  mainWindow.webContents.on('will-navigate', (e) => {
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, _additionalData) => {
    // On Windows/Linux the OS relaunches Tide with the `tide://` callback URL
    // as the last argv arg (macOS uses `open-url` instead). Forward OAuth
    // callbacks to the primary instance's handler; non-oauth second launches
    // just focus the window.
    const lastArg = argv[argv.length - 1];
    if (lastArg?.startsWith('tide://oauth/callback')) {
      log.info('second-instance: tide:// callback received', { url: lastArg.slice(0, 50) + '…' });
      handleOAuthCallback(lastArg);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

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

    // Claim the `tide://` protocol so the OS routes OAuth callbacks here (macOS via `open-url`; Windows/Linux via second-instance with the URL as the last argv arg — handled above). Safe to call unconditionally; returns false if another app already owns it (rare; PKCE still works via second-instance).
    app.setAsDefaultProtocolClient('tide');
    app.on('open-url', (_event, url) => {
      if (url.startsWith('tide://oauth/callback')) {
        // Prevent the default (opening a window); we handle it ourselves.
        _event.preventDefault();
        log.info('open-url: tide:// callback received', { url: url.slice(0, 50) + '…' });
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
