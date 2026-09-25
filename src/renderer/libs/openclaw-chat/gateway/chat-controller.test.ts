import { readModelRef } from '@shared/openclaw/modelRef';
import { ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectWaitingStatus } from '@/libs/openclaw-chat/model/run-activity';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function seedControllerMessages(controller: ChatController, messages: unknown[]): void {
  (
    controller as unknown as {
      setCurrentSessionMessages(
        messages: unknown[],
        options: { resetLoadedHistory: boolean },
      ): void;
    }
  ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
}

test('keeps an ambiguously rejected side run isolated from late agent events', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockRejectedValue(new Error('transport closed before acknowledgement')),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await expect(controller.sendSideQuestion('what changed?', 'btw-run-1')).rejects.toThrow(
    'transport closed before acknowledgement',
  );
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: 'late side-only answer' },
    },
  });

  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('returns the source draft without loading it into another selected session', async () => {
  const controller = new ChatController();
  let finishRewind!: (value: { editorText: string }) => void;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.describe') return Promise.resolve({ session: { goal: null } });
    if (method === 'sessions.rewind') {
      return new Promise(resolve => {
        finishRewind = resolve;
      });
    }
    return Promise.resolve({});
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-source';
  seedControllerMessages(controller, [
    { role: 'user', content: 'latest prompt', __openclaw: { id: 'latest-user' } },
  ]);

  const rewinding = controller.rewindToUserMessage('latest-user');
  await vi.waitFor(() => expect(typeof finishRewind).toBe('function'));
  controller.state.sessionKey = 'agent:main:justdo:session-other';
  finishRewind({ editorText: 'source draft' });

  await expect(rewinding).resolves.toEqual({
    text: 'source draft',
    attachments: [],
    filePaths: [],
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('dismisses only the unchanged completed progress revision', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ card: null });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.get', 'progressCard.put'] },
  };
  controller.state.progressCard = {
    sessionKey,
    revision: 7,
    updatedAt: 2_000,
    steps: [{ step: 'Done', status: ProgressCardStepStatus.Completed }],
  };

  await expect(controller.dismissProgressCard()).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith('progressCard.put', {
    sessionKey,
    expectedRevision: 7,
  });
  expect(controller.state.progressCard).toBeNull();
});

test('treats the clear event sent before a dismiss response as success', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  let resolvePut: ((value: { card: null }) => void) | undefined;
  const request = vi.fn().mockImplementation(
    () =>
      new Promise<{ card: null }>(resolve => {
        resolvePut = resolve;
      }),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.get', 'progressCard.put'] },
  };
  controller.state.progressCard = {
    sessionKey,
    revision: 7,
    updatedAt: 2_000,
    steps: [{ step: 'Done', status: ProgressCardStepStatus.Completed }],
  };
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  const dismissing = controller.dismissProgressCard();
  handleEvent({ event: 'progressCard.changed', payload: { sessionKey, revision: null } });
  resolvePut?.({ card: null });

  await expect(dismissing).resolves.toBe(true);
  expect(controller.state.progressCard).toBeNull();
});

test('removes an invalidated card when its authoritative refresh fails', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      card: {
        sessionKey,
        revision: 1,
        updatedAt: 1_000,
        steps: [{ step: 'Old work', status: 'in_progress' }],
      },
    })
    .mockRejectedValueOnce(new Error('temporary failure'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.get'] },
  };
  const internals = controller as unknown as {
    loadProgressCard(sessionKey: string, force?: boolean): Promise<void>;
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  await internals.loadProgressCard(sessionKey, true);
  expect(controller.state.progressCard?.revision).toBe(1);

  internals.handleEvent({
    event: 'progressCard.changed',
    payload: { sessionKey, revision: 2 },
  });

  expect(controller.state.progressCard).toBeNull();
  await vi.waitFor(() => expect(controller.state.progressCardError).toBe('unavailable'));
  expect(controller.state.progressCard).toBeNull();
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

test('renders an OpenClaw commentary delta when its snapshot field is blank', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = sessionKey;

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
      data: { text: '', delta: 'commentary chunk', phase: 'commentary' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: 'commentary chunk', sourceMode: 'delta' },
  ]);
  expect(controller.state.chatSending).toBe(true);
  expect(streamListener).toHaveBeenCalledWith('stream');
});

