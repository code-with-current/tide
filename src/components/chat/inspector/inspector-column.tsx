/** Permanent Inspector column inside the chat view — full InspectorTab
 *  content, floating-card styling (rounded, bordered, shadowed, inset) so
 *  it reads as an overlay panel rather than a docked pane. Visibility
 *  (width + panel state) is derived by the parent via showInspectorColumn. */
import type { Session } from '@/types';
import { InspectorTab } from '@/components/chat/inspector/inspector-tab';

export function InspectorColumn({ session }: { session: Session }) {
  return (
    <aside className="flex w-[276px] shrink-0 py-2 pr-2">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="h-full overflow-y-auto scroll">
          <InspectorTab session={session} />
        </div>
      </div>
    </aside>
  );
}
