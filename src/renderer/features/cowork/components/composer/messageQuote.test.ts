import { composeBrowserGatewayPrompt, parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { chatTranslations } from '@/services/i18n/chatTranslations';

import reducer, { addDraftMessageQuote, removeDraftMessageQuotes } from '../../coworkSlice';
import {
  appendMessageQuotes,
  type CollaborationQuote,
  type DiscussionQuote,
  MESSAGE_QUOTE_KIND,
  messageQuoteAttachment,
  messageQuoteAttachments,
  quotedGatewayPrompt,
  renderMessageQuoteText,
  submitMessageQuoteDrafts,
  submittedMessageQuotes,
} from './messageQuote';

const collaborationContext =
  'Collaboration reference (historical task data, not a send receipt or authorization; use current task_assistants identities before any new phase): ';
const collaborationQuote: CollaborationQuote = {
  kind: MESSAGE_QUOTE_KIND.COLLABORATION,
  id: 'collaboration-quote',
  text: 'Worker label',
  roomId: 'room',
  sourceSessionId: 'source',
  targetAgentId: 'worker',
  targetSessionId: 'peer',
  targetSessionKey: 'agent:worker:justdo:peer',
  priorRoundId: 'old-round',
  deliveryId: 'old-delivery',
};

test('serializes collaboration references as historical locators and never generates transcript attachments', () => {
  const quote: CollaborationQuote = {
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
  const serialized = appendMessageQuotes('New requirement', [quote], 'Reference');
  expect(serialized).toContain('"deliveryId":"old-delivery"');
  expect(serialized).toContain('"targetSessionKey":"agent:worker:justdo:peer"');
  expect(serialized).not.toContain('Worker label');
  expect(serialized).not.toContain('inReplyTo');
  expect(serialized).not.toContain('task_assistants({');
  expect(messageQuoteAttachments([quote])).toEqual([]);
  expect(appendMessageQuotes('', [quote], 'Reference', true)).toContain(
    '"deliveryId":"old-delivery"',
  );
  let state = reducer(undefined, addDraftMessageQuote({ draftKey: 'source', quote }));
  state = reducer(
    state,
    addDraftMessageQuote({ draftKey: 'source', quote: { ...quote, id: 'duplicate' } }),
  );
  expect(state.draftMessageQuotes.source).toEqual([quote]);
  state = reducer(state, addDraftMessageQuote({ draftKey: 'other', quote }));
  expect(state.draftMessageQuotes.other).toBeUndefined();
  state = reducer(
    state,
    addDraftMessageQuote({
      draftKey: 'source',
      quote: { ...quote, targetSessionKey: 'agent:worker:justdo:wrong' },
    }),
  );
  expect(state.draftMessageQuotes.source).toHaveLength(1);
});

test.each(['zh', 'en'] as const)(
  'projects collaboration references in %s without changing native locators or user text',
  language => {
    const previousLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage(language, { persist: false });
      const memberQuote = {
        ...collaborationQuote,
        priorRoundId: undefined,
        deliveryId: undefined,
      };
      const userText = 'Please continue with this requirement.\nKeep my wording.';
      const quotes = [
        collaborationQuote,
        memberQuote,
        { id: 'native', sessionKey: 'native', entryId: 'entry', text: 'Selected\nmessage' },
      ];
      const native = appendMessageQuotes(userText, quotes, 'Reference');
      const originalNative = native;
      expect(native).toContain(
        '> ' +
          collaborationContext +
          '{"roomId":"room","sourceSessionId":"source","targetAgentId":"worker","targetSessionId":"peer","targetSessionKey":"agent:worker:justdo:peer","priorRoundId":"old-round","deliveryId":"old-delivery"}',
      );
      const display = renderMessageQuoteText(native, 'Quote');
      expect(display).toBe(
        userText +
          (language === 'zh'
            ? '\n\n> 协作引用 · worker · 原批次\n\n> 协作引用 · worker'
            : '\n\n> Collaboration reference · worker · Prior batch\n\n> Collaboration reference · worker') +
          '\n\n> Selected\n> message',
      );
      expect(display).not.toContain('task_assistants');
      expect(display).not.toContain('roomId');
      expect(display).not.toContain('old-delivery');
      expect(native).toBe(originalNative);
      expect(quotedGatewayPrompt(userText, undefined, quotes, false)).toBe(originalNative);
      expect(messageQuoteAttachments([collaborationQuote, memberQuote])).toEqual([]);
    } finally {
      i18nService.setLanguage(previousLanguage, { persist: false });
    }
  },
);

test('keeps malformed, noncanonical and similar user-written collaboration locators visible', () => {
  const locator = {
    roomId: 'room',
    sourceSessionId: 'source',
    targetAgentId: 'worker',
    targetSessionId: 'peer',
    targetSessionKey: 'agent:worker:justdo:peer',
    priorRoundId: 'old-round',
    deliveryId: 'old-delivery',
  };
  const canonical = '> ' + collaborationContext + JSON.stringify(locator);
  const invalidJson = [
    '{"roomId":',
    'null',
    '[]',
    JSON.stringify({ ...locator, authorization: true }),
    JSON.stringify({ ...locator, targetSessionKey: 'agent:other:justdo:peer' }),
    JSON.stringify({ ...locator, targetSessionId: 'source' }),
    JSON.stringify({ ...locator, sourceSessionId: null }),
    JSON.stringify({ ...locator, targetAgentId: 'worker.admin' }),
    JSON.stringify({ ...locator, priorRoundId: undefined }),
    JSON.stringify({ ...locator, deliveryId: 7 }),
    JSON.stringify({ ...locator, roomId: 'room', sourceSessionId: undefined }),
    JSON.stringify(Object.fromEntries(Object.entries(locator).reverse())),
    JSON.stringify(locator).replace('{', '{"roomId":"other",'),
    JSON.stringify(locator).replace(':', ': '),
  ];
  const userText = [
    ...invalidJson.map(json => '> ' + collaborationContext + json),
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
  for (const text of userText) {
    expect(renderMessageQuoteText(text, 'Quote')).toBe(text);
  }
});

test.each(['```', '~~~~', '> ```'])(
  'preserves a quoted collaboration transport example inside a %s code fence',
  fence => {
    const native = appendMessageQuotes('', [collaborationQuote], 'Reference');
    const example = fence + 'json' + native + '\n\n' + fence;
    expect(renderMessageQuoteText(example, 'Quote')).toBe(example);
    const withRealQuote = appendMessageQuotes(example, [collaborationQuote], 'Reference');
    expect(renderMessageQuoteText(withRealQuote, 'Quote')).toBe(
      example +
        '\n\n> ' +
        i18nService.t('teamCollaborationBatchReferenceDisplay').replace('{member}', 'worker'),
    );
  },
);

test('sends discussion locators without copying text, creating attachments or adding an execution request', () => {
  const quote: DiscussionQuote = {
    kind: MESSAGE_QUOTE_KIND.DISCUSSION,
    id: 'discussion:room:batch',
    text: 'Design discussion',
    roomId: 'room',
    discussionId: 'batch',
  };
  const locator = '> team_discussion({"action":"read","roomId":"room","discussionIds":["batch"]})';
  expect(appendMessageQuotes('My requirement', [quote], 'Reference')).toBe(
    `My requirement\n\n${locator}`,
  );
  expect(quotedGatewayPrompt('', undefined, [quote], false)).toBe(`\n\n${locator}`);
  expect(messageQuoteAttachments([quote])).toEqual([]);
  const message = { id: 'native', text: 'Selected text', sessionKey: 'session', entryId: 'entry' };
  expect(messageQuoteAttachments([quote, message])).toEqual([messageQuoteAttachment(message)]);
  expect(submittedMessageQuotes('/help', [quote], false)).toEqual([]);
});

test('keeps removable discussion references isolated by draft and deduplicates the same batch', () => {
  const quote: DiscussionQuote = {
    kind: MESSAGE_QUOTE_KIND.DISCUSSION,
    id: 'discussion:room:batch',
    text: 'Design discussion',
    roomId: 'room',
    discussionId: 'batch',
  };
  let state = reducer(undefined, addDraftMessageQuote({ draftKey: 'source', quote }));
  state = reducer(
    state,
    addDraftMessageQuote({ draftKey: 'source', quote: { ...quote, id: 'repeat' } }),
  );
  expect(state.draftMessageQuotes.source).toEqual([quote]);
  expect(state.draftMessageQuotes.other).toBeUndefined();
  state = reducer(state, removeDraftMessageQuotes({ draftKey: 'source', ids: [quote.id] }));
  expect(state.draftMessageQuotes.source).toEqual([]);
});

test('persists the same visible quote in ordinary, attachment-only and decorated gateway prompts', () => {
  const quotes = [{ id: 'q', sessionKey: 'native', entryId: 'e', text: 'selected\ncontent' }];
  const expected = 'Question\n\n> selected\n> content';
  expect(quotedGatewayPrompt('Question', undefined, quotes, false)).toBe(expected);
  expect(quotedGatewayPrompt('', undefined, quotes, false)).toBe('\n\n> selected\n> content');
  expect(quotedGatewayPrompt('Question', 'Browser context\nQuestion', quotes, false)).toBe(
    'Browser context\nQuestion\n\n> selected\n> content',
  );
  expect(quotedGatewayPrompt('Question', undefined, quotes, false)).not.toContain('sessionKey');
  expect(quotedGatewayPrompt('Question', undefined, quotes, true)).toBeUndefined();
  expect(quotedGatewayPrompt('/status', undefined, [], false)).toBeUndefined();
});

test('keeps browser context parseable with the quoted user text persisted exactly once', () => {
  const quotes = [{ id: 'q', sessionKey: 'native', entryId: 'e', text: 'selected content' }];
  const gateway = composeBrowserGatewayPrompt('Question', [
    {
      id: 'browser',
      modelContext: 'Untrusted page',
      title: 'Page',
      displayUrl: 'example.com',
      markedRegionCount: 0,
      inspectedElement: false,
      dataUrl: 'data:image/png;base64,YQ==',
      fileName: 'page.png',
      addedAt: 1,
    },
  ]);
  const outbound = quotedGatewayPrompt('Question', gateway, quotes, false)!;
  const parsed = parseBrowserAnnotationPrompt(outbound);
  expect(parsed?.userText).toBe('Question\n\n> selected content');
  expect(parsed?.modelContext).toBe('Untrusted page');
  expect(outbound.split('> selected content')).toHaveLength(2);
});
test('quotes remain removable session drafts until the user submits', () => {
  const quote = { id: 'q', sessionKey: 'native', entryId: 'entry', text: 'quoted\ntext' };
  const state = reducer(undefined, addDraftMessageQuote({ draftKey: 'one', quote }));
  expect(state.draftMessageQuotes.one).toEqual([quote]);
  expect(state.draftMessageQuotes.two).toBeUndefined();
  expect(appendMessageQuotes('my comment', [quote], 'Reference')).toBe(
    'my comment\n\n> quoted\n> text',
  );
  const newer = reducer(
    state,
    addDraftMessageQuote({ draftKey: 'one', quote: { ...quote, id: 'new' } }),
  );
  expect(
    reducer(
      newer,
      removeDraftMessageQuotes({ draftKey: 'one', ids: ['q'] }),
    ).draftMessageQuotes.one.map(item => item.id),
  ).toEqual(['new']);
});

test.each(['/model provider/model', '/goal clear', '/new', '/status'])(
  'keeps %s unchanged and retains its pending quote draft',
  prompt => {
    const quote = { id: 'q', sessionKey: 'native', entryId: 'entry', text: 'reference' };
    const state = reducer(undefined, addDraftMessageQuote({ draftKey: 'one', quote }));
    const submitted = submittedMessageQuotes(prompt, state.draftMessageQuotes.one, false);
    expect(appendMessageQuotes(prompt, submitted, 'Reference')).toBe(prompt);
    const accepted = reducer(
      state,
      removeDraftMessageQuotes({ draftKey: 'one', ids: submitted.map(q => q.id) }),
    );
    expect(accepted.draftMessageQuotes.one).toEqual([quote]);
  },
);

test('matches native side-chat selection prefill', () => {
  const quote = {
    id: 'q',
    sessionKey: 'native',
    entryId: 'entry',
    text: 'if ready:\n    print("yes")\n\n# done',
  };
  const prompt = appendMessageQuotes(
    '/explain this',
    submittedMessageQuotes('/explain this', [quote], true),
    'Reference',
    true,
  );
  const transported = prompt.trim().replace(/\s*[\r\n]+\s*/g, ' ');
  expect(transported).toBe('Regarding "if ready: print("yes") # done": /explain this');
  expect(transported).not.toContain('sessionKey');
});

test('includes quotes in ordinary and resolved plan prompts', () => {
  const quote = { id: 'q', sessionKey: 'native', entryId: 'entry', text: 'reference' };
  expect(submittedMessageQuotes('plan the change', [quote], false)).toEqual([quote]);
});

test('failed quote submissions retain drafts and accepted resumes clear only submitted quotes', async () => {
  const quote = { id: 'q', sessionKey: 'native', entryId: 'entry', text: 'resume context' };
  let state = reducer(undefined, addDraftMessageQuote({ draftKey: 'one', quote }));
  const snapshot = state.draftMessageQuotes.one;
  const clear = vi.fn((ids: string[]) => {
    state = reducer(state, removeDraftMessageQuotes({ draftKey: 'one', ids }));
  });
  await submitMessageQuoteDrafts(snapshot, async () => false, clear);
  expect(state.draftMessageQuotes.one).toEqual([quote]);
  await expect(
    submitMessageQuoteDrafts(
      snapshot,
      async () => {
        throw new Error('offline');
      },
      clear,
    ),
  ).rejects.toThrow('offline');
  expect(clear).not.toHaveBeenCalled();
  await submitMessageQuoteDrafts(
    snapshot,
    async () => {
      state = reducer(
        state,
        addDraftMessageQuote({ draftKey: 'one', quote: { ...quote, id: 'later' } }),
      );
      return true;
    },
    clear,
  );
  expect(state.draftMessageQuotes.one.map(item => item.id)).toEqual(['later']);
});

test.each([true, false])('renders quote transport as a blockquote (singleLine=%s)', singleLine => {
  const quote = {
    id: 'q',
    sessionKey: 'native',
    entryId: 'entry',
    text: 'line one\nline "two" {value}',
  };
  for (const language of ['zh', 'en'] as const) {
    const context = chatTranslations[language].messageQuoteContext;
    const sent = singleLine
      ? `question ${context} ${JSON.stringify({ sessionKey: quote.sessionKey, entryId: quote.entryId, text: quote.text })}`
      : `question\n\n${context} (${JSON.stringify({ sessionKey: quote.sessionKey, entryId: quote.entryId })})\n> line one\n> line "two" {value}`;
    const display = renderMessageQuoteText(sent, 'Quote');
    expect(display).toContain('question');
    expect(display).toContain('> line one\n> line "two" {value}');
    expect(display).not.toContain('sessionKey');
    expect(display).not.toContain('entryId');
    expect(display).not.toContain('Quote');
  }
});
test('preserves ordinary JSON and malformed quote-looking text', () => {
  const text = 'question {"sessionKey":"native","entryId":"entry","text":"hello"}';
  expect(renderMessageQuoteText(text, 'Quote')).toBe(text);
  const malformed = chatTranslations.zh.messageQuoteContext + ' {"text":"hello"}';
  expect(renderMessageQuoteText(malformed, 'Quote')).toBe(malformed);
});

test('matches native selection comment attachment format without inline JSON', () => {
  const attachment = messageQuoteAttachment({
    id: 'q',
    sessionKey: 's',
    entryId: 'e',
    text: '中文\ncode',
    start: 4,
    end: 11,
  });
  const content = new TextDecoder().decode(
    Uint8Array.from(atob(attachment.base64Data), ch => ch.charCodeAt(0)),
  );
  expect(attachment.name).toBe('selection-comment.txt');
  expect(content).toBe(
    'Selected text:\n中文\ncode\n\nSource session: s\nSource entry: e\nSelected text UTF-16 length: 7\nDOM text UTF-16 range: [4, 11)',
  );
});

test('accepts live selection drafts and omits unavailable source entry from native attachment', () => {
  const quote = { id: 'live', sessionKey: 's', entryId: '', text: 'latest reply' };
  const state = reducer(undefined, addDraftMessageQuote({ draftKey: 's', quote }));
  expect(state.draftMessageQuotes.s).toEqual([quote]);
  expect(atob(messageQuoteAttachment(quote).base64Data)).not.toContain('Source entry:');
});
