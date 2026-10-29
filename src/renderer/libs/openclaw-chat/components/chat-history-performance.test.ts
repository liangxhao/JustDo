/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { HISTORY_RENDER_WINDOW_SIZE } from '../model/history/history-window';
import type { PersistedTimelineCache } from '../model/timeline/persisted-timeline-cache';
import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:history-performance';
const sessionId = 'history-performance-session';
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

afterEach(() => {
  document.body.replaceChildren();
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

function setup() {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
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
      expect(controller.state.visibleChatMessages.length).toBeLessThanOrEqual(
        HISTORY_RENDER_WINDOW_SIZE,
      );
    }
    expect(controller.getLoadedMessages()).toEqual(messages);
    expect(controller.state.loadedMessageCount).toBe(2_000);
    while (controller.state.historyWindowStart > 0) await controller.showOlderHistory();
    expect(controller.state.historyWindowStart).toBe(0);
    expect(controller.state.visibleChatMessages).toHaveLength(HISTORY_RENDER_WINDOW_SIZE);
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
  document.body.append(chat);
  emit('Live output');
  chat.requestUpdate();
  await chat.updateComplete;
  expect(chat.revealMessage('user-0')).toBe(true);
  await chat.updateComplete;
  const internal = chat as unknown as {
    persistedTimelineCache: PersistedTimelineCache;
    renderVisibleTimelineItem(item: { kind: string }): unknown;
  };
  const revision = internal.persistedTimelineCache.revision;
  const render = vi.spyOn(internal, 'renderVisibleTimelineItem');
  const historicalNode = chat.shadowRoot!.querySelector('[data-entry-id="user-0"]');
  expect(historicalNode).not.toBeNull();
  for (let index = 0; index < 12; index += 1) {
    emit(`Live output ${index}`);
    chat.requestUpdate();
    await chat.updateComplete;
  }
  expect(internal.persistedTimelineCache.revision).toBe(revision);
  expect(
    render.mock.calls.filter(
      ([item]) => item.kind === 'history-message' || item.kind === 'completed-process',
    ),
  ).toHaveLength(0);
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

test('keeps retained DOM and live output available while an older page is progressively committed', async () => {
  const { controller, chat, emit } = setup();
  await controller.loadHistory();
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.revealMessage('answer-437')).toBe(true);
  await chat.updateComplete;
  const retained = chat.shadowRoot!.querySelector('[data-entry-id="final-437"]');
  expect(retained).not.toBeNull();
  const boundary = chat.shadowRoot!
    .querySelector<HTMLElement>('[data-entry-id="answer-437"]')!
    .closest<HTMLDetailsElement>('.completed-process')!;
  expect(boundary.open).toBe(true);
  const process = [...chat.shadowRoot!.querySelectorAll<HTMLDetailsElement>('.completed-process')]
    .find(candidate => candidate !== boundary)!;
  expect(process).toBeDefined();
  process.querySelector<HTMLElement>('summary')!.click();
  await chat.updateComplete;
  const key = process.dataset.completedProcessKey!;
  emit('Before loading history');
  chat.requestUpdate();
  await chat.updateComplete;
  await controller.loadOlderHistory();
  await chat.updateComplete;
  const internal = chat as unknown as {
    historyRenderScheduler: { isPending: boolean };
    flushHistoryRender(): void;
  };
  expect(internal.historyRenderScheduler.isPending).toBe(true);
  expect(chat.shadowRoot!.querySelector('[data-entry-id="final-437"]')).toBe(retained);
  expect(chat.shadowRoot!.querySelector(`[data-completed-process-key="${key}"]`)).toBe(process);
  expect(process.open).toBe(true);
  const restoredBoundary = chat
    .shadowRoot!.querySelector<HTMLElement>('[data-entry-id="answer-437"]')
    ?.closest<HTMLDetailsElement>('.completed-process');
  expect(restoredBoundary?.open).toBe(true);
  emit('Live output while the old page is still rendering');
  chat.requestUpdate();
  await chat.updateComplete;
  expect(internal.historyRenderScheduler.isPending).toBe(true);
  expect(chat.shadowRoot!.textContent).toContain(
    'Live output while the old page is still rendering',
  );
  internal.flushHistoryRender();
  await chat.historyRenderComplete;
  expect(chat.shadowRoot!.querySelector('[data-entry-id="final-437"]')).toBe(retained);
  expect(controller.state.loadedMessageCount).toBe(500);
});

test('restores outer and inner process disclosures after leaving and returning to a history window', async () => {
  const { controller, chat } = setup();
  await controller.loadHistory();
  for (let page = 0; controller.state.historyHasMore && page < 10; page += 1)
    await controller.loadOlderHistory();
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.revealMessage('user-0')).toBe(true);
  await chat.updateComplete;
  const process = chat.shadowRoot!.querySelector<HTMLDetailsElement>('.completed-process')!;
  process.querySelector<HTMLElement>('summary')!.click();
  const inner = process.querySelector<HTMLElement>('[data-process-summary-key]')!;
  inner.click();
  await chat.updateComplete;
  expect(process.open).toBe(true);
  expect(inner.closest<HTMLDetailsElement>('details')!.open).toBe(true);
  const key = process.dataset.completedProcessKey!;
  const summaryKey = inner.dataset.processSummaryKey!;
  expect(chat.revealMessage('user-100')).toBe(true);
  await chat.updateComplete;
  expect(process.isConnected).toBe(false);
  expect(chat.revealMessage('user-0')).toBe(true);
  await chat.updateComplete;
  const restored = chat.shadowRoot!.querySelector<HTMLDetailsElement>(
    `[data-completed-process-key="${key}"]`,
  )!;
  expect(restored.open).toBe(true);
  expect(
    (
      chat as unknown as {
        historyDisclosureState: { expanded(key: string, fallback: boolean): boolean };
      }
    ).historyDisclosureState.expanded(summaryKey, false),
  ).toBe(true);
  expect(
    (chat as unknown as { renderedOpenProcessSummaryKey: string }).renderedOpenProcessSummaryKey,
  ).toBe(summaryKey);
  expect(
    restored
      .querySelector(`[data-process-summary-key="${summaryKey}"]`)!
      .closest<HTMLDetailsElement>('details')!.open,
  ).toBe(true);
});
