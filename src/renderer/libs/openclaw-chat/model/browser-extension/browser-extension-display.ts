import type { BrowserExtensionStreamEvent } from '@shared/browser/browserExtensionStream';

import { isTruncatedHistoryMessage } from '../../gateway/history/chat-history-protocol';
import { stripHeartbeatTokenForDisplay } from '../../pipeline/heartbeat-display';
import { stripSilentReplySuffixFromText } from '../../pipeline/history-display-normalizer';

const GENERIC_FAILURE = 'The agent run failed before producing a reply.';

function hidden(text: string): boolean {
  const trimmed = text.trim();
  return (
    Boolean(trimmed) &&
    ('NO_REPLY'.startsWith(trimmed.toUpperCase()) ||
      trimmed === GENERIC_FAILURE ||
      stripHeartbeatTokenForDisplay(trimmed).shouldSkip)
  );
}

function stripSuffix(text: string): string {
  // Preserve spaces in ordinary delta chunks.
  return /NO_REPLY\s*$/i.test(text) ? stripSilentReplySuffixFromText(text) : text;
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
export function prepareBrowserExtensionStreamEvent(
  value: BrowserExtensionStreamEvent,
): BrowserExtensionStreamEvent | null {
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
