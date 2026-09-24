import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('waits through pre-registration no-active replies and cancels the later manual compaction handle', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  let finishCompact!: (result: unknown) => void;
  const compact = new Promise(resolve => {
    finishCompact = resolve;
  });
  let abortCount = 0;
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.compact') return compact;
    if (method === 'sessions.abort') {
      abortCount += 1;
      if (abortCount === 2) finishCompact({ ok: false, compacted: false, reason: 'aborted' });
      return { ok: true, status: abortCount === 1 ? 'no-active-run' : 'aborted' };
    }
    return {};
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const compacting = controller.sendMessage('/compact');
  let stopped = false;
  const stopping = controller.cancelManualCompaction('session-a').then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  expect(controller.state.compactionInFlight).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  await Promise.all([compacting, stopping]);
  expect(abortCount).toBe(2);
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatSending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('stopping a manual compaction after switching sessions never aborts or clears the new session', async () => {
  const controller = new ChatController();
  let finishCompact!: (result: unknown) => void;
  const compact = new Promise(resolve => {
    finishCompact = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.compact') return compact;
    finishCompact({ ok: false, reason: 'aborted' });
    return { ok: true, status: 'aborted' };
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const compacting = controller.sendMessage('/compact');
  controller.state.sessionKey = 'session-b';
  controller.state.chatSending = true;
  await controller.cancelManualCompaction('session-a');
  await compacting;
  expect(request).toHaveBeenCalledWith('sessions.abort', { key: 'session-a', clearQueued: true });
  expect(controller.state.chatSending).toBe(true);
});

test('manual compaction cancellation reports a lost connection instead of claiming it stopped', async () => {
  const controller = new ChatController();
  let rejectCompact!: (error: Error) => void;
  const compact = new Promise((_resolve, reject) => {
    rejectCompact = reject;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.compact') return compact;
    rejectCompact(new Error('connection closed'));
    throw new Error('connection closed');
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const compacting = controller.sendMessage('/compact');
  await expect(controller.cancelManualCompaction('session-a')).rejects.toThrow('connection closed');
  await compacting;
  const recoveredRequest = vi.fn().mockResolvedValue({ ok: true, status: 'no-active-run' });
  controller.state.client = { request: recoveredRequest } as never;
  await expect(controller.cancelManualCompaction('session-a')).rejects.toThrow('connection closed');
  recoveredRequest.mockResolvedValue({ ok: true, status: 'aborted' });
  await controller.cancelManualCompaction('session-a');
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatSending).toBe(false);
});

test.each([true, false])(
  'does not abort new work when the earlier manual compaction already settled (%s)',
  async success => {
    const controller = new ChatController();
    const request = vi.fn().mockResolvedValue({
      ok: success,
      compacted: false,
      reason: 'Nothing to compact (session too small)',
    });
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'session-a';
    await controller.sendMessage('/compact');
    await controller.cancelManualCompaction('session-a');
    expect(request).toHaveBeenCalledTimes(1);
  },
);

test.each(['failed', 'skipped', 'aborted'] as const)(
  'preserves the native automatic compaction %s outcome without claiming success',
  outcome => {
    vi.useFakeTimers();
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    const handle = (
      controller as unknown as { handleAgentEvent(payload: Record<string, unknown>): void }
    ).handleAgentEvent.bind(controller);
    const emit = (data: Record<string, unknown>) =>
      handle({
        runId: 'run-1',
        stream: 'compaction',
        session: controller.state.sessionKey,
        data,
      });
    emit({ phase: 'start', itemId: 'compact-1' });
    emit({ phase: 'end', itemId: 'compact-1', completed: false, outcome, reason: 'native reason' });

    expect(controller.state.compactionInFlight).toBe(false);
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({
        __openclaw: expect.objectContaining({
          kind: 'compaction-status',
          phase: outcome,
          reason: 'native reason',
        }),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(['itemId', 'operationId'])(
  'tracks consecutive compactions by %s and ignores late events from the previous operation',
  identityField => {
    vi.useFakeTimers();
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    const handle = (
      controller as unknown as {
        handleCompactionPhase(
          phase: string,
          sessionKey: string,
          data: Record<string, unknown>,
        ): void;
      }
    ).handleCompactionPhase.bind(controller);
    const emit = (phase: string, id: string) =>
      handle(phase, controller.state.sessionKey, {
        [identityField]: id,
        completed: phase === 'end',
      });
    emit('start', 'first');
    emit('end', 'first');
    emit('start', 'second');
    expect(controller.state.compactionInFlight).toBe(true);
    emit('start', 'first');
    emit('end', 'first');
    expect(controller.state.compactionInFlight).toBe(true);
    emit('end', 'second');
    expect(controller.state.compactionInFlight).toBe(false);
  },
);

test('allows a new identity-free compaction immediately after the preceding one ends', () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const handle = (
    controller as unknown as {
      handleCompactionPhase(
        phase: string,
        sessionKey: string,
        data?: Record<string, unknown>,
      ): void;
    }
  ).handleCompactionPhase.bind(controller);
  handle('start', controller.state.sessionKey);
  handle('end', controller.state.sessionKey, { completed: true });
  handle('start', controller.state.sessionKey);
  expect(controller.state.compactionInFlight).toBe(true);
});

test.each(['Already compacted', 'Nothing to compact (session too small)'])(
  'shows the native benign preflight %s as a no-op rather than an error',
  async reason => {
    const controller = new ChatController();
    controller.state.client = {
      request: vi.fn().mockResolvedValue({ ok: false, compacted: false, reason }),
    } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    await controller.sendMessage('/compact');
    expect(controller.state.lastError).toBeNull();
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({ __openclaw: { kind: 'compaction-skipped', reason } }),
    ]);
  },
);

test.each(['success', 'failure'])(
  'ignores an old manual compaction %s after disconnect and a replacement request',
  async outcome => {
    const pending: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
    const client = {
      stop: vi.fn(),
      request: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
    };
    const controller = new ChatController();
    controller.state.client = client as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    const first = controller.sendMessage('/compact');
    controller.disconnect();
    controller.state.client = client as never;
    controller.state.connected = true;
    const second = controller.sendMessage('/compact');
    if (outcome === 'success') pending[0].resolve({ ok: true, compacted: true });
    else pending[0].reject(new Error('old connection failed'));
    await first;
    expect(controller.state.compactionInFlight).toBe(true);
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.lastError).toBeNull();
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({ __openclaw: expect.objectContaining({ phase: 'in-progress' }) }),
    ]);
    pending[1].resolve({ ok: true, compacted: false, reason: 'no transcript' });
    await second;
    expect(controller.state.chatSending).toBe(false);
  },
);

test('does not let a preceding history refresh erase a newer manual compaction', async () => {
  let finishHistory: ((loaded: boolean) => void) | undefined;
  let finishSecond: ((result: unknown) => void) | undefined;
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, compacted: true })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSecond = resolve;
        }),
    );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  vi.spyOn(controller, 'loadHistory').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishHistory = resolve;
      }),
  );
  const first = controller.sendMessage('/compact');
  await Promise.resolve();
  expect(controller.state.chatSending).toBe(false);
  const second = controller.sendMessage('/compact');
  finishHistory?.(false);
  await first;
  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ __openclaw: expect.objectContaining({ phase: 'in-progress' }) }),
  ]);
  finishSecond?.({ ok: true, compacted: false, reason: 'no transcript' });
  await second;
});

