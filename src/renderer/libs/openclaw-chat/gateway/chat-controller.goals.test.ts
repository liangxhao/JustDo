import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

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

test('rejects rewind while the canonical session still has a Goal', async () => {
  const controller = new ChatController();
  const request = vi.fn().mockResolvedValue({
    session: {
      goal: {
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Complete the task',
        status: 'paused',
      },
    },
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-goal';
  seedControllerMessages(controller, [
    { role: 'user', content: '/goal start Complete the task', __openclaw: { id: 'goal-user' } },
  ]);

  await expect(controller.rewindToUserMessage('goal-user')).rejects.toThrow(
    'Messages cannot be updated while the session has a Goal',
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-goal',
  });
});

test('loads the selected session progress card from the advertised Gateway method', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({
    card: {
      sessionKey,
      revision: 2,
      updatedAt: 1_000,
      markdown: 'Working',
      steps: [{ step: 'Verify', status: 'in_progress' }],
    },
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.get', 'progressCard.put'] },
  };

  await (
    controller as unknown as {
      loadProgressCard(sessionKey: string, force?: boolean): Promise<void>;
    }
  ).loadProgressCard(sessionKey, true);

  expect(request).toHaveBeenCalledWith('progressCard.get', { sessionKey });
  expect(controller.state.progressCard).toMatchObject({
    sessionKey,
    revision: 2,
    markdown: 'Working',
  });
  expect(controller.state.progressCardLoading).toBe(false);
  expect(controller.state.progressCardAvailable).toBe(true);
});

test('refreshes and clears progress cards from revision notifications', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({
    card: {
      sessionKey,
      revision: 3,
      updatedAt: 2_000,
      steps: [{ step: 'Done', status: 'completed' }],
    },
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.get'] },
  };
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({ event: 'progressCard.changed', payload: { sessionKey, revision: 3 } });
  await vi.waitFor(() => expect(controller.state.progressCard?.revision).toBe(3));
  expect(request).toHaveBeenCalledWith('progressCard.get', { sessionKey });

  handleEvent({ event: 'progressCard.changed', payload: { sessionKey, revision: null } });
  expect(controller.state.progressCard).toBeNull();
});

test('does not issue a dismiss request for an active progress card', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.hello = {
    type: 'hello-ok',
    protocol: 4,
    features: { methods: ['progressCard.put'] },
  };
  controller.state.progressCard = {
    sessionKey,
    revision: 1,
    updatedAt: 1,
    steps: [{ step: 'Working', status: ProgressCardStepStatus.InProgress }],
  };

  await expect(controller.dismissProgressCard()).resolves.toBe(false);
  expect(request).not.toHaveBeenCalled();
});

test('can display user feedback while sending a combined goal command to the Gateway', async () => {
  const request = vi.fn((method: string, params?: Record<string, unknown>) =>
    Promise.resolve(
      method === 'sessions.create'
        ? { sessionId: 'gateway-session-1' }
        : {
            operationId: params?.idempotencyKey,
            action: 'start',
            sessionId: 'gateway-session-1',
            goalId: 'goal-1',
            runId: params?.idempotencyKey,
            status: 'started',
          },
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
      message: 'Please improve chapter two.',
      intent: expect.objectContaining({
        kind: 'session-goal-start',
        version: 1,
      }),
    }),
  );
});

