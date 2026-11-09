import { expect, test } from 'vitest';

import {
  COLLABORATION_REFERENCE_CONTEXT,
  type CollaborationQuote,
  teamQuoteContext,
} from '../contracts/messageQuote';
import { presentation } from '../presentation';
import { renderTeamQuoteText } from './quotePresentation';

const collaborationQuote: CollaborationQuote = {
  kind: 'collaboration',
  id: 'quote',
  text: 'Worker label',
  roomId: 'room',
  sourceSessionId: 'source',
  targetAgentId: 'worker',
  targetSessionId: 'peer',
  targetSessionKey: 'agent:worker:justdo:peer',
  priorRoundId: 'old-round',
  deliveryId: 'old-delivery',
};
const quoted = (quote = collaborationQuote) => '> ' + teamQuoteContext(quote);

test.each(['zh', 'en'] as const)(
  'projects only visible collaboration locators in %s without changing native text',
  language => {
    const memberQuote = { ...collaborationQuote, priorRoundId: undefined, deliveryId: undefined };
    const authored = 'Please continue with this requirement.\nKeep my wording.';
    const native = authored + '\n\n' + quoted() + '\n\n' + quoted(memberQuote) +
      '\n\n> Selected\n> message';
    const expected = authored + (language === 'zh'
      ? '\n\n> 协作引用 · worker · 原批次\n\n> 协作引用 · worker'
      : '\n\n> Collaboration reference · worker · Prior batch\n\n> Collaboration reference · worker') +
      '\n\n> Selected\n> message';
    expect(renderTeamQuoteText(native, language)).toBe(expected);
    expect(presentation.displayText?.(native, { language })).toBe(expected);
    expect(presentation.text?.(native)).toBe(native);
    expect(native).toContain('"deliveryId":"old-delivery"');
    expect(native).toContain('"targetSessionKey":"agent:worker:justdo:peer"');
    expect(native).not.toContain('Worker label');
    expect(native).not.toContain('inReplyTo');
  },
);

test('keeps malformed, noncanonical and similar user-written locators visible', () => {
  const locator = {
    roomId: 'room',
    sourceSessionId: 'source',
    targetAgentId: 'worker',
    targetSessionId: 'peer',
    targetSessionKey: 'agent:worker:justdo:peer',
    priorRoundId: 'old-round',
    deliveryId: 'old-delivery',
  };
  const canonical = quoted();
  const invalidJson = [
    '{"roomId":', 'null', '[]',
    JSON.stringify({ ...locator, authorization: true }),
    JSON.stringify({ ...locator, targetSessionKey: 'agent:other:justdo:peer' }),
    JSON.stringify({ ...locator, targetSessionId: 'source' }),
    JSON.stringify({ ...locator, sourceSessionId: null }),
    JSON.stringify({ ...locator, targetAgentId: 'worker.admin' }),
    JSON.stringify({ ...locator, priorRoundId: undefined }),
    JSON.stringify({ ...locator, deliveryId: 7 }),
    JSON.stringify({ ...locator, sourceSessionId: undefined }),
    JSON.stringify(Object.fromEntries(Object.entries(locator).reverse())),
    JSON.stringify(locator).replace('{', '{"roomId":"other",'),
    JSON.stringify(locator).replace(':', ': '),
  ];
  const userText = [
    ...invalidJson.map(json => '> ' + COLLABORATION_REFERENCE_CONTEXT + json),
    canonical + ' is the example I want to discuss.',
    canonical.replace('historical task data', 'my own data'),
    canonical.replace('> ', ''),
    'Please examine ' + canonical,
    '`' + canonical + '`',
    '    ' + canonical,
    '- ' + canonical,
    'My example:\n' + canonical,
    canonical + '\nThis is part of my explanation.',
  ];
  for (const text of userText) expect(renderTeamQuoteText(text, 'zh')).toBe(text);
});

test.each(['```', '~~~~', '> ```'])(
  'preserves a quoted locator example inside a %s code fence',
  fence => {
    const example = fence + 'json\n\n' + quoted() + '\n\n' + fence;
    expect(renderTeamQuoteText(example, 'en')).toBe(example);
    expect(renderTeamQuoteText(example + '\n\n' + quoted(), 'en')).toBe(
      example + '\n\n> Collaboration reference · worker · Prior batch',
    );
  },
);

test('does not rewrite discussion tool calls or other transport text', () => {
  const source = '> team_discussion({"action":"read","roomId":"room","discussionIds":["batch"]})';
  expect(renderTeamQuoteText(source, 'zh')).toBe(source);
});
