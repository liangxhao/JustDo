/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ChatScrollController } from '../controllers/chat-scroll-controller';
import { ChatController } from '../gateway/chat-controller';
import type { GatewayMessage } from '../types';
import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:history-scroll';
const sessionId = 'history-scroll-session';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  document.body.replaceChildren();
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup({ deferOlderPage = false, unresolvedTools = false } = {}) {
  const messages: GatewayMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
    role: 'assistant',
    content: index === 999 ? 'The actual final answer' : unresolvedTools
      ? [{ type: 'toolCall', id: `yield-${index}`, name: 'sessions_yield' }]
      : `Intermediate commentary ${index}`,
    timestamp: index + 1,
    __openclaw: { id: `entry-${index}`, seq: index + 1 },
  }));
  let releaseOlderPage: (() => void) | null = null;
  const request = vi.fn(async (_method: string, params: { offset?: number; limit: number }) => {
    const end = messages.length - (params.offset ?? 0);
    const start = Math.max(0, end - params.limit);
    const page = {
      messages: messages.slice(start, end),
      sessionId,
      hasMore: start > 0,
      nextOffset: messages.length - start,
      sessionInfo: {
        sessionId,
        activeLeafEntryId: 'entry-999',
        hasActiveRun: false,
        activeRunIds: [],
      },
    };
    if (deferOlderPage && (params.offset ?? 0) > 0) {
      return new Promise<typeof page>(resolve => {
        releaseOlderPage = () => resolve(page);
      });
    }
    return page;
  });
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.connected = true;
  controller.state.client = { generation: 1, stop() {}, request } as never;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  return {
    controller,
    chat,
    request,
    releaseOlderPage() {
      if (!releaseOlderPage) throw new Error('No older history request is waiting');
      releaseOlderPage();
      releaseOlderPage = null;
    },
  };
}

test('keeps a long folded turn and its true final answer stable across native history pages', async () => {
  const { controller, chat, request } = setup();
  await controller.loadHistory();
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const final = root.querySelector<HTMLElement>('[data-entry-id="entry-999"]')!;
  const process = root.querySelector<HTMLDetailsElement>('.completed-process')!;
  const processKey = process.dataset.completedProcessKey;
  expect(final.textContent).toContain('The actual final answer');
  expect(process.open).toBe(false);

  for (const loadedCount of [500, 750, 1_000]) {
    expect(await controller.loadOlderHistory()).toBe(true);
    await chat.updateComplete;
    await chat.historyRenderComplete;

    expect(controller.state.loadedMessageCount).toBe(loadedCount);
    expect(root.querySelector('[data-entry-id="entry-999"]')).toBe(final);
    expect(root.querySelector('.completed-process')).toBe(process);
    expect(process.dataset.completedProcessKey).toBe(processKey);
    expect(root.querySelector('[data-entry-id="entry-935"]')).toBeNull();
    expect(root.querySelectorAll('.chat-container > [data-history-key]')).toHaveLength(2);
    expect(process.querySelector('.completed-process__items [data-entry-id]')).toBeNull();
    expect(root.querySelectorAll('[data-entry-id]')).toHaveLength(1);
  }

  expect(controller.getLoadedMessages()).toHaveLength(1_000);
  expect(controller.state.historyHasMore).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history')).toHaveLength(4);
  expect(request.mock.calls.every(([, params]) => params.limit === 250)).toBe(true);
});

