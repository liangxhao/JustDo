/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ChatScrollController } from '../controllers/chat-scroll-controller';
import {
  beginAssistantTurn,
  createChatTranscriptState,
  type ThinkingItem,
} from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';
import { materializeDisclosureContents } from './timeline/disclosure-content';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function scrollController(chat: JustDoChatElement): ChatScrollController {
  return (chat as unknown as { chatScrollController: ChatScrollController }).chatScrollController;
}

async function commit(chat: JustDoChatElement): Promise<void> {
  await chat.updateComplete;
  materializeDisclosureContents(chat.shadowRoot!);
}

function liveChat(text: string) {
  const turn = beginAssistantTurn(
    createChatTranscriptState('thinking-preview-fixture'),
    { runId: 'preview-run', startedAt: 1_000 },
    { now: () => 1_000, createId: prefix => prefix },
  );
  const thinking: ThinkingItem = {
    id: 'preview-thinking', runId: 'preview-run', firstSeq: 1, lastSeq: 1,
    startedAt: 1_001, updatedAt: 1_001, type: 'thinking', status: 'running', text,
  };
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.scrollTo = vi.fn();
  chat.activeTurn = { ...turn, items: [thinking], lastAgentSeq: 1 };
  document.body.append(chat);
  return {
    chat,
    update(next: string): void {
      const seq = chat.activeTurn!.lastAgentSeq + 1;
      chat.activeTurn = {
        ...chat.activeTurn!, lastAgentSeq: seq,
        items: [{ ...thinking, text: next, lastSeq: seq, updatedAt: 1_000 + seq }],
      };
    },
  };
}

describe('Thinking preview within the chat render lifecycle', () => {
  test('reveals a clipped thinking search match before navigation and keeps its mark attached', async () => {
    const fixture = liveChat('Opening paragraph.\n\n' + 'Thinking line.\n'.repeat(30) + 'Searchable thinking tail');
    await commit(fixture.chat);
    fixture.chat.searchQuery = 'Searchable thinking tail';
    await commit(fixture.chat);
    const body = fixture.chat.shadowRoot!.querySelector<HTMLElement>('[data-thinking-body]')!;
    const navigate = vi.spyOn(scrollController(fixture.chat), 'navigateToElement').mockImplementation(mark => {
      expect(body.parentElement!.classList.contains('is-expanded')).toBe(true);
      expect(mark.isConnected).toBe(true);
      expect(mark.textContent).toBe('Searchable thinking tail');
    });

    expect(fixture.chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });
    expect(navigate).toHaveBeenCalledOnce();
    await commit(fixture.chat);
    expect(body.querySelector('.chat-search-mark')?.textContent).toBe('Searchable thinking tail');
    const navigatePage = vi.spyOn(scrollController(fixture.chat), 'navigateTo');
    fixture.chat.shadowRoot!.querySelector<HTMLButtonElement>('[data-thinking-action="toggle-preview"]')!.click();
    await commit(fixture.chat);
    expect(body.parentElement!.classList.contains('is-expanded')).toBe(false);
    expect(navigatePage).not.toHaveBeenCalled();
    expect(scrollController(fixture.chat).state.mode).toBe('paused');
  });

  test('historical expansion updates cached rows without changing transcript props or paging', async () => {
    const text = 'Complete thinking text.\n'.repeat(3_000);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.scrollTo = vi.fn();
    chat.messages = [
      { role: 'user', content: 'Inspect', timestamp: 1_000, __openclaw: { id: 'preview-user' } },
      {
        role: 'assistant', timestamp: 1_001, __openclaw: { id: 'preview-process' },
        content: [{ type: 'thinking', thinking: text }],
      },
      { role: 'assistant', content: 'Final answer', timestamp: 1_100, __openclaw: { id: 'preview-final' } },
    ];
    chat.processSummariesExpanded = true;
    document.body.append(chat);
    await commit(chat);
    const messages = chat.messages;
    const body = chat.shadowRoot!.querySelector<HTMLElement>('[data-thinking-body]')!;
    expect(body.textContent).toBe(text);
    chat.searchQuery = 'Complete thinking text';
    await commit(chat);
    vi.spyOn(scrollController(chat), 'navigateToElement').mockImplementation(() => {});
    chat.navigateSearch(1);
    await commit(chat);
    expect(chat.shadowRoot!.querySelector('.thinking-content__toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(chat.messages).toBe(messages);
    expect(body.textContent).toBe(text);
    expect(chat.shadowRoot!.querySelector('[data-thinking-section-start]')).toBeNull();
    expect(chat.shadowRoot!.querySelector('[data-thinking-content] justdo-tool-output')).toBeNull();
  });

  test('continues displaying the complete source during streaming growth past the Markdown budget', async () => {
    const source = 'a'.repeat(39_999);
    const fixture = liveChat(source);
    await commit(fixture.chat);
    const next = source + '\n' + 'new content\n'.repeat(3_000);
    fixture.update(next);
    await commit(fixture.chat);
    const body = fixture.chat.shadowRoot!.querySelector<HTMLElement>('[data-thinking-body]')!;
    expect(body.textContent).toBe(next);
    expect(body.parentElement!.classList.contains('is-expanded')).toBe(false);
    expect(fixture.chat.shadowRoot!.querySelector('.thinking-content__toolbar')).toBeNull();
  });
});
