import { appendErrorDisplayDetail } from './errorDisplay';

export const FAILED_RUN_MESSAGE_FLAG = '__justdoFailedRunMessage';
export const FAILED_RUN_MESSAGE_ID = '__justdoFailedRunMessageId';
const NATIVE_RUN_FAILURE_CUSTOM_TYPE = 'run-failed-before-reply';
const NATIVE_STATE_CONTENTION_ERROR_KIND = 'state_contention';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrap(value: unknown) {
  const outer = asRecord(value);
  return { outer, message: asRecord(outer?.message) ?? outer };
}

function nativeFailure(message: Record<string, unknown> | null): boolean {
  return message?.role === 'custom' && message.customType === NATIVE_RUN_FAILURE_CUSTOM_TYPE;
}

export function isFailedRunMessage(value: unknown): boolean {
  const { outer, message } = unwrap(value);
  return (
    message?.[FAILED_RUN_MESSAGE_FLAG] === true ||
    outer?.[FAILED_RUN_MESSAGE_FLAG] === true ||
    nativeFailure(message)
  );
}

/** Only the native public diagnostic is eligible for display, never its raw report. */
export function readFailedRunMessageText(value: unknown): string {
  const { outer, message } = unwrap(value);
  const content = message?.content ?? outer?.content;
  const details = nativeFailure(message) ? asRecord(message?.details) : null;
  const diagnostic =
    details?.errorKind === NATIVE_STATE_CONTENTION_ERROR_KIND ? details.diagnostic : undefined;
  if (typeof content === 'string') return appendErrorDisplayDetail(content.trim(), diagnostic);
  if (Array.isArray(content)) {
    const text = content
      .map(block => asRecord(block)?.text)
      .filter(item => typeof item === 'string' && item.trim())
      .join('\n')
      .trim();
    if (text) return appendErrorDisplayDetail(text, diagnostic);
  }
  for (const error of [message?.errorMessage, outer?.errorMessage]) {
    if (typeof error === 'string' && error.trim())
      return appendErrorDisplayDetail(error.trim(), diagnostic);
  }
  return appendErrorDisplayDetail('', diagnostic);
}
