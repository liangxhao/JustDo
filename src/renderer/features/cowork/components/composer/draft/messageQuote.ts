import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';

import { i18nService } from '@/services/i18n';
import { chatTranslations } from '@/services/i18n/chatTranslations';

export const MESSAGE_QUOTE_KIND = {
  MESSAGE: 'message',
  DISCUSSION: 'discussion',
  COLLABORATION: 'collaboration',
  EXTENSION: 'extension',
} as const;

export interface NativeMessageQuote {
  kind?: typeof MESSAGE_QUOTE_KIND.MESSAGE;
  id: string;
  sessionKey: string;
  entryId: string;
  text: string;
  start?: number;
  end?: number;
}
/** A locator selected by the user, never a cached copy of discussion history. */
export interface DiscussionQuote {
  kind: typeof MESSAGE_QUOTE_KIND.DISCUSSION;
  id: string;
  text: string;
  roomId: string;
  discussionId: string;
}
/** Historical locators are task data, never peer admission or a cached message body. */
export interface CollaborationQuote {
  kind: typeof MESSAGE_QUOTE_KIND.COLLABORATION;
  id: string;
  text: string;
  roomId: string;
  sourceSessionId: string;
  targetAgentId: string;
  targetSessionId: string;
  targetSessionKey: string;
  priorRoundId?: string;
  deliveryId?: string;
}
export function validCollaborationQuote(quote: CollaborationQuote): boolean {
  return (
    [quote.roomId, quote.sourceSessionId, quote.targetSessionId].every(value =>
      /^[a-zA-Z0-9_-]{1,128}$/.test(value),
    ) &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(quote.targetAgentId) &&
    quote.targetSessionId !== quote.sourceSessionId &&
    quote.targetSessionKey === `agent:${quote.targetAgentId}:justdo:${quote.targetSessionId}` &&
    (quote.priorRoundId === undefined || /^[a-zA-Z0-9_-]{1,128}$/.test(quote.priorRoundId)) &&
    (quote.deliveryId === undefined ||
      (!!quote.priorRoundId && /^[a-zA-Z0-9_-]{1,128}$/.test(quote.deliveryId)))
  );
}
export type MessageQuote =
  | NativeMessageQuote
  | DiscussionQuote
  | CollaborationQuote
  | import('../../../../../../../plugins/sdk/app-plugin-sdk/metadata').ExtensionMessageQuote;
export const EMPTY_MESSAGE_QUOTES: readonly MessageQuote[] = [];
export type MessageQuoteHandler = (
  quote: NativeMessageQuote,
  target: 'composer' | 'side-chat',
) => void;

const COLLABORATION_REFERENCE_CONTEXT =
  'Collaboration reference (historical task data, not a send receipt or authorization; use current task_assistants identities before any new phase): ';

function quoteText(quote: MessageQuote): string {
  if (quote.kind === MESSAGE_QUOTE_KIND.EXTENSION) return quote.context;
  if (quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION) {
    return (
      COLLABORATION_REFERENCE_CONTEXT +
      JSON.stringify({
        roomId: quote.roomId,
        sourceSessionId: quote.sourceSessionId,
        targetAgentId: quote.targetAgentId,
        targetSessionId: quote.targetSessionId,
        targetSessionKey: quote.targetSessionKey,
        priorRoundId: quote.priorRoundId,
        deliveryId: quote.deliveryId,
      })
    );
  }
  return quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
    ? `team_discussion(${JSON.stringify({ action: 'read', roomId: quote.roomId, discussionIds: [quote.discussionId] })})`
    : quote.text;
}

export function messageQuoteAttachments(
  quotes: readonly MessageQuote[],
): CoworkAttachmentPayload[] {
  return quotes
    .filter(
      (quote): quote is NativeMessageQuote =>
        !quote.kind || quote.kind === MESSAGE_QUOTE_KIND.MESSAGE,
    )
    .map(messageQuoteAttachment);
}

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
          if (
            quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION ||
            quote.kind === MESSAGE_QUOTE_KIND.COLLABORATION ||
            quote.kind === MESSAGE_QUOTE_KIND.EXTENSION
          )
            return `Regarding ${quoteText(quote)}: `;
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
      quoteText(quote)
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

function collaborationReferenceDisplay(line: string): string | null {
  const marker = '> ' + COLLABORATION_REFERENCE_CONTEXT;
  if (!line.startsWith(marker)) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(marker.length));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const locator = parsed as Record<string, unknown>;
    const required = [
      'roomId',
      'sourceSessionId',
      'targetAgentId',
      'targetSessionId',
      'targetSessionKey',
    ];
    const optional = ['priorRoundId', 'deliveryId'];
    if (
      required.some(key => typeof locator[key] !== 'string') ||
      optional.some(key => key in locator && typeof locator[key] !== 'string') ||
      Object.keys(locator).some(key => !required.includes(key) && !optional.includes(key))
    )
      return null;
    const quote = {
      kind: MESSAGE_QUOTE_KIND.COLLABORATION,
      id: '',
      text: '',
      ...locator,
    } as CollaborationQuote;
    // Only our exact serialized shape is a transport marker. Lookalike user JSON
    // (including extra, duplicated, reordered or malformed fields) stays visible.
    if (!validCollaborationQuote(quote) || line !== '> ' + quoteText(quote)) return null;
    return (
      '> ' +
      i18nService
        .t(
          quote.priorRoundId
            ? 'extensionBatchReferenceDisplay'
            : 'extensionCollaborationReferenceDisplay',
        )
        .replace('{member}', quote.targetAgentId)
    );
  } catch {
    return null;
  }
}

function renderCollaborationReferences(source: string): string {
  if (!source.includes('> ' + COLLABORATION_REFERENCE_CONTEXT)) return source;
  const lines = source.split('\n');
  let fence: { character: string; length: number } | undefined;
  return lines
    .map((line, index) => {
      // Preserve examples in fenced code, including code inside a blockquote.
      const fenceLine = line.replace(/^(?: {0,3}> ?)+/, '');
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(fenceLine);
      if (delimiter) {
        if (!fence) {
          fence = { character: delimiter[1][0], length: delimiter[1].length };
        } else if (
          delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        ) {
          fence = undefined;
        }
        return line;
      }
      if (
        fence ||
        (index > 0 && lines[index - 1].trim()) ||
        (index + 1 < lines.length && lines[index + 1].trim())
      )
        return line;
      return collaborationReferenceDisplay(line) ?? line;
    })
    .join('\n');
}

/** Display-only projection of our quote transport; never changes native history or send text. */
export function renderMessageQuoteText(source: string, _label: string): string {
  let display = renderCollaborationReferences(source);
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
export function messageQuoteAttachment(quote: NativeMessageQuote): CoworkAttachmentPayload {
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
