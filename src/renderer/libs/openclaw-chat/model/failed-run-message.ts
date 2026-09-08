import { isGatewayInjectedModelRef, readModelRef } from '@shared/openclaw/modelRef';

export const FAILED_RUN_MESSAGE_FLAG = '__justdoFailedRunMessage';
export const FAILED_RUN_MESSAGE_ID = '__justdoFailedRunMessageId';

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

export function isFailedRunMessage(value: unknown): boolean {
  const { outer, message } = unwrapFailedRunMessage(value);
  return message?.[FAILED_RUN_MESSAGE_FLAG] === true || outer?.[FAILED_RUN_MESSAGE_FLAG] === true;
}

export function readFailedRunMessageText(value: unknown): string {
  const { outer, message } = unwrapFailedRunMessage(value);
  const content = message?.content ?? outer?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map(block => asRecord(block)?.text)
      .filter(item => typeof item === 'string' && item.trim())
      .join('\n')
      .trim();
    if (text) return text;
  }
  for (const error of [message?.errorMessage, outer?.errorMessage]) {
    if (typeof error === 'string' && error.trim()) return error.trim();
  }
  return '';
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
