/**
 * Electron main process — window creation, lifecycle, IPC registration.
 *
 * Security posture:
 * - contextIsolation: true, nodeIntegration: false, sandbox: false
 * - Custom frameless titleBar (React TitleBar handles traffic lights + drag)
 * - External links open in OS browser
 * - Navigation blocked away from app
 */

import { app, BrowserWindow, shell, ipcMain, protocol } from 'electron';

// Load .env before anything else reads process.env. The system app model
// (agent/system-model.ts, used for title generation) and the TIDE_DEBUG_SDK
// diagnostic flag are read lazily at call time (via IPC, well after startup),
// so loading here wins the race. .env is optional — its absence means
// system-model tasks no-op (title gen returns null, placeholder is kept).
// In ESM these imports are hoisted above this body, but nothing below reads
// env at module-eval time, so order is safe.
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
// Some OpenAI-compatible providers (z.ai GLM via Anthropic protocol) return
// reasoning metadata in a format the AI SDK's Anthropic adapter doesn't fully
// recognize, producing "unsupported reasoning metadata" warnings on every
// tool-call step. They're noise — the response is correct; the adapter just
// doesn't know about z.ai's extra fields. Suppress globally before the AI
// SDK loads.
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
import { registerAgentHandlers } from './agent/orchestrator.js';
import { registerAgentSdkHandlers } from './agent/orchestrator-sdk.js';
import { registerScriptHandlers, killAllScripts } from './ipc/scripts.js';
import { registerOpenInAppHandlers } from './ipc/openInApp.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerExtensionsHandlers } from './ipc/extensions.js';
import { registerMcpHandlers } from './ipc/mcp.js';
import { initUserServers } from './agent/mcp/pool.js';
import { handleOAuthCallback } from './agent/mcp/oauth.js';
import { setUserDataPath } from './appPaths.js';

/**
 * Cutover flag for the Vercel AI SDK orchestrator (Phase 3).
 *
 *   true  → registerAgentSdkHandlers : streamText + stopWhen step cap, full
 *           20-tool SDK factory path, emits the legacy AgentEvent stream so
 *           the current renderer works unchanged. (Phase 4 swaps the channel's
 *           payload to the PartEvent union — no second channel.)
 *   false → registerAgentHandlers    : the legacy hand-rolled SSE loop. Kept
 *           as the fallback until the SDK path is validated live.
 *
 * Both register on the same AGENT_COMMANDS, so exactly one may be active
 * (ipcMain rejects duplicate handles). Flip back here if a live run surfaces
 * a regression.
 */
const USE_SDK_ORCHESTRATOR = true;

// ESM doesn't provide __dirname — derive it from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// Register the `tide://` scheme as privileged BEFORE app ready — this is the
// window for OAuth callback handling. `standard` lets it parse like a normal
// URL (host + path), `secure` gives it a same-origin context (cookies, etc.),
// and `supportFetchAPI` lets the MCP SDK fetch against it during the PKCE
// metadata-exchange step. Must run before app.whenReady(); calling it later
// throws. See Phase 6 (OAuth) of the MCP integration plan.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tide', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const log = createLogger('main');

let mainWindow: BrowserWindow | null = null;

// The currently active workspace — the MCP pool uses its root to resolve
// project-scoped servers (.mcp.json), and the MCP IPC handlers use it to
// pick which config file to mutate on project-scoped add/update/remove.
// Set by the `tide:mcp:workspaceActivated` IPC handler (renderer fires it
// when the active workspace changes).
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

    // Claim the `tide://` protocol so the OS routes OAuth callbacks here.
    // On macOS, the browser hands the URL to the running instance via the
    // `open-url` event; on Windows/Linux a second instance is launched with
    // the URL as the last argv arg (handled in the `second-instance` listener
    // above). Safe to call unconditionally; returns false if another app
    // already owns it (rare; the PKCE flow still works via second-instance).
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
    initLogger(path.join(app.getPath('userData'), 'logs'));
    log.info('app ready', { dev: isDev, userData: app.getPath('userData') });

    registerIpcHandlers();
    // Settings handlers MUST be ready before the window shows — the renderer
    // hydrates shortcuts on mount via tide:settings:get. Deferring it would
    // leave the user with hardcoded macOS defaults until a restart.
    registerSettingsHandlers();
    log.info('core IPC handlers registered', { ms: Date.now() - t0 });

    // Create the window NOW — don't block first paint on the remaining
    // handlers. The renderer needs core IPC (workspaces/sessions/settings,
    // registered above) on mount; chat/agent/MCP/extensions are only used on
    // user action, so we defer them to the next tick (after the window is
    // shown) via setImmediate. This cuts time-to-first-paint by the cost of
    // loading + registering ~6 handler modules.
    createWindow();
    log.info('window created', { ms: Date.now() - t0 });

    // ── Deferred (non-critical) registration ──
    // Runs immediately after createWindow returns, before the next event-loop
    // turn — so the handlers are ready by the time the renderer's bundle has
    // loaded and the user can interact. Order within this block doesn't
    // matter (none of these call each other at registration time).
    setImmediate(() => {
      const t1 = Date.now();
      // Bootstrap the OpenRouter catalog — the universal metadata source. When
      // a provider's /models returns bare ids (z.ai, OpenAI direct), we enrich
      // them from this catalog. Fire-and-forget; cached to disk, refreshed weekly.
      void bootstrapCatalog();
      registerChatHandlers();
      if (USE_SDK_ORCHESTRATOR) {
        registerAgentSdkHandlers(ipcMain);
      } else {
        registerAgentHandlers(ipcMain);
      }
      registerScriptHandlers();
      registerOpenInAppHandlers();
      registerExtensionsHandlers();
      // MCP pool — boot user-scoped servers (~/.tide/mcp.json). Project-scoped
      // servers are connected lazily when the renderer signals the active
      // workspace via `tide:mcp:workspaceActivated`. Init is fire-and-forget;
      // failures (e.g. no config yet) just log and leave an empty pool.
      initUserServers().catch((e) =>
        log.warn('mcp pool init failed', { error: String(e) }),
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllScripts();
});
