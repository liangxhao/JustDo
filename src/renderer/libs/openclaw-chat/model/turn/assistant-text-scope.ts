import { type AssistantTextScope, type NormalizedAgentEvent } from '@shared/openclaw/agentEvent';

import type { AssistantTurn, ContentItem, TurnItem } from '../chat-transcript-state';

export function recordAssistantTextScope(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  scope: AssistantTextScope,
): boolean {
  const itemId = typeof event.data.itemId === 'string' ? event.data.itemId : null;
  if (
    itemId &&
    turn.items.some(
      item =>
        item.type === 'content' &&
        (event.stream === 'assistant' ? item.assistantItemId : item.preambleItemId) === itemId &&
        item.assistantTextScopeId !== undefined &&
        item.assistantTextScopeId !== scope.id,
    )
  )
    return false;
  const previous = turn.assistantTextScopes?.get(scope.id);
  if (scope.commentaryItemIds !== undefined) {
    if (!previous || event.agentSeq >= previous.completedSeq) {
      (turn.assistantTextScopes ??= new Map()).set(scope.id, {
        completedSeq: event.agentSeq,
        commentaryItemIds: scope.commentaryItemIds,
        assistantItemId:
          event.stream === 'assistant' ? itemId : (previous?.assistantItemId ?? null),
      });
    }
    return true;
  }
  // A complete message cannot be reopened by an older provisional delivery.
  return event.stream !== 'assistant' || previous === undefined;
}

export function projectAssistantTextScope(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  scopeId: string,
  insertBySequence: (turn: AssistantTurn, item: TurnItem) => void,
): void {
  const completed = turn.assistantTextScopes?.get(scopeId);
  const items = turn.items.filter(
    (item): item is ContentItem => item.type === 'content' && item.assistantTextScopeId === scopeId,
  );
  const preambles = items.filter(item => item.preambleItemId !== undefined);
  for (const item of preambles) {
    if (completed && !completed.commentaryItemIds.includes(item.preambleItemId!)) {
      item.text = '';
      item.assistantTextScopeSuppressed = true;
    }
  }
  for (const item of items) {
    if (item.preambleItemId !== undefined) continue;
    const hide = completed
      ? item.assistantItemId !== completed.assistantItemId
      : preambles.some(preamble => preamble.text.trim());
    if (hide) {
      // Gateway may project later snapshots to delta-only events for this
      // native owner. Keep its prefix even while it is invisible.
      item.assistantTextScopeSuppressed = true;
    } else if (
      completed &&
      event.stream === 'assistant' &&
      (typeof event.data.text === 'string' || typeof event.data.delta === 'string') &&
      item.lastTextSeq === event.agentSeq &&
      event.data.itemId === item.assistantItemId &&
      item.assistantTextScopeSuppressed &&
      item.text.trim()
    ) {
      delete item.assistantTextScopeSuppressed;
      // The final answer follows the retained commentary; its earlier draft
      // occupied a different semantic position before the tool was selected.
      turn.items.splice(turn.items.indexOf(item), 1);
      item.firstSeq = event.agentSeq;
      item.startedAt = event.timestamp;
      insertBySequence(turn, item);
    }
  }
}
