/** Keyboard shortcut registry — single source of truth for all bindings. */
export interface ShortcutDef {
  /** Stable id, used as the persistence key. Never rename (breaks stored overrides). */
  id: string;
  /** Human label, e.g. "Toggle terminal". */
  label: string;
  /** Group heading the shortcut appears under. */
  group: string;
  /** Default combo as display tokens, e.g. ['⌘', 'K'] or ['T'] for a bare key. */
  keys: string[];
  /** True if a key listener actually fires the action today. False = listed
   *  but not yet wired (the override still persists for when it is). */
  implemented: boolean;
}

export const SHORTCUT_GROUPS = ['Global', 'Navigation', 'Chat', 'Sessions', 'Tools'] as const;

export const SHORTCUTS: ShortcutDef[] = [
  // ── Global ────────────────────────────────────────────────────────────
  // commandPalette (⌘K/Ctrl+K) focuses the SessionsPanel search box — originally reserved for a global command palette that was never built; the sessions search advertises this binding so it now drives that. A real palette, if added later, gets its own binding.
  { id: 'commandPalette', label: 'Search sessions', group: 'Global', keys: ['⌘', 'K'], implemented: true },
  { id: 'newSession', label: 'New session', group: 'Global', keys: ['⌘', 'N'], implemented: true },
  { id: 'openSettings', label: 'Open settings', group: 'Global', keys: ['⌘', ','], implemented: true },
  { id: 'closeWindow', label: 'Close window', group: 'Global', keys: ['⌘', 'W'], implemented: true },

  // ── Navigation ────────────────────────────────────────────────────────
  { id: 'toggleWorkspaces', label: 'Toggle workspaces panel', group: 'Navigation', keys: ['⌘', '1'], implemented: true },
  { id: 'toggleSessions', label: 'Toggle sessions panel', group: 'Navigation', keys: ['⌘', '2'], implemented: true },
  { id: 'toggleRightPanel', label: 'Toggle right panel', group: 'Navigation', keys: ['⌘', '3'], implemented: true },
  { id: 'toggleTerminal', label: 'Toggle terminal', group: 'Navigation', keys: ['T'], implemented: true },
  { id: 'toggleRightPanelBare', label: 'Toggle right panel', group: 'Navigation', keys: ['R'], implemented: true },

  // ── Chat ──────────────────────────────────────────────────────────────
  { id: 'sendMessage', label: 'Send message', group: 'Chat', keys: ['↵'], implemented: true },
  { id: 'newLine', label: 'New line in composer', group: 'Chat', keys: ['⇧', '↵'], implemented: true },
  { id: 'abortTurn', label: 'Abort in-flight turn', group: 'Chat', keys: ['⌘', '.'], implemented: true },
  { id: 'dismissPrompt', label: 'Dismiss permission prompt / dialog', group: 'Chat', keys: ['Esc'], implemented: true },
  // editLastMessage stays unimplemented: the composer only sends new messages
  // — no edit flow exists to wire to. Building it is a separate feature.
  { id: 'editLastMessage', label: 'Edit last message', group: 'Chat', keys: ['⌘', '↑'], implemented: false },

  // ── Sessions ──────────────────────────────────────────────────────────
  { id: 'nextSession', label: 'Next session', group: 'Sessions', keys: ['J'], implemented: true },
  { id: 'prevSession', label: 'Previous session', group: 'Sessions', keys: ['K'], implemented: true },
  // rename uses window.prompt fallback (inline UI is component-local); delete
  // archives-then-deletes + clears store state. Both fire the real IPC.
  { id: 'renameSession', label: 'Rename session', group: 'Sessions', keys: ['⌘', 'E'], implemented: true },
  { id: 'deleteSession', label: 'Delete session', group: 'Sessions', keys: ['⌘', '⌫'], implemented: true },

  // ── Tools ─────────────────────────────────────────────────────────────
  { id: 'approvePermission', label: 'Approve permission', group: 'Tools', keys: ['Y'], implemented: true },
  { id: 'rejectPermission', label: 'Reject permission', group: 'Tools', keys: ['N'], implemented: true },
  { id: 'copyDiff', label: 'Copy diff to clipboard', group: 'Tools', keys: ['⌘', '⇧', 'C'], implemented: true },
  // branchFromWorktree uses window.prompt for branchName/baseBranch (the form
  // is component-local to EmptyChatState); the createWorktree IPC fires.
  { id: 'branchFromWorktree', label: 'Branch from session worktree', group: 'Tools', keys: ['⌘', 'B'], implemented: true },
];

