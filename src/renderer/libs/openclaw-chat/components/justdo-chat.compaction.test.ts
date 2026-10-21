/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import type { JustDoChatElement } from './justdo-chat';
import { materializeDisclosureContents } from './timeline/disclosure-content';

const controllers: ChatController[] = [];
const initialLanguage = i18nService.getLanguage();

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  document.body.replaceChildren();
  i18nService.setLanguage(initialLanguage, { persist: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderMessages(messages: GatewayMessage[]): Promise<JustDoChatElement> {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages;
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}

function createController(sessionKey: string) {
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controllers.push(controller);
  let sequence = 0;
  const receive = (event: string, payload: unknown) =>
    (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent({ event, payload });
  const emit = (stream: string, data: Record<string, unknown>) =>
    receive('agent', { sessionKey, runId: 'run-1', seq: ++sequence, stream, data });
  return { controller, emit, receive };
}

function animationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  return async (chat: JustDoChatElement) => {
    for (let count = 0; callbacks.size > 0 && count < 100; count += 1) {
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id);
      callback(performance.now());
      await chat.updateComplete;
    }
    expect(callbacks.size).toBe(0);
  };
}

test('places live compaction between the surrounding content and enriches the same node before the run ends', async () => {
  const drainFrames = animationFrames();
  const { controller, emit } = createController('agent:main:compaction-live-order');
  emit('lifecycle', { phase: 'start' });
  emit('assistant', { text: 'Before compaction' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;

  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const divider = root.querySelector('.chat-divider')!;
  expect(divider).not.toBeNull();
  let text = root.querySelector('.chat-container')!.textContent!;
  expect(text.indexOf('Before compaction')).toBeLessThan(
    text.indexOf(i18nService.t('coworkCompactionInProgress')),
  );

  emit('compaction', {
    phase: 'end',
    itemId: 'compact-1',
    completed: true,
    tokensBefore: 12_000,
    tokensAfter: 4_000,
  });
  emit('assistant', { text: 'After compaction' });
  await chat.updateComplete;
  await drainFrames(chat);
  expect(root.querySelectorAll('.chat-divider')).toHaveLength(1);
  expect(root.querySelector('.chat-divider')).toBe(divider);
  text = root.querySelector('.chat-container')!.textContent!;
  expect(text.indexOf('Before compaction')).toBeLessThan(text.indexOf('12,000 → 4,000 tokens'));
  expect(text.indexOf('12,000 → 4,000 tokens')).toBeLessThan(text.indexOf('After compaction'));
  expect(controller.state.chatSending).toBe(true);
});

test('fills native compaction details while the same run continues without replacing its live output', async () => {
  vi.useFakeTimers();
  let resolveDetails!: (result: unknown) => void;
  const getCompactionDetails = vi.fn(
    () =>
      new Promise(resolve => {
        resolveDetails = resolve;
      }),
  );
  vi.stubGlobal('electron', { openclaw: { history: { getCompactionDetails } } });
  const sessionKey = 'agent:main:compaction-live-details';
  const { controller, emit, receive } = createController(sessionKey);
  const request = vi.fn();
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.connected = true;
  emit('lifecycle', { phase: 'start' });
  emit('assistant', { text: 'Before compaction' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  emit('compaction', { phase: 'end', itemId: 'compact-1', completed: true });
  emit('assistant', { text: 'After compaction' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const divider = root.querySelector('.chat-divider')!;

  receive('session.message', {
    sessionKey,
    runId: 'run-1',
    hasActiveRun: true,
    messageSeq: 3,
    message: {
      role: 'system',
      timestamp: Date.now(),
      __openclaw: {
        kind: 'compaction',
        id: 'native-entry',
        itemId: 'compact-1',
        runId: 'run-1',
        seq: 3,
        tokensBefore: 12_000,
        tokensAfter: 4_000,
      },
    },
  });
  await chat.updateComplete;
  expect(getCompactionDetails).toHaveBeenCalledWith({ sessionKey, entryIds: ['native-entry'] });
  expect(root.querySelector('.chat-divider')).toBe(divider);
  expect(divider.textContent).toContain('12,000 → 4,000 tokens');
  resolveDetails({
    success: true,
    details: { 'native-entry': { summary: 'Preserved native decisions' } },
  });
  await vi.advanceTimersByTimeAsync(0);
  await chat.updateComplete;
  expect(root.querySelectorAll('.chat-divider')).toHaveLength(1);
  expect(root.querySelector('.chat-divider')).toBe(divider);
  expect(divider.textContent).toContain('Preserved native decisions');
  expect(root.textContent).toContain('Before compaction');
  expect(root.textContent).toContain('After compaction');
  expect(controller.state.chatSending).toBe(true);
  expect(request).not.toHaveBeenCalled();

  request.mockResolvedValue({
    messages: [
      {
        role: 'assistant',
        content: 'Before compaction',
        __openclaw: { id: 'before', runId: 'run-1' },
      },
      {
        role: 'system',
        __openclaw: {
          kind: 'compaction',
          id: 'native-entry',
          itemId: 'compact-1',
          runId: 'run-1',
          tokensBefore: 12_000,
          tokensAfter: 4_000,
          summary: 'Preserved native decisions',
        },
      },
      {
        role: 'assistant',
        content: 'After compaction',
        __openclaw: { id: 'final', runId: 'run-1' },
      },
    ],
  });
  receive('chat', {
    sessionKey,
    runId: 'run-1',
    state: 'final',
    message: { role: 'assistant', content: 'After compaction' },
  });
  receive('session.message', {
    sessionKey,
    runId: 'run-1',
    hasActiveRun: false,
    messageSeq: 4,
    message: {
      role: 'assistant',
      content: 'After compaction',
      __openclaw: { id: 'final', runId: 'run-1', seq: 4 },
    },
  });
  await chat.updateComplete;
  expect(controller.state.transcript.activeTurn).not.toBeNull();
  expect(root.querySelector('.chat-divider')).toBe(divider);
  await vi.advanceTimersByTimeAsync(1200);
  await chat.updateComplete;
  expect(controller.state.transcript.activeTurn).toBeNull();
  materializeDisclosureContents(root);
  expect(root.querySelectorAll('.chat-divider')).toHaveLength(1);
  expect(root.querySelector('.chat-divider')!.closest('.completed-process')).not.toBeNull();
});

test('keeps the live compaction position when the durable final arrives before its marker', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:compaction-final-before-marker';
  const { controller, emit, receive } = createController(sessionKey);
  controller.state.client = { request: vi.fn(), stop: vi.fn() } as never;
  controller.state.connected = true;
  emit('assistant', { text: 'Before compaction' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  emit('compaction', {
    phase: 'end',
    itemId: 'compact-1',
    completed: true,
    summary: 'Preserved decisions',
  });
  emit('assistant', { text: 'After compaction' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  const root = chat.shadowRoot!;
  const divider = root.querySelector('.chat-divider')!;

  receive('chat', {
    sessionKey,
    runId: 'run-1',
    state: 'final',
    message: { role: 'assistant', content: 'After compaction' },
  });
  receive('session.message', {
    sessionKey,
    runId: 'run-1',
    hasActiveRun: false,
    messageSeq: 1,
    message: {
      role: 'assistant',
      content: 'After compaction',
      __openclaw: { id: 'final', runId: 'run-1', seq: 1 },
    },
  });
  await chat.updateComplete;

  expect(controller.state.transcript.activeTurn).not.toBeNull();
  expect(root.querySelectorAll('.chat-divider')).toHaveLength(1);
  expect(root.querySelector('.chat-divider')).toBe(divider);
  const text = root.querySelector('.chat-container')!.textContent!;
  expect(text.indexOf('Before compaction')).toBeLessThan(text.indexOf('Preserved decisions'));
  expect(text.indexOf('Preserved decisions')).toBeLessThan(text.indexOf('After compaction'));
});

test('retains two compactions in their original positions and ignores duplicate lifecycle events', async () => {
  const { controller, emit } = createController('agent:main:compaction-multiple');
  emit('assistant', { text: 'First segment' });
  emit('compaction', { phase: 'start', itemId: 'first' });
  emit('compaction', { phase: 'end', itemId: 'first', completed: true, summary: 'First summary' });
  emit('assistant', { text: 'Middle segment' });
  emit('compaction', { phase: 'start', itemId: 'second' });
  emit('compaction', { phase: 'end', itemId: 'first', completed: true });
  emit('compaction', { phase: 'start', itemId: 'first' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;

  const root = chat.shadowRoot!;
  const dividers = root.querySelectorAll('.chat-divider');
  expect(dividers).toHaveLength(2);
  const text = root.querySelector('.chat-container')!.textContent!;
  expect(text.indexOf('First segment')).toBeLessThan(text.indexOf('First summary'));
  expect(text.indexOf('First summary')).toBeLessThan(text.indexOf('Middle segment'));
  expect(text.indexOf('Middle segment')).toBeLessThan(
    text.indexOf(i18nService.t('coworkCompactionInProgress')),
  );
  expect(controller.state.compactionInFlight).toBe(true);
  emit('compaction', {
    phase: 'end',
    itemId: 'second',
    completed: true,
    summary: 'Second summary',
  });
  await chat.updateComplete;
  expect(root.querySelectorAll('.chat-divider')).toHaveLength(2);
  expect(root.querySelectorAll('.chat-divider')[0]).toBe(dividers[0]);
  expect(root.querySelectorAll('.chat-divider')[1]).toBe(dividers[1]);
  expect(dividers[0].textContent).toContain('First summary');
  expect(dividers[1].textContent).toContain('Second summary');
});

test.each(['session', 'generation', 'client'] as const)(
  'discards compaction details after the %s changes',
  async change => {
    vi.useFakeTimers();
    let resolveDetails!: (result: unknown) => void;
    const getCompactionDetails = vi.fn(
      () =>
        new Promise(resolve => {
          resolveDetails = resolve;
        }),
    );
    vi.stubGlobal('electron', { openclaw: { history: { getCompactionDetails } } });
    const sessionKey = 'agent:main:compaction-stale-details';
    const { controller, emit, receive } = createController(sessionKey);
    controller.state.client = {
      request: vi.fn().mockResolvedValue({ messages: [] }),
      stop: vi.fn(),
    } as never;
    controller.state.connected = true;
    emit('assistant', { text: 'Still executing' });
    emit('compaction', { phase: 'start', itemId: 'compact-1' });
    emit('compaction', { phase: 'end', itemId: 'compact-1', completed: true });
    receive('session.message', {
      sessionKey,
      runId: 'run-1',
      hasActiveRun: true,
      messageSeq: 1,
      message: {
        role: 'system',
        __openclaw: {
          kind: 'compaction',
          id: 'native-entry',
          itemId: 'compact-1',
          runId: 'run-1',
          seq: 1,
        },
      },
    });
    expect(getCompactionDetails).toHaveBeenCalledTimes(1);
    const item = controller.state.transcript.activeTurn!.items.find(
      item => item.type === 'compaction',
    )!;
    if (item.type !== 'compaction') throw new Error('Missing live compaction');
    const messageBefore = item.message;
    if (change === 'session') await controller.switchSession('agent:main:another-session');
    else if (change === 'generation') controller.state.transcript.historyGeneration += 1;
    else controller.state.client = { request: vi.fn(), stop: vi.fn() } as never;
    resolveDetails({
      success: true,
      details: { 'native-entry': { summary: 'Late stale summary' } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(item.message).toBe(messageBefore);
  },
);

test.each(['zh', 'en'] as const)(
  'shows failure, cancellation and skip reasons without hovering in %s',
  async language => {
    i18nService.setLanguage(language, { persist: false });
    const phases = [
      ['failed', 'coworkCompactFailure'],
      ['aborted', 'coworkCompactAborted'],
      ['skipped', 'coworkCompactSkipped'],
    ] as const;
    const reason = 'Native failure <script>unsafe()</script>\nNext useful step';
    const chat = await renderMessages(
      phases.map(([phase], index) => ({
        role: 'system',
        timestamp: index + 1,
        __openclaw: {
          kind: 'compaction-status',
          id: phase,
          phase,
          reason,
          summary: 'Incomplete output must stay hidden',
          tokensBefore: 12_000,
          tokensAfter: 4_000,
        },
      })),
    );

    const dividers = chat.shadowRoot!.querySelectorAll('.chat-divider');
    expect(dividers).toHaveLength(3);
    for (const [index, [, labelKey]] of phases.entries()) {
      expect(dividers[index].querySelector('.chat-divider__summary')?.textContent).toBe(
        i18nService.t(labelKey),
      );
      expect(dividers[index].querySelector('.chat-divider__description')?.textContent).toBe(reason);
      expect(dividers[index].textContent).not.toContain('Incomplete output');
      expect(dividers[index].querySelector('details')).toBeNull();
      expect(dividers[index].querySelector('script')).toBeNull();
    }
  },
);

test('keeps blank terminal reasons out of the visible layout', async () => {
  const chat = await renderMessages([
    {
      role: 'system',
      timestamp: 1,
      __openclaw: { kind: 'compaction-status', id: 'aborted', phase: 'aborted', reason: ' \n ' },
    },
  ]);
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
  expect(chat.shadowRoot!.querySelector('.chat-divider__description')).toBeNull();
});

test('shows successful token counts and expands long summaries as safe plain text', async () => {
  const summary = `保留当前任务\n${'长摘要内容 '.repeat(1_000)}\n<script>alert(1)</script> & <img src=x>`;
  const chat = await renderMessages([
    {
      role: 'system',
      timestamp: 1,
      __openclaw: {
        kind: 'compaction',
        id: 'committed-compaction',
        tokensBefore: 12_000,
        tokensAfter: 4_000,
        summary,
      },
    },
  ]);

  const details = chat.shadowRoot!.querySelector<HTMLDetailsElement>('.chat-divider__details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent?.trim()).toBe('12,000 → 4,000 tokens');
  details.querySelector('summary')!.click();
  expect(details.open).toBe(true);
  expect(details.querySelector('.chat-divider__content')?.textContent).toBe(summary);
  expect(details.querySelector('script, img')).toBeNull();
});

test('updates the active compaction clock and stops it after the terminal event', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1_000);
  const { controller, emit } = createController('agent:main:justdo:compaction-clock');
  emit('lifecycle', { phase: 'start' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toContain('0s');

  await vi.advanceTimersByTimeAsync(2_000);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toContain('2s');
  emit('compaction', { phase: 'end', itemId: 'compact-1', completed: false, outcome: 'aborted' });
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
});

test('renders a background compaction outcome only in its owning session', async () => {
  const sessionKey = 'agent:main:justdo:compacting-session';
  const { controller, emit } = createController(sessionKey);
  emit('lifecycle', { phase: 'start' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).not.toBeNull();

  await controller.switchSession('agent:main:justdo:other-session');
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).toBeNull();
  emit('compaction', {
    phase: 'end',
    itemId: 'compact-1',
    completed: false,
    outcome: 'failed',
    reason: 'Background provider failed',
  });
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).toBeNull();

  await controller.switchSession(sessionKey);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactFailure'),
  );
  expect(chat.shadowRoot!.querySelector('.chat-divider__description')?.textContent).toBe(
    'Background provider failed',
  );
});
