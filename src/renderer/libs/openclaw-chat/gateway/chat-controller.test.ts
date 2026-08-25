import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectTurnItems } from '@/libs/openclaw-chat/model/project-turn-items';
import { projectWaitingStatus } from '@/libs/openclaw-chat/model/run-activity';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('shows a stalled-run status at 20 seconds and clears it on model activity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-1' });
    if (method === 'sessions.describe') {
      return Promise.resolve({ session: { hasActiveRun: true } });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.state.sessionKey = sessionKey;

  await controller.sendMessage('slow request');
  await vi.advanceTimersByTimeAsync(19_999);
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toBeNull();

  await vi.advanceTimersByTimeAsync(1);
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'waiting-model' });
  expect(request).toHaveBeenCalledWith('sessions.describe', { key: sessionKey });

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: 'response resumed' },
    },
  });

  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toBeNull();
});

test('keeps the confirmed run model in the footer timing after final clears activity', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  await controller.sendMessage('use the newly selected model');

  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: {
        phase: 'progress',
        stage: 'waiting_model',
        provider: 'current-provider',
        model: 'current-model',
      },
    },
  });

  expect(controller.getCurrentTurnTiming()?.modelRef).toBe('current-provider/current-model');

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'done without model metadata' },
    },
  });

  expect(controller.state.runActivity).toBeNull();
  expect(controller.getCurrentTurnTiming()?.modelRef).toBe('current-provider/current-model');
});

test('can display user feedback while sending a combined goal command to the Gateway', async () => {
  const request = vi.fn((method: string) =>
    Promise.resolve(
      method === 'sessions.create'
        ? { sessionId: 'gateway-session-1' }
        : { runId: 'run-1', status: 'started' },
    ),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'gateway-session-1';

  await controller.sendMessage(
    'Please improve chapter two.',
    [],
    buildGoalFollowUpPrompt('Write the novel', 'Please improve chapter two.'),
  );

  expect(controller.state.chatMessages[controller.state.chatMessages.length - 1]).toMatchObject({
    role: 'user',
    content: 'Please improve chapter two.',
  });
  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      message: buildGoalFollowUpPrompt('Write the novel', 'Please improve chapter two.'),
    }),
  );
});

test('never renders an internal goal follow-up prompt when no display override is supplied', async () => {
  const request = vi.fn((method: string) =>
    Promise.resolve(
      method === 'sessions.create'
        ? { sessionId: 'gateway-session-1' }
        : { runId: 'run-1', status: 'started' },
    ),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'gateway-session-1';
  const gatewayPrompt = buildGoalFollowUpPrompt('Write five poems', '再来一首');

  await controller.sendMessage(gatewayPrompt);

  expect(controller.state.chatMessages[controller.state.chatMessages.length - 1]).toMatchObject({
    role: 'user',
    content: '再来一首',
  });
  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({ message: gatewayPrompt }),
  );
});

test('rejects a second message while a run is active instead of silently dropping it', async () => {
  const controller = new ChatController();
  controller.state.client = { request: vi.fn() } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;

  await expect(controller.sendMessage('replacement feedback')).rejects.toThrow(
    'already being sent',
  );
});

test('clears the notice when a delayed model event is received', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_250_000);
  const controller = new ChatController();
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.setPendingUserMessage('wait for delayed delivery');
  await vi.advanceTimersByTimeAsync(20_000);

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: controller.state.sessionKey,
      runId: 'run-1',
      seq: 1,
      ts: 1,
      stream: 'thinking',
      data: { text: 'newly received activity' },
    },
  });

  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toBeNull();
});

test('suppresses model-stall notices until every running tool has settled', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_400_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.transportStatus = 'connected';
  controller.setPendingUserMessage('run two tools');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const toolEvent = (seq: number, phase: 'start' | 'result', toolCallId: string) => ({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq,
      stream: 'tool',
      data: { phase, toolCallId, name: 'read', ...(phase === 'result' ? { result: 'ok' } : {}) },
    },
  });

  handleEvent(toolEvent(1, 'start', 'tool-1'));
  handleEvent(toolEvent(2, 'start', 'tool-2'));
  expect(controller.state.runActivity?.stage).toBe('running-tool');
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'thinking',
      data: { text: 'interleaved thinking' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'assistant',
      data: { text: 'interleaved assistant content' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 5,
      stream: 'lifecycle',
      data: { phase: 'progress', stage: 'retrying', reason: 'rate_limit' },
    },
  });
  expect(controller.state.runActivity).toMatchObject({
    stage: 'retrying',
    hasRunningTool: true,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toBeNull();

  handleEvent(toolEvent(6, 'result', 'tool-1'));
  expect(controller.state.runActivity?.stage).toBe('running-tool');
  handleEvent(toolEvent(7, 'result', 'tool-2'));
  expect(controller.state.runActivity?.stage).toBe('waiting-model');

  await vi.advanceTimersByTimeAsync(19_999);
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'waiting-model' });
});

test('shows model waiting before the Gateway assigns a run id', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_500_000);
  const controller = new ChatController();
  controller.state.transportStatus = 'connected';

  controller.setPendingUserMessage('prepare an externally started run');
  await vi.advanceTimersByTimeAsync(20_000);

  expect(controller.state.runActivity).toMatchObject({
    runId: expect.stringMatching(/^justdo-pending-/),
    stage: 'starting',
  });
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'waiting-model' });
});

test('preserves preparation timing when the initial Gateway connection starts', async () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    addEventListener = vi.fn();
    close = vi.fn();
  }
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const controller = new ChatController();
  controller.setPendingUserMessage('first-session preparation');

  await controller.connect('ws://gateway.test', 'token', 'agent:main:justdo:temp-session-1');

  expect(controller.state.runActivity).toMatchObject({
    runId: expect.stringMatching(/^justdo-pending-/),
    stage: 'starting',
  });
  controller.disconnect();
});

test('reports reconnecting when transport drops during pre-run preparation', () => {
  const controller = new ChatController();
  controller.state.client = {} as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.setPendingUserMessage('prepare an externally started run');

  (
    controller as unknown as {
      handleClose(): void;
    }
  ).handleClose();

  expect(controller.state.transportStatus).toBe('reconnecting');
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'reconnecting', tone: 'warning' });
});

test('only claims the run is active after a fresh sessions.describe confirmation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-1' });
    if (method === 'sessions.describe') {
      return Promise.resolve({ session: { hasActiveRun: true } });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('very slow request');
  await vi.advanceTimersByTimeAsync(60_000);

  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'slow-active' });

  if (controller.state.runActivity) {
    controller.state.runActivity.activeRunConfirmedAt = null;
    controller.state.runActivity.probeState = 'idle';
  }
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'waiting-model' });
});

test('does not treat a persisted running status as active-run confirmation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(3_000_000);
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-1' });
    if (method === 'sessions.describe') {
      return Promise.resolve({ session: { status: 'running' } });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('stale persisted state');
  await vi.advanceTimersByTimeAsync(60_000);

  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: controller.state.transportStatus,
    }),
  ).toMatchObject({ kind: 'waiting-model' });
});

test('does not let an old probe release the current run probe lock', async () => {
  let resolveFirst: ((value: unknown) => void) | undefined;
  let resolveSecond: ((value: unknown) => void) | undefined;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSecond = resolve;
        }),
    );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.setPendingUserMessage('first run');
  const probe = (
    controller as unknown as {
      probeActiveRun(): Promise<void>;
    }
  ).probeActiveRun.bind(controller);

  const firstProbe = probe();
  controller.clearSending();
  controller.setPendingUserMessage('second run');
  const secondProbe = probe();
  resolveFirst?.({ session: { hasActiveRun: true } });
  await firstProbe;

  await probe();
  expect(request).toHaveBeenCalledTimes(2);

  resolveSecond?.({ session: { hasActiveRun: true } });
  await secondProbe;
});

test('discards a delayed probe result after model activity and keeps the exact next threshold', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(4_000_000);
  let resolveDescribe: ((value: unknown) => void) | undefined;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-1' });
    if (method === 'sessions.describe') {
      return new Promise(resolve => {
        resolveDescribe = resolve;
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.sendMessage('slow describe');

  await vi.advanceTimersByTimeAsync(20_000);
  await vi.advanceTimersByTimeAsync(5_000);
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: controller.state.sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'thinking',
      data: { text: 'activity while describe is pending' },
    },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  resolveDescribe?.({ session: { hasActiveRun: true } });
  await Promise.resolve();
  await Promise.resolve();

  expect(controller.state.runActivity).toMatchObject({
    probeState: 'idle',
    activeRunConfirmedAt: null,
  });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(2);
});

test('renders a SQLite fallback immediately and lets Gateway history replace it', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;

  expect(
    controller.admitFallbackHistory(sessionKey, [
      { id: 'message-1', role: 'user', content: 'cached prompt', timestamp: 1000 },
      { id: 'message-2', role: 'assistant', content: 'cached answer', timestamp: 2000 },
    ]),
  ).toBe(true);
  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.transcript.historySource).toBe('sqlite-fallback');

  const request = vi.fn().mockResolvedValue({
    messages: [
      { id: 'message-1', role: 'user', content: 'cached prompt', timestamp: 1000 },
      { id: 'message-2', role: 'assistant', content: 'authoritative answer', timestamp: 2000 },
    ],
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ id: 'message-1', content: 'cached prompt' }),
    expect.objectContaining({ id: 'message-2', content: 'authoritative answer' }),
  ]);
  expect(controller.state.transcript.historySource).toBe('gateway');
  expect(
    controller.admitFallbackHistory(sessionKey, [
      { id: 'message-2', role: 'assistant', content: 'late stale cache' },
    ]),
  ).toBe(false);
  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.chatMessages[1]).toEqual(
    expect.objectContaining({ id: 'message-2', content: 'authoritative answer' }),
  );
});

test('replaces truncated OpenClaw history previews with complete messages', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockImplementation((method: string, params: unknown) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: 'preview one\n...(truncated)...',
            __openclaw: { id: 'assistant-1', seq: 1 },
          },
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'preview two\n...(truncated)...' }],
            __openclaw: { id: 'assistant-2', seq: 2 },
          },
        ],
      });
    }
    if (method === 'chat.message.get') {
      const messageId = (params as { messageId: string }).messageId;
      if (messageId === 'assistant-1') {
        return Promise.resolve({
          ok: true,
          message: {
            role: 'assistant',
            content: 'complete first response',
            __openclaw: { id: messageId, seq: 1 },
          },
        });
      }
      return Promise.resolve({
        ok: true,
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'complete second response' }],
        },
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: 'complete first response' }),
    expect.objectContaining({
      content: [expect.objectContaining({ thinking: 'complete second response' })],
      __openclaw: { id: 'assistant-2', seq: 2 },
    }),
  ]);
  expect(request).toHaveBeenCalledWith('chat.message.get', {
    sessionKey,
    messageId: 'assistant-1',
    maxChars: 1_000_000,
  });
  expect(request).toHaveBeenCalledWith('chat.message.get', {
    sessionKey,
    messageId: 'assistant-2',
    maxChars: 1_000_000,
  });
});

test('keeps a truncated history preview when the complete message is unavailable', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: 'available preview\n...(truncated)...',
            __openclaw: { id: 'assistant-1' },
          },
        ],
      });
    }
    if (method === 'chat.message.get') {
      return Promise.resolve({ ok: false, unavailableReason: 'not_found' });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: 'available preview\n...(truncated)...' }),
  ]);
});

test('keeps the SQLite fallback when Gateway history fails', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.admitFallbackHistory(sessionKey, [
    { id: 'message-1', role: 'assistant', content: 'offline cached answer' },
  ]);
  controller.state.client = {
    request: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
  } as never;
  controller.state.connected = true;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(controller.loadHistory()).resolves.toBe(false);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ id: 'message-1', content: 'offline cached answer' }),
  ]);
  expect(controller.state.transcript.historySource).toBe('sqlite-fallback');
  error.mockRestore();
});

test('hides persisted partial NO_REPLY artifacts without hiding legitimate NO text', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;

  controller.admitFallbackHistory(sessionKey, [
    { id: 'message-1', role: 'assistant', content: 'cached answer' },
    { id: 'message-2', role: 'assistant', content: 'NO_RE' },
    { id: 'message-3', role: 'assistant', content: 'NO_REPLY' },
    { id: 'message-4', role: 'assistant', content: 'NO' },
    { id: 'message-5', role: 'user', content: 'NO_RE' },
  ]);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ id: 'message-1', content: 'cached answer' }),
    expect.objectContaining({ id: 'message-4', content: 'NO' }),
    expect.objectContaining({ id: 'message-5', content: 'NO_RE' }),
  ]);
});

test('does not let a limited RPC snapshot truncate a complete SQLite fallback', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const messages = Array.from({ length: 100_000 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `cached ${index}`,
  }));
  const rpcTail = messages.slice(-1000).map(message => ({
    ...message,
    content: `${message.content} authoritative`,
  }));
  vi.stubGlobal('electron', {
    openclaw: {
      history: {
        getPagedHistory: vi.fn().mockResolvedValue({
          success: false,
          error: 'temporary IPC failure',
        }),
      },
    },
  });
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.admitFallbackHistory(sessionKey, messages);
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: rpcTail }),
  } as never;
  controller.state.connected = true;

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.getLoadedMessages()).toHaveLength(100_000);
  expect(controller.getLoadedMessages()[0]).toEqual(
    expect.objectContaining({ id: 'message-0', content: 'cached 0' }),
  );
  expect(controller.getLoadedMessages()[99_999]).toEqual(
    expect.objectContaining({
      id: 'message-99999',
      content: 'cached 99999 authoritative',
    }),
  );
});

test('keeps a complete fallback when a limited RPC snapshot has no safe overlap', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.admitFallbackHistory(sessionKey, [
    { id: 'cached-1', role: 'user', content: 'cached prompt' },
    { id: 'cached-2', role: 'assistant', content: 'cached answer' },
  ]);
  controller.state.client = {
    request: vi.fn().mockResolvedValue({
      messages: [{ id: 'rpc-1', role: 'assistant', content: 'unrelated limited snapshot' }],
    }),
  } as never;
  controller.state.connected = true;

  await expect(controller.loadHistory()).resolves.toBe(false);

  expect(controller.getLoadedMessages()).toEqual([
    expect.objectContaining({ id: 'cached-1' }),
    expect.objectContaining({ id: 'cached-2' }),
  ]);
  expect(controller.state.transcript.historySource).toBe('sqlite-fallback');
});

