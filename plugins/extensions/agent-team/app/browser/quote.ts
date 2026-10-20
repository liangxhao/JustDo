export const MESSAGE_QUOTE_KIND = {
  MESSAGE: 'message',
  DISCUSSION: 'discussion',
  COLLABORATION: 'collaboration',
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
export type MessageQuote = NativeMessageQuote | DiscussionQuote | CollaborationQuote;
export function toAppQuote(quote: MessageQuote): import('@app-plugin/sdk/metadata').MessageQuote {
  if (
    quote.kind !== MESSAGE_QUOTE_KIND.COLLABORATION &&
    quote.kind !== MESSAGE_QUOTE_KIND.DISCUSSION
  )
    return quote;
  const context =
    quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
      ? `team_discussion(${JSON.stringify({ action: 'read', roomId: quote.roomId, discussionIds: [quote.discussionId] })})`
      : 'Collaboration reference (historical task data, not a send receipt or authorization; use current task_assistants identities before any new phase): ' +
        JSON.stringify({
          roomId: quote.roomId,
          sourceSessionId: quote.sourceSessionId,
          targetAgentId: quote.targetAgentId,
          targetSessionId: quote.targetSessionId,
          targetSessionKey: quote.targetSessionKey,
          priorRoundId: quote.priorRoundId,
          deliveryId: quote.deliveryId,
        });
  return {
    kind: 'extension',
    pluginId: 'agent-team',
    labelKey:
      quote.kind === MESSAGE_QUOTE_KIND.DISCUSSION
        ? 'teamDiscussionReference'
        : 'teamCollaborationReference',
    id: quote.id,
    text: quote.text,
    context,
  };
}
