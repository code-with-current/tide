import {
  FolderOpen,
  Lock,
  FileText,
  Trash2,
  AlertTriangle,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Chip } from '@/components/primitives';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';

const FUSES = [
  { name: 'runAsNode', description: 'Block ELECTRON_RUN_AS_NODE=1 turning app into a Node shell.', enabled: true },
  { name: 'enableNodeCliInspectArguments', description: 'Block --inspect debugger in production.', enabled: true },
  { name: 'enableEmbeddedAsarIntegrityValidation', description: 'Validate asar hash at launch.', enabled: true },
  { name: 'onlyLoadAppFromAsar', description: 'Refuse to load code outside the asar.', enabled: true },
  { name: 'grantFileProtocolExtraPrivileges', description: 'Block extra file:// privileges.', enabled: true },
];

export function AdvancedSection() {
  return (
    <>
      <SettingsHeader
        title="Advanced"
        description="Paths, security fuses, diagnostics, and destructive actions. Read carefully."
      />

      {/* Paths */}
      <SettingsGroup title="Paths">
        <Card>
          <SettingsRow title="App data" description="Config DB, settings, logs.">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-[11px] px-2 py-0.5 bg-primary rounded text-muted-foreground max-w-[14rem] truncate">
                ~/Library/Application Support/Tide
              </code>
              <Button variant="ghost" size="sm" className="p-1 h-6">
                <FolderOpen className="size-3" />
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow title="Session logs" description="JSONL files per session, alongside the workspace.">
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-[11px] px-2 py-0.5 bg-primary rounded text-muted-foreground max-w-[14rem] truncate">
                ~/dev/tideCODE/.agent/sessions
              </code>
              <Button variant="ghost" size="sm" className="p-1 h-6">
                <FolderOpen className="size-3" />
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow title="MCP servers" description="User-installed MCP server configs." last>
            <div className="flex items-center gap-1.5">
              <code className="font-mono text-[11px] px-2 py-0.5 bg-primary rounded text-muted-foreground max-w-[14rem] truncate">
                ~/Library/Application Support/Tide/mcp
              </code>
              <Button variant="ghost" size="sm" className="p-1 h-6">
                <FolderOpen className="size-3" />
              </Button>
            </div>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Electron Fuses */}
      <SettingsGroup
        title="Electron Fuses"
        hint={
          <span className="flex items-center gap-1 text-success">
            <Lock className="size-3" /> baked at build
          </span>
        }
      >
        <Card>
          {FUSES.map((f, i) => (
            <SettingsRow
              key={f.name}
              title={<code className="font-mono text-[12px]">{f.name}</code>}
              description={f.description}
              last={i === FUSES.length - 1}
            >
              <Chip tone="ok">on</Chip>
            </SettingsRow>
          ))}
        </Card>
        <div className="text-[11px] text-muted-foreground/60 mt-1.5 px-1">
          Fuses are compile-time flags that cannot be flipped at runtime — they ship with the binary.
        </div>
      </SettingsGroup>

      {/* Dev / Debug */}
      <SettingsGroup title="Developer">
        <Card>
          <SettingsRow title="Enable DevTools" description="Open with ⌘⌥I. Auto-closes in packaged builds unless enabled.">
            <Switch />
          </SettingsRow>
          <SettingsRow title="Verbose orchestrator logging" description="Log effective context, tool args, and stop reasons per turn.">
            <Switch />
          </SettingsRow>
          <SettingsRow title="Event inspector" description="Inspect every IPC event and tool result in real time.">
            <Switch />
          </SettingsRow>
          <SettingsRow title="Log to file" last>
            <div className="flex items-center gap-1.5">
              <FileText className="size-3 text-muted-foreground/60" />
              <code className="font-mono text-[11px] text-muted-foreground">tide.log</code>
              <Button variant="ghost" size="sm" className="p-1 h-6">
                <ExternalLink className="size-3" />
              </Button>
            </div>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Diagnostics */}
      <SettingsGroup title="Diagnostics">
        <Card>
          <SettingsRow title="App version">
            <code className="font-mono text-[11px] text-muted-foreground">v0.4.2</code>
          </SettingsRow>
          <SettingsRow title="Electron">
            <code className="font-mono text-[11px] text-muted-foreground">35.2.1</code>
          </SettingsRow>
          <SettingsRow title="Node">
            <code className="font-mono text-[11px] text-muted-foreground">22.14.0</code>
          </SettingsRow>
          <SettingsRow title="Platform">
            <code className="font-mono text-[11px] text-muted-foreground">darwin 25.5.0 arm64</code>
          </SettingsRow>
          <SettingsRow title="Copy diagnostics to clipboard" last>
            <Button variant="secondary" size="sm" className="text-xs h-7">
              <Copy className="size-3" /> Copy
            </Button>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Danger zone */}
      <SettingsGroup title="Danger zone">
        <Card className="border-destructive/30">
          <SettingsRow title="Clear all caches" description="Drop vector + FTS indexes. Rebuilt on next session.">
            <Button variant="secondary" size="sm" className="text-xs h-7">
              <Trash2 className="size-3" /> Clear
            </Button>
          </SettingsRow>
          <SettingsRow title="Reset all settings" description="Restore defaults. Does not delete sessions or workspaces.">
            <Button variant="secondary" size="sm" className="text-xs h-7">
              Reset
            </Button>
          </SettingsRow>
          <SettingsRow title="Delete all session data" description="Removes every session log across all workspaces. Irreversible." last>
            <Button variant="destructive" size="sm" className="text-xs h-7">
              <AlertTriangle className="size-3" /> Delete everything
            </Button>
          </SettingsRow>
        </Card>
      </SettingsGroup>
    </>
  );
}
