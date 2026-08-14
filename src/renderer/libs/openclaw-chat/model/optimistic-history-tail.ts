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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readToolCallId(value: Record<string, unknown>): string | null {
  const direct = value.toolCallId ?? value.tool_call_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  if (!['toolcall', 'tool_call', 'tooluse', 'tool_use'].includes(type)) return null;
  return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
}

function referencesActiveToolCall(message: unknown, activeToolCallIds: Set<string>): boolean {
  const record = asRecord(message);
  if (!record) return false;
  const directId = readToolCallId(record);
  if (directId && activeToolCallIds.has(directId)) return true;
  if (!Array.isArray(record.content)) return false;
  return record.content.some(block => {
    const blockRecord = asRecord(block);
    if (!blockRecord) return false;
    const blockId = readToolCallId(blockRecord);
    return Boolean(blockId && activeToolCallIds.has(blockId));
  });
}

/**
 * A completed active turn owns the live projection until Gateway history
 * replaces its optimistic fallback. Never render both sources at once.
 */
export function projectPersistedMessagesForActiveTurn<T>(
  messages: T[],
  activeTurn: AssistantTurn | null,
): T[] {
  if (!activeTurn) return messages;
  if (activeTurn.status === 'running') {
    if (activeTurn.toolById.size === 0) return messages;
    const activeToolCallIds = new Set(activeTurn.toolById.keys());
    return messages.filter(message => !referencesActiveToolCall(message, activeToolCallIds));
  }
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
