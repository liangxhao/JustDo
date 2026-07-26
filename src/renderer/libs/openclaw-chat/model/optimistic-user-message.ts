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

function hasPendingMessage(messages: GatewayMessage[], pending: GatewayMessage): boolean {
  const pendingRecord = messageRecord(pending);
  return messages.some(message => {
    const record = messageRecord(message);
    return (
      messageRole(message) === 'user' &&
      record.content === pendingRecord.content &&
      record.timestamp === pendingRecord.timestamp
    );
  });
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