test('never renders an internal goal follow-up prompt when no display override is supplied', async () => {
  const request = vi.fn((method: string, params?: Record<string, unknown>) =>
    Promise.resolve(
      method === 'sessions.create'
        ? { sessionId: 'gateway-session-1' }
        : {
            operationId: params?.idempotencyKey,
            action: 'start',
            sessionId: 'gateway-session-1',
            goalId: 'goal-1',
            runId: params?.idempotencyKey,
            status: 'started',
          },
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
    expect.objectContaining({
      message: '再来一首',
      intent: expect.objectContaining({ kind: 'session-goal-start', version: 1 }),
    }),
  );
});

test('reuses the exact native Goal start identity after an ambiguous transport failure', async () => {
  let sendAttempts = 0;
  const request = vi.fn((method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.create') {
      return Promise.resolve({ sessionId: 'gateway-session-1' });
    }
    if (method === 'chat.send') {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return Promise.reject(
          Object.assign(new Error('unavailable after commit'), {
            gatewayCode: 'UNAVAILABLE',
            retryable: false,
          }),
        );
      }
      return Promise.resolve({
        operationId: params?.idempotencyKey,
        action: 'start',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        runId: params?.idempotencyKey,
        status: 'started',
        replayed: true,
      });
    }
    if (method === 'chat.startup') return Promise.resolve({ messages: [] });
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/goal start Ship the release');
  await controller.sendMessage('/goal start Ship the release');

  const sends = request.mock.calls.filter(([method]) => method === 'chat.send');
  expect(sends).toHaveLength(2);
  expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
  expect(sends[0]?.[1]).toMatchObject({
    message: 'Ship the release',
    sessionId: 'gateway-session-1',
    intent: {
      kind: 'session-goal-start',
      version: 1,
      issuedAtMs: expect.any(Number),
    },
    idempotencyKey: expect.any(String),
  });
  expect(sends[0]?.[1]).not.toHaveProperty('timeoutMs');
  expect(controller.state.chatSending).toBe(false);
});

test('keeps a replayed native Goal start bound while its exact run and goal remain active', async () => {
  let runId = '';
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.create') return { sessionId: 'gateway-session-1' };
    if (method === 'chat.send') {
      runId = String(params?.idempotencyKey);
      return {
        operationId: runId,
        action: 'start',
        sessionId: 'gateway-session-1',
        goalId: 'goal-1',
        runId,
        status: 'started',
        replayed: true,
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          goal: {
            schemaVersion: 1,
            id: 'goal-1',
            objective: 'Ship the release',
            status: 'active',
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [{ key: 'agent:main:justdo:session-1', activeRunIds: [runId] }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const onRunBound = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/goal start Ship the release', [], undefined, { onRunBound });

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe(runId);
  expect(onRunBound).toHaveBeenCalledWith(runId);
});

test('retains ambiguous Goal start identities independently across session switches', async () => {
  const operationIds = new Map<string, string[]>();
  let sessionAAttempts = 0;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const key = String(params?.sessionKey ?? params?.key ?? '');
    if (method === 'sessions.create') {
      return { sessionId: key.endsWith('session-a') ? 'gateway-a' : 'gateway-b' };
    }
    if (method === 'chat.send') {
      const operationId = String(params?.idempotencyKey);
      operationIds.set(key, [...(operationIds.get(key) ?? []), operationId]);
      if (key.endsWith('session-a')) {
        sessionAAttempts += 1;
        if (sessionAAttempts === 1) {
          throw Object.assign(new Error('unavailable after commit'), {
            gatewayCode: 'UNAVAILABLE',
            retryable: false,
          });
        }
        return {
          operationId,
          action: 'start',
          sessionId: 'gateway-a',
          goalId: 'goal-a',
          runId: operationId,
          status: 'started',
          replayed: true,
        };
      }
      return {
        operationId,
        action: 'start',
        sessionId: 'gateway-b',
        goalId: 'goal-b',
        runId: operationId,
        status: 'started',
      };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          goal: {
            schemaVersion: 1,
            id: 'goal-a',
            objective: 'Goal A',
            status: 'complete',
            createdAt: 1,
            updatedAt: 2,
            tokenStart: 0,
            tokensUsed: 1,
            continuationTurns: 0,
          },
        },
      };
    }
    if (method === 'sessions.list') return { sessions: [] };
    if (method === 'chat.startup') return { messages: [] };
    throw new Error(`unexpected method ${method}`);
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;

  controller.state.sessionKey = 'agent:main:justdo:session-a';
  controller.state.currentSessionId = 'gateway-a';
  await controller.sendMessage('/goal start Goal A');

  controller.state.sessionKey = 'agent:main:justdo:session-b';
  controller.state.currentSessionId = 'gateway-b';
  await controller.sendMessage('/goal start Goal B');
  const sessionBRunId = operationIds.get('agent:main:justdo:session-b')?.[0] ?? '';
  (
    controller as unknown as {
      settleChatSend: (sessionKey: string, runId: string, state: 'final') => void;
    }
  ).settleChatSend('agent:main:justdo:session-b', sessionBRunId, 'final');

  controller.state.sessionKey = 'agent:main:justdo:session-a';
  controller.state.currentSessionId = 'gateway-a';
  await controller.sendMessage('/goal start Goal A');

  expect(operationIds.get('agent:main:justdo:session-a')).toEqual([
    expect.any(String),
    operationIds.get('agent:main:justdo:session-a')?.[0],
  ]);
  expect(sessionBRunId).not.toBe(operationIds.get('agent:main:justdo:session-a')?.[0]);
});

test('creates a backing session before the first goal command', async () => {
  const request = vi.fn().mockImplementation((method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.create') {
      return Promise.resolve({
        key: 'agent:main:justdo:new-session',
        sessionId: ' new-backing-session ',
      });
    }
    if (method === 'chat.send') {
      return Promise.resolve({
        operationId: params?.idempotencyKey,
        action: 'start',
        sessionId: 'new-backing-session',
        goalId: 'goal-1',
        runId: params?.idempotencyKey,
        status: 'started',
      });
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
      message: 'build a release dashboard',
      intent: expect.objectContaining({ kind: 'session-goal-start', version: 1 }),
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

test('reconciles a pending Goal command with its persisted objective without duplication', async () => {
  const timestamp = Date.now();
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup' || method === 'chat.history') {
      return Promise.resolve({
        messages: [
          {
            role: 'user',
            content: 'write two poems',
            timestamp: timestamp + 10,
            __openclaw: { id: 'goal-message' },
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
  controller.setPendingUserMessage('/goal write two poems');

  await expect(controller.loadHistory(false, { reconcileSuspended: true })).resolves.toBe(true);

  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'write two poems',
      __openclaw: { id: 'goal-message' },
    }),
  ]);

  await expect(controller.loadHistory(false, { reconcileSuspended: true })).resolves.toBe(true);

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'write two poems',
      __openclaw: { id: 'goal-message' },
    }),
  ]);
});

test('settles truncated Thinking before a progress_card receipt restored from its assistant append', () => {
  vi.useFakeTimers();
  vi.setSystemTime(15_500);
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

  // This is the ordering from the captured run: the durable assistant row is
  // announced before its last Thinking snapshot and targeted Tool frame.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 15_600,
        content: [
          {
            type: 'thinking',
            thinking: 'Batch 1 completed. Both agents done. Now spawn batch 2: 新能源、生物医药.',
          },
          {
            type: 'toolCall',
            id: 'call-plan-after-thinking',
            name: 'progress_card',
            arguments: {
              plan: [
                { step: '批次1', status: 'completed' },
                { step: '批次2', status: 'in_progress' },
              ],
            },
          },
          {
            type: 'toolCall',
            id: 'call-spawn-after-plan',
            name: 'sessions_spawn',
            arguments: { task: '调研新能源' },
          },
        ],
      },
    },
  });

  const turn = controller.state.transcript.activeTurn!;
  const planTool = turn.toolById.get('call-plan-after-thinking');
  const spawnTool = turn.toolById.get('call-spawn-after-plan');
  expect(turn.items).toMatchObject([
    {
      type: 'thinking',
      status: 'completed',
      text: 'Batch 1 completed. Both agents done. Now spawn batch 2: 新能源、生物医药.',
    },
    { type: 'tool', toolCallId: 'call-plan-after-thinking', agentSequencePending: true },
    { type: 'tool', toolCallId: 'call-spawn-after-plan', agentSequencePending: true },
  ]);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: '新能源' },
    },
  });
  expect(turn.items[0]).toMatchObject({
    type: 'thinking',
    status: 'completed',
    text: 'Batch 1 completed. Both agents done. Now spawn batch 2: 新能源、生物医药.',
  });

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-plan-after-thinking',
        name: 'progress_card',
      },
    },
  });
  expect(planTool).not.toHaveProperty('agentSequencePending');

  // The item at seq=4 belongs to the observed plan Tool at seq=3. It must not
  // accidentally release the following recovered sessions_spawn boundary.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'item',
      data: {
        kind: 'tool',
        itemId: 'tool:call-plan-after-thinking',
        toolCallId: 'call-plan-after-thinking',
      },
    },
  });
  expect(spawnTool).toHaveProperty('agentSequencePending', true);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 5,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-spawn-after-plan',
        name: 'sessions_spawn',
      },
    },
  });
  expect(spawnTool).not.toHaveProperty('agentSequencePending');
  expect(turn.items.filter(item => item.type === 'thinking')).toHaveLength(1);
});

