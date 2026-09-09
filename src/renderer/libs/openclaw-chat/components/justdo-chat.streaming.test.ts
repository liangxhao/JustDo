/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

import type { JustDoChatElement } from './justdo-chat';

type TestGatewayEvent = { event: string; payload: unknown };

const controllers: ChatController[] = [];

function gatewayEventHandler(controller: ChatController): (event: TestGatewayEvent) => void {
  return (
    controller as unknown as {
      handleEvent(event: TestGatewayEvent): void;
    }
  ).handleEvent.bind(controller);
}

function notifyController(controller: ChatController): void {
  (
    controller as unknown as {
      notify(): void;
    }
  ).notify();
}

function createAnimationFrameHarness(): {
  drain: (chat: JustDoChatElement, afterFrame?: () => void) => Promise<void>;
  runNext: (chat: JustDoChatElement) => Promise<void>;
} {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));

  const runNext = async (chat: JustDoChatElement): Promise<void> => {
    const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(next).toBeDefined();
    if (!next) return;
    callbacks.delete(next[0]);
    next[1](performance.now());
    await chat.updateComplete;
  };

  return {
    runNext,
    drain: async (chat, afterFrame) => {
      for (let count = 0; callbacks.size > 0 && count < 100; count += 1) {
        await runNext(chat);
        afterFrame?.();
      }
      expect(callbacks.size).toBe(0);
    },
  };
}

function assistantText(chat: JustDoChatElement): string {
  return (
    chat.shadowRoot?.querySelector<HTMLElement>('.chat-bubble__text')?.textContent?.trim() ?? ''
  );
}

