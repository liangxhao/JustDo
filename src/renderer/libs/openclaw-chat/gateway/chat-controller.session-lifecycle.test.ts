import { readModelRef } from '@shared/openclaw/modelRef';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  beginAssistantTurn,
  pruneRecentRuns,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectPersistedTimeline } from '@/libs/openclaw-chat/model/project-history-timeline';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('keeps a side run isolated after switching away from its session', async () => {
  const sessionA = 'agent:main:justdo:session-a';
  const sessionB = 'agent:main:justdo:session-b';
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionA;
  await controller.sendSideQuestion('what changed?', 'btw-run-1');
  controller.state.connected = false;

  await controller.switchSession(sessionB);
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: sessionA,
      runId: 'btw-run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: 'late background side answer' },
    },
  });
  await controller.switchSession(sessionA);

  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('keeps an unsuccessful session operation in its background session', async () => {
  const controller = new ChatController();
  const originalSession = 'agent:main:justdo:session-1';
  controller.state.sessionKey = originalSession;
  const handle = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const emit = (phase: string, extra: Record<string, unknown> = {}) =>
    handle({
      event: 'session.operation',
      payload: {
        operation: 'compact',
        operationId: 'operation-1',
        sessionKey: originalSession,
        phase,
        ...extra,
      },
    });
  emit('start');
  await controller.switchSession('agent:main:justdo:session-2');
  emit('end', { completed: false, reason: 'model unavailable' });
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.compactionInFlight).toBe(false);
  await controller.switchSession(originalSession);
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'failed',
        reason: 'model unavailable',
      }),
    }),
  ]);
});

test.each([undefined, 'switched-provider/switched-model'])(
  'keeps the actual model after final clears activity (final model=%s)',
  async finalModel => {
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
        message: {
          role: 'assistant',
          content: 'done',
          ...(finalModel ? { model: finalModel } : {}),
        },
      },
    });

    expect(controller.state.runActivity).toBeNull();
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe(
      finalModel ?? 'current-provider/current-model',
    );
    expect(
      readModelRef(controller.state.chatMessages[controller.state.chatMessages.length - 1]),
    ).toBe(finalModel ?? 'current-provider/current-model');
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        runId: 'run-1',
        messageSeq: 1,
        message: {
          role: 'assistant',
          content: 'done',
          provider: 'native-provider',
          model: 'vendor/model',
          __openclaw: { id: 'native-final', seq: 1, runId: 'run-1' },
        },
      },
    });
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe('native-provider/vendor/model');
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        runId: 'older-run',
        messageSeq: 2,
        message: {
          role: 'assistant',
          content: 'older reply',
          provider: 'old-provider',
          model: 'old-model',
          __openclaw: { id: 'older-final', seq: 2, runId: 'older-run' },
        },
      },
    });
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe('native-provider/vendor/model');
  },
);

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

