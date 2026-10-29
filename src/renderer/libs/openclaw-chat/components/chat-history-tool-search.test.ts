/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { ChatScrollController } from '../controllers/chat-scroll-controller';
import type { GatewayMessage } from '../types';
import type { JustDoChatElement } from './justdo-chat';
import type { ToolOutput } from './tools/tool-output';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(ChatScrollController.prototype, 'navigateToElement').mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function toolHistory(input: unknown, output: string, name = 'read'): Promise<JustDoChatElement> {
  const messages: GatewayMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'read-call', name, arguments: input }],
      __openclaw: { id: 'read-entry' },
    },
    {
      role: 'toolResult',
      toolCallId: 'read-call',
      toolName: name,
      content: output,
      __openclaw: { id: 'read-result' },
    },
    { role: 'assistant', content: 'Done', __openclaw: { id: 'final' } },
  ];
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages;
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}

function highlightedSource(chat: JustDoChatElement) {
  const mark = chat.shadowRoot!.querySelector<HTMLElement>('.chat-search-mark');
  expect(mark).not.toBeNull();
  expect(mark!.closest('.process-summary__tool-title, .process-summary__detail-label')).toBeNull();
  const reader = mark!.closest<ToolOutput>('justdo-tool-output');
  expect(reader).not.toBeNull();
  const pre = mark!.closest('pre')!;
  const before = document.createRange();
  before.selectNodeContents(pre);
  before.setEndBefore(mark!);
  return {
    text: reader!.text,
    output: mark!.closest('.process-summary__tool-result') !== null,
    offset: before.toString().length,
  };
}

test('navigates indexed tool input and output instead of duplicate summary text', async () => {
  const chat = await toolHistory({ path: 'needle.txt' }, 'needle output');
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedSource(chat)).toMatchObject({
    output: false,
    text: JSON.stringify({ path: 'needle.txt' }, null, 2),
  });
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'needle output' });
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedSource(chat).output).toBe(false);
});

test('keeps repeated tool occurrences ordered when the query also matches translated labels', async () => {
  const query = i18nService.t('coworkToolInput');
  const input = { path: `${query} ${query}.txt` };
  const output = `${query} ${query}`;
  const chat = await toolHistory(input, output);
  chat.searchQuery = query;
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(4);

  const sources = [];
  for (let index = 0; index < 5; index += 1) {
    expect(chat.navigateSearch(1)).toEqual({ index: index % 4, total: 4 });
    sources.push(highlightedSource(chat));
  }
  expect(sources.map(source => source.output)).toEqual([false, false, true, true, false]);
  expect(sources[0].offset).toBeLessThan(sources[1].offset);
  expect(sources[2].offset).toBeLessThan(sources[3].offset);
  expect(sources[4]).toEqual(sources[0]);
});

test('highlights an offscreen tool output on the first navigation after its reader mounts', async () => {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = Array.from({ length: 100 }, (_, index): GatewayMessage[] => [
    { role: 'user', content: `Question ${index}`, __openclaw: { id: `user-${index}` } },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: `file-${index}.txt` } }],
      __openclaw: { id: `call-${index}` },
    },
    {
      role: 'toolResult', toolCallId: `read-${index}`, toolName: 'read',
      content: `Unique output token ${index}.`, __openclaw: { id: `result-${index}` },
    },
    { role: 'assistant', content: `Done ${index}`, __openclaw: { id: `final-${index}` } },
  ]).flat();
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('[data-entry-id="user-0"]')).toBeNull();

  chat.searchQuery = 'Unique output token 0.';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'Unique output token 0.' });
});

test('selects the bounded output page containing a later search hit', async () => {
  const output = `${'x'.repeat(17_000)}needle on a later page`;
  const chat = await toolHistory({ path: 'file.txt' }, output);
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(highlightedSource(chat)).toMatchObject({ output: true, text: output });
  const pre = chat.shadowRoot!.querySelector('.chat-search-mark')!.closest('pre')!;
  expect(pre.textContent!.length).toBeLessThanOrEqual(16_001);
  expect(pre.textContent).not.toContain('x'.repeat(16_000));
});

test('keeps a search hit spanning an output page boundary in one bounded view', async () => {
  const query = 'needle-boundary';
  const chat = await toolHistory({ path: 'file.txt' }, `${'x'.repeat(15_995)}${query}${'y'.repeat(1_000)}`);
  chat.searchQuery = query;
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(mark.textContent).toBe(query);
  expect(mark.closest('pre')!.textContent!.length).toBeLessThanOrEqual(16_001 + query.length);
});