test('retains each reply model after the next run replaces live timing without a history reload', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  for (const [runId, model] of [
    ['run-1', 'model-a'],
    ['run-2', 'model-b'],
  ]) {
    request.mockResolvedValue({ runId, status: 'started' });
    await controller.sendMessage(`use ${model}`);
    handleEvent({
      event: 'agent',
      payload: {
        session: sessionKey,
        runId,
        seq: 1,
        stream: 'lifecycle',
        data: { phase: 'progress', stage: 'waiting_model', provider: 'provider', model },
      },
    });
    handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        runId,
        state: 'final',
        message: { role: 'assistant', content: `reply from ${model}` },
      },
    });
  }

  const replies = controller.state.chatMessages.filter(
    message => (message as { role?: string }).role === 'assistant',
  );
  expect(replies.map(readModelRef)).toEqual(['provider/model-a', 'provider/model-b']);
  expect(controller.getCurrentTurnTiming()?.modelRef).toBe('provider/model-b');
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

test('keeps live reply boundaries when history usage overtakes queued Thinking events', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
    applyInFlightRunSnapshot(
      snapshot: Record<string, unknown>,
      sessionKey: string,
      sessionId: string | null,
      requestRunId: string | null,
      sessionInfo: Record<string, unknown>,
    ): void;
  };
  const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
    internal.handleEvent({
      event: 'agent',
      payload: { sessionKey, runId: 'run-live', seq, stream, data },
    });
  emit(76, 'assistant', { text: 'Agents dispatched.' });
  let accumulatedText = 'Agents dispatched.';
  for (const [seq, thinking, text] of [
    [78, 'Review the first results.', 'Waiting for the remaining agents.'],
    [83, 'Compare all results.', 'Two agents returned the same blessing.'],
  ] as const) {
    accumulatedText += text;
    internal.applyInFlightRunSnapshot(
      {
        runId: 'run-live',
        text: accumulatedText,
        events: [{ runId: 'run-live', seq: seq + 1, stream: 'usage', data: {} }],
      },
      sessionKey,
      null,
      'run-live',
      { hasActiveRun: true, activeRunIds: ['run-live'] },
    );
    const items = controller.state.transcript.activeTurn?.items ?? [];
    expect(items[items.length - 1]).not.toMatchObject({ text: accumulatedText });
    emit(seq, 'thinking', { text: thinking });
    emit(seq + 2, 'assistant', { text });
  }
  expect(
    controller.state.transcript.activeTurn?.items.map(item => [
      item.type,
      'text' in item ? item.text : null,
    ]),
  ).toEqual([
    ['content', 'Agents dispatched.'],
    ['thinking', 'Review the first results.'],
    ['content', 'Waiting for the remaining agents.'],
    ['thinking', 'Compare all results.'],
    ['content', 'Two agents returned the same blessing.'],
  ]);
  controller.disconnect();
});

test('handles the next run activity when its sequence restarts below the previous run', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-1';
  controller.state.transcript.sessionKey = 'session-1';
  const internal = controller as unknown as {
    applyNormalizedAgentEvent(event: unknown): void;
    handleAgentEvent(event: unknown): void;
  };
  const handle = vi.spyOn(internal, 'handleAgentEvent').mockImplementation(() => {});
  const event = {
    runId: 'old-run',
    sessionKey: 'session-1',
    sessionId: null,
    lifecycleGeneration: null,
    agentId: 'main',
    spawnedBy: null,
    agentSeq: 100,
    frameSeq: 100,
    timestamp: 100,
    deliveryEvent: 'agent',
    stream: 'assistant',
    data: { text: 'old' },
  };
  internal.applyNormalizedAgentEvent(event);
  controller.state.transcript.activeTurn!.status = 'final';
  const next = { ...event, runId: 'new-run', agentSeq: 1, timestamp: 200, data: { text: 'new' } };
  internal.applyNormalizedAgentEvent(next);
  expect(handle).toHaveBeenLastCalledWith(next);
  expect(controller.state.transcript.activeTurn?.runId).toBe('new-run');
  controller.disconnect();
});

