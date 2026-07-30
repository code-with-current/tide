import { useMemo } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/quick-tooltip';
import { ShortcutCapture } from '@/components/ui/shortcut-capture';
import { SettingsGroup, SettingsHeader, SettingsRow, Card } from './shared';
import { useUi } from '@/lib/stores/ui';
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  getEffectiveKeys,
  keysToCombo,
} from '@/lib/shortcuts';

/**
 * Settings → Shortcuts.
 *
 * Backed by the shortcut registry (lib/shortcuts.ts) and the UI store's
 * `shortcutOverrides` (persisted to localStorage). Each row shows the action
 * and a ShortcutCapture; clicking the capture, pressing a new combo, persists
 * an override. Conflicts (same combo used by another action) are flagged
 * inline with a warning icon. "Reset all" clears every override back to the
 * registry defaults.
 *
 * Actions marked `implemented: false` in the registry are shown but display a
 * "not yet wired" hint — they rebind and persist correctly, but no key
 * listener fires them yet. Honest rather than silently no-op'ing.
 */
export function ShortcutsSection() {
  const overrides = useUi((s) => s.shortcutOverrides);
  const setShortcut = useUi((s) => s.setShortcut);
  const resetShortcuts = useUi((s) => s.resetShortcuts);

  // Build the effective-binding map across ALL actions once per render so
  // conflict detection is consistent. Keyed by action id.
  const effectiveById = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const s of SHORTCUTS) m[s.id] = getEffectiveKeys(s.id, overrides);
    return m;
  }, [overrides]);

  // Reverse lookup: combo-string → list of action ids using it. Two actions
  // sharing a combo = conflict. We stringify the normalized combo (not the
  // raw tokens) so ['⌘','K'] and a future ['Cmd','K'] would collide too.
  const comboToIds = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of SHORTCUTS) {
      const keys = effectiveById[s.id];
      if (keys.length === 0) continue;
      const sig = signature(keys);
      const arr = m.get(sig) ?? [];
      arr.push(s.id);
      m.set(sig, arr);
    }
    return m;
  }, [effectiveById]);

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <>
      <SettingsHeader
        title="Shortcuts"
        description="Keyboard-first navigation. Click any binding to rebind — conflicts are flagged. Esc cancels, Backspace clears."
        action={
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            disabled={!hasOverrides}
            onClick={resetShortcuts}
          >
            <RotateCcw className="size-3" /> Reset all
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        {SHORTCUT_GROUPS.map((group) => {
          const items = SHORTCUTS.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <SettingsGroup key={group} title={group}>
              <Card>
                {items.map((item, i) => {
                  const keys = effectiveById[item.id];
                  const sig = signature(keys);
                  const conflicted = (comboToIds.get(sig)?.length ?? 0) > 1;
                  const isCustom = !!overrides[item.id];
                  return (
                    <SettingsRow
                      key={item.id}
                      title={
                        <span className="flex items-center gap-1.5">
                          {item.label}
                          {!item.implemented && (
                            <Tip label="Listed but no key listener is wired to this action yet. Your binding still saves for when it is.">
                              <span className="text-[10px] text-muted-foreground/60 italic">(soon)</span>
                            </Tip>
                          )}
                          {isCustom && (
                            <span className="text-[9px] uppercase tracking-wider text-accent-foreground/60 bg-secondary px-1 rounded">
                              custom
                            </span>
                          )}
                        </span>
                      }
                      last={i === items.length - 1}
                    >
                      <div className="flex items-center gap-1.5">
                        {conflicted && (
                          <Tip label="Another action uses this combo — both will fire. Rebind one.">
                            <TriangleAlert className="size-3.5 text-warning" />
                          </Tip>
                        )}
                        <ShortcutCapture
                          keys={keys}
                          onCapture={(tokens) => setShortcut(item.id, tokens)}
                          onClear={() => setShortcut(item.id, null)}
                        />
                      </div>
                    </SettingsRow>
                  );
                })}
              </Card>
            </SettingsGroup>
          );
        })}
      </div>

      <SettingsGroup>
        <p className="text-[11px] text-muted-foreground/70 px-1">
          {hasOverrides
            ? `${Object.keys(overrides).length} custom binding${Object.keys(overrides).length === 1 ? '' : 's'}. Reset all restores defaults.`
            : 'Using defaults. Click any binding above to customize.'}
        </p>
      </SettingsGroup>
    </>
  );
}

/** Stable string signature of a combo for conflict detection. Mirrors the
 *  equality logic in comboMatches without needing an event. */
function signature(keys: string[]): string {
  if (keys.length === 0) return '';
  const c = keysToCombo(keys);
  return `${c.meta ? 'M' : ''}${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}:${c.key}`;
}
