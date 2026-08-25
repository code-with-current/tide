import type { TurnUiState } from '../../hooks/use-chat-timeline-controller';

export function effectiveTurnExpanded(
  chatView: 'compact' | 'stream',
  uiState: TurnUiState | undefined,
): boolean {
  if (chatView === 'stream') return true;
  return uiState?.isExpanded ?? false;
}
