import { getChromeDeliveryMediaUrls } from '@shared/chrome/chromeExtensionDeliverables';
import type { ChromeExtensionStreamEvent } from '@shared/chrome/chromeExtensionStream';
import { unwrapAssistantDeliverableSource } from '@shared/openclaw/assistantDeliverables';
import { filterMediaDirectiveLines } from '@shared/openclaw/mediaDirectives';

import { getTranscriptMedia, isTranscriptImage } from '@/libs/openclaw-chat/attachments';
import { isTruncatedHistoryMessage } from '@/libs/openclaw-chat/gateway/history/chat-history-protocol';
import { stripHeartbeatTokenForDisplay } from '@/libs/openclaw-chat/pipeline/heartbeat-display';
import {
  shouldHideMessage,
  stripSilentReplySuffixFromText,
} from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { stripOpenClawLogHintText } from '@/libs/openclaw-chat/pipeline/system-message-display';

/** The original text still participates in stream reconciliation. */
export function isOmittedChromeDeliveryText(entry: {
  text: string;
  rawMessage?: Record<string, unknown>;
}): boolean {
  const raw = entry.rawMessage;
  if (raw?.__chromeExtensionOmitDeliveryMedia !== true) return false;
  if (Array.isArray(raw.content) && raw.content.some(block => block?.type !== 'text')) return false;
  const references = new Set(getChromeDeliveryMediaUrls(raw).map(unwrapAssistantDeliverableSource));
  return references.size > 0 &&
    !filterMediaDirectiveLines(entry.text, source => references.has(unwrapAssistantDeliverableSource(source))).trim() &&
    !getTranscriptMedia(raw).some(media => isTranscriptImage(media) && !references.has(unwrapAssistantDeliverableSource(media.path)));
}

function hidden(text: string): boolean {
  const trimmed = text.trim();
  return (
    Boolean(trimmed) &&
    ('NO_REPLY'.startsWith(trimmed.toUpperCase()) ||
      stripHeartbeatTokenForDisplay(trimmed).shouldSkip)
  );
}

function stripSuffix(text: string): string {
  // Preserve spaces in ordinary delta chunks.
  return /NO_REPLY\s*$/i.test(text) ? stripSilentReplySuffixFromText(text) : text;
}

/** A rendered text block closes the preceding live process. Media alone leaves it visible. */
export function hasChromeProcessFoldText(entry: {
  text: string;
  status?: string;
  rawMessage?: Record<string, unknown>;
}): boolean {
  if (isOmittedChromeDeliveryText(entry) || (!entry.rawMessage && !entry.text.trim())) return false;
  const raw = entry.rawMessage ?? { role: 'assistant', content: entry.text };
  return normalizeMessage(raw).content.some(block => {
    if (block.type !== 'text' || !block.text) return false;
    const text = stripOpenClawLogHintText(stripSuffix(block.text), entry.status === 'streaming');
    return Boolean(text.trim()) && !shouldHideMessage({ role: 'assistant', content: text });
  });
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const value = message as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return '';
  return value.content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      return typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/** Apply desktop display rules before raw Gateway events reach the reducer. */
export function prepareChromeExtensionStreamEvent(
  value: ChromeExtensionStreamEvent,
): ChromeExtensionStreamEvent | null {
  if (value.kind === 'agent') {
    if (value.event.stream !== 'assistant') return value;
    const data = value.event.data;
    const text =
      typeof data.text === 'string' && data.text.trim()
        ? data.text
        : typeof data.delta === 'string'
          ? data.delta
          : '';
    if (hidden(text)) return null;
    return {
      ...value,
      event: {
        ...value.event,
        data: {
          ...data,
          ...(typeof data.text === 'string' ? { text: stripSuffix(data.text) } : {}),
          ...(typeof data.delta === 'string' ? { delta: stripSuffix(data.delta) } : {}),
        },
      },
    };
  }
  const event = value.event;
  if (event.state !== 'delta' && event.state !== 'final') return value;
  const text = messageText(event.message) || event.deltaText || '';
  if (hidden(text) || (event.state === 'final' && isTruncatedHistoryMessage(event.message))) {
    // A hidden final still closes the run, but must not replace the visible reply.
    return event.state === 'delta'
      ? null
      : {
          ...value,
          event: { ...event, message: undefined, deltaText: undefined },
        };
  }
  const stripped = stripSuffix(text);
  if (stripped === text) return value;
  return {
    ...value,
    event: {
      ...event,
      ...(event.message !== undefined ? { message: { content: stripped } } : {}),
      ...(event.deltaText !== undefined ? { deltaText: stripSuffix(event.deltaText) } : {}),
    },
  };
}
