/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/StatusRowContainer.tsx — ADAPTED (Ruling 4).
 *  Upstream subscribes to OpenChamber stores (useAssistantStatus, useSessionUIStore
 *  abort flags, useConfigStore agent/providers). Tide's status data comes from the T1
 *  projection: `TurnStreamState` (lib/turns/types.ts) plus the Tide `stopReason` string
 *  on the message. Stop-reason mapping: Tide 'aborted' → aborted/abort-status display;
 *  every other Tide stopReason (e.g. 'stop', 'length', 'refusal') renders as a normal
 *  finish — OpenCode finish strings never appear. All inputs are props; Task 6/8 thread
 *  them from the turn record. */

import React from 'react';
import { StatusRow, type StatusRowTodo } from './status-row';
import type { TurnStreamState } from './lib/turns/types';

interface StatusRowContainerProps {
  stream?: TurnStreamState;
  stopReason?: string | null;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  todos?: StatusRowTodo[];
  leftAccessory?: React.ReactNode;
}

/** Status row wrapper — derives StatusRow inputs from the turn's stream state. */
export const StatusRowContainer: React.FC<StatusRowContainerProps> = React.memo(({
  stream,
  stopReason,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  agentName,
  modelName,
  providerId,
  todos,
  leftAccessory,
}) => {
  const isStreaming = stream?.isStreaming ?? false;
  const wasAborted = !isStreaming && stopReason === 'aborted';

  return (
    <StatusRow
      isWorking={isStreaming}
      statusText={statusText ?? null}
      isGenericStatus={isGenericStatus}
      isWaitingForPermission={isWaitingForPermission}
      wasAborted={wasAborted}
      abortActive={!wasAborted}
      retryInfo={retryInfo ?? null}
      showAssistantStatus
      showTodos
      todos={todos}
      agentName={agentName}
      modelName={modelName}
      providerId={providerId ?? null}
      leftAccessory={leftAccessory}
    />
  );
});

StatusRowContainer.displayName = 'StatusRowContainer';
