import {
  type NormalizedAgentEvent,
  readTerminalGuardObservation,
} from '@shared/openclaw/agentEvent';

import type { AssistantTurn, ContentItem } from '../chat-transcript-state';

export interface AssistantTextSourceCoverage {
  replaySnapshot?: boolean;
  chatFallbackCoveredThrough?: number;
}

export function readPreambleText(data: Record<string, unknown>): string | null {
  return data.kind === 'preamble' &&
    typeof data.progressText === 'string' &&
    (data.progressText.trim() || data.replace === true)
    ? data.progressText
    : null;
}

export function reconcileChatTextSource(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  options: AssistantTextSourceCoverage,
): boolean {
  const observation =
    event.stream === 'assistant' ? readTerminalGuardObservation(event.data) : null;
  if (observation?.action === 'rollback' || observation?.action === 'commit') return false;
  const fallbacks = turn.items.filter(
    (item): item is ContentItem => item.type === 'content' && item.chatFallback === true,
  );
  const pending = turn.items.filter(
    (item): item is ContentItem =>
      item.type === 'content' && item.assistantTextSourcePending === true,
  );
  const hasNativeBody = pending.some(item => item.text.trim());
  const hasBaseline =
    Boolean(turn.assistantTextBaselineOwnerIds?.size || turn.assistantTextUnkeyedBaseline) &&
    hasNativeBody;
  const textEvent =
    (event.stream === 'assistant' &&
      (typeof event.data.text === 'string' || typeof event.data.delta === 'string')) ||
    readPreambleText(event.data) !== null;
  const coveredThrough =
    options.replaySnapshot && options.chatFallbackCoveredThrough !== undefined
      ? options.chatFallbackCoveredThrough
      : textEvent
        ? event.agentSeq
        : -1;
  const coversChat = fallbacks.every(
    item => item.chatSourceSeq !== undefined && item.chatSourceSeq <= coveredThrough,
  );
  const missingBaseline = [...(turn.assistantTextRecoveryOwnerIds ?? [])].some(
    id => !turn.assistantTextBaselineOwnerIds?.has(id),
  );
  if (hasBaseline && coversChat && !missingBaseline) {
    turn.items = turn.items.filter(item => !(item.type === 'content' && item.chatFallback));
    for (const item of pending) delete item.assistantTextSourcePending;
    turn.assistantTextRecoveryOwnerIds?.clear();
    turn.assistantTextSourceSelected = true;
    return false;
  }
  if (!fallbacks.length) {
    for (const item of pending) delete item.assistantTextSourcePending;
    if (
      event.stream === 'assistant' &&
      turn.items.some(
        item => item.type === 'content' && item.assistantItemId !== undefined && item.text.trim(),
      )
    ) {
      turn.assistantTextSourceSelected = true;
    }
    return false;
  }
  if (textEvent && (pending.length || missingBaseline)) {
    for (const item of pending) {
      if (item.assistantItemId)
        (turn.assistantTextRecoveryOwnerIds ??= new Set()).add(item.assistantItemId);
    }
    return Boolean(turn.assistantTextRecoveryOwnerIds?.size);
  }
  return false;
}