test('queues a fresh load when switching A to B to A while the first A load is in flight', async () => {
  const sessionA = 'agent:main:justdo:session-a';
  const sessionB = 'agent:main:justdo:session-b';
  let resolveFirstA:
    ((value: { messages: Array<{ role: string; content: string }> }) => void) | undefined;
  const firstA = new Promise<{ messages: Array<{ role: string; content: string }> }>(resolve => {
    resolveFirstA = resolve;
  });
  let aHistoryReads = 0;
  const request = vi.fn().mockImplementation((method: string, params: { sessionKey?: string }) => {
    if (method === 'sessions.messages.subscribe' || method === 'sessions.messages.unsubscribe') {
      return Promise.resolve({});
    }
    if (method === 'chat.startup' || method === 'chat.history') {
      if (params.sessionKey === sessionA) {
        aHistoryReads += 1;
        return aHistoryReads === 1
          ? firstA
          : Promise.resolve({
              messages: [{ role: 'assistant', content: 'fresh A history' }],
            });
      }
      return Promise.resolve({
        messages: [{ role: 'assistant', content: 'B history' }],
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
  controller.state.client = { request } as never;
  controller.state.connected = true;

  const firstSwitch = controller.switchSession(sessionA);
  await vi.waitFor(() => expect(aHistoryReads).toBe(1));
  await controller.switchSession(sessionB);
  await controller.switchSession(sessionA);
  resolveFirstA?.({ messages: [{ role: 'assistant', content: 'stale A history' }] });
  await firstSwitch;

  await vi.waitFor(() => expect(aHistoryReads).toBe(2));
  await vi.waitFor(() =>
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({ content: 'fresh A history' }),
    ]),
  );
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
    limit: 250,
    maxChars: 500_000,
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
      limit: 250,
      maxChars: 500_000,
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
  expect(request).toHaveBeenCalledWith('chat.startup', {
    sessionKey: 'agent:main:subagent:child-1',
    limit: 250,
    maxChars: 500_000,
  });
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:subagent:child-1',
    limit: 250,
    maxChars: 500_000,
  });
  expect(controller.state.chatMessages).toEqual([historyMessage]);
});

test('retries an assistant-only subagent tail until the originating task is present', async () => {
  const sessionKey = 'agent:main:subagent:assistant-tail-child';
  const assistantTail = { role: 'assistant', content: 'completed result' };
  const completeHistory = [{ role: 'user', content: 'persisted subagent task' }, assistantTail];
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
  controller.state.sessionKey = sessionKey;

  (
    controller as unknown as {
      handleHello(hello: Record<string, unknown>): void;
    }
  ).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(request.mock.calls.filter(([method]) => method === 'chat.startup')).toHaveLength(1);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history')).toHaveLength(1);
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

  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey,
    limit: 250,
    maxChars: 500_000,
  });
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

test('uses the native Gateway snapshot as the subagent history authority', async () => {
  const sessionKey = 'agent:main:subagent:child-1';
  const taskMessage = {
    role: 'user',
    content:
      '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect the stream.',
  };
  const persistedAssistant = { role: 'assistant', content: 'persisted reply' };
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
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
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
  expect([...values.values()].some(value => value.includes('"error":"chat.send failed"'))).toBe(
    true,
  );
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

test('preserves loaded Plan history across a same-session reset and shows the phase boundary immediately', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const messages = [{ role: 'user', content: 'plan this change', __openclaw: { id: 'user-1' } }];
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'sid-1';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'sid-1';
  (
    controller as unknown as {
      setCurrentSessionMessages(next: unknown[], options: { resetLoadedHistory: boolean }): void;
    }
  ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'planning-run', sessionId: 'sid-1' },
    { now: () => 1_000, createId: prefix => `${prefix}-1` },
  );
  controller.preparePlanImplementationReset({
    requestId: 'plan-1',
    toolName: 'PresentPlan',
    toolInput: { title: 'Plan', plan: '# Plan' },
  });

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'sessions.changed',
    payload: { sessionKey, sessionId: 'sid-1', reason: 'reset' },
  });

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatMessages).toEqual([
    ...messages,
    expect.objectContaining({
      role: 'assistant',
      content: [
        expect.objectContaining({
          type: 'toolcall',
          name: 'PresentPlan',
          input: { title: 'Plan', plan: '# Plan' },
        }),
      ],
    }),
    expect.objectContaining({
      role: 'system',
      __openclaw: expect.objectContaining({ kind: 'reset', planImplementation: true }),
    }),
  ]);
  expect(
    projectPersistedTimeline(controller.state.chatMessages as never[]).map(item => item.kind),
  ).toEqual(['history-message', 'plan-presentation', 'phase-boundary']);
});

test('settles the background unknown run without clearing the selected session', async () => {
  const controller = new ChatController();
  const request = vi.fn((method: string) =>
    method === 'chat.send'
      ? Promise.reject(new Error('request timeout: chat.send'))
      : Promise.resolve({ messages: [] }),
  );
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  await controller
    .sendMessage('hello', [], undefined, {
      clientTurnId: 'uncertain-a',
      onRequestUnknown: () => undefined,
    })
    .catch(() => undefined);
  await controller.switchSession('session-b');
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-b';
  controller.settleConfirmedRun('session-a', 'uncertain-a', 'aborted');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-b');
  await controller.switchSession('session-a');
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
});

