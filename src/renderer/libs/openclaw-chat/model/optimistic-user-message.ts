import { parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { parseGoalStartObjective } from '@shared/cowork/slashCommands';
import { stripSwarmInstruction } from '@shared/cowork/swarm';

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

function messageContentIdentity(message: GatewayMessage): { text: string; recordings: string } {
  const record = messageRecord(message);
  const recordings: unknown[] = [];
  const addRecording = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const steps = (value as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) return;
    // Step ids survive history normalization, unlike wrapper ids and page text
    // (which Gateway may sanitize). Different recording-only sends must not
    // match merely because both have an empty visible prompt.
    recordings.push(steps.map(step => [step?.id, step?.action, step?.pageId]));
  };
  const textPart = (text: string) => {
    text = stripSwarmInstruction(text);
    const browser = parseBrowserAnnotationPrompt(text);
    if (browser?.recording) addRecording(browser.recording);
    return browser?.recording ? browser.userText : text;
  };
  const text =
    typeof record.content === 'string'
      ? textPart(record.content)
      : typeof record.text === 'string'
        ? textPart(record.text)
        : Array.isArray(record.content)
          ? record.content
              .map(block => {
                if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
                const value = block as Record<string, unknown>;
                if (value.type === 'browser_recording') addRecording(value.recording);
                return typeof value.text === 'string' ? textPart(value.text) : '';
              })
              .join('')
          : '';
  return { text: text.trim(), recordings: JSON.stringify(recordings) };
}

export function isPendingUserMessageMatch(
  message: GatewayMessage,
  pending: GatewayMessage,
): boolean {
  const pendingContent = messageContentIdentity(pending);
  const persistedContent = messageContentIdentity(message);
  const pendingText = pendingContent.text;
  const persistedText = persistedContent.text;
  const comparablePendingText = parseGoalStartObjective(pendingText) ?? pendingText;
  const comparablePersistedText = parseGoalStartObjective(persistedText) ?? persistedText;
  const pendingTimestamp = messageTimestamp(pending);
  if (
    messageRole(message) !== 'user' ||
    comparablePersistedText !== comparablePendingText ||
    persistedContent.recordings !== pendingContent.recordings
  ) {
    return false;
  }

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
  if (!pending) return messages;
  if (messages.some(message => isPendingUserMessageMatch(message, pending))) return messages;

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