test('hydrates delayed session tool details after a newer item event', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-1';
  controller.state.transcript.sessionKey = 'session-1';
  controller.state.connected = true;
  controller.state.initialHistoryReady = true;
  const apply = (
    controller as unknown as {
      applyNormalizedAgentEvent(event: unknown): void;
    }
  ).applyNormalizedAgentEvent.bind(controller);
  const emit = (seq: number, stream: string, data: unknown) =>
    apply({
      runId: 'run-1',
      sessionKey: 'session-1',
      sessionId: null,
      lifecycleGeneration: null,
      agentId: 'main',
      spawnedBy: null,
      agentSeq: seq,
      frameSeq: seq,
      timestamp: 100 + seq,
      deliveryEvent: stream === 'tool' ? 'session.tool' : 'agent',
      stream,
      data,
    });
  emit(10, 'item', { kind: 'tool', phase: 'start', toolCallId: 'write-1' });
  emit(9, 'tool', {
    phase: 'start',
    toolCallId: 'write-1',
    name: 'write',
    args: { path: 'a.txt', content: 'hello' },
  });
  emit(12, 'item', { kind: 'tool', phase: 'end', toolCallId: 'write-1' });
  emit(11, 'tool', {
    phase: 'result',
    toolCallId: 'write-1',
    name: 'write',
    result: 'Wrote a.txt',
  });
  expect(controller.state.transcript.activeTurn?.toolById.get('write-1')).toMatchObject({
    input: { path: 'a.txt', content: 'hello' },
    output: 'Wrote a.txt',
    status: 'completed',
  });
  expect(controller.state.transcript.activeTurn?.lastAgentSeq).toBe(12);
  controller.disconnect();
});

test('replaces truncated OpenClaw history previews with complete messages', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockImplementation((method: string, params: unknown) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: '[chat.history omitted: message too large]',
            __openclaw: { id: 'assistant-1', seq: 1, truncated: true, reason: 'oversized' },
          },
          {
            role: 'assistant',
            content: '[chat.history omitted: message too large]',
            __openclaw: { id: 'assistant-2', seq: 2, truncated: true, reason: 'oversized' },
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
    maxChars: 2_000_000,
  });
  expect(request).toHaveBeenCalledWith('chat.message.get', {
    sessionKey,
    messageId: 'assistant-2',
    maxChars: 2_000_000,
  });
});

test('keeps a truncated history preview when the complete message is unavailable', async () => {
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: '[chat.history omitted: message too large]',
            __openclaw: { id: 'assistant-1', truncated: true, reason: 'oversized' },
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
    expect.objectContaining({ content: '[chat.history omitted: message too large]' }),
  ]);
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
  const setMessages = (
    controller as unknown as { setCurrentSessionMessages: (messages: unknown[]) => void }
  ).setCurrentSessionMessages.bind(controller);
  setMessages([{ role: 'assistant', content: 'A-old', timestamp: 1_000 }]);

  await controller.switchSession(temporarySession);
  setMessages([{ role: 'user', content: 'B-new', timestamp: 2_000 }]);
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
  const setMessages = (
    controller as unknown as { setCurrentSessionMessages: (messages: unknown[]) => void }
  ).setCurrentSessionMessages.bind(controller);
  setMessages([{ role: 'assistant', content: 'A-old', timestamp: 1_000 }]);

  await controller.switchSession(temporarySession);
  setMessages([{ role: 'user', content: 'B-new', timestamp: 2_000 }]);
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

test('reveals a live Workboard user task as soon as its authoritative message arrives', () => {
  const sessionKey = 'agent:main:subagent:workboard-default-card-1';
  const taskMessage = {
    role: 'user',
    content:
      'Work on this OpenClaw Workboard card: Fix the streaming drawer\n\n## Worker protocol\nCard id: card-1',
  };
  const controller = new ChatController({
    expectInitialHistory: true,
    expectInitialUserMessage: true,
  });
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: { sessionKey, message: taskMessage },
  });

  expect(controller.state.chatMessages).toEqual([taskMessage]);
  expect(controller.state.initialHistoryReady).toBe(true);
});

