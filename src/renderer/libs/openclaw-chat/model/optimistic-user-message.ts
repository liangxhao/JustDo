import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { unwrapToolMessage } from './tool-message-adapter';

function messageRecord(message: GatewayMessage): Record<string, unknown> {
  return unwrapToolMessage(message) ?? (message as Record<string, unknown>);
}

function messageRole(message: GatewayMessage): string {
  return String(messageRecord(message).role ?? '').toLowerCase();
}

function messageTimestamp(message: GatewayMessage): number | null {
  const outer = message as Record<string, unknown>;
  const inner = messageRecord(message);
  for (const value of [inner.timestamp, inner.ts, outer.timestamp, outer.ts]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function messageText(message: GatewayMessage): string {
  const record = messageRecord(message);
  if (typeof record.content === 'string') return record.content.trim();
  if (typeof record.text === 'string') return record.text.trim();
  if (!Array.isArray(record.content)) return '';
  return record.content
    .map(block => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
      const value = block as Record<string, unknown>;
      return typeof value.text === 'string' ? value.text : '';
    })
    .join('')
    .trim();
}

export function isPendingUserMessageMatch(
  message: GatewayMessage,
  pending: GatewayMessage,
): boolean {
  const pendingText = messageText(pending);
  const pendingTimestamp = messageTimestamp(pending);
  if (messageRole(message) !== 'user' || messageText(message) !== pendingText) return false;

  const timestamp = messageTimestamp(message);
  // The temporary Cowork message, pending Lit projection, and Gateway record
  // are created independently for the same submission, so their timestamps
  // are close but not byte-identical.
  return (
    timestamp === null ||
    pendingTimestamp === null ||
    Math.abs(timestamp - pendingTimestamp) < 60_000
  );
}

function hasPendingMessage(messages: GatewayMessage[], pending: GatewayMessage): boolean {
  return messages.some(message => isPendingUserMessageMatch(message, pending));
}

/**
 * Keep a pending prompt ahead of a response that reached history first.
 *
 * A newly promoted session can briefly expose its assistant reply before the
 * gateway history contains the initiating user message. Appending the pending
 * prompt would invert the turn until the next history refresh.
 */
export function mergePendingUserMessageForDisplay(
  messages: GatewayMessage[],
  pending: GatewayMessage | null,
): GatewayMessage[] {
  if (!pending || hasPendingMessage(messages, pending)) return messages;

  const pendingTimestamp = messageTimestamp(pending);
  let insertionIndex = -1;
  if (pendingTimestamp !== null) {
    insertionIndex = messages.findIndex(message => {
      const timestamp = messageTimestamp(message);
      return timestamp !== null && timestamp >= pendingTimestamp;
    });
  }

  if (insertionIndex < 0 && !messages.some(message => messageRole(message) === 'user')) {
    insertionIndex = messages.findIndex(message => messageRole(message) === 'assistant');
  }

  if (insertionIndex < 0) return [...messages, pending];
  return [...messages.slice(0, insertionIndex), pending, ...messages.slice(insertionIndex)];
}