test('retains expanded unresolved tool history across native page prepends', async () => {
  const { controller, chat } = setup({ unresolvedTools: true });
  await controller.loadHistory();
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const final = root.querySelector('[data-entry-id="entry-999"]')!;
  const process = root.querySelector<HTMLDetailsElement>('.completed-process')!;
  process.querySelector<HTMLElement>('summary')!.click();
  await chat.updateComplete;
  const inner = process.querySelector<HTMLElement>('[data-process-summary-key]')!;
  inner.click();
  await chat.updateComplete;
  const innerDetails = inner.closest<HTMLDetailsElement>('details')!;
  const processKey = process.dataset.completedProcessKey;
  const summaryKey = inner.dataset.processSummaryKey;
  expect(final.textContent).toContain('The actual final answer');
  expect(process.open).toBe(true);
  expect(innerDetails.open).toBe(true);

  for (const loadedCount of [500, 750, 1_000]) {
    expect(await controller.loadOlderHistory()).toBe(true);
    await chat.updateComplete;
    await chat.historyRenderComplete;

    expect(controller.state.loadedMessageCount).toBe(loadedCount);
    expect(root.querySelector('.completed-process')).toBe(process);
    expect(process.dataset.completedProcessKey).toBe(processKey);
    expect(process.querySelector('[data-process-summary-key]')).toBe(inner);
    expect(inner.dataset.processSummaryKey).toBe(summaryKey);
    expect(process.open).toBe(true);
    expect(innerDetails.open).toBe(true);
    expect(root.querySelector('[data-entry-id="entry-999"]')).toBe(final);
    expect(root.querySelectorAll('.process-summary__item').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('.process-summary__item').length).toBeLessThanOrEqual(250);
  }
});

test('preserves the paused reading position when wheel input fetches a short folded page', async () => {
  const { controller, chat, releaseOlderPage } = setup({ deferOlderPage: true });
  let scrollTop = 0;
  Object.defineProperties(chat, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 800 },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, 200));
      },
    },
  });
  chat.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  await controller.loadHistory();
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const final = root.querySelector<HTMLElement>('[data-entry-id="entry-999"]')!;
  const process = root.querySelector<HTMLDetailsElement>('.completed-process')!;
  process.getBoundingClientRect = () => new DOMRect(0, -scrollTop, 800, 40);
  final.getBoundingClientRect = () => new DOMRect(0, 40 - scrollTop, 800, 760);

  // The native history is long, but the collapsed presentation is only two rows.
  expect(scrollTop).toBe(200);
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
  expect(controller.state.historyLoadingOlder).toBe(true);
  await chat.updateComplete;
  expect(final.isConnected).toBe(true);

  // Model the browser applying the user's continued wheel movement during I/O.
  scrollTop = 160;
  chat.dispatchEvent(new Event('scroll'));
  const readingOffset = final.getBoundingClientRect().top;
  releaseOlderPage();
  await vi.waitFor(() => expect(controller.state.loadedMessageCount).toBe(500));
  await chat.updateComplete;
  await chat.historyRenderComplete;

  expect(root.querySelector('[data-entry-id="entry-999"]')).toBe(final);
  expect(root.querySelector('.completed-process')).toBe(process);
  expect(scrollTop).toBe(160);
  expect(final.getBoundingClientRect().top).toBe(readingOffset);
});

test('searches a loaded offscreen entry inside a long folded turn without mounting its whole body', async () => {
  const { controller, chat, request } = setup();
  await controller.loadHistory();
  while (controller.state.historyHasMore) await controller.loadOlderHistory();
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  expect(root.querySelector('[data-entry-id="entry-100"]')).toBeNull();
  const initialRequests = request.mock.calls.length;
  const navigate = vi.spyOn(ChatScrollController.prototype, 'navigateToElement')
    .mockImplementation(() => undefined);

  chat.searchQuery = 'Intermediate commentary 100';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(1);
  expect(root.querySelector('[data-entry-id="entry-100"]')).toBeNull();
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 1 });

  const target = root.querySelector<HTMLElement>('[data-entry-id="entry-100"]')!;
  expect(target).not.toBeNull();
  expect(target.closest<HTMLDetailsElement>('.completed-process')?.open).toBe(true);
  expect(target.querySelector('.chat-search-mark')?.textContent).toBe('Intermediate commentary 100');
  expect(root.querySelectorAll('[data-entry-id]').length).toBeLessThanOrEqual(251);
  expect(request).toHaveBeenCalledTimes(initialRequests);
  expect(navigate).toHaveBeenCalled();
});