test('never lets a SQLite fallback retire an active live turn', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.admitFallbackHistory(sessionKey, [
    { id: 'message-1', role: 'user', content: 'cached prompt' },
  ]);
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1, createId: prefix => `${prefix}-1` },
  );

  expect(
    controller.admitFallbackHistory(sessionKey, [
      { id: 'message-1', role: 'user', content: 'stale cached prompt' },
    ]),
  ).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: 'cached prompt' }),
  ]);
  expect(controller.state.transcript.activeTurn).toBe(turn);
  expect(controller.state.transcript.activeTurn?.status).toBe('running');
});

test('keeps fallback snapshots isolated by session and does not truncate 100,000 messages', async () => {
  const firstSessionKey = 'agent:main:justdo:session-1';
  const secondSessionKey = 'agent:main:justdo:session-2';
  const controller = new ChatController();
  controller.state.sessionKey = firstSessionKey;
  const messages = Array.from({ length: 100_000 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
  }));

  controller.admitFallbackHistory(firstSessionKey, messages);
  controller.admitFallbackHistory(secondSessionKey, [
    { id: 'other-message', role: 'assistant', content: 'other session' },
  ]);

  expect(controller.getLoadedMessages()).toHaveLength(100_000);
  expect(controller.state.visibleChatMessages).toHaveLength(750);
  await controller.switchSession(secondSessionKey);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ id: 'other-message', content: 'other session' }),
  ]);
  await controller.switchSession(firstSessionKey);
  expect(controller.getLoadedMessages()).toHaveLength(100_000);
  expect(controller.getLoadedMessages()[0]).toEqual(expect.objectContaining({ id: 'message-0' }));
});

test('clears active sending state when switching between existing sessions', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:running-session';
  controller.state.currentSessionId = 'backing-session-1';
  controller.setPendingUserMessage('keep working');

  await controller.switchSession('agent:main:justdo:other-session');

  expect(controller.state.sessionKey).toBe('agent:main:justdo:other-session');
  expect(controller.state.currentSessionId).toBeNull();
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatLoading).toBe(true);
});

test('keeps run timing across session switches and after completion', async () => {
  const firstSessionKey = 'agent:main:justdo:running-session';
  const secondSessionKey = 'agent:main:justdo:other-session';
  const controller = new ChatController();
  controller.state.sessionKey = firstSessionKey;
  controller.state.transcript.sessionKey = firstSessionKey;
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', startedAt: 1_000 },
    { now: () => 1_000, createId: prefix => `${prefix}-1` },
  );

  await controller.switchSession(secondSessionKey);
  await controller.switchSession(firstSessionKey);

  expect(controller.getCurrentTurnTiming()).toEqual({
    runId: 'run-1',
    status: 'running',
    startedAt: 1_000,
  });

  const resumed = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', startedAt: 5_000 },
    { now: () => 5_000, createId: prefix => `${prefix}-2` },
  );
  expect(controller.getCurrentTurnTiming()?.startedAt).toBe(1_000);

  resumed.status = 'final';
  resumed.endedAt = 8_000;
  await controller.switchSession(secondSessionKey);
  await controller.switchSession(firstSessionKey);

  expect(controller.getCurrentTurnTiming()).toEqual({
    runId: 'run-1',
    status: 'final',
    startedAt: 1_000,
    endedAt: 8_000,
  });

  controller.state.chatMessages = [{ role: 'user', content: 'new turn', timestamp: 9_000 }];
  controller.state.loadedMessageCount = 1;
  controller.state.historyWindowEnd = 1;
  expect(controller.getCurrentTurnTiming()).toBeNull();

  controller.state.chatMessages = [{ role: 'user', content: 'original turn', timestamp: 500 }];
  controller.state.loadedMessageCount = 2;
  controller.state.historyWindowEnd = 1;
  expect(controller.getCurrentTurnTiming()).toBeNull();
});

test('stops cached background timing when an external final arrives', async () => {
  const firstSessionKey = 'agent:main:justdo:running-session';
  const secondSessionKey = 'agent:main:justdo:other-session';
  const controller = new ChatController();
  controller.state.sessionKey = firstSessionKey;
  controller.state.transcript.sessionKey = firstSessionKey;
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', startedAt: 1_000 },
    { now: () => 1_000, createId: prefix => `${prefix}-1` },
  );
  await controller.switchSession(secondSessionKey);
  const now = vi.spyOn(Date, 'now').mockReturnValue(6_000);

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: firstSessionKey,
      runId: 'run-1',
      state: 'final',
    },
  });
  expect(controller.state.sessionKey).toBe(secondSessionKey);
  await controller.switchSession(firstSessionKey);

  expect(controller.getCurrentTurnTiming()).toEqual({
    runId: 'run-1',
    status: 'final',
    startedAt: 1_000,
    endedAt: 6_000,
  });
  now.mockRestore();
});

test('sends the backing session id returned by chat history', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({ messages: [], sessionId: ' backing-session-1 ' });
    }
    if (method === 'sessions.compaction.list') {
      return Promise.resolve({ checkpoints: [] });
    }
    if (method === 'chat.send') {
      return Promise.resolve({ runId: 'run-1', status: 'started' });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();
  await controller.sendMessage('continue with stable session identity');

  expect(controller.state.currentSessionId).toBe('backing-session-1');
  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'backing-session-1',
      message: 'continue with stable session identity',
      justdoUserInitiated: true,
    }),
  );
});

test('creates a backing session before the first goal command', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.create') {
      return Promise.resolve({
        key: 'agent:main:justdo:new-session',
        sessionId: ' new-backing-session ',
      });
    }
    if (method === 'chat.send') {
      return Promise.resolve({ runId: 'run-1', status: 'started' });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:new-session';

  await controller.sendMessage('/goal build a release dashboard');

  expect(controller.state.currentSessionId).toBe('new-backing-session');
  expect(request).toHaveBeenNthCalledWith(1, 'sessions.create', {
    key: 'agent:main:justdo:new-session',
  });
  expect(request).toHaveBeenNthCalledWith(
    2,
    'chat.send',
    expect.objectContaining({
      sessionKey: 'agent:main:justdo:new-session',
      sessionId: 'new-backing-session',
      message: '/goal build a release dashboard',
      justdoUserInitiated: true,
    }),
  );
});

test('does not send a first goal command when backing session creation fails', async () => {
  const request = vi.fn().mockRejectedValue(new Error('session create failed'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:new-session';

  await expect(controller.sendMessage('/goal build a release dashboard')).rejects.toThrow(
    'session create failed',
  );

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:new-session',
  });
  expect(controller.state.lastError).toBe('session create failed');
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.chatSending).toBe(false);
});

test('propagates a Goal edit transport failure when requested by the caller', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.create') {
      return Promise.resolve({ sessionId: 'backing-session-1' });
    }
    if (method === 'chat.send') return Promise.reject(new Error('goal edit rejected'));
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'backing-session-1';

  await expect(
    controller.sendMessage('/goal edit refined objective', [], undefined, {
      propagateRequestFailure: true,
    }),
  ).rejects.toThrow('goal edit rejected');

  expect(controller.state.lastError).toBe('goal edit rejected');
  expect(controller.state.chatSending).toBe(false);
});

test('keeps ordinary chat request failures handled inside the controller', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockRejectedValue(new Error('ordinary send rejected')),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await expect(controller.sendMessage('hello')).resolves.toBeUndefined();
  expect(controller.state.lastError).toBe('ordinary send rejected');
});

test('preserves optimistic prompt when promoting a temp session to a persisted session', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:temp-123';
  controller.setPendingUserMessage('start this task');

  await controller.switchSession('agent:main:justdo:persisted-session', {
    promoteFromSessionKey: 'agent:main:justdo:temp-123',
  });

  expect(controller.state.sessionKey).toBe('agent:main:justdo:persisted-session');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.pendingUserMessage?.content).toBe('start this task');
  expect(controller.state.chatLoading).toBe(true);
});

test('does not promote a temporary session during ordinary navigation', async () => {
  const originalSession = 'agent:main:justdo:session-a';
  const temporarySession = 'agent:main:justdo:temp-b';
  const controller = new ChatController();
  controller.state.sessionKey = originalSession;
  controller.admitFallbackHistory(originalSession, [
    { role: 'assistant', content: 'A-old', timestamp: 1_000 },
  ]);

  await controller.switchSession(temporarySession);
  controller.admitFallbackHistory(temporarySession, [
    { role: 'user', content: 'B-new', timestamp: 2_000 },
  ]);
  controller.setPendingUserMessage('B-new');
  await controller.switchSession(originalSession);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'assistant', content: 'A-old' }),
  ]);
  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatSending).toBe(false);
});

test('promotes the registered temporary session after navigating away from it', async () => {
  const originalSession = 'agent:main:justdo:session-a';
  const temporarySession = 'agent:main:justdo:temp-b';
  const persistedSession = 'agent:main:justdo:session-b';
  const controller = new ChatController();
  controller.state.sessionKey = originalSession;
  controller.admitFallbackHistory(originalSession, [
    { role: 'assistant', content: 'A-old', timestamp: 1_000 },
  ]);

  await controller.switchSession(temporarySession);
  controller.admitFallbackHistory(temporarySession, [
    { role: 'user', content: 'B-new', timestamp: 2_000 },
  ]);
  controller.setPendingUserMessage('B-new');
  await controller.switchSession(originalSession);
  await controller.switchSession(persistedSession, {
    promoteFromSessionKey: temporarySession,
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'user', content: 'B-new' }),
  ]);
  expect(controller.state.pendingUserMessage?.content).toBe('B-new');
  expect(controller.state.chatSending).toBe(true);
});

test('moves the message subscription when switching connected sessions', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup') return Promise.resolve({ messages: [] });
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (
    controller as unknown as { subscribedMessageSessionKey: string | null }
  ).subscribedMessageSessionKey = 'agent:main:justdo:session-1';

  await controller.switchSession('agent:main:justdo:session-2');

  expect(request).toHaveBeenNthCalledWith(1, 'sessions.messages.unsubscribe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(request).toHaveBeenNthCalledWith(2, 'sessions.messages.subscribe', {
    key: 'agent:main:justdo:session-2',
  });
  expect(request).toHaveBeenNthCalledWith(3, 'chat.startup', {
    sessionKey: 'agent:main:justdo:session-2',
    limit: 1000,
  });
});

test('subscribes to session messages before taking the initial history snapshot', async () => {
  let resolveMessageSubscription: (() => void) | undefined;
  const subscriptionGate = new Promise<void>(resolve => {
    resolveMessageSubscription = resolve;
  });
  const historyMessage = { role: 'user', content: 'persisted task' };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.messages.subscribe') return subscriptionGate;
    if (method === 'chat.startup') return Promise.resolve({ messages: [historyMessage] });
    return Promise.resolve({});
  });
  vi.stubGlobal('electron', {
    openclaw: {
      history: {
        getPagedHistory: vi.fn().mockResolvedValue({
          success: true,
          messages: [historyMessage],
          hasMore: false,
        }),
      },
    },
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.sessionKey = 'agent:main:subagent:child-1';

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});
  await Promise.resolve();

  expect(request).toHaveBeenCalledWith('sessions.messages.subscribe', {
    key: 'agent:main:subagent:child-1',
  });
  expect(request).not.toHaveBeenCalledWith('chat.startup', expect.anything());
  expect(controller.state.initialHistoryReady).toBe(false);

  resolveMessageSubscription?.();
  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));

  const methods = request.mock.calls.map(([method]) => method);
  expect(methods.indexOf('sessions.messages.subscribe')).toBeLessThan(
    methods.indexOf('chat.startup'),
  );
  expect(controller.state.chatMessages).toEqual([historyMessage]);
});

test('bounds a stalled initial message subscription and catches up after it resolves', async () => {
  vi.useFakeTimers();
  let resolveMessageSubscription: (() => void) | undefined;
  const subscriptionGate = new Promise<void>(resolve => {
    resolveMessageSubscription = resolve;
  });
  const initialHistory = [{ role: 'user', content: 'persisted task' }];
  const caughtUpHistory = [...initialHistory, { role: 'assistant', content: 'persisted result' }];
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.messages.subscribe') return subscriptionGate;
    if (method === 'chat.startup') return Promise.resolve({ messages: initialHistory });
    if (method === 'chat.history') return Promise.resolve({ messages: caughtUpHistory });
    return Promise.resolve({});
  });
  const controller = new ChatController({
    initialMessageSubscriptionBarrierTimeoutMs: 10,
  });
  controller.state.client = { request } as never;
  controller.state.sessionKey = 'agent:main:subagent:child-1';

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});
  await vi.advanceTimersByTimeAsync(10);
  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));

  expect(controller.state.chatMessages).toEqual(initialHistory);
  resolveMessageSubscription?.();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('chat.history', {
      sessionKey: 'agent:main:subagent:child-1',
      limit: 1000,
    }),
  );
  await vi.waitFor(() => expect(controller.state.chatMessages).toEqual(caughtUpHistory));
});

test('clears a transient initial history error after a successful empty retry', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup') return Promise.reject(new Error('temporary history failure'));
    if (method === 'chat.history') return Promise.resolve({ messages: [] });
    return Promise.resolve({});
  });
  const controller = new ChatController({
    expectInitialHistory: true,
    initialHistoryRetryDelaysMs: [0],
  });
  controller.state.client = { request } as never;
  controller.state.sessionKey = 'agent:main:subagent:child-1';

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.lastError).toBeNull();
  expect(consoleError).toHaveBeenCalledWith(
    '[ChatCtrl] loadHistory FAILED:',
    'temporary history failure',
  );
});

