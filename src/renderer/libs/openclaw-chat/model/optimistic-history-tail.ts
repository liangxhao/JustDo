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

function messageRole(message: unknown): string {
  const record = asRecord(message);
  const nested = asRecord(record?.message);
  const role = nested?.role ?? record?.role;
  return typeof role === 'string' ? role.toLowerCase() : '';
}

function messageRunId(message: unknown): string | null {
  const record = asRecord(message);
  const nested = asRecord(record?.message);
  const runId = nested?.runId ?? record?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

/**
 * A completed active turn owns the live projection until Gateway history
 * replaces its optimistic fallback. Never render both sources at once.
 */
export function projectPersistedMessagesForActiveTurn<T>(
  messages: T[],
  activeTurn: AssistantTurn | null,
  pendingUserMessage: unknown = null,
): T[] {
  if (!activeTurn) return messages;
  let projected = messages;
  if (activeTurn.toolById.size > 0) {
    const activeToolCallIds = new Set(activeTurn.toolById.keys());
    let lastUserIndex = -1;
    projected.forEach((message, index) => {
      if (messageRole(message) === 'user') lastUserIndex = index;
    });
    projected = projected.filter((message, index) => {
      if (index <= lastUserIndex || !referencesActiveToolCall(message, activeToolCallIds)) {
        return true;
      }
      const persistedRunId = messageRunId(message);
      if (persistedRunId !== null) return persistedRunId !== activeTurn.runId;
      // Until the optimistic user prompt appears in chat.history, no
      // unscoped persisted Tool can be proven to belong to the active turn.
      return pendingUserMessage !== null;
    });
  }
  if (activeTurn.status === 'running') return projected;
  return isLocallyOptimisticHistoryTail(projected[projected.length - 1])
    ? projected.slice(0, -1)
    : projected;
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
