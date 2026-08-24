/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/historySignals.ts. No adaptations. */

export interface TurnHistorySignals {
  hasBufferedTurns: boolean;
  hasMoreAboveTurns: boolean;
  historyLoading: boolean;
  canLoadEarlier: boolean;
}
