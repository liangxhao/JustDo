import type { AssistantTurn, ChatTranscriptState } from './chat-transcript-state';

const LOCAL_OPTIMISTIC_MESSAGE_FLAG = '__justdoOptimisticHistoryTail';

export function markOptimisticHistoryTail(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return message;
  }
  return {
    ...(message as Record<string, unknown>),
    [LOCAL_OPTIMISTIC_MESSAGE_FLAG]: true,
  };
}

export function isLocallyOptimisticHistoryTail(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>)[LOCAL_OPTIMISTIC_MESSAGE_FLAG] === true,
  );
}

/**
 * A completed active turn owns the live projection until Gateway history
 * replaces its optimistic fallback. Never render both sources at once.
 */
export function projectPersistedMessagesForActiveTurn<T>(
  messages: T[],
  activeTurn: AssistantTurn | null,
): T[] {
  if (!activeTurn || activeTurn.status === 'running') return messages;
  return isLocallyOptimisticHistoryTail(messages[messages.length - 1])
    ? messages.slice(0, -1)
    : messages;
}

/**
 * OpenClaw WebChat replaces live state with authoritative chat.history.
 * Retire the terminal projection only after the optimistic fallback is gone.
 */
export function retireSettledActiveTurn(state: ChatTranscriptState, messages: unknown[]): boolean {
  if (!state.activeTurn || state.activeTurn.status === 'running') return false;
  if (isLocallyOptimisticHistoryTail(messages[messages.length - 1])) return false;
  state.activeTurn = null;
  state.revision += 1;
  return true;
}
