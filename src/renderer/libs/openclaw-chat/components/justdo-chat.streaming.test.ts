/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

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
  drain: (chat: JustDoChatElement) => Promise<void>;
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
    drain: async chat => {
      for (let count = 0; callbacks.size > 0 && count < 100; count += 1) {
        await runNext(chat);
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
  test('reveals burst snapshots by frame and keeps optimistic final history behind the live text', async () => {
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
    expect(assistantText(chat)).toBe('你好');
    expect(chat.shadowRoot?.querySelector('.chat-group--streaming')).not.toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-container')?.getAttribute('aria-busy')).toBe(
      'true',
    );

    const authoritativeHistory = [{ role: 'assistant', content: '你好，世界！', runId: 'run-1' }];
    controller.state.chatMessages = authoritativeHistory;
    controller.state.visibleChatMessages = authoritativeHistory;
    controller.state.transcript.persistedMessages = authoritativeHistory;
    controller.state.transcript.activeTurn = null;
    notifyController(controller);
    await chat.updateComplete;

    expect(assistantText(chat)).toBe('你好');
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
    expect(chat.shadowRoot?.textContent).toContain('exec');
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

  test('waits for final pacing before enhancing completed Mermaid content', async () => {
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

    expect(chat.shadowRoot?.querySelector('.mermaid-block')).toBeNull();

    await frames.drain(chat);
    await Promise.resolve();

    expect(
      chat.shadowRoot?.querySelector('.mermaid-block[data-mermaid-rendered="true"]'),
    ).not.toBeNull();
  });
});
