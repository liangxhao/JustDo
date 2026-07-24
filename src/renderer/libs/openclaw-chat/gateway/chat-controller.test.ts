import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

test('preserves optimistic prompt when promoting a temp session to a persisted session', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:temp-123';
  controller.setPendingUserMessage('start this task');

  await controller.switchSession('agent:main:justdo:persisted-session');

  expect(controller.state.sessionKey).toBe('agent:main:justdo:persisted-session');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.pendingUserMessage?.content).toBe('start this task');
  expect(controller.state.chatLoading).toBe(true);
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
  expect(streamListener).toHaveBeenCalledTimes(1);
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