test('navigates each search occurrence across Markdown text nodes and preserves its formatting', async () => {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = [{
    role: 'assistant',
    content: 'one **needle** one needle',
    __openclaw: { id: 'markdown-search' },
  }];
  document.body.append(chat);
  await chat.updateComplete;
  vi.spyOn(ChatScrollController.prototype, 'navigateToElement')
    .mockImplementation(() => undefined);
  chat.searchQuery = 'one needle';
  await chat.updateComplete;
  expect(chat.getSearchMatchCount()).toBe(2);
  const root = chat.shadowRoot!;
  const paragraph = root.querySelector<HTMLElement>('.markdown-content p')!;
  const highlightedOffset = () => {
    const marks = [...paragraph.querySelectorAll<HTMLElement>('.chat-search-mark')];
    expect(marks.map(mark => mark.textContent).join('')).toBe('one needle');
    const before = document.createRange();
    before.selectNodeContents(paragraph);
    before.setEndBefore(marks[0]);
    return before.toString().length;
  };

  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedOffset()).toBe(0);
  expect(paragraph.querySelector('strong')?.textContent).toBe('needle');
  expect(chat.navigateSearch(1)).toEqual({ index: 1, total: 2 });
  expect(highlightedOffset()).toBe(11);
  expect(paragraph.querySelector('strong')?.textContent).toBe('needle');
  expect(chat.navigateSearch(1)).toEqual({ index: 0, total: 2 });
  expect(highlightedOffset()).toBe(0);
});

test('restores an evicted process choice after another offscreen process is opened', async () => {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = Array.from({ length: 150 }, (_, index): GatewayMessage[] => [
    { role: 'user', content: `Question ${index}`, __openclaw: { id: `user-${index}` } },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `Reasoning ${index}` },
        { type: 'text', text: `Commentary ${index}` },
      ],
      __openclaw: { id: `process-${index}` },
    },
    { role: 'assistant', content: `Final ${index}`, __openclaw: { id: `final-${index}` } },
  ]).flat();
  document.body.append(chat);
  await chat.updateComplete;
  vi.spyOn(ChatScrollController.prototype, 'navigateToElement')
    .mockImplementation(() => undefined);
  const root = chat.shadowRoot!;
  const processFor = (index: number) => root
    .querySelector<HTMLElement>(`[data-entry-id="final-${index}"]`)!
    .closest('.history-viewport-row')!
    .previousElementSibling!
    .querySelector<HTMLDetailsElement>('.completed-process')!;

  expect(chat.revealMessage('user-0')).toBe(true);
  await chat.updateComplete;
  const original = processFor(0);
  original.querySelector<HTMLElement>('summary')!.click();
  await chat.updateComplete;
  const inner = original.querySelector<HTMLElement>('[data-process-summary-key]')!;
  inner.click();
  await chat.updateComplete;
  expect(inner.closest<HTMLDetailsElement>('details')!.open).toBe(true);
  const processKey = original.dataset.completedProcessKey;
  const summaryKey = inner.dataset.processSummaryKey;

  expect(chat.revealMessage('user-100')).toBe(true);
  await chat.updateComplete;
  expect(original.isConnected).toBe(false);
  const other = processFor(100);
  other.querySelector<HTMLElement>('summary')!.click();
  await chat.updateComplete;
  const otherInner = other.querySelector<HTMLElement>('[data-process-summary-key]')!;
  otherInner.click();
  await chat.updateComplete;
  expect(otherInner.closest<HTMLDetailsElement>('details')!.open).toBe(true);

  expect(chat.revealMessage('user-0')).toBe(true);
  await chat.updateComplete;
  const returned = processFor(0);
  const returnedInner = returned.querySelector<HTMLElement>('[data-process-summary-key]')!;
  expect(returned.dataset.completedProcessKey).toBe(processKey);
  expect(returned).not.toBe(original);
  expect(returned.open).toBe(true);
  expect(returnedInner.dataset.processSummaryKey).toBe(summaryKey);
  expect(returnedInner.closest<HTMLDetailsElement>('details')!.open).toBe(true);
});
