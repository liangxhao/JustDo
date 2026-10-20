import { expect, it } from 'vitest';

import { toAppQuote, type CollaborationQuote } from './quote';

it('preserves discussion labels, identities and read locators in the generic quote', () => {
  expect(
    toAppQuote({
      kind: 'discussion',
      id: 'quote',
      text: 'Group conclusion',
      roomId: 'room',
      discussionId: 'round',
    }),
  ).toEqual({
    kind: 'extension',
    pluginId: 'agent-team',
    labelKey: 'teamDiscussionReference',
    id: 'quote',
    text: 'Group conclusion',
    context: 'team_discussion({"action":"read","roomId":"room","discussionIds":["round"]})',
  });
});

it('keeps collaboration context and body unchanged while declaring its display label', () => {
  const quote: CollaborationQuote = {
    kind: 'collaboration',
    id: 'quote',
    text: 'Review conclusion',
    roomId: 'room',
    sourceSessionId: 'source',
    targetAgentId: 'reviewer',
    targetSessionId: 'peer',
    targetSessionKey: 'agent:reviewer:justdo:peer',
    priorRoundId: 'round',
    deliveryId: 'delivery',
  };
  const result = toAppQuote(quote);
  expect(result).toMatchObject({
    kind: 'extension',
    pluginId: 'agent-team',
    labelKey: 'teamCollaborationReference',
    id: quote.id,
    text: quote.text,
  });
  expect('context' in result && result.context).toBe(
    'Collaboration reference (historical task data, not a send receipt or authorization; use current task_assistants identities before any new phase): ' +
      JSON.stringify({
        roomId: 'room',
        sourceSessionId: 'source',
        targetAgentId: 'reviewer',
        targetSessionId: 'peer',
        targetSessionKey: 'agent:reviewer:justdo:peer',
        priorRoundId: 'round',
        deliveryId: 'delivery',
      }),
  );
  const ordinary = {
    id: 'native-quote',
    text: 'Native message',
    sessionKey: 'native-key',
    entryId: 'entry',
  };
  expect(toAppQuote(ordinary)).toBe(ordinary);
});