test('keeps global non-overlapping occurrence order when a previous hit crosses the page edge', async () => {
  const chat = await toolHistory({ path: 'file.txt' }, `${'x'.repeat(15_999)}ababababa`);
  chat.searchQuery = 'aba';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  const first = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(first.textContent).toBe('aba');
  const firstText = first.closest('pre')!.textContent!.trimStart();
  expect(firstText.length).toBe(16_002);
  expect(firstText.endsWith('aba')).toBe(true);

  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  const second = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  expect(second.textContent).toBe('aba');
  // The previous full-source hit consumes the first two page characters.
  // The second hit is the first "aba" in this remaining, bounded snippet.
  expect(second.closest('pre')!.textContent!.trimStart()).toBe('bababa');
  expect(highlightedSource(chat).offset).toBe(1);
  const reader = second.closest<ToolOutput>('justdo-tool-output')!;
  chat.searchQuery = '';
  await chat.updateComplete;
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe('babababa');
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
});

test.each(['unified', 'split'])(
  'searches native Edit code and output in source order in %s mode',
  async mode => {
    const chat = await toolHistory({
      path: 'file.txt',
      old_string: 'old needle first\nold needle second',
      new_string: 'new needle first\nnew needle second',
    }, 'needle output', 'edit');
    chat.searchQuery = 'needle';
    await chat.updateComplete;
    expect(chat.getSearchMatchCount()).toBe(5);
    // Materialize the native Edit presentation before choosing its display mode.
    chat.navigateSearch(1);
    if (mode === 'split') {
      const split = [...chat.shadowRoot!.querySelectorAll<HTMLButtonElement>('.edit-diff__mode-button')]
        .find(button => button.textContent?.trim() === i18nService.t('coworkEditDiffSplitMode'))!;
      split.click();
      await chat.updateComplete;
    }
    // Continue at the second old line, then both new lines, the output and wrap.
    const texts = ['old needle second', 'new needle first', 'new needle second', null, 'old needle first'];
    for (let index = 0; index < texts.length; index += 1) {
      expect(chat.navigateSearch(1)).toEqual({ index: (index + 1) % 5, total: 5 });
      if (texts[index] === null) expect(highlightedSource(chat)).toMatchObject({ output: true, text: 'needle output' });
      else {
        const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
        expect(mark.closest('code')?.textContent).toBe(texts[index]);
        expect(mark.closest('.edit-diff__header, .edit-diff__marker, .sr-only')).toBeNull();
      }
    }
  },
);

test('does not count both split copies of an unchanged Edit context line', async () => {
  const chat = await toolHistory({
    path: 'file.txt', old_string: 'needle context\nold line', new_string: 'needle context\nnew line',
  }, 'Done', 'edit');
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  const split = [...chat.shadowRoot!.querySelectorAll<HTMLButtonElement>('.edit-diff__mode-button')]
    .find(button => button.textContent?.trim() === i18nService.t('coworkEditDiffSplitMode'))!;
  split.click();
  await chat.updateComplete;
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
  expect(chat.shadowRoot!.querySelectorAll('.chat-search-mark')).toHaveLength(1);
});

test('manual reader paging unwraps a marked boundary before replacing plain source text', async () => {
  const query = 'needle-boundary';
  const output = `${'x'.repeat(15_995)}${query}${'y'.repeat(1_000)}`;
  const chat = await toolHistory({}, output, 'custom');
  chat.searchQuery = query;
  await chat.updateComplete;
  chat.navigateSearch(1);
  const mark = chat.shadowRoot!.querySelector('.chat-search-mark')!;
  const reader = mark.closest<ToolOutput>('justdo-tool-output')!;
  const next = [...reader.querySelectorAll<HTMLButtonElement>('.message-reader-actions button')]
    .find(button => button.textContent?.trim() === i18nService.t('messageNext'))!;
  next.click();
  await reader.updateComplete;
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe(output.slice(16_000));
});

test('replacing marked plain reader source does not leave an old mark or suffix', async () => {
  const chat = await toolHistory({}, 'prefix needle suffix', 'custom');
  chat.searchQuery = 'needle';
  await chat.updateComplete;
  chat.navigateSearch(1);
  const reader = chat.shadowRoot!.querySelector('.chat-search-mark')!.closest<ToolOutput>('justdo-tool-output')!;
  reader.text = 'replacement exact';
  await reader.updateComplete;
  expect(reader.querySelector('.chat-search-mark')).toBeNull();
  expect(reader.querySelector('pre')!.textContent!.trimStart()).toBe('replacement exact');
});