function prepareController(): ChatController {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:streaming-test';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('justdo-chat assistant stream pacing', () => {
  test.each(['result-only', 'assistant-call'] as const)(
    'shows delayed Thinking before a recovered %s Tool before its live start arrives',
    async source => {
      const frames = createAnimationFrameHarness();
      const controller = prepareController();
      controller.state.initialHistoryReady = true;
      const chat = document.createElement('justdo-chat') as JustDoChatElement;
      chat.controller = controller;
      document.body.append(chat);
      await chat.updateComplete;
      await frames.drain(chat);
      const handleEvent = gatewayEventHandler(controller);
      const sessionKey = controller.state.sessionKey;
      const emit = (seq: number, stream: string, ts: number, data: Record<string, unknown>) =>
        handleEvent({
          event: 'agent',
          payload: { sessionKey, runId: 'order-run', seq, stream, ts, data },
        });
      emit(1, 'lifecycle', 1_000, { phase: 'start' });
      handleEvent({
        event: 'session.message',
        payload: {
          sessionKey,
          activeRunIds: ['order-run'],
          message:
            source === 'result-only'
              ? {
                  role: 'toolResult',
                  timestamp: 1_500,
                  toolCallId: 'read-1',
                  toolName: 'read',
                  content: 'done',
                }
              : {
                  role: 'assistant',
                  timestamp: 1_000,
                  content: [
                    { type: 'thinking', thinking: 'Reason before reading.' },
                    { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
                  ],
                },
        },
      });
      await chat.updateComplete;
      await frames.drain(chat);
      const order = () => controller.state.transcript.activeTurn?.items.map(item => item.type);
      emit(2, 'thinking', 1_100, {
        text: 'Reason before reading.',
        progressSegmentFirstSeq: 2,
        progressSegmentStartedAt: 1_100,
      });
      expect(order()).toEqual(['thinking', 'tool']);
      await chat.updateComplete;
      await frames.drain(chat, () => expect(order()).toEqual(['thinking', 'tool']));
      const summary = chat.shadowRoot?.querySelector<HTMLButtonElement>(
        '[data-process-summary-key]',
      );
      if (summary?.getAttribute('aria-expanded') === 'false') summary.click();
      await chat.updateComplete;
      const domOrder = () =>
        Array.from(
          chat.shadowRoot?.querySelectorAll(
            '.process-summary__item, .chat-group--streaming-thinking, [data-live-process-id]',
          ) ?? [],
        ).map(element =>
          element.matches('.process-summary__item--thinking, .chat-group--streaming-thinking')
            ? 'thinking'
            : 'tool',
        );
      expect(domOrder()).toEqual(['thinking', 'tool']);
      emit(3, 'tool', 1_300, { phase: 'start', name: 'read', toolCallId: 'read-1', args: {} });
      await chat.updateComplete;
      await frames.drain(chat, () => expect(order()).toEqual(['thinking', 'tool']));
      expect(order()).toEqual(['thinking', 'tool']);
      expect(domOrder()).toEqual(['thinking', 'tool']);
    },
  );

  test('preserves a visible preamble across the native text-stripped session message and full history takeover', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const sessionKey = controller.state.sessionKey;
    const sessionId = 'diagnostic-session';
    const runId = 'diagnostic-run';
    const preamble = '诊断第一步：准备读取';
    const user = { role: 'user', content: 'Run the diagnostic.', timestamp: 1_000 };
    let history: Record<string, unknown> = { messages: [user], sessionId };
    controller.state.client = { request: vi.fn(async () => history), stop: vi.fn() } as never;
    controller.state.connected = true;
    await controller.loadHistory();
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);
    const handleEvent = gatewayEventHandler(controller);
    const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
      handleEvent({
        event: 'agent',
        payload: { sessionKey, runId, seq, ts: 2_000 + seq, stream, data },
      });
    const matchingBubbles = () =>
      Array.from(chat.shadowRoot?.querySelectorAll('.chat-bubble__text') ?? []).filter(
        element => element.textContent?.trim() === preamble,
      );
    handleEvent({
      event: 'agent',
      payload: {
        sessionKey,
        runId,
        seq: 1,
        ts: 1_900,
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    });
    emit(7, 'thinking', { text: 'Execute the first step.' });
    for (const seq of [16, 18, 20]) {
      emit(seq, 'item', {
        kind: 'preamble',
        phase: seq === 20 ? 'end' : 'update',
        itemId: 'commentary-first',
        progressText: preamble,
        progressSegmentFirstSeq: 16,
        progressSegmentStartedAt: 2_016,
      });
      await chat.updateComplete;
      await frames.drain(chat);
      expect(matchingBubbles()).toHaveLength(1);
    }
    // Captured native session.message omits text, but retains Thinking/Tool calls.
    const strippedMessage = {
      role: 'assistant',
      timestamp: 2_000,
      stopReason: 'toolUse',
      openclawDelivery: { textPhaseRequiresTerminal: true },
      content: [
        { type: 'thinking', thinking: 'Execute the first step.' },
        { type: 'toolCall', id: 'echo-first', name: 'exec', arguments: { command: 'echo first' } },
      ],
      __openclaw: { runId, id: 'assistant-first', seq: 2, recordTimestampMs: 2_021 },
    };
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        sessionId,
        messageId: 'assistant-first',
        messageSeq: 2,
        hasActiveRun: true,
        message: strippedMessage,
      },
    });
    expect(
      controller.state.transcript.activeTurn?.items.some(
        item => item.type === 'content' && item.text === preamble,
      ),
    ).toBe(true);
    await chat.updateComplete;
    await frames.drain(chat, () => expect(matchingBubbles()).toHaveLength(1));
    expect(matchingBubbles()).toHaveLength(1);
    emit(22, 'tool', {
      phase: 'start',
      name: 'exec',
      toolCallId: 'echo-first',
      args: { command: 'echo first' },
    });
    emit(24, 'tool', { phase: 'result', name: 'exec', toolCallId: 'echo-first', result: 'first' });
    await chat.updateComplete;
    await frames.drain(chat, () => expect(matchingBubbles()).toHaveLength(1));
    const completeMessage = {
      ...strippedMessage,
      content: [
        strippedMessage.content[0],
        { type: 'text', text: preamble },
        strippedMessage.content[1],
      ],
    };
    history = {
      messages: [
        user,
        completeMessage,
        { role: 'toolResult', toolCallId: 'echo-first', content: 'first', timestamp: 2_024 },
      ],
      sessionId,
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    };
    handleEvent({ event: 'chat', payload: { sessionKey, runId, state: 'final' } });
    await controller.loadHistory();
    await chat.updateComplete;
    await frames.drain(chat);
    expect(matchingBubbles()).toHaveLength(1);
  });

  test('renders live preamble updates between Thinking and Tools without waiting for history', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const request = vi.fn(async () => ({
      messages: [{ role: 'user', content: 'Collect agent results.', timestamp: 1_000 }],
    }));
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.connected = true;
    await controller.loadHistory();
    const initialRequests = request.mock.calls.length;
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);
    const handleEvent = gatewayEventHandler(controller);
    const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
      handleEvent({
        event: 'agent',
        payload: {
          sessionKey: controller.state.sessionKey,
          runId: 'run-preamble',
          seq,
          stream,
          data,
        },
      });
    const visibleReplies = () =>
      Array.from(
        chat.shadowRoot?.querySelectorAll('.chat-bubble--assistant .chat-bubble__text') ?? [],
      ).map(element => element.textContent?.trim());
    emit(7, 'thinking', { text: 'Choose five agents.' });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(chat.shadowRoot?.querySelector('.chat-group--streaming-thinking')).not.toBeNull();
    emit(52, 'item', {
      kind: 'preamble',
      phase: 'update',
      itemId: 'dispatch',
      progressText: 'Dispatching',
    });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(visibleReplies()).toEqual(['Dispatching']);
    emit(54, 'item', {
      kind: 'preamble',
      phase: 'end',
      itemId: 'dispatch',
      progressText: 'Dispatching five agents.',
    });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(visibleReplies()).toEqual(['Dispatching five agents.']);
    emit(57, 'tool', { phase: 'start', toolCallId: 'spawn-1', name: 'sessions_spawn' });
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelector('.process-summary__tool-status--running')).not.toBeNull();
    expect(visibleReplies()).toEqual(['Dispatching five agents.']);
    emit(59, 'tool', {
      phase: 'result',
      toolCallId: 'spawn-1',
      name: 'sessions_spawn',
      result: 'accepted',
    });
    emit(141, 'thinking', { text: 'Wait for the remaining results.' });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(chat.shadowRoot?.querySelector('.chat-group--streaming-thinking')).not.toBeNull();
    emit(150, 'item', {
      kind: 'preamble',
      phase: 'end',
      itemId: 'wait',
      progressText: 'Waiting for the remaining results.',
    });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(visibleReplies()).toEqual([
      'Dispatching five agents.',
      'Waiting for the remaining results.',
    ]);
    emit(153, 'tool', { phase: 'start', toolCallId: 'yield-1', name: 'sessions_yield' });
    await chat.updateComplete;
    expect(visibleReplies()).toEqual([
      'Dispatching five agents.',
      'Waiting for the remaining results.',
    ]);
    expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
      'thinking',
      'content',
      'tool',
      'thinking',
      'content',
      'tool',
    ]);
    expect(request).toHaveBeenCalledTimes(initialRequests);
  });

  test('keeps every visible reply separated while history overtakes subagent result Thinking', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const sessionKey = controller.state.sessionKey;
    const runId = 'run-subagent-results';
    const user = { role: 'user', content: 'Collect five agent results.', timestamp: 1_000 };
    let history: Record<string, unknown> = { messages: [user] };
    controller.state.client = { request: vi.fn(async () => history), stop: vi.fn() } as never;
    controller.state.connected = true;
    await controller.loadHistory();
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);
    const handleEvent = gatewayEventHandler(controller);
    const emit = (seq: number, stream: string, data: Record<string, unknown>, id = runId) =>
      handleEvent({ event: 'agent', payload: { sessionKey, runId: id, seq, stream, data } });
    const replies = [
      'Five agents dispatched.',
      'Waiting for three agents.',
      'Two agents returned the same blessing.',
    ];
    const bubbles = () =>
      Array.from(chat.shadowRoot?.querySelectorAll('.chat-bubble__text') ?? [])
        .map(element => element.textContent?.trim())
        .filter(text => replies.includes(text ?? ''));
    emit(76, 'assistant', { text: replies[0] });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(bubbles()).toEqual(replies.slice(0, 1));
    for (const [index, seq] of [
      [1, 78],
      [2, 83],
    ]) {
      history = {
        messages: [user],
        sessionInfo: { hasActiveRun: true, activeRunIds: [runId] },
        inFlightRun: {
          runId,
          text: replies.slice(0, index + 1).join(''),
          events: [{ runId, seq: seq + 1, stream: 'usage', data: {} }],
        },
      };
      await controller.loadHistory();
      await chat.updateComplete;
      await frames.drain(chat, () => expect(bubbles()).toEqual(replies.slice(0, index)));
      expect(bubbles()).toEqual(replies.slice(0, index));
      emit(seq, 'thinking', { text: `Review result ${index}.` });
      await chat.updateComplete;
      await frames.drain(chat, () => expect(bubbles()).toEqual(replies.slice(0, index)));
      expect(chat.shadowRoot?.querySelector('.chat-group--streaming-thinking')).not.toBeNull();
      const items = controller.state.transcript.activeTurn?.items ?? [];
      expect(items[items.length - 1]).toMatchObject({
        type: 'thinking',
        text: `Review result ${index}.`,
      });
      expect(bubbles()).toEqual(replies.slice(0, index));
      emit(seq + 2, 'assistant', { text: replies[index] });
      await chat.updateComplete;
      await frames.drain(chat, () => {
        for (const previous of replies.slice(0, index)) expect(bubbles()).toContain(previous);
      });
      expect(bubbles()).toEqual(replies.slice(0, index + 1));
    }
    handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: replies[2] },
      },
    });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(bubbles()).toEqual(replies);
    history = {
      messages: [
        user,
        ...replies.map((text, index) => ({
          role: 'assistant',
          runId,
          timestamp: 2_000 + index,
          content: [
            ...(index ? [{ type: 'thinking', thinking: `Review result ${index}.` }] : []),
            { type: 'text', text },
          ],
        })),
      ],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    };
    await controller.loadHistory();
    await chat.updateComplete;
    await frames.drain(chat);
    expect(bubbles()).toEqual(replies);
    const announceId = 'announce:requester-settle:main:results';
    emit(1, 'lifecycle', { phase: 'start' }, announceId);
    emit(2, 'thinking', { text: 'The result was already delivered.' }, announceId);
    emit(3, 'assistant', { text: 'NO_REPLY' }, announceId);
    handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        runId: announceId,
        state: 'final',
        message: { role: 'assistant', content: 'NO_REPLY' },
      },
    });
    await chat.updateComplete;
    await frames.drain(chat);
    expect(bubbles()).toEqual(replies);
  });

  test('does not show the previous model while the next prompt is still optimistic', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    controller.state.chatMessages = [
      { role: 'user', content: 'previous prompt', timestamp: 1_000 },
      {
        role: 'assistant',
        content: 'previous answer',
        timestamp: 2_000,
        provider: 'previous-provider',
        model: 'previous-model',
      },
    ];
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(controller.state.chatMessages, { resetLoadedHistory: true });
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    controller.state.pendingUserMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'next prompt' }],
      text: 'next prompt',
      timestamp: Date.now(),
    };
    controller.state.chatSending = true;
    beginAssistantTurn(
      controller.state.transcript,
      { runId: 'run-next' },
      {
        now: Date.now,
        createId: () => 'turn-next',
      },
    );
    notifyController(controller);
    await chat.updateComplete;
    await frames.drain(chat);

    expect(controller.state.visibleChatMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ model: 'previous-model' })]),
    );
    const footer = chat.shadowRoot?.querySelector('.active-turn__footer');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).not.toContain('previous-provider/previous-model');
  });

  test('reveals burst snapshots by frame, flushes the terminal snapshot, and avoids history duplication', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const handleEvent = gatewayEventHandler(controller);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const searchMatchCounts: number[] = [];
    chat.searchQuery = '世界';
    chat.addEventListener('search-match-count-change', event => {
      searchMatchCounts.push((event as CustomEvent<{ total: number }>).detail.total);
    });
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);

    handleEvent({
      event: 'agent',
      payload: {
        session: controller.state.sessionKey,
        runId: 'run-1',
        seq: 1,
        stream: 'assistant',
        data: { text: '你' },
      },
    });
    handleEvent({
      event: 'agent',
      payload: {
        session: controller.state.sessionKey,
        runId: 'run-1',
        seq: 2,
        stream: 'assistant',
        data: { text: '你好' },
      },
    });

    expect(controller.state.transcript.activeTurn?.items).toMatchObject([
      { type: 'content', text: '你好' },
    ]);
    expect(assistantText(chat)).toBe('');

    await frames.runNext(chat);
    expect(assistantText(chat)).toBe('你');

    await frames.runNext(chat);
    expect(assistantText(chat)).toBe('你好');
    await frames.drain(chat);

    handleEvent({
      event: 'chat',
      payload: {
        sessionKey: controller.state.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: { role: 'assistant', content: '你好，世界！' },
      },
    });
    await chat.updateComplete;

    expect(controller.state.transcript.activeTurn?.status).toBe('final');
    expect(assistantText(chat)).toBe('你好，世界！');
    expect(chat.shadowRoot?.querySelector('.chat-group--streaming')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-container')?.getAttribute('aria-busy')).toBe(
      'false',
    );

    const authoritativeHistory = [{ role: 'assistant', content: '你好，世界！', runId: 'run-1' }];
    controller.state.chatMessages = authoritativeHistory;
    controller.state.visibleChatMessages = authoritativeHistory;
    controller.state.transcript.persistedMessages = authoritativeHistory;
    controller.state.transcript.activeTurn = null;
    notifyController(controller);
    await chat.updateComplete;

    expect(assistantText(chat)).toBe('你好，世界！');
    expect(chat.shadowRoot?.querySelectorAll('.chat-bubble__text')).toHaveLength(1);

    await frames.drain(chat);
    expect(assistantText(chat)).toBe('你好，世界！');
    expect(searchMatchCounts[searchMatchCounts.length - 1]).toBe(1);
    expect(chat.shadowRoot?.querySelector('.chat-group--streaming')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-container')?.getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  test('flushes queued assistant text before rendering the following Tool', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const handleEvent = gatewayEventHandler(controller);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);

    handleEvent({
      event: 'agent',
      payload: {
        session: controller.state.sessionKey,
        runId: 'run-1',
        seq: 1,
        stream: 'assistant',
        data: { text: '先完成这段正文' },
      },
    });
    expect(assistantText(chat)).toBe('');

    handleEvent({
      event: 'agent',
      payload: {
        session: controller.state.sessionKey,
        runId: 'run-1',
        seq: 2,
        stream: 'tool',
        data: { phase: 'start', toolCallId: 'call-1', name: 'exec' },
      },
    });
    await chat.updateComplete;

    expect(assistantText(chat)).toBe('先完成这段正文');
    expect(chat.shadowRoot?.querySelector('.process-summary__tool-title strong')?.textContent).toBe(
      'Exec',
    );
  });

  test('seeds an existing background stream when returning to its session', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const firstSessionKey = controller.state.sessionKey;
    const secondSessionKey = 'agent:main:justdo:streaming-test-2';
    const handleEvent = gatewayEventHandler(controller);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);

    handleEvent({
      event: 'agent',
      payload: {
        session: firstSessionKey,
        runId: 'run-1',
        seq: 1,
        stream: 'assistant',
        data: { text: '已经看到' },
      },
    });
    await frames.drain(chat);
    expect(assistantText(chat)).toBe('已经看到');

    await controller.switchSession(secondSessionKey);
    await chat.updateComplete;
    expect(assistantText(chat)).toBe('');

    handleEvent({
      event: 'agent',
      payload: {
        session: firstSessionKey,
        runId: 'run-1',
        seq: 2,
        stream: 'assistant',
        data: { text: '已经看到并在后台完成' },
      },
    });

    await controller.switchSession(firstSessionKey);
    await chat.updateComplete;

    expect(assistantText(chat)).toBe('已经看到并在后台完成');
    await frames.drain(chat);
    expect(assistantText(chat)).toBe('已经看到并在后台完成');
  });

  test('flushes terminal Mermaid content before enhancing it', async () => {
    const frames = createAnimationFrameHarness();
    const controller = prepareController();
    const handleEvent = gatewayEventHandler(controller);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    document.body.append(chat);
    await chat.updateComplete;
    await frames.drain(chat);

    handleEvent({
      event: 'agent',
      payload: {
        session: controller.state.sessionKey,
        runId: 'run-1',
        seq: 1,
        stream: 'assistant',
        data: { text: 'diagram' },
      },
    });
    await frames.drain(chat);

    handleEvent({
      event: 'chat',
      payload: {
        sessionKey: controller.state.sessionKey,
        runId: 'run-1',
        state: 'final',
        message: {
          role: 'assistant',
          content: 'diagram\n\n```mermaid\nflowchart LR\nA-->B\n```',
        },
      },
    });
    await chat.updateComplete;

    expect(chat.shadowRoot?.querySelector('.mermaid-block')).not.toBeNull();

    await frames.drain(chat);
    await Promise.resolve();

    expect(
      chat.shadowRoot?.querySelector('.mermaid-block[data-mermaid-rendered="true"]'),
    ).not.toBeNull();
  });
});