test('keeps a plain active-run assistant append from bypassing canonical content streaming', () => {
  vi.useFakeTimers();
  vi.setSystemTime(14_000);
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

  const message = {
    role: 'assistant',
    timestamp: 14_100,
    content: '纯字符串最终正文必须等待正式流。',
  };
  streamListener.mockClear();
  handleEvent({
    event: 'session.message',
    payload: { sessionKey, activeRunIds: ['run-1'], message },
  });
  handleEvent({
    event: 'session.message',
    payload: { sessionKey, activeRunIds: ['run-1'], message },
  });

  expect(controller.state.transcript.activeTurn?.items).toEqual([]);
  expect(streamListener).not.toHaveBeenCalled();

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'assistant',
      data: { text: '纯字符串' },
    },
  });
  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', status: 'streaming', text: '纯字符串' },
  ]);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'assistant',
      data: { text: message.content },
    },
  });
  expect(controller.state.transcript.activeTurn?.items).toHaveLength(1);
  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', status: 'streaming', text: message.content },
  ]);
});

test('places string content before an attached Tool during active-run repair', () => {
  vi.useFakeTimers();
  vi.setSystemTime(14_500);
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
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 14_600,
        content: '附件形式的工具调用前正文。',
        __justdoAttachedToolMessages: [
          {
            role: 'toolUse',
            id: 'call-attached-yield',
            name: 'sessions_yield',
            input: { message: '继续等待。' },
          },
        ],
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    {
      type: 'content',
      text: '附件形式的工具调用前正文。',
      followingToolCallId: 'call-attached-yield',
    },
    { type: 'tool', toolCallId: 'call-attached-yield' },
  ]);
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

test('ignores foreign-run text and results that reuse an active Tool call ID', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-current' },
    { now: () => 100, createId: prefix => `${prefix}-1` },
  );
  const tool = {
    id: 'tool-current',
    runId: 'run-current',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 100,
    updatedAt: 100,
    type: 'tool' as const,
    status: 'running' as const,
    toolCallId: 'call-collision',
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
      runId: 'run-foreign',
      timestamp: 110,
      content: [
        { type: 'text', text: 'foreign progress' },
        { type: 'toolCall', id: 'call-collision', name: 'sessions_yield' },
      ],
    },
    {
      role: 'toolResult',
      runId: 'run-foreign',
      timestamp: 120,
      toolCallId: 'call-collision',
      toolName: 'sessions_yield',
      content: 'foreign result',
    },
  ]);

  expect(changed).toBe(false);
  expect(turn.items).toEqual([tool]);
  expect(tool).toMatchObject({ status: 'running' });
  expect(tool).not.toHaveProperty('output');
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

test.each([
  '/exec gateway full off',
  '/elevated full',
  '/config set tools.exec.mode full',
  '/config: set tools.exec.mode full',
  '/cron list',
  '/nodes',
  '/openclaw repair',
  '/plugin list',
  '/restart',
  '/update',
])('does not send the app-managed command %s to Gateway', async message => {
  const request = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await expect(controller.sendMessage(message)).rejects.toThrow('managed by the app');

  expect(request).not.toHaveBeenCalled();
  expect(controller.state.chatMessages).toEqual([]);
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

test('keeps the previous transcript visible while a rotated oversized snapshot hydrates', async () => {
  let historyReads = 0;
  let resolveFullMessage: ((value: { ok: true; message: unknown }) => void) | undefined;
  const request = vi.fn((method: string) => {
    if (method === 'chat.history') {
      historyReads += 1;
      if (historyReads === 1) {
        return Promise.resolve({
          messages: [
            {
              role: 'assistant',
              content: 'previous physical session',
              __openclaw: { id: 'old-message', seq: 1 },
            },
          ],
          sessionInfo: { sessionId: 'old-session' },
        });
      }
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: '[chat.history omitted: message too large]',
            __openclaw: {
              id: 'new-message',
              seq: 1,
              truncated: true,
              reason: 'oversized',
            },
          },
        ],
        sessionInfo: { sessionId: 'new-session' },
      });
    }
    if (method === 'chat.message.get') {
      return new Promise(resolve => {
        resolveFullMessage = resolve;
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();
  const rotatingLoad = controller.loadHistory();
  await vi.waitFor(() => expect(resolveFullMessage).toBeTypeOf('function'));

  expect(controller.state.currentSessionId).toBe('old-session');
  expect(controller.state.visibleChatMessages).toEqual([
    expect.objectContaining({ content: 'previous physical session' }),
  ]);

  resolveFullMessage?.({
    ok: true,
    message: {
      role: 'assistant',
      content: 'complete replacement session',
      __openclaw: { id: 'new-message', seq: 1 },
    },
  });
  await expect(rotatingLoad).resolves.toBe(true);

  expect(controller.state.currentSessionId).toBe('new-session');
  expect(controller.state.visibleChatMessages).toEqual([
    expect.objectContaining({ content: 'complete replacement session' }),
  ]);
});

test('uses one native Gateway snapshot without a REST history fallback', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    messages: [{ role: 'assistant', content: 'native history' }],
    hasMore: false,
  });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  expect(request).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'assistant', content: 'native history' }),
  ]);
});

