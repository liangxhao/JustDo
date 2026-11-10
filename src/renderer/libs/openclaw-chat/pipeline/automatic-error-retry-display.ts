import { FAILED_RUN_MESSAGE_FLAG, FAILED_RUN_MESSAGE_ID, isFailedRunMessage } from '@shared/openclaw/runFailureDisplay';

import type { AssistantTurn } from '../model/chat-transcript-state';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

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
    const message: Record<string, unknown> = {
      ...raw,
      role: 'assistant',
      content: Array.isArray(raw.content)
        ? raw.content.filter(block => {
            const text = record(block);
            if (text?.type !== 'text') return true;
            // A failed assistant may retain a useful partial answer. Only its
            // native synthetic error copy is hidden, not unrelated reply text.
            return raw.role === 'assistant' &&
              (typeof raw.errorMessage !== 'string' || typeof text.text !== 'string' ||
                (text.text.trim() !== raw.errorMessage.trim() &&
                  text.text.trim() !== `Error: ${raw.errorMessage.trim()}`));
          })
        : raw.role === 'assistant' && typeof raw.content === 'string' &&
          (typeof raw.errorMessage !== 'string' || (raw.content.trim() !== raw.errorMessage.trim() &&
            raw.content.trim() !== `Error: ${raw.errorMessage.trim()}`)) ? raw.content : [],
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
