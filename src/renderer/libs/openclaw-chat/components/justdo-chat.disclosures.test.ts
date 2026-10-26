/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatScrollController } from '../controllers/chat-scroll-controller';
import type { ContentItem } from '../model/chat-transcript-state';
import { beginAssistantTurn, createChatTranscriptState } from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';
import { materializeDisclosureContents } from './timeline/disclosure-content';

const SOURCE = '<details>\n<summary>Evidence</summary>\n\n**Hidden evidence**\n\n</details>';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function commit(chat: JustDoChatElement): Promise<void> {
  await chat.updateComplete;
  await chat.historyRenderComplete;
}

function disclosures(chat: JustDoChatElement): HTMLDetailsElement[] {
  return Array.from(chat.shadowRoot!.querySelectorAll('details.markdown-disclosure'));
}

describe('message-authored disclosures', () => {
  test('renders message Markdown inside disclosures and copies the complete original source', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [{ role: 'assistant', content: SOURCE, __openclaw: { id: 'entry-1' } }];
    document.body.append(chat);
    await commit(chat);

    const [details] = disclosures(chat);
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Evidence');
    expect(details.querySelector('strong')?.textContent).toBe('Hidden evidence');
    chat.shadowRoot!.querySelector<HTMLButtonElement>('.message-copy')!.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(SOURCE);
  });

  test('keeps a reader choice and summary focus through stream growth and finalization', async () => {
    const transcript = createChatTranscriptState('agent:main:disclosure-test');
    const turn = beginAssistantTurn(
      transcript,
      { runId: 'disclosure-run', startedAt: 1000 },
      { now: () => 1000, createId: prefix => `${prefix}-1` },
    );
    const content: ContentItem = {
      id: 'content-1',
      runId: turn.runId,
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 1000,
      updatedAt: 1000,
      type: 'content',
      status: 'streaming',
      sourceMode: 'snapshot',
      text: SOURCE.replace('\n\n</details>', ''),
    };
    turn.items.push(content);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.activeTurn = turn;
    chat.isStreaming = true;
    document.body.append(chat);
    await commit(chat);

    const [initial] = disclosures(chat);
    initial.open = true;
    initial.querySelector('summary')!.focus();
    chat.activeTurn = {
      ...turn,
      items: [{ ...content, text: `${content.text}\n\nMore evidence` }],
    };
    await commit(chat);
    expect(disclosures(chat)[0].open).toBe(true);
    expect(chat.shadowRoot!.activeElement).toBe(disclosures(chat)[0].querySelector('summary'));

    chat.activeTurn = {
      ...turn,
      status: 'final',
      items: [
        { ...content, status: 'completed', text: `${SOURCE}\n\nThe answer remains visible.` },
      ],
    };
    chat.isStreaming = false;
    await commit(chat);
    expect(disclosures(chat)[0].open).toBe(true);
    expect(chat.shadowRoot!.activeElement).toBe(disclosures(chat)[0].querySelector('summary'));
    expect(chat.shadowRoot!.textContent).toContain('The answer remains visible.');
  });

  test('keeps choices across history windows without sharing them with another message', async () => {
    const first = { role: 'assistant', content: SOURCE, __openclaw: { id: 'first' } };
    const second = { role: 'assistant', content: SOURCE, __openclaw: { id: 'second' } };
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [first];
    document.body.append(chat);
    await commit(chat);
    disclosures(chat)[0].open = true;

    chat.messages = [second];
    await commit(chat);
    expect(disclosures(chat)[0].open).toBe(false);
    chat.messages = [first, { role: 'user', content: 'Another question' }, second];
    await commit(chat);
    expect(disclosures(chat).map(details => details.open)).toEqual([true, false]);
  });

  test('opens a search result inside nested disclosures and retains the search expansion', async () => {
    vi.spyOn(ChatScrollController.prototype, 'navigateToElement').mockImplementation(() => {});
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [
      {
        role: 'assistant',
        __openclaw: { id: 'nested' },
        content: `<details>\n<summary>Outer</summary>\n\n${SOURCE}\n\n</details>`,
      },
    ];
    chat.searchQuery = 'Hidden evidence';
    document.body.append(chat);
    await commit(chat);
    expect(disclosures(chat).map(details => details.open)).toEqual([false, false]);
    expect(chat.navigateSearch(1).total).toBe(1);
    expect(disclosures(chat).map(details => details.open)).toEqual([true, true]);

    chat.requestUpdate();
    await commit(chat);
    expect(disclosures(chat).map(details => details.open)).toEqual([true, true]);
  });

  test('keeps separate choices for text projections on either side of a tool in one native entry', async () => {
    const preserve = vi.spyOn(ChatScrollController.prototype, 'preserveAnchorForInteraction');
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { id: 'split-entry', runId: 'split-run' },
        content: [
          { type: 'text', text: SOURCE },
          { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'example.txt' } },
          { type: 'text', text: SOURCE.replace('Hidden evidence', 'Other evidence') },
        ],
      },
    ];
    document.body.append(chat);
    await commit(chat);
    materializeDisclosureContents(chat.shadowRoot!);
    expect(disclosures(chat)).toHaveLength(2);
    const summary = disclosures(chat)[0].querySelector('summary')!;
    summary.click();
    expect(preserve).toHaveBeenCalledWith(summary);
    expect(disclosures(chat).map(details => details.open)).toEqual([true, false]);

    chat.requestUpdate();
    await commit(chat);
    expect(disclosures(chat).map(details => details.open)).toEqual([true, false]);
  });

  test('enhances code and tables inside a closed disclosure without changing its default', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [
      {
        role: 'assistant',
        content: [
          '<details>',
          '<summary>Examples</summary>',
          '',
          '```ts',
          'const answer = 42;',
          '```',
          '',
          '| Name | Value |',
          '| --- | --- |',
          '| Answer | 42 |',
          '',
          '</details>',
        ].join('\n'),
      },
    ];
    document.body.append(chat);
    await commit(chat);
    const [details] = disclosures(chat);
    expect(details.open).toBe(false);
    expect(details.querySelector('.message-code-copy')).not.toBeNull();
    expect(details.querySelector('.message-table-wrapper')).not.toBeNull();
  });
});
