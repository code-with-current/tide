/**
 * Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/ChatEmptyState.tsx — ADAPTED.
 * upstream port seams: Tide branding (tide-logo.png instead of TideLogo),
 * `useThemeSystem` → the ported CSS token vars, `useGlobalSyncStore` init-error
 * branch dropped (Tide has no sync store), i18n → literal English ("Start a
 * conversation" matches Tide's new-session screen tone). Lands unmounted —
 * Task 8 decides whether to wire it into the timeline.
 */

import React from 'react';

import tideLogoUrl from '@/assets/tide-logo.png';

const ChatEmptyState: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
      <img src={tideLogoUrl} alt="" aria-hidden="true" width={140} height={140} className="opacity-20" />
      <span className="text-body-md text-[var(--muted-foreground)]">Start a conversation</span>
    </div>
  );
};

export const ChatEmptyStateMemoized = React.memo(ChatEmptyState);