test('lets authoritative media history retire the completed active turn', async () => {
  const readAssistantMediaDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
    mimeType: 'image/png',
  });
  vi.stubGlobal('window', {
    electron: { openclaw: { engine: { readAssistantMediaDataUrl } } },
  });
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
        url: '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/full',
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

  expect(readAssistantMediaDataUrl).toHaveBeenCalledWith({
    source:
      '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/full',
    sessionKey: 'agent:main:justdo:session-1',
  });
  await vi.waitFor(() => {
    expect(controller.state.chatMessages).toEqual([
      userMessage,
      {
        ...persistedMediaMessage,
        content: [
          { type: 'text', text: '工作区文件汇总' },
          {
            type: 'image',
            url: 'data:image/png;base64,YWJj',
            mimeType: 'image/png',
          },
        ],
      },
    ]);
  });
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('does not reset a resumed turn whose stream event arrived before the acceptance callback', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const resumed = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-resumed' },
    { now: () => 100, createId: prefix => `${prefix}-resumed` },
  );
  resumed.items.push({
    id: 'thinking-resumed',
    runId: 'run-resumed',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 100,
    updatedAt: 100,
    type: 'thinking',
    status: 'running',
    text: 'Already streaming',
  });

  controller.beginGoalResume(controller.state.sessionKey, 'run-resumed');

  expect(controller.state.transcript.activeTurn).toBe(resumed);
  expect(controller.state.transcript.activeTurn?.items).toHaveLength(1);
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
    limit: 250,
    maxChars: 500_000,
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

test('keeps legitimate assistant text that mentions the heartbeat token', () => {
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = 'agent:main:justdo:session-1';

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
      data: { text: 'Use HEARTBEAT_OK as the acknowledgement token.' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: 'Use HEARTBEAT_OK as the acknowledgement token.' },
  ]);
  expect(streamListener).toHaveBeenCalledWith('stream');
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
    if (method === 'chat.history' || method === 'chat.startup')
      return Promise.resolve({ messages: [] });
    if (method === 'sessions.describe') {
      return Promise.resolve({
        session: { key: 'agent:main:justdo:session-1', hasActiveRun: false },
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

  (controller as unknown as { handleEvent(event: unknown): void }).handleEvent({
    event: 'agent',
    payload: {
      sessionKey: controller.state.sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'thinking',
      data: { text: 'in progress' },
    },
  });
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

test('lets reconnect history settle a first turn that disconnected before run binding', async () => {
  const persistedMessages = [
    { role: 'user', content: 'first turn', __openclaw: { seq: 1 } },
    { role: 'assistant', content: 'finished while offline', __openclaw: { seq: 2 } },
  ];
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'sessions.describe') {
      return Promise.resolve({
        session: { key: 'agent:main:justdo:session-1', hasActiveRun: false },
      });
    }
    if (method === 'chat.startup') {
      return Promise.resolve({
        messages: persistedMessages,
        sessionInfo: { key: 'agent:main:justdo:session-1', hasActiveRun: false },
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  controller.setPendingUserMessage('first turn');

  (controller as unknown as { handleClose(): void }).handleClose();
  expect(controller.state.transportStatus).toBe('reconnecting');

  controller.state.connected = true;
  await (
    controller as unknown as { reconcileSuspendedRun(): Promise<void> }
  ).reconcileSuspendedRun();

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.chatMessages).toEqual(persistedMessages);
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

test('reloads history for a sessions.changed message invalidation without a row payload', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'sessions.changed',
    payload: { sessionKey, phase: 'message' },
  });

  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_200);
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey,
    limit: 250,
    maxChars: 500_000,
  });
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

test('retains stable cached messages when a same-scope history snapshot is transiently empty', async () => {
  vi.useFakeTimers();
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

  expect(controller.state.chatMessages).toEqual([staleMessage]);
});

test('applies an identity-bearing session.message row without waiting for history', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ messages: [] });
  const baseline = {
    role: 'assistant',
    content: 'first',
    __openclaw: { id: 'message-10', seq: 10, runId: 'run-old' },
  };
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [baseline];
  controller.state.transcript.persistedMessages = [baseline];

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      messageId: 'message-11',
      messageSeq: 11,
      message: { role: 'user', content: 'second' },
    },
  });

  expect(controller.state.chatMessages).toEqual([
    baseline,
    {
      role: 'user',
      content: 'second',
      __openclaw: { id: 'message-11', seq: 11 },
    },
  ]);
  await vi.advanceTimersByTimeAsync(1300);
  expect(request).not.toHaveBeenCalled();
});

