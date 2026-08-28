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
