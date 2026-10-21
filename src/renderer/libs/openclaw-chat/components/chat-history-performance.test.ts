/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import type { PersistedTimelineCache } from '../model/timeline/persisted-timeline-cache';
import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:history-performance';
const sessionId = 'history-performance-session';

afterEach(() => {
  document.body.replaceChildren();
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const messages = Array.from({ length: 500 }, (_, index) => [
    {
      role: 'user',
      content: `Question ${index}`,
      timestamp: index * 4 + 1,
      __openclaw: { id: `user-${index}`, seq: index * 4 + 1 },
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `Reasoning ${index}` },
        { type: 'text', text: `Commentary ${index}` },
      ],
      timestamp: index * 4 + 2,
      __openclaw: { id: `process-${index}`, seq: index * 4 + 2 },
    },
    {
      role: 'assistant',
      content: `Answer ${index}`,
      timestamp: index * 4 + 3,
      __openclaw: { id: `answer-${index}`, seq: index * 4 + 3 },
    },
    {
      role: 'assistant',
      content: `Final ${index}`,
      timestamp: index * 4 + 4,
      __openclaw: { id: `final-${index}`, seq: index * 4 + 4 },
    },
  ]).flat();
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.connected = true;
  controller.state.client = {
    generation: 1,
    stop() {},
    request: vi.fn(async (_method, params) => {
      const end = messages.length - (params.offset ?? 0);
      const start = Math.max(0, end - params.limit);
      const activeRun = controller.state.transcript.activeTurn?.runId;
      return {
        messages: messages.slice(start, end),
        sessionId,
        hasMore: start > 0,
        nextOffset: messages.length - start,
        sessionInfo: {
          sessionId,
          activeLeafEntryId: 'final-499',
          hasActiveRun: Boolean(activeRun),
          activeRunIds: activeRun ? [activeRun] : [],
        },
        ...(activeRun ? { inFlightRun: { runId: activeRun, events: [] } } : {}),
      };
    }),
  } as never;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  let seq = 0;
  const emit = (text: string) => {
    (controller as unknown as { handleEvent(event: unknown): void }).handleEvent({
      event: 'agent',
      payload: {
        sessionKey,
        sessionId,
        runId: 'live-history-run',
        seq: ++seq,
        ts: Date.now(),
        stream: 'assistant',
        data: { itemId: 'live-body', text },
      },
    });
  };
  return { controller, chat, messages, emit };
}

test.each([false, true])(
  'keeps a 2,000-message history window bounded while loading (running: %s)',
  async running => {
    const { controller, messages, emit } = setup();
    await controller.loadHistory();
    expect(controller.state.loadedMessageCount).toBe(250);
    if (running) emit('Live output');
    for (let page = 0; controller.state.historyHasMore && page < 10; page += 1) {
      expect(await controller.loadOlderHistory()).toBe(true);
      expect(controller.state.visibleChatMessages.length).toBeLessThanOrEqual(750);
    }
    expect(controller.getLoadedMessages()).toEqual(messages);
    expect(controller.state.loadedMessageCount).toBe(2_000);
    expect(controller.state.historyWindowStart).toBe(0);
    expect(controller.state.visibleChatMessages).toHaveLength(750);
    if (running)
      expect(controller.state.transcript.activeTurn?.items).toEqual([
        expect.objectContaining({ text: 'Live output' }),
      ]);

    controller.showLatestHistory();
    expect(controller.state.historyWindowEnd).toBe(2_000);
    expect(controller.state.visibleChatMessages).toContainEqual(
      expect.objectContaining({ content: 'Final 499' }),
    );
  },
);

test('does not reproject or rerender old messages on repeated live text updates', async () => {
  const { controller, chat, emit } = setup();
  await controller.loadHistory();
  for (let page = 0; controller.state.historyHasMore && page < 10; page += 1) {
    expect(await controller.loadOlderHistory()).toBe(true);
  }
  (
    controller as unknown as { applyHistoryWindow(window: { start: number; end: number }): void }
  ).applyHistoryWindow({ start: 0, end: 100 });
  document.body.append(chat);
  emit('Live output');
  chat.requestUpdate();
  await chat.updateComplete;
  const internal = chat as unknown as {
    persistedTimelineCache: PersistedTimelineCache;
    renderVisibleTimelineItem(item: { kind: string }): unknown;
  };
  const revision = internal.persistedTimelineCache.revision;
  const render = vi.spyOn(internal, 'renderVisibleTimelineItem');
  const historicalNode = chat.shadowRoot!.querySelector('[data-entry-id="user-0"]');
  for (let index = 0; index < 12; index += 1) {
    emit(`Live output ${index}`);
    chat.requestUpdate();
    await chat.updateComplete;
  }
  expect(internal.persistedTimelineCache.revision).toBe(revision);
  expect(render.mock.calls.filter(([item]) => item.kind === 'history-message')).toHaveLength(0);
  expect(chat.shadowRoot!.querySelector('[data-entry-id="user-0"]')).toBe(historicalNode);
  expect(chat.shadowRoot!.textContent).toContain('Live output 11');
  render.mockRestore();
});

test('search and message navigation can materialize a collapsed history without loading more pages', async () => {
  const { controller, chat } = setup();
  await controller.loadHistory();
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  expect(root.querySelector('[data-entry-id="process-499"]')).toBeNull();
  chat.searchQuery = 'Reasoning 499';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(root.textContent).toContain('Reasoning 499');
  const target = root.querySelector<HTMLElement>('[data-entry-id="answer-499"]')!;
  target.scrollIntoView = vi.fn();
  expect(chat.revealMessage('answer-499')).toBe(true);
  expect(root.querySelector('[data-entry-id="answer-499"]')!.closest('details')!.open).toBe(true);
  expect(controller.state.loadedMessageCount).toBe(250);
  vi.restoreAllMocks();
});