test('retries an unexpectedly empty initial subagent history before revealing the transcript', async () => {
  const historyMessage = { role: 'user', content: 'persisted subagent task' };
  const getPagedHistory = vi
    .fn()
    .mockResolvedValueOnce({ success: true, messages: [], hasMore: false })
    .mockResolvedValueOnce({ success: true, messages: [historyMessage], hasMore: false });
  vi.stubGlobal('electron', { openclaw: { history: { getPagedHistory } } });
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup') return Promise.resolve({ messages: [] });
    if (method === 'chat.history') return Promise.resolve({ messages: [historyMessage] });
    return Promise.resolve({});
  });
  const controller = new ChatController({
    expectInitialHistory: true,
    initialHistoryRetryDelaysMs: [0],
  });
  controller.state.client = { request } as never;
  controller.state.sessionKey = 'agent:main:subagent:child-1';

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(getPagedHistory).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith('chat.startup', {
    sessionKey: 'agent:main:subagent:child-1',
    limit: 1000,
  });
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:subagent:child-1',
    limit: 1000,
  });
  expect(controller.state.chatMessages).toEqual([historyMessage]);
});

test('retries an assistant-only subagent tail until the originating task is present', async () => {
  const assistantTail = { role: 'assistant', content: 'completed result' };
  const completeHistory = [{ role: 'user', content: 'persisted subagent task' }, assistantTail];
  const getPagedHistory = vi
    .fn()
    .mockResolvedValueOnce({ success: true, messages: [assistantTail], hasMore: false })
    .mockResolvedValueOnce({ success: true, messages: completeHistory, hasMore: false });
  vi.stubGlobal('electron', { openclaw: { history: { getPagedHistory } } });
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup') return Promise.resolve({ messages: [assistantTail] });
    if (method === 'chat.history') return Promise.resolve({ messages: completeHistory });
    return Promise.resolve({});
  });
  const controller = new ChatController({
    expectInitialHistory: true,
    initialHistoryRetryDelaysMs: [0],
  });
  controller.state.client = { request } as never;
  controller.state.sessionKey = 'agent:main:subagent:child-1';

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(getPagedHistory).toHaveBeenCalledTimes(2);
  expect(controller.state.chatMessages).toEqual(completeHistory);
});

test('catches up a missing subagent task during an active streamed turn', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:subagent:child-1';
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const persistedInFlightAssistant = {
    role: 'assistant',
    content: 'A persisted snapshot from the active turn.',
  };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({ messages: [taskMessage, persistedInFlightAssistant] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;
  const activeTurn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1000, createId: prefix => `${prefix}-1` },
  );
  activeTurn.items.push({
    id: 'thinking-1',
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1000,
    updatedAt: 1000,
    type: 'thinking',
    status: 'running',
    text: 'Inspecting the stream.',
  });
  activeTurn.items.push({
    id: 'content-1',
    runId: 'run-1',
    firstSeq: 2,
    lastSeq: 2,
    startedAt: 1000,
    updatedAt: 1000,
    type: 'content',
    status: 'streaming',
    sourceMode: 'snapshot',
    text: 'A persisted snapshot from the active turn.',
  });

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey },
  });

  await vi.advanceTimersByTimeAsync(1200);
  await vi.waitFor(() => expect(controller.state.chatMessages).toEqual([taskMessage]));

  expect(request).toHaveBeenCalledWith('chat.history', { sessionKey, limit: 1000 });
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.transcript.activeTurn).toBe(activeTurn);
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'thinking', text: 'Inspecting the stream.' }),
    expect.objectContaining({
      type: 'content',
      text: 'A persisted snapshot from the active turn.',
    }),
  ]);
});

test('replaces an assistant-only persisted tail when the subagent task catches up', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:subagent:child-1';
  const assistantTail = { role: 'assistant', content: 'premature persisted tail' };
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({ messages: [taskMessage, assistantTail] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [assistantTail];
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.persistedMessages = [assistantTail];
  controller.state.chatSending = true;
  const activeTurn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1000, createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey },
  });

  await vi.advanceTimersByTimeAsync(1200);
  await vi.waitFor(() => expect(controller.state.chatMessages).toEqual([taskMessage]));

  expect(controller.state.transcript.activeTurn).toBe(activeTurn);
  expect(controller.state.chatSending).toBe(true);
});

test('preserves completed persistent-session turns while excluding the active assistant tail', async () => {
  const sessionKey = 'agent:main:subagent:child-1';
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInitial task.',
  };
  const initialReply = { role: 'assistant', content: 'Initial task complete.' };
  const followUp = { role: 'user', content: 'Do the follow-up.' };
  const completedReply = { role: 'assistant', content: 'Follow-up complete.' };
  const activePrompt = { role: 'user', content: 'Now do one more thing.' };
  const activeTail = { role: 'assistant', content: 'In-flight assistant snapshot.' };
  const history = [taskMessage, initialReply, followUp, completedReply, activePrompt, activeTail];
  const request = vi
    .fn()
    .mockImplementation((method: string) =>
      method === 'chat.history' ? Promise.resolve({ messages: history }) : Promise.resolve({}),
    );
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [followUp, completedReply, activePrompt];
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.persistedMessages = controller.state.chatMessages;
  controller.state.chatSending = true;
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-2' },
    { now: () => 1000, createId: prefix => `${prefix}-1` },
  );

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.state.chatMessages).toEqual([
    taskMessage,
    initialReply,
    followUp,
    completedReply,
    activePrompt,
  ]);
  expect(controller.state.transcript.activeTurn?.runId).toBe('run-2');
});

test('starts forked subagent display at its task instead of an inherited user turn', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:subagent:child-1';
  const inheritedUser = {
    role: 'user',
    content: 'Parent discussion quoting a marker:\n[Subagent Task]\nThis is not a child envelope.',
  };
  const inheritedAssistant = { role: 'assistant', content: 'parent conversation reply' };
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const persistedInFlightAssistant = { role: 'assistant', content: 'in-flight reply' };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [inheritedUser, inheritedAssistant, taskMessage, persistedInFlightAssistant],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [inheritedUser, inheritedAssistant];
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.persistedMessages = [inheritedUser, inheritedAssistant];
  controller.state.chatSending = true;
  const activeTurn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1000, createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey },
  });

  await vi.advanceTimersByTimeAsync(1200);
  await vi.waitFor(() => expect(controller.state.chatMessages).toEqual([taskMessage]));

  expect(controller.state.transcript.activeTurn).toBe(activeTurn);
  expect(controller.state.historyHasMore).toBe(false);
});

test('prefers an RPC subagent task over a paged assistant-only recent window', async () => {
  const sessionKey = 'agent:main:subagent:child-1';
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const persistedAssistant = { role: 'assistant', content: 'persisted reply' };
  vi.stubGlobal('electron', {
    openclaw: {
      history: {
        getPagedHistory: vi.fn().mockResolvedValue({
          success: true,
          messages: [persistedAssistant],
          hasMore: true,
          nextCursor: 'older-page',
        }),
      },
    },
  });
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({ messages: [taskMessage, persistedAssistant] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.state.chatMessages).toEqual([taskMessage, persistedAssistant]);
  expect(controller.state.historyHasMore).toBe(false);
  expect(controller.state.historyNextCursor).toBeNull();
});

test('admits a live subagent task event immediately and rejects an older in-flight snapshot', async () => {
  let resolveHistory: ((value: { messages: unknown[] }) => void) | undefined;
  const historyGate = new Promise<{ messages: unknown[] }>(resolve => {
    resolveHistory = resolve;
  });
  const sessionKey = 'agent:main:subagent:child-1';
  const staleAssistant = { role: 'assistant', content: 'stale tail' };
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') return historyGate;
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;

  const historyLoad = controller.loadHistory();
  await Promise.resolve();
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey, message: taskMessage },
  });

  expect(controller.state.chatMessages).toEqual([taskMessage]);
  resolveHistory?.({ messages: [staleAssistant] });
  await expect(historyLoad).resolves.toBe(false);
  expect(controller.state.chatMessages).toEqual([taskMessage]);
});

test('catches up subagent task history when its session.message event was dropped', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:subagent:child-1';
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') return Promise.resolve({ messages: [taskMessage] });
    return Promise.resolve({});
  });
  const controller = new ChatController({ expectInitialHistory: true });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'thinking',
      data: { text: 'Inspecting the stream.' },
    },
  });

  await vi.advanceTimersByTimeAsync(1200);
  await vi.waitFor(() => expect(controller.state.chatMessages).toEqual([taskMessage]));
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'thinking', text: 'Inspecting the stream.' }),
  ]);
});

test('hydrates a live sessions_yield card from history without replacing the active turn', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const toolCallId = 'call-yield-batch-2';
  const toolOutput = JSON.stringify({
    status: 'partial',
    pending: 4,
    results: [{ sessionKey: 'agent:main:subagent:child-1', status: 'ok' }],
  });
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: toolCallId,
                name: 'sessions_yield',
                arguments: { message: '等待第二批 subagent。' },
              },
            ],
          },
          {
            role: 'toolResult',
            toolCallId,
            toolName: 'sessions_yield',
            content: [{ type: 'text', text: toolOutput }],
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'tool',
      data: { phase: 'start', toolCallId, name: 'sessions_yield' },
    },
  });
  const liveTool = controller.state.transcript.activeTurn?.toolById.get(toolCallId);
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'tool',
      data: { phase: 'result', toolCallId, name: 'sessions_yield' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toHaveLength(1);
  expect(liveTool).toMatchObject({ toolCallId, status: 'running' });
  expect(liveTool?.input).toBeUndefined();
  expect(liveTool?.output).toBeUndefined();
  await expect(controller.loadHistory()).resolves.toBe(false);

  expect(controller.state.transcript.activeTurn?.toolById.get(toolCallId)).toBe(liveTool);
  expect(liveTool).toMatchObject({
    toolCallId,
    status: 'completed',
    input: { message: '等待第二批 subagent。' },
    output: toolOutput,
  });
  expect(controller.state.chatMessages).toEqual([]);
});

test('restores a missed sessions_yield start from session.message during repeated waits', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        result: '{"status":"partial","pending":2}',
      },
    },
  });

  // The next Agent Tool frame is missed, but the same transcript append is
  // delivered through session.message while the root run remains active.
  streamListener.mockClear();
  vi.setSystemTime(10_100);
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      message: {
        role: 'assistant',
        timestamp: 10_100,
        content: [
          {
            type: 'toolCall',
            id: 'call-yield-2',
            name: 'sessions_yield',
            arguments: { message: '继续等待第二批 subagent。' },
          },
        ],
      },
    },
  });

  const recovered = controller.state.transcript.activeTurn?.toolById.get('call-yield-2');
  expect(recovered).toMatchObject({
    type: 'tool',
    status: 'running',
    name: 'sessions_yield',
    input: { message: '继续等待第二批 subagent。' },
  });
  expect(controller.state.transcript.activeTurn?.items).toHaveLength(2);
  expect(
    projectTurnItems(controller.state.transcript.activeTurn).find(
      item => item.kind === 'live-process' && item.item === recovered,
    ),
  ).toBeDefined();
  expect(streamListener).toHaveBeenCalledWith('terminal');

  // A late canonical start updates the recovered card in place, and recovery
  // must not advance Agent ordering or block later Tool calls in the same run.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-yield-2',
        name: 'sessions_yield',
      },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 5,
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-yield-2',
        name: 'sessions_yield',
        result: '{"status":"partial","pending":1}',
      },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 6,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-yield-3',
        name: 'sessions_yield',
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.toolById.get('call-yield-2')).toBe(recovered);
  expect(recovered).toMatchObject({ status: 'completed' });
  expect([...controller.state.transcript.activeTurn!.toolById.keys()]).toEqual([
    'call-yield-1',
    'call-yield-2',
    'call-yield-3',
  ]);
  expect(controller.state.transcript.activeTurn?.toolById.get('call-yield-3')).toMatchObject({
    status: 'running',
  });
});

test('does not restore an old Tool row into a newer active turn', () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      message: {
        role: 'assistant',
        timestamp: 19_999,
        content: [
          {
            type: 'toolCall',
            id: 'call-old-yield',
            name: 'sessions_yield',
          },
        ],
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.toolById.has('call-old-yield')).toBe(false);
});

test('does not restore untimed, foreign-run, or non-yield Tool rows', () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'session-current';
  controller.state.transcript.sessionId = 'session-current';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      sessionId: 'session-current',
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  const toolMessage = (id: string, name: string, timestamp?: number) => ({
    role: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    content: [{ type: 'toolCall', id, name }],
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-other',
      activeRunIds: ['run-current'],
      message: toolMessage('call-foreign-session', 'sessions_yield', 20_100),
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-other'],
      message: toolMessage('call-foreign-run', 'sessions_yield', 20_100),
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      message: toolMessage('call-untimed', 'sessions_yield'),
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      message: toolMessage('call-generic', 'exec', 20_100),
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      message: {
        ...toolMessage('call-metadata-run', 'sessions_yield', 20_100),
        metadata: { runId: 'run-other' },
      },
    },
  });

  expect([...controller.state.transcript.activeTurn!.toolById.keys()]).toEqual([]);
});

test('catches up a missed sessions_yield after a later session.message reveals a sequence gap', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const baselineMessage = {
    role: 'user',
    content: 'Start the subagents.',
    timestamp: 29_900,
    __openclaw: { id: 'message-10', seq: 10 },
  };
  const missedYieldMessage = {
    role: 'assistant',
    timestamp: 30_100,
    content: [
      {
        type: 'toolCall',
        id: 'call-missed-yield',
        name: 'sessions_yield',
        arguments: { message: '等待后续 subagent。' },
      },
    ],
    __openclaw: { id: 'message-11', seq: 11 },
  };
  const laterMessage = {
    role: 'assistant',
    content: 'A later append arrived.',
    timestamp: 30_200,
    metadata: { runId: 'announce:v1:child-run' },
    __openclaw: { id: 'message-12', seq: 12 },
  };
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [baselineMessage, missedYieldMessage, laterMessage],
        sessionId: 'session-current',
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'session-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'session-current';
  controller.state.chatMessages = [baselineMessage];
  controller.state.transcript.persistedMessages = [baselineMessage];
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      sessionId: 'session-current',
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  // Both the canonical Tool start and its dropIfSlow session.message were
  // missed. The next append exposes the transcript sequence gap.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      messageSeq: 12,
      message: laterMessage,
    },
  });
  expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);

  await vi.advanceTimersByTimeAsync(200);
  await vi.waitFor(() =>
    expect(controller.state.transcript.activeTurn?.toolById.get('call-missed-yield')).toMatchObject(
      {
        status: 'running',
        name: 'sessions_yield',
        input: { message: '等待后续 subagent。' },
      },
    ),
  );
  expect(request).toHaveBeenCalledWith('chat.history', { sessionKey, limit: 1000 });
  expect(controller.state.runActivity).toMatchObject({
    runId: 'run-current',
    stage: 'running-tool',
    hasRunningTool: true,
  });
  expect(
    projectWaitingStatus({
      activity: controller.state.runActivity,
      transportStatus: 'connected',
      now: 50_000,
    }),
  ).toBeNull();

  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      messageSeq: 13,
      message: {
        role: 'assistant',
        content: 'The cursor continues after catch-up.',
        timestamp: 30_300,
        __openclaw: { id: 'message-13', seq: 13 },
      },
    },
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledTimes(1);
});

