import type { AssistantTurn, ChatTranscriptState } from '../chat-transcript-state';
import { isTurnCompactionMessage, matchesCompactionHistory } from '../turn/compaction-item';
import { isFailedRunMessage, readFailedRunMessageText } from '../turn/failed-run-message';
import { readTranscriptIdentity } from './transcript-identity';

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

export function readActiveTurnMessageRunId(message: unknown): string | null {
  const record = asRecord(message);
  const nested = asRecord(record?.message);
  const nestedOpenClaw = asRecord(nested?.__openclaw);
  const openClaw = asRecord(record?.__openclaw);
  for (const candidate of [
    nested?.runId,
    nested?.run_id,
    nestedOpenClaw?.runId,
    nestedOpenClaw?.run_id,
    record?.runId,
    record?.run_id,
    openClaw?.runId,
    openClaw?.run_id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** Bootstrap the durable prefix without taking ownership of a live run's output. */
export function projectInitialHistoryForActiveTurn(
  messages: unknown[],
  turn: AssistantTurn,
  startedAt = turn.startedAt,
): unknown[] | null {
  const runIndex = messages.findIndex(
    message => readActiveTurnMessageRunId(message) === turn.runId,
  );
  if (runIndex >= 0) {
    return messages.slice(0, runIndex + (messageRole(messages[runIndex]) === 'user' ? 1 : 0));
  }
  const timestamp = (message: unknown): number | null => {
    const outer = asRecord(message);
    const record = asRecord(outer?.message) ?? outer;
    const marker = asRecord(record?.__openclaw) ?? asRecord(outer?.__openclaw);
    const value = marker?.recordTimestampMs ?? record?.timestamp ?? record?.ts;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const activeIndex = messages.findIndex(message => (timestamp(message) ?? -1) >= startedAt);
  if (activeIndex >= 0) {
    return messages.slice(0, activeIndex + (messageRole(messages[activeIndex]) === 'user' ? 1 : 0));
  }
  // An unscoped, undated row cannot be proven older than the executing turn.
  return messages.every(message => timestamp(message) !== null) ? messages : null;
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
  // session.message can publish the producer-owned durable assistant row
  // before its Agent stream ends. Keep it in the authoritative transcript,
  // but leave the active turn as the sole visible owner until that projection
  // retires so Content/Tool output is never rendered twice.
  let projected = messages.filter(message => {
    if (messageRole(message) === 'user') return true;
    // Followup inputs can be persisted while this run still owns its output.
    // Exact run ownership must survive a later user row in the same transcript.
    if (isTurnCompactionMessage(activeTurn, message)) return false;
    if (readActiveTurnMessageRunId(message) !== activeTurn.runId) return true;
    // Persisted diagnostics can describe a model attempt rather than the
    // whole-run failure. Show the native diagnostic alongside the retained
    // terminal explanation without allowing it to replace that explanation.
    // Only normalized error rows are admitted here; assistant partial text
    // remains owned by the live turn and must not be rendered twice.
    const identity = readTranscriptIdentity(message);
    return (
      activeTurn.status === 'error' &&
      identity?.kind.startsWith('openclaw-') === true &&
      !isLocallyOptimisticHistoryTail(message) &&
      messageRole(message) === 'system' &&
      isRunFailureMessage(message)
    );
  });
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
      const persistedRunId = readActiveTurnMessageRunId(message);
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
export function retireSettledActiveTurn(
  state: ChatTranscriptState,
  messages: unknown[],
  preserveCompactionPositions = false,
): boolean {
  if (!state.activeTurn || state.activeTurn.status === 'running') return false;
  if (isLocallyOptimisticHistoryTail(messages[messages.length - 1])) return false;
  // A durable final append can precede its compaction marker. Keep the live
  // position until that marker arrives or a reconciled full snapshot takes over.
  if (
    preserveCompactionPositions &&
    state.activeTurn.items.some(
      item =>
        item.type === 'compaction' &&
        item.message &&
        !messages.some(message => matchesCompactionHistory(item, message)),
    )
  )
    return false;
  const terminal = state.activeTurn.items.find(item => item.type === 'terminal');
  const normalizeError = (value: string): string => value.replace(/\s+/g, ' ').trim();
  if (
    state.activeTurn.status === 'error' &&
    !messages.some(message => {
      if (isLocallyOptimisticHistoryTail(message)) return false;
      if (readActiveTurnMessageRunId(message) !== state.activeTurn?.runId) return false;
      const outer = asRecord(message);
      const record = asRecord(outer?.message) ?? outer;
      const error = record?.errorMessage ?? outer?.errorMessage;
      const failureText = (
        typeof error === 'string' && error.trim() ? error : readFailedRunMessageText(message)
      )
        .replace(/\s+/g, ' ')
        .trim();
      // A recoverable model attempt can leave an error row under the same run
      // before a different whole-run failure. It must not erase that diagnosis.
      if (
        !failureText ||
        (terminal?.type === 'terminal' && !failureText.includes(normalizeError(terminal.message)))
      )
        return false;
      return isRunFailureMessage(message);
    })
  ) {
    return false;
  }
  state.activeTurn = null;
  state.revision += 1;
  return true;
}

function isRunFailureMessage(message: unknown): boolean {
  const outer = asRecord(message);
  const record = asRecord(outer?.message) ?? outer;
  return (
    isFailedRunMessage(message) ||
    (messageRole(message) === 'assistant' &&
      (record?.stopReason ?? record?.stop_reason) === 'error') ||
    (messageRole(message) === 'system' && record?.isError === true)
  );
}