test('reports a manual compaction business failure even when the RPC transport succeeds', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ ok: false, compacted: false, reason: 'model unavailable' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.sendMessage('/compact');
  expect(controller.state.lastError).toBe('model unavailable');
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: '上下文压缩失败：model unavailable' }),
  ]);
  expect(request).toHaveBeenCalledOnce();
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
    limit: 250,
    maxChars: 500_000,
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
      content: '上下文压缩失败：compact unavailable',
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

test('keeps an acknowledged compaction visible until a failed history refresh recovers', async () => {
  vi.useFakeTimers();
  const marker = {
    role: 'system',
    timestamp: Date.now(),
    __openclaw: { kind: 'compaction', id: 'committed-compaction', summary: 'Preserved decisions' },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ compacted: true, result: { tokensBefore: 100, tokensAfter: 20 } })
    .mockRejectedValueOnce(new Error('history unavailable'))
    .mockImplementation((method: string) =>
      Promise.resolve(method === 'chat.history' ? { messages: [marker] } : { checkpoints: [] }),
    );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [{ role: 'assistant', content: 'old visible history' }];

  await controller.sendMessage('/compact');

  expect(controller.state.chatMessages).toEqual([
    { role: 'assistant', content: 'old visible history' },
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'completed',
        tokensBefore: 100,
        tokensAfter: 20,
      }),
    }),
  ]);
  expect(controller.state.lastError).toBe('history unavailable');
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.state.chatMessages).toContainEqual(marker);
  expect(controller.state.chatMessages).not.toContainEqual(
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction-status' }),
    }),
  );
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

test('settles a managed run when chat.final uses the compact session-key alias', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({
    messages: [
      {
        role: 'assistant',
        content: 'finished through compact alias',
        __openclaw: { seq: 1, runId: 'run-1' },
      },
    ],
    sessionId: 'sid-1',
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'sid-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.state.transcript.sessionId = 'sid-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: 'sid-1' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'justdo:session-1',
      sessionId: 'sid-1',
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'finished through compact alias' },
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: 'finished through compact alias',
      runId: 'run-1',
    }),
  ]);

  await vi.advanceTimersByTimeAsync(1500);
  expect(request).not.toHaveBeenCalled();
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

test('supports optional summary updates when a compaction event source provides them', () => {
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
    data: { phase, itemId: 'compact-1', ...(phase === 'end' ? { completed: true } : {}) },
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

test('applies compact session-operation aliases to the selected managed session', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey: 'justdo:session-1' },
  });
  handleEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'end', sessionKey: 'justdo:session-1' },
  });

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

test('releases an unconfirmed compaction Stop for retry without admitting replacement work', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  let finishCompact!: (value: unknown) => void;
  const compact = new Promise(resolve => {
    finishCompact = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.compact') return compact;
    return { ok: true, status: 'no-active-run' };
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const compacting = controller.sendMessage('/compact');
  const stopping = expect(controller.cancelManualCompaction('session-a')).rejects.toThrow();

  await vi.advanceTimersByTimeAsync(30_000);
  await stopping;

  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatSending).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const compactionRequests = request.mock.calls.filter(
    ([method]) => method === 'sessions.compact',
  ).length;
  await expect(controller.sendMessage('/compact')).rejects.toThrow('already being sent');
  expect(request.mock.calls.filter(([method]) => method === 'sessions.compact')).toHaveLength(
    compactionRequests,
  );
  request.mockImplementation(async () => {
    finishCompact({ ok: false, reason: 'aborted' });
    return { ok: true, status: 'aborted' };
  });
  const retry = controller.cancelManualCompaction('session-a');
  await vi.advanceTimersByTimeAsync(250);
  await Promise.all([retry, compacting]);
  expect(controller.state.compactionInFlight).toBe(false);
});