test('rejects a send captured for another session before making a Gateway request', async () => {
  const request = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-b';
  await expect(
    controller.sendMessage('for A', [], undefined, {
      expectedSessionKey: 'session-a',
      propagateRequestFailure: true,
    }),
  ).rejects.toThrow('context changed');
  expect(request).not.toHaveBeenCalled();
  expect(controller.state.chatSending).toBe(false);
});

test('keeps a possibly accepted run active when chat.send acknowledgement is lost', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockRejectedValue(new Error('request timeout')),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const onRequestUnknown = vi.fn();
  await expect(
    controller.sendMessage('hello', [], undefined, {
      clientTurnId: 'pending-run',
      propagateRequestFailure: true,
      onRequestUnknown,
    }),
  ).rejects.toThrow('request timeout');
  expect(onRequestUnknown).toHaveBeenCalledWith('pending-run');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('pending-run');
  expect(controller.state.lastError).toBeNull();
});

test('propagates a definitive send rejection so the product can settle its receipt', async () => {
  const controller = new ChatController();
  const rejection = Object.assign(new Error('invalid prompt'), { gatewayCode: 'INVALID_REQUEST' });
  controller.state.client = { request: vi.fn().mockRejectedValue(rejection) } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  const onRequestUnknown = vi.fn();
  await expect(
    controller.sendMessage('hello', [], undefined, {
      propagateRequestFailure: true,
      onRequestUnknown,
    }),
  ).rejects.toThrow('invalid prompt');
  expect(onRequestUnknown).not.toHaveBeenCalled();
  expect(controller.state.chatSending).toBe(false);
});

test('does not clear the active session when an earlier session stop completes', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-b';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-b';
  controller.clearSending('session-a');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-b');
});

test('does not send after cancellation while session preparation is pending', async () => {
  let finishPreparation!: (value: unknown) => void;
  const request = vi.fn((method: string) =>
    method === 'sessions.create'
      ? new Promise(resolve => {
          finishPreparation = resolve;
        })
      : Promise.resolve({}),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  let cancelled = false;
  const sending = controller.sendMessage('/goal start do work', [], undefined, {
    expectedSessionKey: 'session-a',
    isCancelled: () => cancelled,
    propagateRequestFailure: true,
  });
  cancelled = true;
  finishPreparation({ sessionId: 'backing-session' });
  await expect(sending).rejects.toThrow('context changed');
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  expect(controller.state.chatSending).toBe(false);
});

test('does not clear a replacement run in the same session after a delayed stop response', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-a';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'replacement';
  controller.clearSending('session-a', 'stopped-run');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('replacement');
});

