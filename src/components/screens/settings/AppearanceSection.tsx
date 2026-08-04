import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { useUi } from '@/lib/stores/ui';

const THEMES = [
  { id: 'tide', label: 'Tide', bg: '#0a0a0b', accent: '#e4e4e7' },
  { id: 'claude', label: 'Claude', bg: '#1a1715', accent: '#d97757' },
  { id: 'green', label: 'Green', bg: '#0d1410', accent: '#4ade80' },
  { id: 'celestial', label: 'Celestial', bg: '#0b0d1a', accent: '#7c8aff' },
  { id: 'liquid', label: 'Liquid', bg: '#08141a', accent: '#22d3ee' },
  { id: 'bright', label: 'Bright', bg: '#f8f9fa', accent: '#d97757' },
];

/** Terminal color themes — name → xterm.js theme object. */
const TERMINAL_THEMES: Record<string, { label: string; theme: Record<string, string> }> = {
  'tide-dark': {
    label: 'Tide Dark',
    theme: { background: '#0a0a0c', foreground: '#c7c7c9', cursor: '#c7c7c9', selectionBackground: 'rgba(120,120,140,0.3)' },
  },
  dracula: {
    label: 'Dracula',
    theme: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a' },
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    theme: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642' },
  },
  'github-dark': {
    label: 'GitHub Dark',
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#1f2937' },
  },
  monokai: {
    label: 'Monokai',
    theme: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#49483e' },
  },
  'one-dark': {
    label: 'One Dark',
    theme: { background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', selectionBackground: '#3e4451' },
  },
};

/** Export for TerminalPanel to consume. */
export function getTerminalTheme(themeId: string): Record<string, string> {
  return TERMINAL_THEMES[themeId]?.theme ?? TERMINAL_THEMES['tide-dark'].theme;
}

/** The content without the header — used by GeneralSection's right column. */
export function AppearanceContent() {
  const { fontScale, reduceMotion, terminalTheme, terminalFontSize, appTheme, setAppearance } = useUi();

  return (
    <>
      <SettingsGroup title="Theme">
        <Card>
          <SettingsRow title="Base theme" description="Color palette for the entire app." last>
            <Select
              value={appTheme}
              onValueChange={(v) => setAppearance({ appTheme: v })}
            >
              <SelectTrigger className="w-[10rem] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEMES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full border border-border/40" style={{ background: t.bg }} />
                      <span className="w-2 h-2 rounded-full" style={{ background: t.accent }} />
                      {t.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      <SettingsGroup title="Typography">
        <Card>
          <SettingsRow title="Base font size" description="Scales all rem-based sizes in the app." last>
            <Select
              value={String(fontScale)}
              onValueChange={(v) => setAppearance({ fontScale: parseInt(v, 10) })}
            >
              <SelectTrigger className="w-[10rem] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="13">Compact · 13px</SelectItem>
                <SelectItem value="14">Default · 14px</SelectItem>
                <SelectItem value="15">Comfortable · 15px</SelectItem>
                <SelectItem value="16">Web · 16px</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      <SettingsGroup title="Terminal">
        <Card>
          <SettingsRow title="Color theme" description="Terminal color scheme.">
            <Select
              value={terminalTheme}
              onValueChange={(v) => setAppearance({ terminalTheme: v })}
            >
              <SelectTrigger className="w-[12rem] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TERMINAL_THEMES).map(([id, t]) => (
                  <SelectItem key={id} value={id}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow title="Font size" description="Terminal text size in pixels." last>
            <Select
              value={String(terminalFontSize)}
              onValueChange={(v) => setAppearance({ terminalFontSize: parseInt(v, 10) })}
            >
              <SelectTrigger className="w-[8rem] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[11, 12, 13, 14, 15, 16, 18].map((s) => (
                  <SelectItem key={s} value={String(s)}>{s}px</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      <SettingsGroup title="Motion">
        <Card>
          <SettingsRow title="Reduce motion" description="Disable non-essential animations." last>
            <Switch
              checked={reduceMotion}
              onCheckedChange={(v) => setAppearance({ reduceMotion: v })}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>
    </>
  );
}

/** Full section with header — kept for backward compat. GeneralSection uses AppearanceContent directly. */
export function AppearanceSection() {
  return (
    <>
      <SettingsHeader title="Appearance" description="Theme, typography, and terminal. Changes apply instantly." />
      <AppearanceContent />
    </>
  );
}