test('does not catch up history for consecutive, duplicate, or out-of-order message sequences', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(40_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const baselineMessage = {
    role: 'user',
    content: 'Start.',
    timestamp: 39_900,
    __openclaw: { id: 'message-10', seq: 10 },
  };
  const request = vi.fn().mockResolvedValue({
    messages: [baselineMessage],
    sessionId: 'session-current',
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'session-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'session-current';
  controller.state.chatMessages = [baselineMessage];
  controller.state.transcript.persistedMessages = [baselineMessage];
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      sessionId: 'session-current',
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  for (const messageSeq of [11, 12, 12, 11, 13]) {
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        sessionId: 'session-current',
        activeRunIds: ['run-current'],
        messageSeq,
        message: {
          role: 'assistant',
          content: `Message ${messageSeq}`,
          timestamp: 40_000 + messageSeq,
          __openclaw: { id: `message-${messageSeq}`, seq: messageSeq },
        },
      },
    });
  }

  await vi.advanceTimersByTimeAsync(200);
  expect(request).not.toHaveBeenCalled();
});

test('retries an unresolved message sequence gap until history reaches its target', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(50_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const baselineMessage = {
    role: 'user',
    content: 'Start.',
    timestamp: 49_900,
    __openclaw: { id: 'message-10', seq: 10 },
  };
  const missedYieldMessage = {
    role: 'assistant',
    timestamp: 50_100,
    content: [
      {
        type: 'toolCall',
        id: 'call-retried-yield',
        name: 'sessions_yield',
        arguments: { message: '等待重试恢复。' },
      },
    ],
    __openclaw: { id: 'message-11', seq: 11 },
  };
  const laterMessage = {
    role: 'assistant',
    content: 'A later announce exposed the gap.',
    timestamp: 50_200,
    metadata: { runId: 'announce:v1:child-run' },
    __openclaw: { id: 'message-12', seq: 12 },
  };
  let historyRequestCount = 0;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      historyRequestCount += 1;
      return Promise.resolve({
        messages:
          historyRequestCount === 1
            ? [baselineMessage]
            : [baselineMessage, missedYieldMessage, laterMessage],
        sessionId: 'session-current',
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'session-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'session-current';
  controller.state.chatMessages = [baselineMessage];
  controller.state.transcript.persistedMessages = [baselineMessage];
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      sessionId: 'session-current',
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      messageSeq: 12,
      message: laterMessage,
    },
  });

  await vi.advanceTimersByTimeAsync(500);
  await vi.waitFor(() =>
    expect(
      controller.state.transcript.activeTurn?.toolById.get('call-retried-yield'),
    ).toMatchObject({ status: 'running', name: 'sessions_yield' }),
  );
  expect(historyRequestCount).toBe(2);
});

test('runs at most one unsequenced compatibility catch-up per active session identity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const baselineMessage = {
    role: 'user',
    content: 'Start.',
    timestamp: 59_900,
  };
  const request = vi.fn().mockResolvedValue({
    messages: [baselineMessage],
    sessionId: 'session-current',
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'session-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'session-current';
  controller.state.chatMessages = [baselineMessage];
  controller.state.transcript.persistedMessages = [baselineMessage];
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      sessionId: 'session-current',
      runId: 'run-current',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  const sendUnsequencedMessage = (content: string) =>
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        sessionId: 'session-current',
        activeRunIds: ['run-current'],
        message: { role: 'assistant', content, timestamp: 60_100 },
      },
    });

  sendUnsequencedMessage('First unsequenced append.');
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledTimes(1);

  sendUnsequencedMessage('Second unsequenced append.');
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledTimes(1);
});

test('settles a live sessions_yield from an explicit payloadless history failure', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1, createId: prefix => `${prefix}-1` },
  );
  const tool = {
    id: 'tool-1',
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1,
    updatedAt: 1,
    type: 'tool' as const,
    status: 'running' as const,
    toolCallId: 'call-yield-1',
    name: 'sessions_yield',
  };
  turn.items.push(tool);
  turn.toolById.set(tool.toolCallId, tool);

  const changed = (
    controller as unknown as {
      hydrateActiveToolItemsFromHistory(messages: unknown[]): boolean;
    }
  ).hydrateActiveToolItemsFromHistory([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-yield-1',
      toolName: 'sessions_yield',
      isError: true,
      content: [],
    },
  ]);

  expect(changed).toBe(true);
  expect(turn.toolById.get('call-yield-1')).toBe(tool);
  expect(tool.status).toBe('failed');
});

test('hydrates input for a waiting sessions_yield projected from history as a live Tool', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1, createId: prefix => `${prefix}-1` },
  );
  const tool = {
    id: 'tool-1',
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1,
    updatedAt: 1,
    type: 'tool' as const,
    status: 'running' as const,
    toolCallId: 'call-yield-1',
    name: 'sessions_yield',
  };
  turn.items.push(tool);
  turn.toolById.set(tool.toolCallId, tool);

  const changed = (
    controller as unknown as {
      hydrateActiveToolItemsFromHistory(messages: unknown[]): boolean;
    }
  ).hydrateActiveToolItemsFromHistory([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-yield-1',
          name: 'sessions_yield',
          arguments: { message: '等待 subagent 完成。' },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-yield-1',
      toolName: 'sessions_yield',
      content: [],
    },
  ]);

  expect(changed).toBe(true);
  expect(turn.toolById.get('call-yield-1')).toBe(tool);
  expect(tool).toMatchObject({
    status: 'running',
    input: { message: '等待 subagent 完成。' },
  });
});

test('cleans up a stale subscription that resolves after a newer session subscribe', async () => {
  let resolveFirstSubscribe: (() => void) | undefined;
  const request = vi.fn().mockImplementation((method: string, params: { key?: string }) => {
    if (method === 'sessions.messages.subscribe' && params.key?.endsWith('session-1')) {
      return new Promise<void>(resolve => {
        resolveFirstSubscribe = resolve;
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  const sync = (
    controller as unknown as {
      syncMessageSessionSubscription(sessionKey: string): Promise<void>;
    }
  ).syncMessageSessionSubscription.bind(controller);

  const first = sync('agent:main:justdo:session-1');
  await Promise.resolve();
  await sync('agent:main:justdo:session-2');
  resolveFirstSubscribe?.();
  await first;

  expect(request).toHaveBeenCalledWith('sessions.messages.unsubscribe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(
    (controller as unknown as { subscribedMessageSessionKey: string | null })
      .subscribedMessageSessionKey,
  ).toBe('agent:main:justdo:session-2');
});

test('binds the real run id when an agent event arrives before chat.send acknowledges', async () => {
  let resolveSend: ((value: { runId: string }) => void) | undefined;
  const request = vi.fn().mockImplementation(
    () =>
      new Promise<{ runId: string }>(resolve => {
        resolveSend = resolve;
      }),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  const sending = controller.sendMessage('hello');
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      runId: 'gateway-run-1',
      seq: 1,
      stream: 'assistant',
      session: 'agent:main:justdo:session-1',
      data: { text: 'first response chunk' },
    },
  });

  expect(controller.state.chatRunId).toBe('gateway-run-1');
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'content', text: 'first response chunk' }),
  ]);

  resolveSend?.({ runId: 'gateway-run-1' });
  await sending;
  expect(controller.state.chatRunId).toBe('gateway-run-1');
});

test('keeps a real run active when chat.send rejects after streaming has started', async () => {
  let rejectSend: ((error: Error) => void) | undefined;
  const request = vi.fn().mockImplementation(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  const sending = controller.sendMessage('hello');
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      runId: 'gateway-run-1',
      seq: 1,
      stream: 'assistant',
      session: 'agent:main:justdo:session-1',
      data: { text: 'still running' },
    },
  });
  rejectSend?.(new Error('request timeout: chat.send'));
  await sending;

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('gateway-run-1');
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'content', text: 'still running' }),
  ]);
  expect(controller.state.lastError).toBeNull();
});

test('keeps optimistic messages in the per-session cache', async () => {
  const request = vi.fn().mockResolvedValue({ runId: 'run-1' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('cached prompt');
  controller.state.connected = false;
  await controller.switchSession('agent:main:justdo:session-2');
  await controller.switchSession('agent:main:justdo:session-1');

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'user', content: 'cached prompt' }),
  ]);
});

test('settles the originating session when chat.send completes after switching away', async () => {
  const runningSessionKey = 'agent:main:justdo:session-1';
  const otherSessionKey = 'agent:main:justdo:session-2';
  let resolveSend: ((value: { runId: string; status: string }) => void) | undefined;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') {
      return new Promise<{ runId: string; status: string }>(resolve => {
        resolveSend = resolve;
      });
    }
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({ messages: [] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = runningSessionKey;

  const sending = controller.sendMessage('hello', [], undefined, {
    clientTurnId: 'justdo-client-turn-1',
  });
  await controller.switchSession(otherSessionKey);
  resolveSend?.({ runId: 'gateway-run-1', status: 'ok' });
  await sending;
  await controller.switchSession(runningSessionKey);

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.runActivity).toBeNull();
  expect(controller.state.transcript.activeTurn?.status).toBe('final');
});

test('records the originating session error when chat.send rejects after switching away', async () => {
  const runningSessionKey = 'agent:main:justdo:session-1';
  const otherSessionKey = 'agent:main:justdo:session-2';
  let rejectSend: ((error: Error) => void) | undefined;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.send') {
      return new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      });
    }
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({ messages: [] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = runningSessionKey;

  const sending = controller.sendMessage('hello', [], undefined, {
    clientTurnId: 'justdo-client-turn-1',
  });
  await controller.switchSession(otherSessionKey);
  rejectSend?.(new Error('chat.send failed'));
  await sending;
  await controller.switchSession(runningSessionKey);

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.lastError).toBe('chat.send failed');
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'user', content: 'hello' }),
    expect.objectContaining({ role: 'assistant', content: 'Error: chat.send failed' }),
  ]);
});

test('restores a pending first turn and its background stream after switching away', async () => {
  const runningSessionKey = 'agent:main:justdo:running-session';
  const otherSessionKey = 'agent:main:justdo:other-session';
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({ messages: [] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = runningSessionKey;
  controller.setPendingUserMessage('start the long task');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: runningSessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: 'before switching' },
    },
  });
  await controller.switchSession(otherSessionKey);
  handleEvent({
    event: 'agent',
    payload: {
      session: runningSessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'assistant',
      data: { text: 'continued while hidden' },
    },
  });
  await controller.switchSession(runningSessionKey);

  expect(controller.state.pendingUserMessage).toMatchObject({
    role: 'user',
    content: 'start the long task',
  });
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'content', text: 'continued while hidden' }),
  ]);

  await controller.switchSession(otherSessionKey);
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: runningSessionKey,
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'completed while hidden' },
    },
  });
  await controller.switchSession(runningSessionKey);

  expect(controller.state.pendingUserMessage).toMatchObject({
    role: 'user',
    content: 'start the long task',
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'assistant', content: 'completed while hidden' }),
  ]);
  expect(controller.state.chatSending).toBe(false);
});

test('keeps a follow-up turn visible when return history still lacks the active turn', async () => {
  const runningSessionKey = 'agent:main:justdo:running-session';
  const otherSessionKey = 'agent:main:justdo:other-session';
  const persistedMessages = [
    { id: 'user-1', role: 'user', content: 'earlier prompt', timestamp: 1_000 },
    { id: 'assistant-1', role: 'assistant', content: 'earlier answer', timestamp: 2_000 },
  ];
  const request = vi.fn().mockImplementation((method: string, params?: { sessionKey?: string }) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-2' });
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({
        messages: params?.sessionKey === runningSessionKey ? persistedMessages : [],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = runningSessionKey;
  controller.admitFallbackHistory(runningSessionKey, persistedMessages);
  await controller.loadHistory();
  await controller.sendMessage('follow-up prompt');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  handleEvent({
    event: 'agent',
    payload: {
      session: runningSessionKey,
      runId: 'run-2',
      seq: 1,
      stream: 'assistant',
      data: { text: 'partial follow-up' },
    },
  });

  await controller.switchSession(otherSessionKey);
  handleEvent({
    event: 'agent',
    payload: {
      session: runningSessionKey,
      runId: 'run-2',
      seq: 2,
      stream: 'assistant',
      data: { text: 'newer partial follow-up' },
    },
  });
  await controller.switchSession(runningSessionKey);

  expect(controller.state.chatMessages).toEqual([
    ...persistedMessages,
    expect.objectContaining({ role: 'user', content: 'follow-up prompt' }),
  ]);
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'content', text: 'newer partial follow-up' }),
  ]);
});