test('starts a continued Goal cleanly when browser annotations remain in the draft', async () => {
  const request = vi.fn((method: string, params?: Record<string, unknown>) =>
    Promise.resolve(
      method === 'sessions.create'
        ? { sessionId: 'gateway-session-1' }
        : {
            operationId: params?.idempotencyKey,
            action: 'start',
            sessionId: 'gateway-session-1',
            goalId: 'goal-2',
            runId: params?.idempotencyKey,
            status: 'started',
          },
    ),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'gateway-session-1';
  const goalPrompt = buildGoalFollowUpPrompt('Ship the release', 'Add release notes');
  const gatewayMessage = composeBrowserGatewayPrompt(goalPrompt, [
    {
      id: 'annotation-1',
      modelContext: 'Untrusted browser context',
      title: 'Release',
      displayUrl: 'example.com',
      markedRegionCount: 1,
      inspectedElement: false,
      dataUrl: 'data:image/png;base64,YWJj',
      fileName: 'browser-annotation.png',
      addedAt: 1,
    },
  ]);

  await controller.sendMessage('Add release notes', [], gatewayMessage);

  const sendParams = request.mock.calls.find(([method]) => method === 'chat.send')?.[1];
  expect(sendParams?.intent).toMatchObject({ kind: 'session-goal-start', version: 1 });
  expect(sendParams?.message).toBe('Add release notes');
  expect(JSON.stringify(controller.state.chatMessages)).not.toContain('/goal start');
  expect(controller.state.chatMessages[controller.state.chatMessages.length - 1]).toMatchObject({
    role: 'user',
    content: 'Add release notes',
  });
});

test('replaces an interrupted active turn as soon as Goal resume is accepted', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'session-runtime-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
  const interrupted = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-paused', sessionId: controller.state.currentSessionId },
    { now: () => 100, createId: prefix => `${prefix}-paused` },
  );
  interrupted.status = 'aborted';
  interrupted.items.push({
    id: 'terminal-paused',
    runId: 'run-paused',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 100,
    updatedAt: 200,
    type: 'terminal',
    status: 'aborted',
    message: 'The run was interrupted.',
  });
  const preservedPartialMessage = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'Partial reasoning' }],
    interrupted: true,
  };
  controller.state.chatMessages = [preservedPartialMessage];

  controller.beginGoalResume(controller.state.sessionKey, 'run-resumed');

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-resumed');
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId: 'run-resumed',
    sessionId: 'session-runtime-1',
    status: 'running',
    items: [],
  });
  expect(controller.state.chatMessages).toEqual([preservedPartialMessage]);
});

test('does not apply a Goal resume receipt to a different selected session', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-2';
  controller.state.transcript.sessionKey = controller.state.sessionKey;

  controller.beginGoalResume('agent:main:justdo:session-1', 'run-session-1');

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
});

test('reconciles a pending Goal command from session.message without duplication', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.setPendingUserMessage('/goal write two poems');

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      messageId: 'goal-message',
      messageSeq: 1,
      message: { role: 'user', content: 'write two poems' },
    },
  });

  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: 'write two poems',
      __openclaw: { id: 'goal-message', seq: 1 },
    }),
  ]);
});
