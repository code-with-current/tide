/** Permanent Inspector column inside the chat view — full InspectorTab
 *  content, right-side placement. Visibility (width + panel state) is
 *  derived by the parent via showInspectorColumn. */
import type { Session } from '@/types';
import { InspectorTab } from '@/components/chat/inspector/inspector-tab';

export function InspectorColumn({ session }: { session: Session }) {
  return (
    <aside className="w-[260px] shrink-0 border-l border-border bg-card">
      <div className="h-full overflow-y-auto scroll">
        <InspectorTab session={session} />
      </div>
    </aside>
  );
}