test('compacts the current session instead of sending /compact as chat', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      compacted: true,
      result: { tokensBefore: 25_329, tokensAfter: 1_069 },
    })
    .mockResolvedValueOnce({
      messages: [
        {
          role: 'system',
          timestamp: 2000,
          __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
        },
      ],
    })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'The compacted conversation summary.',
          tokensBefore: 25_329,
          tokensAfter: 1_069,
          createdAt: 2000,
          postCompaction: { entryId: 'compaction-entry-1', leafId: 'compaction-entry-1' },
        },
      ],
    });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/compact');

  expect(request).toHaveBeenNthCalledWith(1, 'sessions.compact', {
    key: 'agent:main:justdo:session-1',
  });
  expect(request).toHaveBeenNthCalledWith(2, 'chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 1000,
  });
  expect(request).toHaveBeenNthCalledWith(3, 'sessions.compaction.list', {
    key: 'agent:main:justdo:session-1',
  });
  expect(request).not.toHaveBeenCalledWith('chat.send', expect.anything());
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'system',
      __openclaw: {
        kind: 'compaction',
        id: 'compaction-entry-1',
        checkpointId: 'checkpoint-1',
        summary: 'The compacted conversation summary.',
        tokensBefore: 25_329,
        tokensAfter: 1_069,
      },
    }),
  ]);
});

test('settles a manual compaction request after switching away', async () => {
  const originalSession = 'agent:main:justdo:session-1';
  const otherSession = 'agent:main:justdo:session-2';
  let resolveCompact:
    | ((value: {
        compacted: boolean;
        result: { tokensBefore: number; tokensAfter: number };
      }) => void)
    | undefined;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.compact') {
      return new Promise(resolve => {
        resolveCompact = resolve;
      });
    }
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({ messages: [] });
    }
    if (method === 'sessions.compaction.list') {
      return Promise.resolve({ checkpoints: [] });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = originalSession;

  const compacting = controller.sendMessage('/compact');
  await controller.switchSession(otherSession);
  resolveCompact?.({
    compacted: true,
    result: { tokensBefore: 120_000, tokensAfter: 18_000 },
  });
  await compacting;
  await controller.switchSession(originalSession);

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
});

test('hydrates an automatic compaction summary when no checkpoint was persisted', async () => {
  const getCompactionDetails = vi.fn().mockResolvedValue({
    success: true,
    details: {
      'compaction-entry-1': {
        summary: 'Recovered automatic compaction summary.',
        tokensBefore: 25_329,
      },
    },
  });
  vi.stubGlobal('electron', {
    openclaw: {
      history: { getCompactionDetails },
    },
  });
  const request = vi.fn((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'system',
            timestamp: 2000,
            __openclaw: {
              kind: 'compaction',
              id: 'compaction-entry-1',
              summary: '   ',
            },
          },
        ],
      });
    }
    if (method === 'sessions.compaction.list') {
      return Promise.resolve({
        checkpoints: [
          {
            checkpointId: 'checkpoint-1',
            summary: '',
            postCompaction: { entryId: 'compaction-entry-1' },
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  expect(getCompactionDetails).toHaveBeenCalledWith({
    sessionKey: 'agent:main:justdo:session-1',
    entryIds: ['compaction-entry-1'],
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: {
        kind: 'compaction',
        id: 'compaction-entry-1',
        checkpointId: 'checkpoint-1',
        summary: 'Recovered automatic compaction summary.',
        tokensBefore: 25_329,
      },
    }),
  ]);
});

test('keeps base history when local compaction detail hydration rejects', async () => {
  vi.stubGlobal('electron', {
    openclaw: {
      history: {
        getCompactionDetails: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      },
    },
  });
  const request = vi.fn((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'system',
            timestamp: 2000,
            __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
          },
        ],
      });
    }
    if (method === 'sessions.compaction.list') return Promise.resolve({ checkpoints: [] });
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await expect(controller.loadHistory()).resolves.toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
    }),
  ]);
});

test('shows compaction progress immediately and replaces it with the authoritative marker', async () => {
  let resolveCompact:
    | ((value: {
        compacted: boolean;
        result: { tokensBefore: number; tokensAfter: number };
      }) => void)
    | undefined;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.compact') {
      return new Promise(resolve => {
        resolveCompact = resolve;
      });
    }
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'system',
            timestamp: 2000,
            __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
          },
        ],
      });
    }
    if (method === 'sessions.compaction.list') {
      return Promise.resolve({
        checkpoints: [
          {
            checkpointId: 'checkpoint-1',
            summary: 'Compacted summary.',
            tokensBefore: 100,
            tokensAfter: 20,
            postCompaction: { entryId: 'compaction-entry-1' },
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  const compactPromise = controller.sendMessage('/compact');

  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'system',
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'in-progress',
      }),
    }),
  ]);

  resolveCompact?.({
    compacted: true,
    result: { tokensBefore: 100, tokensAfter: 20 },
  });
  await compactPromise;

  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction',
        id: 'compaction-entry-1',
        tokensBefore: 100,
        tokensAfter: 20,
      }),
    }),
  ]);
});

test('sends and optimistically renders image attachments in an existing session', async () => {
  const request = vi.fn().mockResolvedValue({ runId: 'run-1' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('second image', [
    {
      name: 'second.png',
      mimeType: 'image/png',
      base64Data: 'YWJj',
    },
  ]);

  expect(request).toHaveBeenCalledWith('chat.send', {
    sessionKey: 'agent:main:justdo:session-1',
    message: 'second image',
    deliver: false,
    justdoUserInitiated: true,
    idempotencyKey: expect.stringMatching(/^justdo-/),
    attachments: [
      {
        type: 'image',
        mimeType: 'image/png',
        content: 'YWJj',
      },
    ],
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: [
        { type: 'text', text: 'second image' },
        {
          type: 'attachment',
          attachment: {
            url: 'data:image/png;base64,YWJj',
            kind: 'image',
            label: 'second.png',
            mimeType: 'image/png',
          },
        },
      ],
    }),
  ]);
});

test('compacts while intentionally ignoring unsupported /compact arguments', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    compacted: false,
    reason: 'not enough history',
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/compact keep recent decisions');

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.compact', {
    key: 'agent:main:justdo:session-1',
  });
  expect(controller.state.lastError).toBeNull();
});

test.each([
  '/exec gateway full off',
  '/elevated full',
  '/config set tools.exec.mode full',
  '/cron list',
  '/nodes',
])('does not send the app-managed command %s to Gateway', async message => {
  const request = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await expect(controller.sendMessage(message)).rejects.toThrow('managed by the application');

  expect(request).not.toHaveBeenCalled();
  expect(controller.state.chatMessages).toEqual([]);
});

test('renders an error result and does not refresh history when session compaction fails', async () => {
  const request = vi.fn().mockRejectedValue(new Error('compact unavailable'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/compact');

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.compact', {
    key: 'agent:main:justdo:session-1',
  });
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.lastError).toBe('compact unavailable');
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'system',
      content: 'Compaction failed: compact unavailable',
    }),
  ]);
});

test('renders the reason when session compaction is skipped', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    compacted: false,
    reason: 'not enough history',
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/compact');

  expect(request).toHaveBeenCalledOnce();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'system',
      __openclaw: {
        kind: 'compaction-skipped',
        reason: 'not enough history',
      },
    }),
  ]);
});

test('does not append a synthetic marker when post-compact history refresh fails', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ compacted: true, result: { tokensBefore: 100, tokensAfter: 20 } })
    .mockRejectedValueOnce(new Error('history unavailable'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [{ role: 'assistant', content: 'old visible history' }];

  await controller.sendMessage('/compact');

  expect(controller.state.chatMessages).toEqual([
    { role: 'assistant', content: 'old visible history' },
  ]);
  expect(controller.state.lastError).toBe('history unavailable');
  expect(request).toHaveBeenCalledTimes(2);
});

test('applies intentionally shorter authoritative history after compaction', async () => {
  const compactedMarker = {
    role: 'system',
    timestamp: 2000,
    __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ compacted: true, result: { tokensBefore: 100, tokensAfter: 20 } })
    .mockResolvedValueOnce({ messages: [compactedMarker] })
    .mockResolvedValueOnce({ checkpoints: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [
    { role: 'user', content: 'old prompt', timestamp: 1000 },
    { role: 'assistant', content: 'old answer', timestamp: 1100 },
  ];

  await controller.sendMessage('/compact');

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction', id: 'compaction-entry-1' }),
    }),
  ]);
});

test('enriches compaction markers again after history refreshes', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [
        {
          role: 'system',
          timestamp: 2000,
          __openclaw: { kind: 'compaction', id: 'checkpoint-1' },
        },
      ],
    })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'Persisted compact summary.',
          tokensBefore: 25_329,
          tokensAfter: 1_069,
          createdAt: 2000,
        },
      ],
    });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  expect(request).toHaveBeenNthCalledWith(2, 'sessions.compaction.list', {
    key: 'agent:main:justdo:session-1',
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: {
        kind: 'compaction',
        id: 'checkpoint-1',
        checkpointId: 'checkpoint-1',
        summary: 'Persisted compact summary.',
        tokensBefore: 25_329,
        tokensAfter: 1_069,
      },
    }),
  ]);
});

test('does not apply history when the session changes during async normalization', async () => {
  let resolveCheckpoints:
    | ((value: { checkpoints: Array<{ checkpointId: string; summary: string }> }) => void)
    | undefined;
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'system',
            timestamp: 1000,
            __openclaw: { kind: 'compaction', id: 'checkpoint-1' },
          },
        ],
      });
    }
    return new Promise(resolve => {
      resolveCheckpoints = resolve;
    });
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  const load = controller.loadHistory();
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith('sessions.compaction.list', {
      key: 'agent:main:justdo:session-1',
    });
  });
  const nextSessionMessages = [{ role: 'assistant', content: 'session 2 content' }];
  controller.state.sessionKey = 'agent:main:justdo:session-2';
  controller.state.chatMessages = nextSessionMessages;
  controller.state.chatLoading = false;
  resolveCheckpoints?.({
    checkpoints: [{ checkpointId: 'checkpoint-1', summary: 'session 1 summary' }],
  });

  await load;
  expect(controller.state.chatMessages).toBe(nextSessionMessages);
});

test('uses positional fallback only for a legacy checkpoint without transcript position', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [
        {
          role: 'system',
          timestamp: 2000,
          __openclaw: { kind: 'compaction', id: 'history-marker-id' },
        },
      ],
    })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'Persisted compact summary.',
          tokensBefore: 25_329,
          tokensAfter: 1_069,
          createdAt: 2000,
        },
      ],
    });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: {
        kind: 'compaction',
        id: 'history-marker-id',
        checkpointId: 'checkpoint-1',
        summary: 'Persisted compact summary.',
        tokensBefore: 25_329,
        tokensAfter: 1_069,
      },
    }),
  ]);
});

test('pairs multiple history markers with distinct checkpoints from newest to newest', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [
        {
          role: 'system',
          timestamp: 1000,
          __openclaw: { kind: 'compaction', id: 'history-marker-1' },
        },
        {
          role: 'system',
          timestamp: 2000,
          __openclaw: { kind: 'compaction', id: 'history-marker-2' },
        },
        {
          role: 'system',
          timestamp: 3000,
          __openclaw: { kind: 'compaction', id: 'history-marker-3' },
        },
      ],
    })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'First persisted summary.',
          createdAt: 1000,
        },
        {
          checkpointId: 'checkpoint-2',
          summary: 'Second persisted summary.',
          createdAt: 2000,
        },
      ],
    });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  expect(
    controller.state.chatMessages.map(message => (message as Record<string, unknown>).__openclaw),
  ).toEqual([
    { kind: 'compaction', id: 'history-marker-1' },
    {
      kind: 'compaction',
      id: 'history-marker-2',
      checkpointId: 'checkpoint-1',
      summary: 'First persisted summary.',
      tokensBefore: undefined,
      tokensAfter: undefined,
    },
    {
      kind: 'compaction',
      id: 'history-marker-3',
      checkpointId: 'checkpoint-2',
      summary: 'Second persisted summary.',
      tokensBefore: undefined,
      tokensAfter: undefined,
    },
  ]);
});

test('does not shift an older positioned checkpoint onto a newer marker', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      messages: [
        {
          role: 'system',
          timestamp: 1000,
          __openclaw: { kind: 'compaction', id: 'compaction-entry-1' },
        },
        {
          role: 'system',
          timestamp: 2000,
          __openclaw: { kind: 'compaction', id: 'compaction-entry-2' },
        },
      ],
    })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'Summary for the first compaction only.',
          createdAt: 1000,
          postCompaction: { entryId: 'compaction-entry-1' },
        },
      ],
    });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  expect(
    controller.state.chatMessages.map(message => (message as Record<string, unknown>).__openclaw),
  ).toEqual([
    {
      kind: 'compaction',
      id: 'compaction-entry-1',
      checkpointId: 'checkpoint-1',
      summary: 'Summary for the first compaction only.',
      tokensBefore: undefined,
      tokensAfter: undefined,
    },
    { kind: 'compaction', id: 'compaction-entry-2' },
  ]);
});

test('loads the latest history page first and prepends older history on demand', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    messages: [{ role: 'assistant', content: 'rpc fallback' }],
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            { role: 'assistant', content: 'recent 1' },
            { role: 'assistant', content: 'recent 2' },
          ],
          hasMore: true,
          nextCursor: '2',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [{ role: 'user', content: 'older' }],
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (controller as unknown as { gatewayHttpBase: string; gatewayToken: string }).gatewayHttpBase =
    'http://127.0.0.1:4173';

  await controller.loadHistory();

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'http://127.0.0.1:4173/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=250',
    expect.anything(),
  );
  expect(controller.state.historyHasMore).toBe(true);
  expect(
    controller.state.chatMessages.map(message => (message as { content?: unknown }).content),
  ).toEqual(['recent 1', 'recent 2']);

  await controller.loadOlderHistory();

  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'http://127.0.0.1:4173/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=250&cursor=2',
    expect.anything(),
  );
  expect(
    controller.getLoadedMessages().map(message => (message as { content?: unknown }).content),
  ).toEqual(['older', 'recent 1', 'recent 2']);
  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.loadedMessageCount).toBe(3);
  expect(controller.state.historyHasMore).toBe(false);
});

