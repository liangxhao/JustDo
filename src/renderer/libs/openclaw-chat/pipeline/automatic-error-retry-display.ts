import type { AssistantTurn } from '../model/chat-transcript-state';

export { isRetryFailureMessage, projectRetryFailureMessages, retryMessageRunId } from '@shared/openclaw/automaticErrorRetryDisplay';

export function projectRetryFailureTurn(turn: AssistantTurn | null, hiddenRunIds: ReadonlySet<string>): AssistantTurn | null {
  if (!turn || !hiddenRunIds.has(turn.runId) || turn.status !== 'error') return turn;
  const errors = new Set(turn.items.flatMap(item =>
    item.type === 'terminal' && item.status === 'error' ? [item.message.trim()] : [],
  ));
  return { ...turn, items: turn.items.filter(item =>
    !(item.type === 'terminal' && item.status === 'error') &&
    !(item.type === 'content' && errors.has(item.text.trim())),
  ) };
}
