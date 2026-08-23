import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { useShallow } from 'zustand/react/shallow';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { Segmented } from '@/components/ui/segmented';

const THEMES = [
  { id: 'tide', label: 'Tide', bg: '#141414', accent: '#d1cfc0' },
  { id: 'claude', label: 'Claude', bg: '#262624', accent: '#d97757' },
  { id: 'discord', label: 'Discord', bg: '#323339', accent: '#5865f2' },
  // { id: 'celestial', label: 'Celestial', bg: '#0b0d1a', accent: '#7c8aff' },
  { id: 'liquid', label: 'Liquid', bg: '#090b0f', accent: '#3a8cff' },
  // { id: 'bright', label: 'Bright', bg: '#e9e4d8', accent: '#2e2e2e' },
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
  'tide-light': {
    label: 'Tide Light',
    theme: { background: '#fafafa', foreground: '#38383a', cursor: '#38383a', selectionBackground: 'rgba(56,56,58,0.18)' },
  },
  'solarized-light': {
    label: 'Solarized Light',
    theme: { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5' },
  },
  'github-light': {
    label: 'GitHub Light',
    theme: { background: '#ffffff', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#ddf4ff' },
  },
};

/** Export for TerminalPanel to consume. */
export function getTerminalTheme(themeId: string): Record<string, string> {
  return TERMINAL_THEMES[themeId]?.theme ?? TERMINAL_THEMES['tide-dark'].theme;
}

/** The content without the header. */
export function AppearanceContent() {
  const { fontScale, terminalTheme, terminalFontSize, appTheme, toolColorMode, setAppearance } = useUi(
    useShallow((s) => ({
      fontScale: s.fontScale,
      terminalTheme: s.terminalTheme,
      terminalFontSize: s.terminalFontSize,
      appTheme: s.appTheme,
      toolColorMode: s.toolColorMode,
      setAppearance: s.setAppearance,
    })),
  );
  const sidebarMode = useUi((s) => s.sidebarMode);
  const setSidebarMode = useUi((s) => s.setSidebarMode);
  const chatView = useUi((s) => s.chatView);
  const setChatView = useUi((s) => s.setChatView);

  return (
    <>
      <SettingsGroup title="Theme">
        <Card>
          <SettingsRow title="Base theme" description="Color palette for the entire app.">
            <div className="flex items-center gap-1.5">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setAppearance({ appTheme: t.id })}
                  title={t.label}
                  className={cn(
                    'size-9 rounded-lg flex items-center justify-center border-2 transition-colors cursor-pointer',
                    appTheme === t.id ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30',
                  )}
                  style={{ background: t.bg }}
                >
                  <span className="size-2 rounded-full" style={{ background: t.accent }} />
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow title="Session Chat Colors" description="Chat stream tool icons and labels." last>
            <div className="flex items-center gap-1">
              <Segmented
                size="sm"
                value={toolColorMode}
                onChange={(v) => setAppearance({ toolColorMode: v })}
                options={[
                  { value: 'colorful', label: 'Colorful' },
                  { value: 'monochrome', label: 'Monochrome' },
                ]}
              />
            </div>
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

      <SettingsGroup title="Layout">
        <Card>
          <SettingsRow title="Sidebar" description="Choose how the sidebar displays.">
            <div className="flex items-center gap-1">
              <Segmented
                size="sm"
                value={sidebarMode}
                onChange={setSidebarMode}
                options={[
                  { value: 'dual', label: 'Dual' },
                  { value: 'integrated', label: 'Integrated' },
                ]}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title="Turn view"
            description="Compact groups thinking and process into collapsible sections. Stream shows every block inline in the order it was emitted."
            last
          >
            <Segmented
              size="sm"
              value={chatView}
              onChange={setChatView}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'stream', label: 'Stream' },
              ]}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>
    </>
  );
}

export function AppearanceSection() {
  return (
    <>
      <SettingsHeader title="Appearance" description="Theme, layout, chat, and terminal. Changes apply instantly." />
      <AppearanceContent />
    </>
  );
}