test('hydrates a truncated message while loading an older history page', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockImplementation((method: string, params: unknown) => {
    if (method === 'chat.history') {
      return Promise.resolve({ messages: [{ role: 'assistant', content: 'rpc fallback' }] });
    }
    if (method === 'chat.message.get') {
      expect(params).toEqual({
        sessionKey,
        messageId: 'older-1',
        maxChars: 1_000_000,
      });
      return Promise.resolve({
        ok: true,
        message: { role: 'assistant', content: 'complete older response' },
      });
    }
    return Promise.resolve({});
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: 'recent response',
              __openclaw: { id: 'recent-1' },
            },
          ],
          hasMore: true,
          nextCursor: 'older-page',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            {
              role: 'assistant',
              content: 'older preview\n...(truncated)...',
              __openclaw: { id: 'older-1', seq: 1 },
            },
          ],
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  (controller as unknown as { gatewayHttpBase: string }).gatewayHttpBase = 'http://127.0.0.1:4173';

  await controller.loadHistory();
  await expect(controller.loadOlderHistory()).resolves.toBe(true);

  expect(controller.getLoadedMessages()).toEqual([
    expect.objectContaining({
      content: 'complete older response',
      __openclaw: { id: 'older-1', seq: 1 },
    }),
    expect.objectContaining({ content: 'recent response' }),
  ]);
});

test('skips duplicate older pages until a page adds visible history', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    messages: [{ role: 'assistant', content: 'rpc fallback' }],
  });
  const recent = {
    role: 'assistant',
    content: 'recent',
    __openclaw: { id: 'recent-1' },
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [recent],
          hasMore: true,
          nextCursor: 'duplicate-page',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [recent],
          hasMore: true,
          nextCursor: 'older-page',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            {
              role: 'user',
              content: 'older visible message',
              __openclaw: { id: 'older-1' },
            },
          ],
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (controller as unknown as { gatewayHttpBase: string }).gatewayHttpBase = 'http://127.0.0.1:4173';
  await controller.loadHistory();

  await expect(controller.loadOlderHistory()).resolves.toBe(true);

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(
    controller.getLoadedMessages().map(message => (message as { content?: unknown }).content),
  ).toEqual(['older visible message', 'recent']);
  expect(controller.state.historyHasMore).toBe(false);
  expect(controller.state.historyNextCursor).toBeNull();
});

test('continues duplicate-only history pages in bounded automatic batches', async () => {
  vi.useFakeTimers();
  const recent = {
    role: 'assistant',
    content: 'recent',
    __openclaw: { id: 'recent-1' },
  };
  let olderRequestCount = 0;
  const getPagedHistory = vi.fn().mockImplementation(({ cursor }: { cursor?: string }) => {
    if (!cursor) {
      return Promise.resolve({
        success: true,
        messages: [recent],
        hasMore: true,
        nextCursor: 'duplicate-0',
      });
    }
    olderRequestCount += 1;
    if (olderRequestCount <= 8) {
      return Promise.resolve({
        success: true,
        messages: [recent],
        hasMore: true,
        nextCursor: `duplicate-${olderRequestCount}`,
      });
    }
    return Promise.resolve({
      success: true,
      messages: [
        {
          role: 'user',
          content: 'older visible message',
          __openclaw: { id: 'older-1' },
        },
      ],
      hasMore: false,
    });
  });
  vi.stubGlobal('electron', {
    openclaw: {
      history: { getPagedHistory },
    },
  });
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [recent] }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  await expect(controller.loadOlderHistory()).resolves.toBe(false);

  expect(olderRequestCount).toBe(8);
  expect(controller.state.historyNextCursor).toBe('duplicate-8');
  await vi.runAllTimersAsync();
  expect(
    controller.getLoadedMessages().map(message => (message as { content?: unknown }).content),
  ).toEqual(['older visible message', 'recent']);
  expect(olderRequestCount).toBe(9);
  expect(controller.state.historyHasMore).toBe(false);
});

test('preserves an existing older-page cursor across a transient paging failure', async () => {
  const recent = {
    role: 'assistant',
    content: 'recent',
    __openclaw: { id: 'recent-1' },
  };
  const request = vi.fn().mockResolvedValue({ messages: [recent] });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [recent],
          hasMore: true,
          nextCursor: 'older-page',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockRejectedValueOnce(new Error('temporary paging failure'));
  vi.stubGlobal('fetch', fetchMock);
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (controller as unknown as { gatewayHttpBase: string }).gatewayHttpBase = 'http://127.0.0.1:4173';

  await controller.loadHistory();
  await controller.loadHistory();

  expect(controller.state.historyHasMore).toBe(true);
  expect(controller.state.historyNextCursor).toBe('older-page');
});

test('does not truncate loaded history or hide an older cursor', async () => {
  const request = vi.fn().mockResolvedValueOnce({ messages: [] });
  const messages = Array.from({ length: 2105 }, (_, index) => ({
    role: 'assistant',
    content: `message-${index}`,
    __openclaw: { id: `message-${index}` },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages,
          hasMore: true,
          nextCursor: 'older',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (controller as unknown as { gatewayHttpBase: string }).gatewayHttpBase = 'http://127.0.0.1:4173';

  await controller.loadHistory();

  expect(controller.state.chatMessages).toHaveLength(2105);
  expect((controller.state.chatMessages[0] as { content: string }).content).toBe('message-0');
  expect(controller.state.visibleChatMessages).toHaveLength(750);
  expect(controller.state.historyHasMore).toBe(true);
  expect(controller.state.historyNextCursor).toBe('older');
});

test('deduplicates an RPC fallback snapshot against already loaded older pages', async () => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    __openclaw: { id: `message-${index}` },
  }));
  let pagingAvailable = true;
  const getPagedHistory = vi.fn().mockImplementation(({ cursor }: { cursor?: string }) => {
    if (!pagingAvailable) {
      return Promise.resolve({ success: false, error: 'temporary paging failure' });
    }
    const end = cursor ? Number(cursor) : messages.length;
    const start = Math.max(0, end - 250);
    return Promise.resolve({
      success: true,
      messages: messages.slice(start, end),
      hasMore: start > 0,
      nextCursor: start > 0 ? String(start) : undefined,
    });
  });
  vi.stubGlobal('electron', {
    openclaw: {
      history: { getPagedHistory },
    },
  });
  const request = vi.fn().mockResolvedValue({
    messages: messages.map(message => ({
      ...message,
      content: `${message.content} authoritative`,
    })),
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();
  await controller.loadOlderHistory();
  await controller.loadOlderHistory();
  await controller.loadOlderHistory();
  expect(controller.getLoadedMessages()).toHaveLength(1000);

  pagingAvailable = false;
  await expect(controller.loadHistory()).resolves.toBe(true);

  const loaded = controller.getLoadedMessages() as Array<{
    content: string;
    __openclaw: { id: string };
  }>;
  expect(loaded).toHaveLength(1000);
  expect(new Set(loaded.map(message => message.__openclaw.id)).size).toBe(1000);
  expect(loaded[0]?.content).toBe('message-0 authoritative');
  expect(loaded[999]?.content).toBe('message-999 authoritative');
  expect(controller.state.loadedMessageCount).toBe(1000);
});

test('loads paged REST history for Electron loopback gateway sessions', async () => {
  const getPagedHistory = vi.fn().mockResolvedValue({
    success: false,
    error: 'temporary IPC failure',
  });
  vi.stubGlobal('electron', {
    openclaw: {
      history: { getPagedHistory },
    },
  });
  const request = vi.fn().mockResolvedValueOnce({
    messages: [{ role: 'assistant', content: 'rpc fallback' }],
  });
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        messages: [{ role: 'assistant', content: 'rest history' }],
        hasMore: false,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  (controller as unknown as { gatewayHttpBase: string; gatewayToken: string }).gatewayHttpBase =
    'http://127.0.0.1:42871';

  await controller.loadHistory();

  expect(getPagedHistory).toHaveBeenCalledWith({
    sessionKey: 'agent:main:justdo:session-1',
    cursor: undefined,
    limit: 250,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:42871/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=250',
    expect.anything(),
  );
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'assistant', content: 'rest history' }),
  ]);
});

test('preserves the just-finished terminal message when refreshed history has not caught up', async () => {
  const userMessage = {
    role: 'user',
    content: 'please inspect the repo',
    timestamp: 1000,
  };
  const terminalMessage = {
    role: 'assistant',
    content: 'The repo inspection is complete.',
    timestamp: 2000,
    __justdoOptimisticHistoryTail: true,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, terminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([userMessage, terminalMessage]);
});

test('lets authoritative media history retire the completed active turn', async () => {
  const userMessage = {
    role: 'user',
    content: '使用 MEDIA: 方式汇总一下文件',
    timestamp: 1000,
  };
  const optimisticTerminalMessage = {
    role: 'assistant',
    content: '工作区文件汇总\nMEDIA:C:\\workspace\\visualization_demo.png',
    timestamp: 2000,
    __justdoOptimisticHistoryTail: true,
  };
  const persistedMediaMessage = {
    role: 'assistant',
    provider: 'openclaw',
    model: 'gateway-injected',
    content: [
      { type: 'text', text: '工作区文件汇总' },
      {
        type: 'image',
        url: '/api/chat/media/outgoing/session/image/full',
        mimeType: 'image/png',
      },
    ],
    timestamp: 2100,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, persistedMediaMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, optimisticTerminalMessage];
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 1, createId: prefix => `${prefix}-1` },
  );
  turn.status = 'final';

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([userMessage, persistedMediaMessage]);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('marks an aborted terminal message as the active turn fallback', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  (
    controller as unknown as {
      handleAborted(payload: { message: unknown }): void;
    }
  ).handleAborted({
    message: { role: 'assistant', content: 'Stopped after partial output.' },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      __justdoOptimisticHistoryTail: true,
    }),
  ]);
});

test('does not persist hidden control replies from an aborted run', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null), setItem });
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  (
    controller as unknown as {
      handleAborted(payload: { runId: string; message: unknown }): void;
    }
  ).handleAborted({
    runId: 'hidden-run',
    message: { role: 'assistant', content: 'NO_REPLY' },
  });

  expect(controller.state.chatMessages).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
});

test('keeps streamed thinking as a truncated message when an aborted run has no final message', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-thinking';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-thinking' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  turn.items.push({
    id: 'thinking-1',
    runId: 'run-thinking',
    firstSeq: 1,
    lastSeq: 2,
    startedAt: 100,
    updatedAt: 200,
    type: 'thinking',
    status: 'running',
    text: 'Partial reasoning before the user stopped the run.',
  });

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      runId: 'run-thinking',
      session: controller.state.sessionKey,
      seq: 3,
      stream: 'lifecycle',
      data: { phase: 'end', aborted: true },
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      __justdoOptimisticHistoryTail: true,
      content: [
        expect.objectContaining({
          type: 'thinking',
          thinking: 'Partial reasoning before the user stopped the run.',
        }),
      ],
    }),
  ]);
});

test('keeps streamed assistant text as a truncated message when an aborted run has no final message', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-content';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-content' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  turn.items.push({
    id: 'content-1',
    runId: 'run-content',
    firstSeq: 1,
    lastSeq: 2,
    startedAt: 100,
    updatedAt: 200,
    type: 'content',
    status: 'streaming',
    sourceMode: 'snapshot',
    text: 'Partial answer before the user stopped the run.',
  });

  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  handleEvent({
    event: 'agent',
    payload: {
      runId: 'run-content',
      session: controller.state.sessionKey,
      seq: 3,
      stream: 'lifecycle',
      data: { phase: 'end', aborted: true },
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      runId: 'run-content',
      interrupted: true,
      content: [
        expect.objectContaining({
          type: 'text',
          text: 'Partial answer before the user stopped the run.',
          interrupted: true,
        }),
      ],
    }),
  ]);

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: controller.state.sessionKey,
      runId: 'run-content',
      state: 'aborted',
      message: { role: 'assistant', content: 'Partial answer before the user stopped the run.' },
    },
  });

  expect(controller.state.chatMessages).toHaveLength(1);
});

test('keeps an empty lifecycle abort out of assistant messages until real output arrives', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-late-abort';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-late-abort' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      runId: 'run-late-abort',
      session: controller.state.sessionKey,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'end', aborted: true },
    },
  });
  expect(controller.state.chatMessages).toEqual([]);

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: controller.state.sessionKey,
      runId: 'run-late-abort',
      state: 'aborted',
      message: { role: 'assistant', content: 'The final partial response.' },
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      runId: 'run-late-abort',
      content: 'The final partial response.',
    }),
  ]);
});

test('keeps a stopped prompt without synthesizing an assistant bubble across stale history', async () => {
  let storedInterruptedMessages: string | null = null;
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => storedInterruptedMessages),
    setItem: vi.fn((_key: string, value: string) => {
      storedInterruptedMessages = value;
    }),
  });
  const sessionKey = 'agent:main:justdo:session-stopped-before-reply';
  const request = vi.fn((method: string) => {
    if (method === 'chat.send') return Promise.resolve({ runId: 'run-stopped' });
    if (method === 'chat.history') return Promise.resolve({ messages: [] });
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await controller.sendMessage('Please start this work.');
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      runId: 'run-stopped',
      session: sessionKey,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'end', aborted: true },
    },
  });

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'Please start this work.',
      __justdoOptimisticHistoryTail: true,
    }),
  ]);
  expect(storedInterruptedMessages).toBeNull();
});

test('replaces a short lifecycle abort projection with a richer chat.aborted message', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-richer-abort';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-richer-abort' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  turn.items.push({
    id: 'content-short',
    runId: 'run-richer-abort',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 100,
    updatedAt: 100,
    type: 'content',
    status: 'streaming',
    sourceMode: 'snapshot',
    text: 'Short partial.',
  });
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      runId: 'run-richer-abort',
      session: controller.state.sessionKey,
      seq: 2,
      stream: 'lifecycle',
      data: { phase: 'end', aborted: true },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: controller.state.sessionKey,
      runId: 'run-richer-abort',
      state: 'aborted',
      message: { role: 'assistant', content: 'Short partial. Richer ending.' },
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      runId: 'run-richer-abort',
      content: 'Short partial. Richer ending.',
    }),
  ]);
});

