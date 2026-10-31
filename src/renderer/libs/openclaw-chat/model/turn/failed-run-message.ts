import { appendErrorDisplayDetail } from '@shared/openclaw/errorDisplay';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';
import {
  FAILED_RUN_MESSAGE_FLAG,
  isFailedRunMessage,
  readFailedRunMessageText,
} from '@shared/openclaw/runFailureDisplay';
import { isGatewayInjectedModelRef, readModelRef } from '@shared/providers/modelRef';

import { cleanFailureDisplayText } from '../../pipeline/system-message-display';
import type { AssistantTurn } from '../chat-transcript-state';

export {
  FAILED_RUN_MESSAGE_FLAG,
  FAILED_RUN_MESSAGE_ID,
  isFailedRunMessage,
  readFailedRunMessageText,
} from '@shared/openclaw/runFailureDisplay';

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

const nativeFailureSummary = Symbol('native-failure-summary');

/** Preserve only Gateway display copy on this in-memory, source-owned projection. */
export function withNativeFailureSummary<T extends object>(message: T, summary: string): T {
  return summary.trim() ? { ...message, [nativeFailureSummary]: summary.trim() } : message;
}

export function readNativeFailureSummary(value: unknown): string {
  const { message } = unwrapFailedRunMessage(value);
  const summary = (message as { [nativeFailureSummary]?: unknown } | null)?.[nativeFailureSummary];
  return typeof summary === 'string' ? summary : '';
}

function nativeFailureRunId(value: unknown): string | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
  const runId = marker?.runId ?? message?.runId ?? outer?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

export function readAssistantFailureDetail(value: unknown): string {
  const { message } = unwrapFailedRunMessage(value);
  const modelFailure =
    message?.role === 'assistant' ||
    (message?.role === 'system' && message[FAILED_RUN_MESSAGE_FLAG] === true);
  if (!(
    message &&
    modelFailure &&
    (message.stopReason ?? message.stop_reason) === 'error' &&
    typeof message.errorMessage === 'string' &&
    !isInternalManagedSubagentHandoffError(message.errorMessage)
  ))
    return '';
  return appendErrorDisplayDetail('', message.errorMessage);
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
  const sources = messages.flatMap(value => {
    const detail = readNativeFailureDetails([value], turn.runId);
    return detail ? [{ detail, summary: readNativeFailureSummary(value) }] : [];
  });
  if (!sources.length) return turn;
  let changed = false;
  const items = turn.items.map(item => {
    if (item.type !== 'terminal') return item;
    let detail = '';
    for (const source of sources) {
      let displayed = cleanFailureDisplayText(`${item.message}\n${detail}`);
      const parts: string[] = [];
      for (const part of [source.summary, source.detail].map(cleanFailureDisplayText)) {
        if (!part || displayed.includes(part)) continue;
        parts.push(part);
        displayed += `\n${part}`;
      }
      const block = parts.join('\n');
      if (block) detail = detail ? `${detail}\n\n${block}` : block;
    }
    const message = appendErrorDisplayDetail(item.message, detail);
    if (message === item.message) return item;
    changed = true;
    return { ...item, message };
  });
  return changed ? { ...turn, items } : turn;
}

export function readUncoveredFailureDetail(value: unknown, messages: readonly unknown[]): string {
  // Normalized failure rows already render their diagnostic as their content.
  // A source without a run id cannot use the cross-message coverage check below.
  if (isFailedRunMessage(value)) return '';
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