test.each([false, true])(
  'keeps one interrupted message when late abort frames follow Stop confirmation (background=%s)',
  async background => {
    const controller = new ChatController();
    const sessionKey = 'session-stop';
    const runId = 'run-stop';
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.state.chatSending = true;
    controller.state.chatRunId = runId;
    const turn = beginAssistantTurn(
      controller.state.transcript,
      { runId },
      {
        now: () => 100,
        createId: prefix => `${prefix}-stop`,
      },
    );
    turn.items.push({
      id: 'content-stop',
      runId,
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 100,
      updatedAt: 100,
      type: 'content',
      status: 'streaming',
      sourceMode: 'snapshot',
      text: 'Partial answer',
    });
    const handleEvent = (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent.bind(controller);

    if (background) await controller.switchSession('session-other');
    controller.settleConfirmedRun(sessionKey, runId, 'aborted');
    for (let repeat = 0; repeat < 3; repeat += 1) {
      handleEvent({
        event: 'agent',
        payload: {
          runId,
          session: sessionKey,
          seq: 2,
          stream: 'lifecycle',
          data: { phase: 'end', aborted: true },
        },
      });
      handleEvent({
        event: 'chat',
        payload: {
          runId,
          sessionKey,
          state: 'aborted',
          message: { role: 'assistant', content: 'Partial answer with its final buffered words.' },
        },
      });
    }
    handleEvent({
      event: 'agent',
      payload: {
        runId,
        session: sessionKey,
        seq: 3,
        stream: 'assistant',
        data: { text: 'stale output after Stop' },
      },
    });

    expect(controller.state.chatSending).toBe(false);
    expect(turn.status).toBe('aborted');
    expect(turn.items.filter(item => item.type === 'terminal')).toHaveLength(1);
    if (background) await controller.switchSession(sessionKey);
    expect(controller.state.chatMessages).toHaveLength(1);
    expect(controller.state.chatMessages[0]).toMatchObject({
      runId,
      content: 'Partial answer with its final buffered words.',
    });
    expect(
      turn.items.some(item => item.type === 'content' && item.text.includes('stale output')),
    ).toBe(false);
  },
);

test.each([
  ['expired', false],
  ['expired', true],
  ['capacity', false],
  ['capacity', true],
] as const)(
  'keeps stopped run identity after recent metadata is %s (background=%s)',
  async (eviction, background) => {
    vi.useFakeTimers();
    const controller = new ChatController();
    const sessionKey = 'session-stop-retention';
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.settleConfirmedRun(sessionKey, 'stopped-before-first-frame', 'aborted');
    const transcript = controller.state.transcript;
    if (eviction === 'expired') {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      pruneRecentRuns(transcript, Date.now());
    } else {
      for (let index = 0; index < 25; index += 1) {
        controller.settleConfirmedRun(sessionKey, `other-stopped-${index}`, 'aborted');
      }
    }
    expect(transcript.recentRuns.has('stopped-before-first-frame')).toBe(false);
    const internal = controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
      applyInFlightRunSnapshot(
        snapshot: Record<string, unknown>,
        key: string,
        sessionId: string | null,
        requestedRunId: string | null,
        info: Record<string, unknown>,
      ): void;
    };
    if (background) await controller.switchSession('other-session');
    for (const [stream, data] of [
      ['lifecycle', { phase: 'start' }],
      ['thinking', { thinking: 'late thought' }],
      ['tool', { phase: 'start', toolCallId: 'late-call', name: 'exec' }],
      ['assistant', { text: 'late text' }],
    ] as const) {
      internal.handleEvent({
        event: 'agent',
        payload: {
          sessionKey,
          runId: 'stopped-before-first-frame',
          seq: 10,
          stream,
          data,
        },
      });
    }
    for (const state of ['delta', 'final'] as const) {
      internal.handleEvent({
        event: 'chat',
        payload: {
          sessionKey,
          runId: 'stopped-before-first-frame',
          state,
          message: { role: 'assistant', content: 'late text' },
        },
      });
    }
    if (background) await controller.switchSession(sessionKey);
    internal.applyInFlightRunSnapshot(
      { runId: 'stopped-before-first-frame', text: 'stale snapshot', events: [] },
      sessionKey,
      null,
      null,
      { hasActiveRun: true, activeRunIds: ['stopped-before-first-frame'] },
    );
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(transcript.activeTurn).toBeNull();
    expect(controller.state.chatMessages).toEqual([]);
    // Durable message appends remain authoritative after transient run metadata
    // expires. Repeated delivery merges its stable identity without starting work.
    for (let delivery = 0; delivery < 2; delivery += 1) {
      internal.handleEvent({
        event: 'session.message',
        payload: {
          sessionKey,
          runId: 'stopped-before-first-frame',
          messageId: 'persisted-stop',
          messageSeq: 1,
          message: {
            role: 'assistant',
            content: 'persisted partial',
            __openclaw: { id: 'persisted-stop', seq: 1, runId: 'stopped-before-first-frame' },
          },
        },
      });
    }
    expect(controller.state.chatMessages).toHaveLength(1);
    expect(controller.state.chatMessages[0]).toMatchObject({ content: 'persisted partial' });
    expect(controller.state.chatSending).toBe(false);
    controller.disconnect();
  },
);
