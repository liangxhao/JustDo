import { composeBrowserGatewayPrompt, parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { expect, test, vi } from 'vitest';

import { chatTranslations } from '@/services/i18n/chatTranslations';

import reducer, { addDraftMessageQuote, removeDraftMessageQuotes } from '../../coworkSlice';
import {
  appendMessageQuotes,
  messageQuoteAttachment,
  quotedGatewayPrompt,
  renderMessageQuoteText,
  submitMessageQuoteDrafts,
  submittedMessageQuotes,
} from './messageQuote';

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