/** Map of id → def for quick lookup. */
export const SHORTCUTS_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s]),
);

/** Display token → modifier-flag mapping. Order matters for canonicalization. */
const MOD_TOKENS: Array<[string, 'meta' | 'ctrl' | 'alt' | 'shift']> = [
  ['⌘', 'meta'],
  ['Ctrl', 'ctrl'],
  ['⌥', 'alt'],
  ['⇧', 'shift'],
];

/** Convert a display key token to the KeyboardEvent.key it matches.
 *  e.g. '⌘' is a modifier (handled separately), 'K' → 'k', '↵' → 'Enter'. */
function tokenToKey(token: string): string | null {
  switch (token) {
    case '↵': return 'Enter';
    case 'Esc': return 'Escape';
    case '⌫': return 'Backspace';
    case '↑': return 'ArrowUp';
    case '↓': return 'ArrowDown';
    case '⌘': case 'Ctrl': case '⌥': case '⇧': return null; // modifiers
    default: return token.toLowerCase();
  }
}

/** Normalized combo extracted from a KeyboardEvent for matching. Returns
 *  null for pure-modifier presses (Shift alone, Cmd alone) — those never
 *  constitute a binding. */
export interface NormalizedCombo {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // lowercase, or special name like 'Enter'
}

export function normalizeEvent(e: KeyboardEvent): NormalizedCombo | null {
  const MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift'];
  // Pure modifier press — not a binding.
  if (MODIFIERS.includes(e.key)) return null;
  return {
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  };
}

/** Convert a stored `keys` array (display tokens) to a NormalizedCombo for
 *  comparison. */
export function keysToCombo(keys: string[]): NormalizedCombo {
  const combo: NormalizedCombo = { meta: false, ctrl: false, alt: false, shift: false, key: '' };
  for (const token of keys) {
    const mod = MOD_TOKENS.find(([t]) => t === token);
    if (mod) { combo[mod[1]] = true; continue; }
    const k = tokenToKey(token);
    if (k) combo.key = k;
  }
  return combo;
}

/** Does a captured event match a stored binding? */
export function comboMatches(keys: string[], e: KeyboardEvent): boolean {
  const norm = normalizeEvent(e);
  if (!norm) return false;
  const target = keysToCombo(keys);
  return (
    norm.meta === target.meta &&
    norm.ctrl === target.ctrl &&
    norm.alt === target.alt &&
    norm.shift === target.shift &&
    norm.key === target.key
  );
}

/** Convert a captured KeyboardEvent back to display tokens for storage.
 *  Used by the rebind capture UI. */
export function eventToTokens(e: KeyboardEvent): string[] | null {
  const norm = normalizeEvent(e);
  if (!norm) return null;
  const tokens: string[] = [];
  // macOS-first display: ⌘ Ctrl ⌥ ⇧ then the key. On non-mac, ⌘ shows as Ctrl
  // visually but we store the token as-is; the matching layer uses flags.
  if (norm.meta) tokens.push('⌘');
  if (norm.ctrl) tokens.push('Ctrl');
  if (norm.alt) tokens.push('⌥');
  if (norm.shift) tokens.push('⇧');
  // Reverse-map the special keys back to display glyphs.
  const keyMap: Record<string, string> = {
    enter: '↵', escape: 'Esc', backspace: '⌫', arrowup: '↑', arrowdown: '↓',
  };
  tokens.push(keyMap[norm.key] ?? (norm.key.length === 1 ? norm.key.toUpperCase() : norm.key));
  return tokens;
}

/** Platform-default bindings (populated by backend at startup via useUi.loadShortcuts); take precedence over the hardcoded macOS fallback once they arrive, so non-macOS users see Ctrl from first paint. */
let platformDefaults: Record<string, string[]> | null = null;

export function setPlatformDefaults(defaults: Record<string, string[]> | null): void {
  platformDefaults = defaults;
}

/** Resolve the effective binding for an action: 1) user override (settings.json via IPC), 2) platform default (backend; macOS ⌘ / Windows+Linux Ctrl), 3) hardcoded fallback in SHORTCUTS (macOS-flavored). Key listeners call this. */
export function getEffectiveKeys(id: string, overrides: Record<string, string[]> | undefined): string[] {
  if (overrides?.[id]) return overrides[id];
  if (platformDefaults?.[id]) return platformDefaults[id];
  return SHORTCUTS_BY_ID[id]?.keys ?? [];
}

