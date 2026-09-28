import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';

import { chatTranslations } from '@/services/i18n/chatTranslations';

export interface MessageQuote {
  id: string;
  sessionKey: string;
  entryId: string;
  text: string;
  start?: number;
  end?: number;
}
export const EMPTY_MESSAGE_QUOTES: readonly MessageQuote[] = [];
export type MessageQuoteHandler = (quote: MessageQuote, target: 'composer' | 'side-chat') => void;

/** Keep the visible quote in native history as well as the source attachment. */
export function quotedGatewayPrompt(
  prompt: string,
  gatewayPrompt: string | undefined,
  quotes: readonly MessageQuote[],
  sideChat: boolean,
): string | undefined {
  if (!quotes.length) return gatewayPrompt;
  if (sideChat && gatewayPrompt === undefined) return undefined;
  return appendMessageQuotes(gatewayPrompt ?? prompt, quotes, '', sideChat);
}

export function appendMessageQuotes(
  prompt: string,
  quotes: readonly MessageQuote[],
  _label: string,
  singleLine = false,
): string {
  if (!quotes.length) return prompt;
  if (singleLine) {
    // OpenClaw Control UI companion prefill: compact selection, capped at 300 chars.
    return (
      quotes
        .map(quote => {
          const compact = quote.text.replace(/\s+/g, ' ').trim();
          const text = compact.slice(0, 300).replace(/[\uD800-\uDBFF]$/, '');
          return `Regarding "${text}": `;
        })
        .join('') + prompt
    );
  }
  return [
    prompt,
    ...quotes.map(quote =>
      quote.text
        .split('\n')
        .map(line => '> ' + line)
        .join('\n'),
    ),
  ].join('\n\n');
}

/** Raw slash commands keep their arguments exact and leave quote drafts untouched. */
export function submittedMessageQuotes(
  prompt: string,
  quotes: readonly MessageQuote[],
  sideChat: boolean,
): readonly MessageQuote[] {
  return !sideChat && prompt.trimStart().startsWith('/') ? EMPTY_MESSAGE_QUOTES : quotes;
}

/** Clear only the snapshot accepted by the transport; later draft additions survive. */
export async function submitMessageQuoteDrafts(
  quotes: readonly MessageQuote[],
  submit: () => boolean | void | Promise<boolean | void>,
  clearAccepted: (ids: string[]) => void,
): Promise<boolean | void> {
  const ids = quotes.map(quote => quote.id);
  const result = await submit();
  if (result !== false && ids.length) clearAccepted(ids);
  return result;
}

/** Display-only projection of our quote transport; never changes native history or send text. */
export function renderMessageQuoteText(source: string, _label: string): string {
  let display = source;
  for (const context of [
    chatTranslations.zh.messageQuoteContext,
    chatTranslations.en.messageQuoteContext,
  ]) {
    const escaped = context.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      escaped + String.raw`\s+(\()?({(?:[^{}"]|"(?:\\.|[^"\\])*")*})(\))?`,
      'g',
    );
    display = display.replace(pattern, (original, open, json, close) => {
      try {
        const quote = JSON.parse(json) as Record<string, unknown>;
        if (typeof quote.sessionKey !== 'string' || typeof quote.entryId !== 'string')
          return original;
        if (open && close && Object.keys(quote).length === 2) return `\n\n`;
        if (!open && !close && typeof quote.text === 'string' && Object.keys(quote).length === 3)
          return `\n\n${quote.text
            .split('\n')
            .map(line => '> ' + line)
            .join('\n')}\n\n`;
      } catch {
        /* Ordinary user text stays unchanged. */
      }
      return original;
    });
  }
  return display;
}

/** Native Control UI selection-comment.txt payload, delivered through the attachment bridge. */
export function messageQuoteAttachment(quote: MessageQuote): CoworkAttachmentPayload {
  const source = [
    `Source session: ${quote.sessionKey}`,
    ...(quote.entryId ? [`Source entry: ${quote.entryId}`] : []),
    `Selected text UTF-16 length: ${quote.text.length}`,
    ...(quote.start !== undefined && quote.end !== undefined
      ? [`DOM text UTF-16 range: [${quote.start}, ${quote.end})`]
      : []),
  ].join('\n');
  const content = `Selected text:\n${quote.text}\n\n${source}`;
  const bytes = new TextEncoder().encode(content);
  return {
    name: 'selection-comment.txt',
    mimeType: 'text/plain',
    base64Data: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
  };
}
