import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WorkspaceScopeSelect, type WorkspaceOption } from './scope-select';
import { useWorkspaces } from '@/lib/queries';
import type { KnowledgeSource, SourceKind } from '@/types';

/** Add/edit dialog for a knowledge source. Kind is fixed after creation —
 *  editing only renames or re-points the location. */

const KINDS: Array<{ value: SourceKind; label: string; placeholder: string; hint: string }> = [
  {
    value: 'url',
    label: 'Web page',
    placeholder: 'https://example.com/page',
    hint: 'Fetches and indexes a single page.',
  },
  {
    value: 'docs',
    label: 'Local docs',
    placeholder: '/path/to/docs',
    hint: 'Indexes a local folder or file of markdown/text docs.',
  },
  {
    value: 'crawl',
    label: 'Site crawl',
    placeholder: 'https://docs.example.com/',
    hint: 'Crawls same-origin pages starting from the root URL.',
  },
  {
    value: 'repo',
    label: 'Git repo',
    placeholder: 'https://github.com/owner/repo',
    hint: 'Shallow-clones and code-aware chunks a repository.',
  },
];

export interface SourceDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the final field values when the user saves. */
  onSave: (input: {
    name: string;
    kind: SourceKind;
    location: string;
    enabledWorkspaceIds: string[];
  }) => void;
  /** Present in edit mode (kind cannot change). */
  initial?: KnowledgeSource | null;
  /** Disables the submit button while a save is in flight. The add IPC
   *  resolves only when the first index pass finishes — without this a second
   *  click during a long crawl hits the duplicate-location guard. */
  busy?: boolean;
}

export function SourceDialog({ open, onClose, onSave, initial, busy }: SourceDialogProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('url');
  const [location, setLocation] = useState('');
  const [scope, setScope] = useState<string[]>(['*']);
  const [error, setError] = useState<string | null>(null);
  const workspacesQuery = useWorkspaces();
  const workspaces: WorkspaceOption[] = useMemo(
    () => (workspacesQuery.data ?? []).map((w) => ({ id: w.id, name: w.name })),
    [workspacesQuery.data],
  );

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setKind(initial?.kind ?? 'url');
    setLocation(initial?.location ?? '');
    setScope(initial?.enabledWorkspaceIds ?? ['*']);
    setError(null);
  }, [open, initial]);

  const kindMeta = KINDS.find((k) => k.value === kind) ?? KINDS[0];

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    const trimmedLocation = location.trim();
    if (!trimmedLocation) {
      setError('Location is required.');
      return;
    }
    if ((kind === 'url' || kind === 'crawl') && !/^https?:\/\/\S+/i.test(trimmedLocation)) {
      setError('Enter an http(s):// URL.');
      return;
    }
    onSave({ name: trimmedName, kind, location: trimmedLocation, enabledWorkspaceIds: scope });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit source' : 'Add knowledge source'}</DialogTitle>
          <DialogDescription>
            Indexed content is searchable by the agent's memory tool.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="source-name">Name</Label>
            <Input
              id="source-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="React docs"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source-kind">Kind</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as SourceKind)}
              disabled={!!initial}
            >
              <SelectTrigger id="source-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Availability</Label>
            <WorkspaceScopeSelect
              value={scope}
              workspaces={workspaces}
              onChange={setScope}
              className="h-8 w-full justify-start border border-input bg-transparent px-3 hover:bg-muted/50"
            />
            <p className="text-[0.7857rem] text-muted-foreground/60">
              Which workspaces the agent can search this source from.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source-location">Location</Label>
            <Input
              id="source-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={kindMeta.placeholder}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
            <p className="text-[0.7857rem] text-muted-foreground/60">{kindMeta.hint}</p>
          </div>

          {error && (
            <p className="text-[0.7857rem] text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy}>
            {initial ? 'Save' : 'Add & index'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