test('does not release unknown admission before Main records its cancellation identity', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockRejectedValue(new Error('request timeout: chat.send')),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'session-a';
  let recordUnknown!: () => void;
  const onRequestUnknown = vi.fn(
    () =>
      new Promise<void>(resolve => {
        recordUnknown = resolve;
      }),
  );
  let settled = false;
  const sending = controller
    .sendMessage('hello', [], undefined, {
      clientTurnId: 'uncertain-admission',
      onRequestUnknown,
      propagateRequestFailure: true,
    })
    .catch(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(onRequestUnknown).toHaveBeenCalledWith('uncertain-admission'));
  expect(settled).toBe(false);
  expect(controller.state.chatSending).toBe(true);
  recordUnknown();
  await sending;
  expect(settled).toBe(true);
  expect(controller.state.chatRunId).toBe('uncertain-admission');
});

test('repairs a still-running transcript even if sending state was already cleared', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-stop';
  controller.state.transcript.sessionKey = 'session-stop';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-stop' },
    {
      now: () => 100,
      createId: prefix => `${prefix}-stop`,
    },
  );

  controller.settleConfirmedRun('session-stop', 'run-stop', 'aborted');

  expect(turn.status).toBe('aborted');
  expect(turn.items.filter(item => item.type === 'terminal')).toHaveLength(1);
});

test('fences a confirmed Main-started run stopped before its first stream frame', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-stop';
  controller.state.transcript.sessionKey = 'session-stop';
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  controller.settleConfirmedRun('session-stop', 'run-before-first-frame', 'aborted');
  handleEvent({
    event: 'agent',
    payload: {
      session: 'session-stop',
      runId: 'run-before-first-frame',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'session-stop',
      runId: 'run-before-first-frame',
      state: 'delta',
      message: { role: 'assistant', content: 'late first token' },
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.transcript.activeTurn).toBeNull();
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey: 'session-stop',
      runId: 'run-before-first-frame',
      state: 'final',
      message: { role: 'assistant', content: 'late final must not bypass the terminal fence' },
    },
  });
  expect(controller.state.chatMessages).toEqual([]);
});

test('refreshes progress without replacing the saved card, draft, or transcript', async () => {
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:refresh';
  const request = vi
    .fn()
    .mockResolvedValue({ status: 'accepted', runId: 'refresh-run', revision: 7 });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.refresh'] },
  };
  const card = { sessionKey, revision: 7, updatedAt: 2000, markdown: 'Saved progress' };
  controller.state.progressCard = card;
  const before = controller.state.chatMessages;
  await expect(controller.refreshProgressCard()).resolves.toBe(true);
  await expect(controller.refreshProgressCard()).resolves.toBe(true);
  expect(request).toHaveBeenNthCalledWith(1, 'progressCard.refresh', {
    sessionKey,
    idempotencyKey: expect.any(String),
  });
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  expect(controller.state.progressCard).toBe(card);
  expect(controller.state.chatMessages).toBe(before);
});

test('ignores a progress refresh acknowledgement after switching sessions', async () => {
  const controller = new ChatController();
  let resolve!: (value: unknown) => void;
  controller.state.client = {
    request: vi.fn(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    ),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:refresh';
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.refresh'] },
  };
  controller.state.progressCard = {
    sessionKey: controller.state.sessionKey,
    revision: 7,
    updatedAt: 2000,
  };
  const pending = controller.refreshProgressCard();
  controller.state.sessionKey = 'agent:main:justdo:other';
  resolve({ status: 'accepted', runId: 'refresh-run', revision: 7 });
  await expect(pending).resolves.toBe(false);
});

test('reuses uncertain progress refreshes but replaces a confirmed failed intent', async () => {
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:refresh-retry';
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('lost acknowledgement'))
    .mockRejectedValueOnce({ details: { code: 'PROGRESS_CARD_REFRESH_TERMINAL' } })
    .mockResolvedValue({ status: 'accepted', runId: 'retry-run', revision: 7 });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.refresh'] },
  };
  controller.state.progressCard = { sessionKey, revision: 7, updatedAt: 2000 };
  await expect(controller.refreshProgressCard()).resolves.toBe(false);
  await expect(controller.refreshProgressCard()).resolves.toBe(false);
  await expect(controller.refreshProgressCard()).resolves.toBe(true);
  expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  expect(request.mock.calls[2][1].idempotencyKey).not.toBe(request.mock.calls[0][1].idempotencyKey);
});
