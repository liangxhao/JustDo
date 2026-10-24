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

function sourceLines(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    `Source line ${String(index).padStart(5, '0')}: preserve this thinking text.\n`,
  ).join('');
}

function scrollController(chat: JustDoChatElement): ChatScrollController {
  return (chat as unknown as { chatScrollController: ChatScrollController }).chatScrollController;
}

function body(chat: JustDoChatElement): string {
  return [...chat.shadowRoot!.querySelectorAll('[data-thinking-body]')]
    .map(element => element.textContent ?? '').join('');
}

async function commit(chat: JustDoChatElement): Promise<void> {
  await chat.updateComplete;
  materializeDisclosureContents(chat.shadowRoot!);
}

async function action(chat: JustDoChatElement, name: string): Promise<void> {
  const button = chat.shadowRoot!.querySelector<HTMLButtonElement>(
    `[data-thinking-action="${name}"]`,
  );
  expect(button).not.toBeNull();
  button!.click();
  await commit(chat);
}

function liveChat(text: string) {
  const turn = beginAssistantTurn(
    createChatTranscriptState('thinking-reader-fixture'),
    { runId: 'reader-run', startedAt: 1_000 },
    { now: () => 1_000, createId: prefix => prefix },
  );
  const thinking: ThinkingItem = {
    id: 'reader-thinking', runId: 'reader-run', firstSeq: 1, lastSeq: 1,
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

describe('Thinking reader within the chat render lifecycle', () => {
  test('historical page actions update cached rows without changing transcript props', async () => {
    const text = sourceLines(2_000);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.scrollTo = vi.fn();
    chat.messages = [
      { role: 'user', content: 'Inspect', timestamp: 1_000, __openclaw: { id: 'reader-user' } },
      {
        role: 'assistant', timestamp: 1_001, __openclaw: { id: 'reader-process' },
        content: [{ type: 'thinking', thinking: text }],
      },
      { role: 'assistant', content: 'Final answer', timestamp: 1_100, __openclaw: { id: 'reader-final' } },
    ];
    chat.processSummariesExpanded = true;
    document.body.append(chat);
    await commit(chat);
    const messages = chat.messages;
    const first = body(chat);
    expect(first).toContain('Source line 00000');
    let contentAtNavigation = '';
    const navigate = vi.spyOn(scrollController(chat), 'navigateTo').mockImplementation(() => {
      contentAtNavigation = body(chat);
    });

    await action(chat, 'next');

    expect(chat.messages).toBe(messages);
    expect(navigate).toHaveBeenCalledOnce();
    expect(contentAtNavigation).toBe(body(chat));
    expect(contentAtNavigation).not.toBe(first);
    expect(body(chat)).not.toBe(first);
    expect(body(chat)).not.toContain('Source line 00000');
    expect(chat.shadowRoot!.querySelector('[data-thinking-content] justdo-tool-output')).toBeNull();

    const jump = vi.spyOn(scrollController(chat), 'jumpToLatest');
    await action(chat, 'latest');
    expect(jump).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(body(chat)).toContain('Source line 01999');
    expect(scrollController(chat).state.mode).toBe('paused');
  });

  test('a manually selected live section survives additional streaming frames', async () => {
    const source = sourceLines(2_000);
    const fixture = liveChat(source);
    await commit(fixture.chat);
    expect(body(fixture.chat).length).toBeLessThanOrEqual(32_000);
    expect(body(fixture.chat)).toContain('Source line 01999');
    await action(fixture.chat, 'previous');
    const selected = body(fixture.chat);

    fixture.update(source + sourceLines(400));
    await commit(fixture.chat);

    expect(body(fixture.chat)).toBe(selected);
    expect(scrollController(fixture.chat).state.mode).toBe('paused');
    expect(fixture.chat.shadowRoot!.querySelector('[data-thinking-content] justdo-tool-output')).toBeNull();

    await action(fixture.chat, 'latest');
    expect(scrollController(fixture.chat).state.mode).toBe('follow');
    expect(body(fixture.chat)).not.toBe(selected);
  });

  test('crossing the long-text threshold while paused retains the current reading surface', async () => {
    const source = 'a'.repeat(39_999);
    const fixture = liveChat(source);
    await commit(fixture.chat);
    const prior = body(fixture.chat);
    const reader = fixture.chat.shadowRoot!.querySelector<HTMLElement>('[data-thinking-content]')!;
    scrollController(fixture.chat).preserveAnchorForInteraction(reader);

    fixture.update(source + '\n' + 'new content\n'.repeat(1_000));
    await commit(fixture.chat);

    expect(body(fixture.chat)).toBe(prior);
    await action(fixture.chat, 'latest');
    expect(body(fixture.chat)).toContain('new content');
    expect(body(fixture.chat).length).toBeLessThanOrEqual(32_000);
  });

  test('an authoritative replacement overrides a manually frozen range', async () => {
    const source = sourceLines(1_200);
    const fixture = liveChat(source);
    await commit(fixture.chat);
    await action(fixture.chat, 'previous');

    fixture.update('R'.repeat(source.length));
    await commit(fixture.chat);

    expect(body(fixture.chat)).not.toContain('Source line');
    expect(body(fixture.chat).replace(/R/g, '')).toBe('');
    fixture.update('Retracted to a short authoritative replacement.');
    await commit(fixture.chat);
    expect(body(fixture.chat)).toContain('Retracted to a short authoritative replacement.');
    expect(fixture.chat.shadowRoot!.querySelector('[data-thinking-action="next"]')).toBeNull();
  });
});