test('preserves optimistic terminal content when refreshed history advanced without it', async () => {
  const userMessage = {
    role: 'user',
    content: 'please inspect the repo',
    timestamp: 1000,
  };
  const yieldedMessage = {
    role: 'toolResult',
    content: 'yielded',
    timestamp: 1500,
  };
  const laterToolMessage = {
    role: 'toolResult',
    content: 'late tool result',
    timestamp: 2500,
  };
  const terminalMessage = {
    role: 'assistant',
    content: 'The repo inspection is complete.',
    timestamp: 3000,
    __justdoOptimisticHistoryTail: true,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, yieldedMessage, laterToolMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, yieldedMessage, terminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([
    userMessage,
    yieldedMessage,
    laterToolMessage,
    terminalMessage,
  ]);
});

test('does not duplicate optimistic terminal content when history has a fuller persisted version', async () => {
  const userMessage = {
    role: 'user',
    content: 'please inspect the repo',
    timestamp: 1000,
  };
  const yieldedMessage = {
    role: 'toolResult',
    content: 'yielded',
    timestamp: 1500,
  };
  const terminalMessage = {
    role: 'assistant',
    content:
      '## 完成汇总\n\n工作方式：5 个 subagent 并行，每组处理 3 个 skill，异步产出示例 JSON。',
    timestamp: 3000,
    __justdoOptimisticHistoryTail: true,
  };
  const persistedTerminalMessage = {
    role: 'assistant',
    content:
      '## 完成汇总\n\n工作方式：5 个 subagent 并行，每组处理 3 个 skill，异步产出示例 JSON。文件已写入 E:\\workspace\\justdo\\project\\Skill_示例汇总.xlsx',
    timestamp: 3100,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, yieldedMessage, persistedTerminalMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, yieldedMessage, terminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([
    userMessage,
    yieldedMessage,
    persistedTerminalMessage,
  ]);
});

test('does not duplicate optimistic terminal content when persisted timestamp is slightly older', async () => {
  const userMessage = {
    role: 'user',
    content: '针对每个skill，写一个例子，可以开subagent，等完成之后，汇总一些，写入excel中',
    timestamp: 1000,
  };
  const optimisticTerminalMessage = {
    role: 'assistant',
    content:
      '全部完成！以下是执行摘要：\n\n---\n\n## 任务完成：15 个技能示例 → Excel 汇总\n\n### 执行过程\n1. 读取了所有 15 个技能的 SKILL.md 文档\n2. 通过 5 个并行 subagent 分别生成示例（每组 3 个技能）\n3. 等待全部完成后，汇总写入 Excel\n\n### 生成文件\n- OpenClaw_技能使用示例汇总.xlsx\n\n### Excel 表格结构\n| 列 | 内容 |\n|---|---|\n| 序号 | 1-15 |\n| 技能名称 | 含英文名+中文说明 |\n| 典型场景 | 每个技能的一个实际应用场景 |\n| 具体示例 | 可直接执行的示例说明 |\n\n### 格式优化\n- 标题行加粗\n- 代码列使用 Consolas 字体',
    timestamp: 113_000,
    __justdoOptimisticHistoryTail: true,
  };
  const persistedTerminalMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '我需要确认所有子代理已完成，然后汇总最终文件路径。' },
      {
        type: 'text',
        text: '全部完成！以下是执行摘要：\n\n---\n\n## 任务完成：15 个技能示例 → Excel 汇总\n\n### 执行过程\n1. 读取了所有 15 个技能的 SKILL.md 文档\n2. 通过 5 个并行 subagent 分别生成示例（每组 3 个技能）\n3. 等待全部完成后，汇总写入 Excel\n\n### 生成文件\n- OpenClaw_技能使用示例汇总.xlsx\n\n### Excel 表格结构\n| 列 | 内容 |\n|---|---|\n| 序号 | 1-15 |\n| 技能名称 | 含英文名+中文说明 |\n| 典型场景 | 每个技能的一个实际应用场景 |\n| 具体示例 | 可直接执行的示例说明 |\n\n文件路径：E:\\workspace\\JustDo\\project\\OpenClaw_技能使用示例汇总.xlsx',
      },
    ],
    timestamp: 100_000,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, persistedTerminalMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, optimisticTerminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([userMessage, persistedTerminalMessage]);
});

test('strips trailing NO_REPLY from terminal messages and dedupes persisted replacements', async () => {
  const userMessage = {
    role: 'user',
    content: '针对每个 skill 写一个例子并汇总',
    timestamp: 1000,
  };
  const persistedTerminalMessage = {
    role: 'assistant',
    content:
      '全部完成！以下是整个工作的汇总。\n\n---\n\n## 执行摘要\n3 个子代理并行工作，为全部 15 个 OpenClaw 技能各创建了示例文件。\n\nMEDIA:examples/sales-report.xlsx',
    timestamp: 100_000,
  };
  const optimisticTerminalMessage = {
    role: 'assistant',
    content:
      '全部完成！以下是整个工作的汇总。\n\n---\n\n## 执行摘要\n3 个子代理并行工作，为全部 15 个 OpenClaw 技能各创建了示例文件。\n\n### 输出文件NO_REPLY',
    timestamp: 220_000,
    __justdoOptimisticHistoryTail: true,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, persistedTerminalMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, optimisticTerminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([userMessage, persistedTerminalMessage]);
});

test('strips trailing NO_REPLY from renderable final payloads', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleFinal(payload: {
        sessionKey: string;
        state: 'final';
        runId: string;
        message: unknown;
      }): void;
    }
  ).handleFinal({
    sessionKey: 'agent:main:justdo:session-1',
    state: 'final',
    runId: 'run-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '全部完成！以下是整个工作的汇总。NO_REPLY' }],
      timestamp: 2000,
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      content: [{ type: 'text', text: '全部完成！以下是整个工作的汇总。' }],
    }),
  ]);
});

test('does not replay deferred session.message reload immediately after renderable final message', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({ event: 'session.message', payload: {} });
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] },
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'Final answer' }],
    }),
  ]);
  expect(request).not.toHaveBeenCalled();

  await vi.runOnlyPendingTimersAsync();

  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 1000,
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'Final answer' }],
    }),
  ]);
});

test('keeps live tool messages until delayed post-final history catches up', async () => {
  vi.useFakeTimers();
  const persistedFinal = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Final answer' }],
    timestamp: Date.now(),
  };
  const request = vi.fn().mockResolvedValue({ messages: [persistedFinal] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: 'agent:main:justdo:session-1',
      runId: 'run-1',
      seq: 1,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'tool-1',
        name: 'Read',
        args: { file_path: 'README.md' },
      },
    },
  });
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'tool', status: 'completed' })]),
  );
  expect(request).not.toHaveBeenCalled();

  await vi.runOnlyPendingTimersAsync();

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatMessages).toEqual([persistedFinal]);
});

test('coalesces idle session.message events before refreshing history', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  handleEvent({ event: 'session.message', payload: {} });
  handleEvent({ event: 'session.message', payload: {} });

  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1300);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 1000,
  });
});

test('ignores session.message events routed to another session', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey: 'agent:main:justdo:session-2' },
  });
  await vi.runOnlyPendingTimersAsync();

  expect(request).not.toHaveBeenCalled();
});

test('replays deferred session.message reload after silent final message', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({ event: 'session.message', payload: {} });
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'NO_REPLY' }] },
    },
  });

  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 1000,
  });
});

test('does not retain NO_REPLY assistant streams for later lifecycle renders', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId: 'run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: 'NO_REPLY' },
    },
  });

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(streamListener).not.toHaveBeenCalled();

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId: 'run-1',
      seq: 2,
      stream: 'lifecycle',
      data: { phase: 'finishing' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items ?? []).toHaveLength(0);
  expect(streamListener).toHaveBeenCalledTimes(1);
});

test('does not revive a completed chat for a silent subagent announce run', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const runId = 'announce:v1:agent:main:subagent:child-run';

  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 2,
      stream: 'assistant',
      data: { text: 'NO_RE' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 4,
      stream: 'assistant',
      data: { text: 'NO_REPLY' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 6,
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(streamListener).not.toHaveBeenCalled();
});

test('starts a dormant subagent announce when it produces visible content', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const runId = 'announce:v1:agent:main:subagent:child-run';

  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 2,
      stream: 'assistant',
      data: { text: '子代理结果已经汇总完成。' },
    },
  });

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe(runId);
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId,
    items: [expect.objectContaining({ type: 'content', text: '子代理结果已经汇总完成。' })],
  });
  expect(streamListener).toHaveBeenCalledTimes(2);
});

test('streams dormant announce thinking before its first visible content', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const runId = 'announce:v1:agent:main:subagent:child-run';

  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 2,
      stream: 'thinking',
      data: { text: '正在整理子代理结果。' },
    },
  });

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe(runId);
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId,
    items: [expect.objectContaining({ type: 'thinking', text: '正在整理子代理结果。' })],
  });
  expect(streamListener).toHaveBeenCalledTimes(2);

  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 3,
      stream: 'assistant',
      data: { text: '子代理结果已经汇总完成。' },
    },
  });

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe(runId);
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId,
    items: [
      expect.objectContaining({ type: 'thinking', text: '正在整理子代理结果。' }),
      expect.objectContaining({ type: 'content', text: '子代理结果已经汇总完成。' }),
    ],
  });
  expect(streamListener).toHaveBeenCalledTimes(3);
});

test('keeps streamed dormant announce thinking when a tool follows', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const runId = 'announce:v1:agent:main:subagent:child-run';

  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 2,
      stream: 'thinking',
      data: { text: '准备读取结果文件。' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'justdo:session-1',
      runId,
      seq: 3,
      stream: 'tool',
      data: { phase: 'start', toolCallId: 'call-1', name: 'read' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed', text: '准备读取结果文件。' },
    { type: 'tool', status: 'running', toolCallId: 'call-1', name: 'read' },
  ]);
  expect(streamListener).toHaveBeenCalledTimes(3);
});

test('does not create visible state from Agent events without a canonical sequence', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: 'agent:main:justdo:session-1',
      runId: 'run-1',
      stream: 'assistant',
      data: { text: 'unordered legacy content' },
    },
  });

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(streamListener).not.toHaveBeenCalled();
});

test('rejected chat finals cannot mutate visible or sending state', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'sid-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.transcript.sessionId = 'sid-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: 'sid-1', lifecycleGeneration: 'life-1' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'sid-other',
      lifecycleGeneration: 'life-1',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'wrong session' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'sid-1',
      lifecycleGeneration: 'life-old',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'stale lifecycle' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'sid-1',
      lifecycleGeneration: 'life-1',
      runId: 'run-2',
      state: 'final',
      message: { role: 'assistant', content: 'other run' },
    },
  });

  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-1');
  expect(controller.state.transcript.activeTurn?.status).toBe('running');
});

test('keeps a live run suspended across transport loss and accepts later updates', () => {
  const controller = new ChatController();
  controller.state.client = {} as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );

  (controller as unknown as { handleClose(): void }).handleClose();
  expect(controller.state.transportStatus).toBe('reconnecting');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.transcript.activeTurn?.status).toBe('running');
  expect(controller.state.transcript.recentRuns.has('run-1')).toBe(false);

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      state: 'delta',
      deltaText: 'continued',
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toEqual([
    expect.objectContaining({ type: 'content', text: 'continued' }),
  ]);
});

test('creates one interruption only after reconnect confirms the run is inactive', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') return Promise.resolve({ messages: [] });
    if (method === 'sessions.list') {
      return Promise.resolve({
        sessions: [{ key: 'agent:main:justdo:session-1', hasActiveRun: false }],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );

  (controller as unknown as { handleClose(): void }).handleClose();
  controller.state.connected = true;
  await (
    controller as unknown as { reconcileSuspendedRun(): Promise<void> }
  ).reconcileSuspendedRun();
  await (
    controller as unknown as { reconcileSuspendedRun(): Promise<void> }
  ).reconcileSuspendedRun();

  expect(controller.state.transcript.activeTurn?.status).toBe('aborted');
  expect(
    controller.state.transcript.activeTurn?.items.filter(item => item.type === 'terminal'),
  ).toHaveLength(1);
  expect(controller.state.chatSending).toBe(false);
});

test('invalidates in-flight history when sessions.changed rotates the session id', () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'sid-old';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.transcript.sessionId = 'sid-old';
  const generation = controller.state.transcript.historyGeneration;

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'sid-new',
      reason: 'reset',
    },
  });

  expect(controller.state.currentSessionId).toBe('sid-new');
  expect(controller.state.transcript.historyGeneration).toBe(generation + 1);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('rejects automatic session id rotation for a managed JustDo session', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'sid-stable';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.transcript.sessionId = 'sid-stable';
  const generation = controller.state.transcript.historyGeneration;

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'sid-unexpected',
      reason: 'update',
    },
  });

  expect(controller.state.currentSessionId).toBe('sid-stable');
  expect(controller.state.transcript.sessionId).toBe('sid-stable');
  expect(controller.state.transcript.historyGeneration).toBe(generation);
});

test('appends a selected-session external final once when no run is active', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const event = {
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'external-run',
      state: 'final',
      message: { role: 'assistant', content: 'injected answer' },
    },
  };

  handleEvent(event);
  handleEvent(event);

  expect(controller.state.chatMessages).toHaveLength(1);
  expect(controller.state.chatMessages[0]).toMatchObject({ content: 'injected answer' });
});

test('keeps similar adjacent external finals from different runs as separate messages', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'external-run-1',
      state: 'final',
      message: { role: 'assistant', content: '第一条异步消息。' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'external-run-2',
      state: 'final',
      message: { role: 'assistant', content: '第一条异步消息。第二条消息新增了细节。' },
    },
  });

  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ runId: 'external-run-1', content: '第一条异步消息。' }),
    expect.objectContaining({
      runId: 'external-run-2',
      content: '第一条异步消息。第二条消息新增了细节。',
    }),
  ]);
});

test('keeps identical adjacent external finals without identities as separate messages', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const event = {
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'final',
      message: { role: 'assistant', content: '相同内容也可能是两条独立消息。' },
    },
  };

  handleEvent(event);
  handleEvent(event);

  expect(controller.state.chatMessages).toEqual([
    {
      role: 'assistant',
      content: '相同内容也可能是两条独立消息。',
      __justdoOptimisticHistoryTail: true,
    },
    {
      role: 'assistant',
      content: '相同内容也可能是两条独立消息。',
      __justdoOptimisticHistoryTail: true,
    },
  ]);
});

