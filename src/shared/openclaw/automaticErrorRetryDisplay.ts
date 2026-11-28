import { FAILED_RUN_MESSAGE_FLAG, FAILED_RUN_MESSAGE_ID, isFailedRunMessage } from './runFailureDisplay';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

const contextOverflowCopy =
  'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.';
const missingReplyCopy = "Agent couldn't generate a response. Please try again.";
const preflightCompactionCopy = 'Auto-compaction failed before the next model request. Try again or run /compact.';
const sideEffectCaution = ' Completed tool actions were not replayed; verify their effects before retrying.';
const nativeRetryFailureCopies = new Set([
  'OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.',
  contextOverflowCopy,
  contextOverflowCopy + sideEffectCaution,
  preflightCompactionCopy,
  preflightCompactionCopy + sideEffectCaution,
  'Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.' +
    '\n\nTry starting a fresh session or using a model with a larger context window.',
  'This conversation is too long for the model. Try /compact, or start a new conversation with /new.',
  missingReplyCopy,
]);

const nativeFailurePrefixes = /^(?:Error: |Your request couldn't be completed: |⚠[\uFE0E\uFE0F]?\s*){1,3}/u;
const stripFailurePrefixes = (text: string): string => text.trimStart().replace(nativeFailurePrefixes, '');

export function isKnownAutomaticRetryFailureCopy(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 4_096 &&
    nativeRetryFailureCopies.has(stripFailurePrefixes(value).trimEnd().replace(/\r\n/g, '\n'));
}

function stripNativeFailureFromTerminalText(text: string): string {
  const copy = stripFailurePrefixes(text);
  for (const known of nativeRetryFailureCopies) {
    for (const separator of ['\n\n', '\r\n\r\n']) {
      const wireCopy = separator === '\n\n' ? known : known.replace(/\n/g, '\r\n');
      if (copy.startsWith(wireCopy + separator)) return copy.slice(wireCopy.length + separator.length);
    }
  }
  return text;
}

export function retryMessageRunId(value: unknown): string | undefined {
  const outer = record(value);
  const message = record(outer?.message) ?? outer;
  const marker = record(message?.__openclaw) ?? record(outer?.__openclaw);
  const id = marker?.runId ?? message?.runId ?? outer?.runId;
  return typeof id === 'string' && id ? id : undefined;
}

export function isRetryFailureMessage(value: unknown): boolean {
  const outer = record(value);
  const message = record(outer?.message) ?? outer;
  return isFailedRunMessage(value) || Boolean(message && (
    (message.role === 'assistant' && (message.stopReason ?? message.stop_reason) === 'error') ||
    (message.role === 'system' && message.isError === true)
  ));
}

/** Remove terminal error copy from a display clone, retaining tools and file/media blocks. */
export function projectRetryFailureMessages<T>(messages: T[], hiddenRunIds: ReadonlySet<string>): T[] {
  let changed = false;
  const projected = messages.map(value => {
    const runId = retryMessageRunId(value);
    if (!runId || !hiddenRunIds.has(runId) || !isRetryFailureMessage(value)) return value;
    const outer = record(value)!;
    const raw = record(outer.message) ?? outer;
    const innerMarker = record(raw.__openclaw);
    const outerMarker = record(outer.__openclaw);
    const marker = innerMarker ?? outerMarker;
    if ([raw.runId, outer.runId, innerMarker?.runId, innerMarker?.run_id, outerMarker?.runId, outerMarker?.run_id]
      .some(id => typeof id === 'string' && id && id !== runId)) return value;
    // Public chat history removes errorMessage. OpenClaw tags terminal assistant
    // errors separately from other messages, and that row may contain partial text.
    const nativeTerminalError = marker?.runId === runId && marker.idempotencyKey === `${runId}:terminal-error`;
    const errorMessage = typeof raw.errorMessage === 'string' ? raw.errorMessage.trim() : undefined;
    const projectText = (text: unknown): unknown => {
      if (raw.role !== 'assistant') return undefined;
      if (typeof text !== 'string') return text;
      const trimmed = text.trim();
      if (errorMessage !== undefined && (trimmed === errorMessage || trimmed === `Error: ${errorMessage}`)) {
        return undefined;
      }
      if (nativeTerminalError) {
        if (isKnownAutomaticRetryFailureCopy(text)) return undefined;
        return stripNativeFailureFromTerminalText(text);
      }
      return text;
    };
    const message: Record<string, unknown> = {
      ...raw,
      role: 'assistant',
      content: Array.isArray(raw.content)
        ? raw.content.flatMap(block => {
            const entry = record(block);
            if (entry?.type !== 'text') return [block];
            const text = projectText(entry.text);
            if (text === entry.text && raw.role === 'assistant') return [block];
            return text === undefined ? [] : [{ ...entry, text }];
          })
        : typeof raw.content === 'string' ? projectText(raw.content) ?? [] : [],
    };
    // The original message remains untouched. Attached tools and non-text
    // resources still flow through the regular timeline instead of disappearing.
    for (const key of ['errorMessage', 'errorCode', 'isError', 'stopReason', 'stop_reason',
      'customType', 'text', FAILED_RUN_MESSAGE_FLAG, FAILED_RUN_MESSAGE_ID]) delete message[key];
    changed = true;
    if (raw === outer) return message as T;
    const envelope: Record<string, unknown> = { ...outer, message };
    delete envelope[FAILED_RUN_MESSAGE_FLAG];
    delete envelope[FAILED_RUN_MESSAGE_ID];
    return envelope as T;
  });
  return changed ? projected : messages;
}
