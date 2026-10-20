import { parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { parseGoalStartObjective } from '@shared/cowork/slashCommands';
import { stripSwarmInstruction } from '@shared/cowork/swarm';

import { pluginMessageText } from '@/features/plugins/app/messagePresentation';
import { getTranscriptMedia } from '@/libs/openclaw-chat/attachments';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { stripAppInput } from '../../../../../../plugins/extensions/runtime-services/contracts/app-input';
import { unwrapToolMessage } from '../tools/tool-message-adapter';

function messageRecord(message: GatewayMessage): Record<string, unknown> {
  return unwrapToolMessage(message) ?? (message as Record<string, unknown>);
}

function messageRole(message: GatewayMessage): string {
  return String(messageRecord(message).role ?? '').toLowerCase();
}

const MEDIA_CONTENT_TYPES = new Set([
  'attachment',
  'attachment_error',
  'image',
  'image_url',
  'input_image',
  'audio',
  'input_audio',
  'video',
  'file',
  'document',
]);

function messageInputKey(message: GatewayMessage): string | null {
  const record = messageRecord(message);
  const metadata = record.__openclaw;
  const key =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? ((metadata as Record<string, unknown>).idempotencyKey ?? record.idempotencyKey)
      : record.idempotencyKey;
  return typeof key === 'string' && key.trim() ? key : null;
}

function hasMessageMedia(message: GatewayMessage): boolean {
  const record = messageRecord(message);
  if (getTranscriptMedia(record).length > 0) return true;
  return [record.content, record.openclawDisplayContent].some(
    content =>
      Array.isArray(content) &&
      content.some(
        block =>
          block &&
          typeof block === 'object' &&
          !Array.isArray(block) &&
          MEDIA_CONTENT_TYPES.has(String((block as Record<string, unknown>).type)),
      ),
  );
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

function messageContentIdentity(message: GatewayMessage): {
  text: string;
  recordings: string;
  annotations: string | null;
} {
  const record = messageRecord(message);
  const recordings: unknown[] = [];
  const annotationIds: Array<string | null> = [];
  const addAnnotation = (value: unknown) => {
    const id =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : null;
    annotationIds.push(typeof id === 'string' && id.trim() ? id : null);
  };
  const addRecording = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const steps = (value as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) return;
    // Step ids survive history normalization, unlike wrapper ids and page text
    // (which Gateway may sanitize). Different recording-only sends must not
    // match merely because both have an empty visible prompt.
    recordings.push(steps.map(step => [step?.id, step?.action, step?.pageId]));
  };
  const textPart = (source: string) => {
    const text = stripSwarmInstruction(pluginMessageText(stripAppInput(source)));
    const browser = parseBrowserAnnotationPrompt(text);
    if (browser?.recording) addRecording(browser.recording);
    browser?.annotations.forEach(addAnnotation);
    return browser?.userText ?? text;
  };
  // Pending messages also carry a plain text shortcut. Read structured content
  // first so that shortcut cannot hide the recording's identity.
  const text =
    typeof record.content === 'string'
      ? textPart(record.content)
      : Array.isArray(record.content)
        ? record.content
            .map(block => {
              if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
              const value = block as Record<string, unknown>;
              if (value.type === 'browser_recording') addRecording(value.recording);
              if (value.type === 'browser_annotation') addAnnotation(value.annotation);
              return typeof value.text === 'string' ? textPart(value.text) : '';
            })
            .join('')
        : typeof record.text === 'string'
          ? textPart(record.text)
          : '';
  return {
    text: text.trim(),
    recordings: JSON.stringify(recordings),
    // Unknown card identity cannot justify replacing a different history row.
    annotations: annotationIds.includes(null) ? null : JSON.stringify(annotationIds),
  };
}

export function isPendingUserMessageMatch(
  message: GatewayMessage,
  pending: GatewayMessage,
): boolean {
  if (messageRole(message) !== 'user' || messageRole(pending) !== 'user') return false;
  const inputKey = messageInputKey(message);
  const pendingInputKey = messageInputKey(pending);
  // Compare the exact persisted input key captured from the owning send. Media
  // paths, MIME and even visible content can change before history is hydrated.
  if (inputKey && pendingInputKey) return inputKey === pendingInputKey;
  // Without shared input identity, equal text/time cannot identify attachments.
  if (hasMessageMedia(message) || hasMessageMedia(pending)) return false;
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
    persistedContent.recordings !== pendingContent.recordings ||
    pendingContent.annotations === null ||
    persistedContent.annotations === null ||
    persistedContent.annotations !== pendingContent.annotations
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
