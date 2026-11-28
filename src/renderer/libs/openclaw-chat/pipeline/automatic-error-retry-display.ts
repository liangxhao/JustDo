import { isKnownAutomaticRetryFailureCopy } from '@shared/openclaw/automaticErrorRetryDisplay';

import type { AssistantTurn, TurnItem } from '../model/chat-transcript-state';

export { isRetryFailureMessage, projectRetryFailureMessages, retryMessageRunId } from '@shared/openclaw/automaticErrorRetryDisplay';

export function isRetryFailurePreview(item: TurnItem): boolean {
  return item.type === 'content' && item.preambleItemId === undefined && item.assistantTextScopeId === undefined &&
    isKnownAutomaticRetryFailureCopy(item.text);
}

export function projectRetryFailureTurn(turn: AssistantTurn | null, hiddenRunIds: ReadonlySet<string>): AssistantTurn | null {
  if (!turn || !hiddenRunIds.has(turn.runId)) return turn;
  if (turn.status === 'running') {
    const items = turn.items.filter(item => item.runId !== turn.runId || !isRetryFailurePreview(item));
    return items.length === turn.items.length ? turn : { ...turn, items };
  }
  if (turn.status !== 'error') return turn;
  const errors = new Set(turn.items.flatMap(item =>
    item.type === 'terminal' && item.status === 'error' ? [item.message.trim()] : [],
  ));
  return { ...turn, items: turn.items.filter(item =>
    !(item.type === 'terminal' && item.status === 'error') &&
    !(item.type === 'content' && item.runId === turn.runId &&
      (isRetryFailurePreview(item) || errors.has(item.text.trim()))),
  ) };
}
