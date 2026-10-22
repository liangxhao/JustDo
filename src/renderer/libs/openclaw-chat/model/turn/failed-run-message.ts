import { appendErrorDisplayDetail } from '@shared/openclaw/errorDisplay';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';
import { isGatewayInjectedModelRef, readModelRef } from '@shared/providers/modelRef';

import type { AssistantTurn } from '../chat-transcript-state';

export const FAILED_RUN_MESSAGE_FLAG = '__justdoFailedRunMessage';
export const FAILED_RUN_MESSAGE_ID = '__justdoFailedRunMessageId';
const NATIVE_RUN_FAILURE_CUSTOM_TYPE = 'run-failed-before-reply';
const NATIVE_STATE_CONTENTION_ERROR_KIND = 'state_contention';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapFailedRunMessage(value: unknown): {
  outer: Record<string, unknown> | null;
  message: Record<string, unknown> | null;
} {
  const outer = asRecord(value);
  return { outer, message: asRecord(outer?.message) ?? outer };
}

function isNativeRunFailureMessage(message: Record<string, unknown> | null): boolean {
  return message?.role === 'custom' && message.customType === NATIVE_RUN_FAILURE_CUSTOM_TYPE;
}

function nativeFailureRunId(value: unknown): string | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
  const runId = marker?.runId ?? message?.runId ?? outer?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

export function readAssistantFailureDetail(value: unknown): string {
  const { message } = unwrapFailedRunMessage(value);
  return message?.role === 'assistant' &&
    (message.stopReason ?? message.stop_reason) === 'error' &&
    typeof message.errorMessage === 'string' &&
    !isInternalManagedSubagentHandoffError(message.errorMessage)
    ? appendErrorDisplayDetail('', message.errorMessage)
    : '';
}

export function readNativeFailureDetails(messages: readonly unknown[], runId: string): string {
  const details = messages.flatMap(value => {
    const { outer, message } = unwrapFailedRunMessage(value);
    const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
    const detail = readAssistantFailureDetail(value);
    return typeof marker?.id === 'string' &&
      marker.id.trim() &&
      nativeFailureRunId(value) === runId &&
      detail
      ? [detail]
      : [];
  });
  return [...new Set(details)].join(' · ');
}

/** Enrich only a presentation copy; native execution/terminal state remains unchanged. */
export function withFailureDetailsForDisplay(
  turn: AssistantTurn | null,
  messages: readonly unknown[],
): AssistantTurn | null {
  if (!turn || turn.status !== 'error') return turn;
  const detail = readNativeFailureDetails(messages, turn.runId);
  if (!detail) return turn;
  let changed = false;
  const items = turn.items.map(item => {
    if (item.type !== 'terminal') return item;
    const message = appendErrorDisplayDetail(item.message, detail);
    if (message === item.message) return item;
    changed = true;
    return { ...item, message };
  });
  return changed ? { ...turn, items } : turn;
}

export function readUncoveredFailureDetail(value: unknown, messages: readonly unknown[]): string {
  const detail = readAssistantFailureDetail(value);
  const runId = nativeFailureRunId(value);
  return detail &&
    !(
      runId &&
      messages.some(
        message =>
          isFailedRunMessage(message) &&
          nativeFailureRunId(message) === runId &&
          readFailedRunMessageText(message).includes(detail),
      )
    )
    ? detail
    : '';
}

export function isFailedRunMessage(value: unknown): boolean {
  const { outer, message } = unwrapFailedRunMessage(value);
  return (
    message?.[FAILED_RUN_MESSAGE_FLAG] === true ||
    outer?.[FAILED_RUN_MESSAGE_FLAG] === true ||
    isNativeRunFailureMessage(message)
  );
}

export function readFailedRunMessageText(value: unknown): string {
  const { outer, message } = unwrapFailedRunMessage(value);
  const content = message?.content ?? outer?.content;
  // Gateway exposes only this category's public diagnostic; raw report errors stay private.
  const details = isNativeRunFailureMessage(message) ? asRecord(message?.details) : null;
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

export function readFailedRunMessageModelRef(value: unknown): string {
  const { outer, message } = unwrapFailedRunMessage(value);
  const modelRef = readModelRef(message) ?? readModelRef(outer);
  return modelRef && !isGatewayInjectedModelRef(modelRef) ? modelRef : '';
}

export function readFailedRunMessageTimestamp(value: unknown): number | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  for (const timestamp of [message?.timestamp, message?.ts, outer?.timestamp, outer?.ts]) {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
    if (typeof timestamp !== 'string' || !timestamp.trim()) continue;
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
