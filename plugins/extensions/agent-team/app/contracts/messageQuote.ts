import type { MessageQuote as AppMessageQuote, NativeMessageQuote } from '@app-plugin/sdk/metadata';

export type { NativeMessageQuote } from '@app-plugin/sdk/metadata';

export const MESSAGE_QUOTE_KIND = {
  MESSAGE: 'message',
  DISCUSSION: 'discussion',
  COLLABORATION: 'collaboration',
} as const;

/** A user-selected locator, never a cached copy of discussion history. */
export interface DiscussionQuote {
  kind: typeof MESSAGE_QUOTE_KIND.DISCUSSION;
  id: string;
  text: string;
  roomId: string;
  discussionId: string;
}

/** Historical task data, never peer admission or a cached message body. */
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

export type TeamMessageQuote = DiscussionQuote | CollaborationQuote;
export type MessageQuote = NativeMessageQuote | TeamMessageQuote;
export const COLLABORATION_REFERENCE_CONTEXT =
  'Collaboration reference (historical task data, not a send receipt or authorization; use current task_assistants identities before any new phase): ';

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

export function validDiscussionQuote(quote: DiscussionQuote): boolean {
  return typeof quote.roomId === 'string' && !!quote.roomId &&
    typeof quote.discussionId === 'string' && !!quote.discussionId;
}

export function teamQuoteContext(quote: TeamMessageQuote): string {
  return quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
    ? `team_discussion(${JSON.stringify({ action: 'read', roomId: quote.roomId, discussionIds: [quote.discussionId] })})`
    : COLLABORATION_REFERENCE_CONTEXT + JSON.stringify({
      roomId: quote.roomId,
      sourceSessionId: quote.sourceSessionId,
      targetAgentId: quote.targetAgentId,
      targetSessionId: quote.targetSessionId,
      targetSessionKey: quote.targetSessionKey,
      priorRoundId: quote.priorRoundId,
      deliveryId: quote.deliveryId,
    });
}

export function toAppQuote(quote: MessageQuote): AppMessageQuote {
  if (quote.kind !== MESSAGE_QUOTE_KIND.COLLABORATION &&
      quote.kind !== MESSAGE_QUOTE_KIND.DISCUSSION) return quote;
  return {
    kind: 'extension',
    pluginId: 'agent-team',
    labelKey: quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
      ? 'teamDiscussionReference' : 'teamCollaborationReference',
    id: quote.id,
    text: quote.text,
    context: teamQuoteContext(quote),
  };
}

/** Match the exact locator after the public draft port has converted its shape. */
export function hasTeamQuote(quotes: readonly AppMessageQuote[], quote: TeamMessageQuote): boolean {
  const context = teamQuoteContext(quote);
  return quotes.some(item => item.kind === 'extension' &&
    item.pluginId === 'agent-team' && item.context === context);
}
