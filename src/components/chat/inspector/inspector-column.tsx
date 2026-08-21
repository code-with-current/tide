/** Permanent Inspector column inside the chat view — full InspectorTab
 *  content, floating-card styling (rounded, bordered, shadowed, inset) so
 *  it reads as an overlay panel rather than a docked pane. Visibility
 *  (width + panel state) is derived by the parent via showInspectorColumn. */
import type { Session } from '@/types';
import { InspectorTab } from '@/components/chat/inspector/inspector-tab';

export function InspectorColumn({ session }: { session: Session }) {
  return (
    <aside className="relative flex w-[300px] shrink-0 p-3 pl-0">
      {/* Semi-transparent blurred scrim behind the card — the chat's content
          shows through softened, giving the column its floating depth. */}
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 left-3 my-3 rounded-2xl bg-background/40 backdrop-blur-md"
      />
      <div className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/25 ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        <div className="h-full overflow-y-auto scroll">
          <InspectorTab session={session} />
        </div>
      </div>
    </aside>
  );
}