test('drops stale optimistic wait messages once persisted history has advanced past them', async () => {
  const userMessage = {
    role: 'user',
    content: 'please inspect the repo',
    timestamp: 1000,
  };
  const staleWaitMessage = {
    role: 'assistant',
    content: '收到 docx 完成。继续等待其余 4 个完成。',
    timestamp: 2000,
    __justdoOptimisticHistoryTail: true,
  };
  const optimisticTerminalMessage = {
    role: 'assistant',
    content: '所有 15 个 subagent 全部完成！现在创建汇总 Excel 文件。',
    timestamp: 120_000,
    __justdoOptimisticHistoryTail: true,
  };
  const persistedTerminalMessage = {
    role: 'assistant',
    content:
      '所有 15 个 subagent 全部完成！现在创建汇总 Excel 文件。文件路径：`OpenClaw_Skills_示例汇总.xlsx`',
    timestamp: 121_000,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [userMessage, persistedTerminalMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [userMessage, staleWaitMessage, optimisticTerminalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([userMessage, persistedTerminalMessage]);
});

test('does not let a stale history refresh overwrite newer visible messages', async () => {
  vi.useFakeTimers();
  const waitingMessage = {
    role: 'assistant',
    content: '3 个子代理已启动，分别负责 5 个技能的示例创作。等待它们完成...',
    timestamp: 1000,
  };
  const finalMessage = {
    role: 'assistant',
    content: '已完成！`Skill_Examples_汇总.xlsx` 已生成（14KB）。',
    timestamp: 2000,
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ messages: [waitingMessage] })
    .mockResolvedValueOnce({ messages: [waitingMessage, finalMessage] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [waitingMessage];

  const load = controller.loadHistory();
  controller.state.chatMessages = [waitingMessage, finalMessage];
  await load;

  expect(controller.state.chatMessages).toEqual([waitingMessage, finalMessage]);
  expect(request).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1300);
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledTimes(2);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.state.chatMessages).toEqual([waitingMessage, finalMessage]);
});

test('notifies listeners when an active run makes a history load stop early', async () => {
  const request = vi.fn().mockResolvedValue({
    messages: [{ role: 'assistant', content: 'persisted content', timestamp: 1000 }],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  const loadingStates: boolean[] = [];
  controller.subscribe(state => loadingStates.push(state.chatLoading));

  await controller.loadHistory();

  expect(loadingStates).toEqual([true, false]);
  expect(controller.state.chatLoading).toBe(false);
});

test('preserves optimistic attachment blocks after managed image resolution', async () => {
  const readFileAsDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
  });
  vi.stubGlobal('window', {
    electron: {
      dialog: {
        readFileAsDataUrl,
      },
    },
  });
  const request = vi.fn().mockResolvedValue({
    messages: [
      {
        role: 'user',
        content: 'image prompt',
        timestamp: Date.now(),
        MediaPaths: ['C:\\media\\prompt.png'],
        MediaTypes: ['image/png'],
      },
    ],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.setPendingUserMessage('image prompt', [
    {
      name: 'prompt.png',
      mimeType: 'image/png',
      base64Data: 'YWJj',
    },
  ]);
  controller.state.chatSending = false;

  await controller.loadHistory();
  await Promise.resolve();

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: [
        { type: 'text', text: 'image prompt' },
        {
          type: 'attachment',
          attachment: {
            url: 'data:image/png;base64,YWJj',
            kind: 'image',
            label: 'prompt.png',
            mimeType: 'image/png',
          },
        },
      ],
    }),
  ]);
  expect(readFileAsDataUrl).toHaveBeenCalledTimes(1);
});

test('does not apply a shorter post-run history snapshot over a newer visible final tail', async () => {
  vi.useFakeTimers();
  const userMessage = {
    role: 'user',
    content: '针对每个skill，写一个例子',
    timestamp: 1000,
  };
  const waitingMessage = {
    role: 'assistant',
    content: '5 个子 agent 已启动，正在并行编写示例。等待它们完成...',
    timestamp: 2000,
  };
  const yieldedMessage = {
    role: 'toolResult',
    content: '{ "status": "yielded", "message": "等待5个子agent完成skill示例编写" }',
    timestamp: 3000,
  };
  const finalMessage = {
    role: 'assistant',
    content: '任务完成 ✅ 以下是执行摘要：Skill Examples 汇总 Excel 已生成。',
    timestamp: 130_000,
  };
  const staleHistory = [userMessage, waitingMessage, yieldedMessage];
  const settledHistory = [userMessage, waitingMessage, yieldedMessage, finalMessage];
  const request = vi
    .fn()
    .mockResolvedValueOnce({ messages: staleHistory })
    .mockResolvedValueOnce({ messages: settledHistory });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [...staleHistory, finalMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual(settledHistory);
  expect(request).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1300);
  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledTimes(2);
  });
  expect(controller.state.chatMessages).toEqual(settledHistory);
});

test('does not preserve ordinary cached messages when refreshed history is empty', async () => {
  const staleMessage = {
    role: 'assistant',
    content: 'old cached history',
    timestamp: 1000,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [staleMessage];

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([]);
});

test('hydrates OpenClaw transcript MediaPaths as image blocks', async () => {
  const readFileAsDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
  });
  vi.stubGlobal('window', {
    electron: {
      dialog: {
        readFileAsDataUrl,
      },
    },
  });
  const controller = new ChatController();
  const resolved = await (
    controller as unknown as {
      resolveManagedHistoryImages(messages: unknown[]): Promise<unknown[]>;
    }
  ).resolveManagedHistoryImages([
    {
      role: 'user',
      content: '[User sent media without caption]',
      MediaPaths: ['C:\\media\\saved.png'],
      MediaTypes: ['image/png'],
    },
  ]);

  expect(resolved[0]).toMatchObject({
    content: [
      { type: 'text', text: '[User sent media without caption]' },
      {
        type: 'image',
        url: 'data:image/png;base64,YWJj',
        alt: 'saved.png',
        mimeType: 'image/png',
      },
    ],
  });

  await (
    controller as unknown as {
      resolveManagedHistoryImages(messages: unknown[]): Promise<unknown[]>;
    }
  ).resolveManagedHistoryImages([
    {
      role: 'user',
      content: 'same image',
      MediaPaths: ['C:\\media\\saved.png'],
      MediaTypes: ['image/png'],
    },
  ]);
  expect(readFileAsDataUrl).toHaveBeenCalledTimes(1);
});

test('dedupes a final message already present at the history tail', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  controller.state.chatMessages = [
    {
      role: 'user',
      content: '生成介绍文档',
      timestamp: 1000,
    },
    {
      role: 'assistant',
      content: '已生成介绍文档：文件包含了思源笔记的基本信息。',
      timestamp: 1400,
    },
  ];
  controller.state.transcript.activeTurn = {
    id: 'turn-1',
    runId: 'run-1',
    sessionId: null,
    lifecycleGeneration: null,
    sessionKey: controller.state.sessionKey,
    status: 'final',
    lastAgentSeq: 1,
    startedAt: 1200,
    items: [
      {
        id: 'thinking-1',
        runId: 'run-1',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1200,
        updatedAt: 1300,
        type: 'thinking',
        status: 'completed',
        text: '确认文件已经写入，然后汇报结果。',
      },
    ],
    toolById: new Map(),
  };

  (
    controller as unknown as {
      handleFinal(payload: {
        sessionKey: string;
        state: 'final';
        runId: string;
        message: unknown;
      }): void;
    }
  ).handleFinal({
    sessionKey: 'agent:main:justdo:session-1',
    state: 'final',
    runId: 'run-1',
    message: {
      role: 'assistant',
      content: '已生成介绍文档：文件包含了思源笔记的基本信息。',
      timestamp: 1500,
    },
  });

  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.chatMessages[1]).toEqual(
    expect.objectContaining({
      role: 'assistant',
      __justdoOptimisticHistoryTail: true,
    }),
  );
  expect((controller.state.chatMessages[1] as { content?: unknown }).content).toEqual([
    { type: 'thinking', thinking: '确认文件已经写入，然后汇报结果。' },
    { type: 'text', text: '已生成介绍文档：文件包含了思源笔记的基本信息。' },
  ]);
});

test('captures the gateway detail when a lifecycle run fails', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: 'agent:main:justdo:session-1',
    data: {
      phase: 'error',
      error: 'LLM request failed: provider rejected the request schema or tool payload.',
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.lastError).toBe(
    'LLM request failed: provider rejected the request schema or tool payload.',
  );
});

test('stores final timing when lifecycle end uses the compatibility fallback', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', startedAt: 500 },
    { now: () => Date.now(), createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: sessionKey,
    data: { phase: 'end' },
  });
  await vi.advanceTimersByTimeAsync(1_600);

  expect(controller.getCurrentTurnTiming()).toEqual({
    runId: 'run-1',
    status: 'final',
    startedAt: 500,
    endedAt: 2_500,
  });
});

test('does not apply the lifecycle end fallback while compaction is in flight', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  const handleAgentEvent = (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent.bind(controller);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: 'agent:main:justdo:session-1',
    data: { phase: 'end' },
  });
  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: 'agent:main:justdo:session-1',
    data: { phase: 'start' },
  });
  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: 'agent:main:justdo:session-1',
    data: { phase: 'start' },
  });
  await vi.advanceTimersByTimeAsync(2000);

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.compactionInFlight).toBe(true);
  expect(
    controller.state.chatMessages.filter(
      message =>
        (message as { __openclaw?: { kind?: string } }).__openclaw?.kind === 'compaction-status',
    ),
  ).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({ phase: 'in-progress' }),
    }),
  ]);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: 'agent:main:justdo:session-1',
    data: { phase: 'end', completed: true },
  });
  await vi.advanceTimersByTimeAsync(1600);

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'completed',
      }),
    }),
  ]);
});

test('streams automatic compaction output into the local progress marker', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  const handleAgentEvent = (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent.bind(controller);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase: 'start' },
  });
  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase: 'update', text: 'Current progress and decisions' },
  });

  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'in-progress',
        summary: 'Current progress and decisions',
      }),
    }),
  ]);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: {
      phase: 'end',
      text: 'Current progress and decisions\nNext steps',
      tokensBefore: 120_000,
      tokensAfter: 18_000,
    },
  });

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        phase: 'completed',
        summary: 'Current progress and decisions\nNext steps',
        tokensBefore: 120_000,
        tokensAfter: 18_000,
      }),
    }),
  ]);
});

test('resumes the lifecycle end fallback when automatic compaction fails', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  const handleAgentEvent = (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent.bind(controller);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: controller.state.sessionKey,
    data: { phase: 'end' },
  });
  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase: 'start' },
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.state.chatSending).toBe(true);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase: 'failed', error: 'Compaction timed out' },
  });
  await vi.advanceTimersByTimeAsync(1600);

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
});

test('ignores a duplicate compaction start that arrives after completion', () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handleAgentEvent = (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent.bind(controller);
  const event = (phase: 'start' | 'end') => ({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase },
  });

  handleAgentEvent(event('start'));
  handleAgentEvent(event('end'));
  handleAgentEvent(event('start'));

  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'completed',
      }),
    }),
  ]);
});

test('does not consume compaction history retries while the active turn is still sending', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.connected = true;
  controller.state.chatSending = true;
  const request = vi.fn();
  controller.state.client = { request } as never;
  const handleCompactionPhase = (
    controller as unknown as {
      handleCompactionPhase(phase: string): void;
    }
  ).handleCompactionPhase.bind(controller);

  handleCompactionPhase('start');
  handleCompactionPhase('end');
  await vi.advanceTimersByTimeAsync(10_000);

  const attempts = (
    controller as unknown as {
      deferredHistoryReloadAttempts: Map<string, number>;
    }
  ).deferredHistoryReloadAttempts;
  expect(attempts.get(controller.state.sessionKey)).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

test('removes automatic compaction progress when the lifecycle fails', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  const handleAgentEvent = (
    controller as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent.bind(controller);

  handleAgentEvent({
    runId: 'run-1',
    stream: 'compaction',
    session: controller.state.sessionKey,
    data: { phase: 'start' },
  });
  handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: controller.state.sessionKey,
    data: { phase: 'error', error: 'automatic compaction failed' },
  });

  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([]);
});

test('completes automatic compaction for a session while another session is selected', async () => {
  const originalSession = 'agent:main:justdo:session-1';
  const otherSession = 'agent:main:justdo:session-2';
  const controller = new ChatController();
  controller.state.sessionKey = originalSession;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey: originalSession },
  });
  await controller.switchSession(otherSession);
  handleEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'end', sessionKey: originalSession },
  });
  await controller.switchSession(originalSession);

  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'completed',
      }),
    }),
  ]);
});

test('keeps compaction progress when history only contains an existing legacy marker', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const legacyMarker = {
    role: 'system',
    timestamp: 1000,
    __openclaw: { kind: 'compaction' },
  };
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [legacyMarker];
  (
    controller as unknown as {
      handleCompactionPhase(phase: string): void;
    }
  ).handleCompactionPhase('start');

  const projected = (
    controller as unknown as {
      projectLocalCompactionStatus(sessionKey: string, messages: unknown[]): unknown[];
    }
  ).projectLocalCompactionStatus(sessionKey, [legacyMarker]);

  expect(projected).toEqual([
    legacyMarker,
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'in-progress',
      }),
    }),
  ]);
});

test('restores a persisted lifecycle failure after the controller restarts', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const sessionKey = 'agent:main:justdo:session-1';
  const error = 'LLM request failed: provider rejected the request schema or tool payload.';
  const firstController = new ChatController();
  firstController.state.sessionKey = sessionKey;
  firstController.state.chatSending = true;
  firstController.state.chatRunId = 'run-1';
  (
    firstController as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId: 'run-1',
    stream: 'lifecycle',
    session: sessionKey,
    data: { phase: 'error', error },
  });

  const restartedController = new ChatController();
  restartedController.state.sessionKey = sessionKey;
  restartedController.state.connected = true;
  restartedController.state.client = {
    request: vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          runId: 'run-1',
          content: 'The agent run failed before producing a reply.',
          timestamp: Date.now(),
        },
      ],
    }),
  } as never;

  await restartedController.loadHistory();

  expect(restartedController.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'system', content: error, isError: true }),
  ]);
});
