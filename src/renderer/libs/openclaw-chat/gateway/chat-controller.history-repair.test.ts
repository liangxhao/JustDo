import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectTurnItems } from '@/libs/openclaw-chat/model/project-turn-items';
import { projectWaitingStatus } from '@/libs/openclaw-chat/model/run-activity';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('adopts and replays a v2026.9.2 in-flight Thinking, Tool, and Content snapshot', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({
    messages: [{ role: 'user', content: 'continue the task', timestamp: 1_000 }],
    sessionId: 'sid-1',
    sessionInfo: {
      sessionId: 'sid-1',
      updatedAt: 1_120,
      totalTokens: 42_000,
      totalTokensFresh: false,
      contextTokens: 200_000,
      modelProvider: 'openai',
      model: 'gpt-5.6-sol',
      hasActiveRun: true,
      activeRunIds: ['run-live'],
      status: 'running',
    },
    inFlightRun: {
      runId: 'run-live',
      text: 'The recovered answer is still streaming.',
      startedAt: 1_100,
      events: [
        {
          runId: 'run-live',
          seq: 1,
          stream: 'thinking',
          ts: 1_101,
          sessionKey,
          data: { thinking: 'Recovered reasoning' },
        },
        {
          runId: 'run-live',
          seq: 2,
          stream: 'tool',
          ts: 1_102,
          sessionKey,
          data: { phase: 'start', toolCallId: 'tool-1', name: 'read', args: { path: 'a' } },
        },
        {
          runId: 'run-live',
          seq: 3,
          stream: 'tool',
          ts: 1_103,
          sessionKey,
          data: {
            phase: 'update',
            toolCallId: 'tool-1',
            name: 'read',
            partialResult: 'halfway',
          },
        },
        {
          runId: 'run-live',
          seq: 4,
          stream: 'assistant',
          ts: 1_104,
          sessionKey,
          data: {
            text: 'The recovered answer is still streaming.',
            progressSegmentFirstSeq: 4,
          },
        },
      ],
    },
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await expect(controller.loadHistory()).resolves.toBe(true);

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-live');
  expect(controller.state.contextUsage).toEqual({
    sessionKey,
    sessionId: 'sid-1',
    totalTokens: 42_000,
    totalTokensFresh: false,
    contextTokens: 200_000,
    updatedAt: 1_120,
    modelRef: 'openai/gpt-5.6-sol',
  });
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId: 'run-live',
    lastAgentSeq: -1,
    lastSnapshotAgentSeq: 4,
    items: [
      { type: 'thinking', status: 'completed', text: 'Recovered reasoning' },
      { type: 'tool', status: 'running', toolCallId: 'tool-1', output: 'halfway' },
      { type: 'content', status: 'streaming', text: 'The recovered answer is still streaming.' },
    ],
  });
});

test('accepts cumulative Agent snapshots with sequence gaps without reconnecting', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const recoverFromGap = vi.fn();
  const controller = new ChatController();
  controller.state.client = { request: vi.fn(), recoverFromGap } as never;
  controller.state.connected = true;
  controller.state.initialHistoryReady = true;
  controller.state.sessionKey = sessionKey;
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-live',
      seq: 7,
      stream: 'thinking',
      data: { thinking: '你' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-live',
      seq: 16,
      stream: 'thinking',
      data: { thinking: '你好' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-live',
      seq: 17,
      stream: 'usage',
      data: { inputTokens: 12, outputTokens: 4 },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-live',
      seq: 18,
      stream: 'assistant',
      data: { text: '你好！有什么我可以帮你的吗？' },
    },
  });

  expect(recoverFromGap).not.toHaveBeenCalled();
  expect(controller.state.transcript.activeTurn?.lastAgentSeq).toBe(18);
  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed', text: '你好' },
    { type: 'content', status: 'streaming', text: '你好！有什么我可以帮你的吗？' },
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

test('renders assistant text from session.message during repeated sessions_yield waits', () => {
  vi.useFakeTimers();
  vi.setSystemTime(12_000);
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

  const firstUpdate = 'task1_fib 已完成，其余 4 个仍在执行。';
  streamListener.mockClear();
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 12_100,
        content: [
          { type: 'thinking', thinking: 'Inspect the first completed subagent.' },
          { type: 'text', text: firstUpdate },
          {
            type: 'toolCall',
            id: 'call-yield-content-1',
            name: 'sessions_yield',
            arguments: { message: '继续等待。' },
          },
        ],
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed' },
    {
      type: 'content',
      status: 'completed',
      text: firstUpdate,
      followingToolCallId: 'call-yield-content-1',
    },
    { type: 'tool', status: 'running', toolCallId: 'call-yield-content-1' },
  ]);
  expect(streamListener).toHaveBeenCalledWith('terminal');

  // A late canonical assistant snapshot must update the restored segment in
  // place instead of duplicating the already visible progress message.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'assistant',
      data: { text: firstUpdate },
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
        phase: 'start',
        toolCallId: 'call-yield-content-1',
        name: 'sessions_yield',
      },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-yield-content-1',
        name: 'sessions_yield',
        result: '{"status":"partial","pending":3}',
      },
    },
  });

  const secondUpdate = 'task2_primes 也已完成，继续等待剩余 3 个。';
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 12_200,
        content: [
          { type: 'text', text: secondUpdate },
          {
            type: 'toolCall',
            id: 'call-yield-content-2',
            name: 'sessions_yield',
            arguments: { message: '继续等待剩余任务。' },
          },
        ],
      },
    },
  });

  expect(
    controller.state.transcript.activeTurn?.items
      .filter(item => item.type === 'content')
      .map(item => item.text),
  ).toEqual([firstUpdate, secondUpdate]);
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'content',
    'tool',
    'content',
    'tool',
  ]);
});

test('deduplicates a late assistant snapshot after history settles its recovered Tool', () => {
  vi.useFakeTimers();
  vi.setSystemTime(13_000);
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

  const firstUpdate = 'task1 已完成，继续等待。';
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 13_100,
        content: [
          { type: 'text', text: firstUpdate },
          { type: 'toolCall', id: 'call-yield-race-1', name: 'sessions_yield' },
        ],
      },
    },
  });

  // Durable Tool completion can beat both canonical assistant and Tool Agent
  // frames. It must not discard the replay fingerprint for the restored text.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 13_150,
        toolCallId: 'call-yield-race-1',
        toolName: 'sessions_yield',
        content: '{"status":"partial","pending":2}',
      },
    },
  });

  const secondUpdate = 'task2 已完成，只剩最后一个。';
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 13_200,
        content: [
          { type: 'text', text: secondUpdate },
          { type: 'toolCall', id: 'call-yield-race-2', name: 'sessions_yield' },
        ],
      },
    },
  });

  // The old snapshot arrives while the next recovered Tool is pending. It
  // belongs to the first segment and must not overwrite or duplicate either.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'assistant',
      data: { text: firstUpdate },
    },
  });

  expect(
    controller.state.transcript.activeTurn?.items
      .filter(item => item.type === 'content')
      .map(item => item.text),
  ).toEqual([firstUpdate, secondUpdate]);
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'content',
    'tool',
    'content',
    'tool',
  ]);
  expect(controller.state.transcript.activeTurn?.toolById.get('call-yield-race-2')).toHaveProperty(
    'agentSequencePending',
    true,
  );
});

test('preserves mixed text and Thinking block order before a recovered Tool', () => {
  vi.useFakeTimers();
  vi.setSystemTime(14_800);
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
        timestamp: 14_900,
        content: [
          { type: 'text', text: '正文 A' },
          { type: 'thinking', thinking: '推理 R' },
          { type: 'text', text: '正文 B' },
          { type: 'toolCall', id: 'call-mixed-order', name: 'sessions_yield' },
        ],
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: '正文 A' },
    { type: 'thinking', text: '推理 R' },
    { type: 'content', text: '正文 B', followingToolCallId: 'call-mixed-order' },
    { type: 'tool', toolCallId: 'call-mixed-order' },
  ]);

  // Replaying the canonical streams must consume each recovered segment in
  // order without moving or duplicating any of them.
  for (const [seq, stream, text] of [
    [2, 'assistant', '正文 A'],
    [3, 'thinking', '推理 R'],
    [4, 'assistant', '正文 B'],
  ] as const) {
    handleEvent({
      event: 'agent',
      payload: { session: sessionKey, runId: 'run-1', seq, stream, data: { text } },
    });
  }
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'content',
    'thinking',
    'content',
    'tool',
  ]);
});

test('restores nested multi-Tool assistant segments idempotently', () => {
  vi.useFakeTimers();
  vi.setSystemTime(14_950);
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
  const message = {
    type: 'message',
    message: {
      role: 'assistant',
      timestamp: 14_960,
      content: [
        { type: 'text', text: '第一段' },
        { type: 'toolCall', id: 'call-nested-1', name: 'sessions_yield' },
        { type: 'text', text: '第二段' },
        { type: 'toolCall', id: 'call-nested-2', name: 'sessions_yield' },
      ],
    },
  };
  for (let index = 0; index < 2; index += 1) {
    handleEvent({
      event: 'session.message',
      payload: { sessionKey, activeRunIds: ['run-1'], message },
    });
  }

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: '第一段', followingToolCallId: 'call-nested-1' },
    { type: 'tool', toolCallId: 'call-nested-1' },
    { type: 'content', text: '第二段', followingToolCallId: 'call-nested-2' },
    { type: 'tool', toolCallId: 'call-nested-2' },
  ]);
});

test('keeps late Thinking before a sessions_yield recovered from the same assistant append', () => {
  vi.useFakeTimers();
  vi.setSystemTime(15_000);
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
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: 'Batch 1 is partial' },
    },
  });

  // Transcript notifications and Agent frames use independent delivery paths.
  // The committed assistant row can therefore restore the full Thinking while
  // its final Agent snapshot is still in flight.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 15_100,
        content: [
          {
            type: 'thinking',
            thinking: 'Batch 1 is partial, so wait for the remaining agent.',
          },
          {
            type: 'toolCall',
            id: 'call-yield-late-thinking',
            name: 'sessions_yield',
            arguments: { message: '等待剩余 agent。' },
          },
        ],
      },
    },
  });

  const recovered = controller.state.transcript.activeTurn?.toolById.get(
    'call-yield-late-thinking',
  );
  expect(recovered).toMatchObject({
    status: 'running',
    agentSequencePending: true,
  });
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({
    type: 'thinking',
    status: 'completed',
    text: 'Batch 1 is partial, so wait for the remaining agent.',
  });

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'thinking',
      data: { text: 'remaining agent' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({
    type: 'thinking',
    status: 'completed',
    text: 'Batch 1 is partial, so wait for the remaining agent.',
  });

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-yield-late-thinking',
        name: 'sessions_yield',
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({
    type: 'thinking',
    status: 'completed',
  });
  expect(controller.state.transcript.activeTurn?.items[1]).toBe(recovered);
  expect(recovered).toMatchObject({ firstSeq: 4, lastSeq: 4 });
  expect(recovered).not.toHaveProperty('agentSequencePending');
});

test('uses only the matching Tool item to release a recovered sessions_yield boundary', () => {
  vi.useFakeTimers();
  vi.setSystemTime(16_000);
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
        timestamp: 16_100,
        content: [
          { type: 'thinking', thinking: 'Wait for the current batch.' },
          {
            type: 'toolCall',
            id: 'call-yield-item-fallback',
            name: 'sessions_yield',
          },
        ],
      },
    },
  });

  const recovered = controller.state.transcript.activeTurn?.toolById.get(
    'call-yield-item-fallback',
  );
  expect(recovered).toMatchObject({
    status: 'running',
    agentSequencePending: true,
  });
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({
    type: 'thinking',
    recoveredSnapshotText: 'Wait for the current batch.',
  });

  // Status/commentary items are unrelated to the Tool and must not release its
  // boundary even though they share the Agent item stream.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'item',
      data: { kind: 'status', itemId: 'fast-mode-auto:on' },
    },
  });
  expect(recovered).toHaveProperty('agentSequencePending', true);

  // The targeted Tool frame can be missed while its following per-client Tool
  // item still arrives with a stable Tool call ID.
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'item',
      data: {
        kind: 'tool',
        itemId: 'tool:call-yield-item-fallback',
        toolCallId: 'call-yield-item-fallback',
      },
    },
  });
  expect(recovered).not.toHaveProperty('agentSequencePending');
  expect(recovered).not.toHaveProperty('recoveredPreToolThinkingText');

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 4,
      stream: 'thinking',
      data: { text: 'Continue with the next batch.' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed', text: 'Wait for the current batch.' },
    { type: 'tool', toolCallId: 'call-yield-item-fallback' },
    { type: 'thinking', status: 'running', text: 'Continue with the next batch.' },
  ]);
});

test('settles running Thinking when the first recovered Tool row is result-only', () => {
  vi.useFakeTimers();
  vi.setSystemTime(16_500);
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
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: 'A truncated pre-Tool snapshot' },
    },
  });

  // Both the assistant Tool-call append and Agent Tool frames were missed.
  // The first durable evidence is the result row itself.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 16_600,
        toolCallId: 'call-result-only',
        toolName: 'exec',
        content: 'ok',
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed', text: 'A truncated pre-Tool snapshot' },
    {
      type: 'tool',
      toolCallId: 'call-result-only',
      status: 'completed',
      output: 'ok',
    },
  ]);
  const recovered = controller.state.transcript.activeTurn?.toolById.get('call-result-only');
  expect(recovered).not.toHaveProperty('agentSequencePending');
});

test('releases result-only sessions_yield ordering without inventing a terminal payload', () => {
  vi.useFakeTimers();
  vi.setSystemTime(16_750);
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
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: 'Wait for the current batch.' },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 16_800,
        toolCallId: 'call-yield-result-only',
        toolName: 'sessions_yield',
        content: '',
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'thinking', status: 'completed', text: 'Wait for the current batch.' },
    {
      type: 'tool',
      toolCallId: 'call-yield-result-only',
      status: 'running',
    },
  ]);
  const recovered = controller.state.transcript.activeTurn?.toolById.get('call-yield-result-only');
  expect(recovered).not.toHaveProperty('agentSequencePending');
  expect(recovered?.output).toBeUndefined();
});

test('releases recovered Tool ordering when history supplies the missed terminal frame', () => {
  vi.useFakeTimers();
  vi.setSystemTime(17_000);
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
        timestamp: 17_100,
        content: [
          {
            type: 'toolCall',
            id: 'call-yield-history-result',
            name: 'sessions_yield',
          },
        ],
      },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: 'Wait for the last agent.' },
    },
  });

  const recovered = controller.state.transcript.activeTurn?.toolById.get(
    'call-yield-history-result',
  );
  expect(recovered).toMatchObject({ status: 'running', agentSequencePending: true });

  // Both canonical Tool frames are absent. The committed result must settle
  // the pre-Tool Thinking boundary before the next model continuation starts.
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 17_200,
        toolCallId: 'call-yield-history-result',
        toolName: 'sessions_yield',
        content: '{"status":"partial","pending":1}',
      },
    },
  });

  expect(recovered).toMatchObject({ status: 'completed' });
  expect(recovered).not.toHaveProperty('agentSequencePending');
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({
    type: 'thinking',
    status: 'completed',
  });

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'thinking',
      data: { text: 'Process the partial result and continue.' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
    'thinking',
  ]);
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

test('does not restore untimed or foreign-run Tool rows', () => {
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
      message: {
        ...toolMessage('call-metadata-run', 'sessions_yield', 20_100),
        metadata: { runId: 'run-other' },
      },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      activeRunIds: ['run-current'],
      message: {
        ...toolMessage('call-openclaw-run', 'sessions_yield', 20_100),
        __openclaw: { runId: 'run-other' },
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
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey,
    limit: 250,
    maxChars: 500_000,
  });
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

test('recovers an unsequenced internal Agent gap only for the selected run owner', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const recoverFromGap = vi.fn();
  const controller = new ChatController();
  controller.state.client = { recoverFromGap } as never;
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
      lifecycleGeneration: 'generation-1',
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      sessionId: 'session-current',
      lifecycleGeneration: 'generation-1',
      runId: 'run-1',
      stream: 'error',
      data: { reason: 'seq gap', expected: 2, received: 4 },
    },
  });
  expect(recoverFromGap).toHaveBeenCalledOnce();
  expect(recoverFromGap).toHaveBeenCalledWith('agent stream sequence gap');

  for (const payload of [
    {
      sessionKey: 'agent:main:justdo:session-other',
      sessionId: 'session-current',
      lifecycleGeneration: 'generation-1',
      runId: 'run-1',
    },
    {
      sessionKey,
      sessionId: 'session-current',
      lifecycleGeneration: 'generation-1',
      runId: 'run-other',
    },
    {
      sessionKey,
      sessionId: 'session-other',
      lifecycleGeneration: 'generation-1',
      runId: 'run-1',
    },
    {
      sessionKey,
      sessionId: 'session-current',
      lifecycleGeneration: 'generation-other',
      runId: 'run-1',
    },
  ]) {
    handleEvent({
      event: 'agent',
      payload: {
        ...payload,
        stream: 'error',
        data: { reason: 'seq gap', expected: 2, received: 4 },
      },
    });
  }
  expect(recoverFromGap).toHaveBeenCalledOnce();
});

test.each([false, true])(
  'settles Thinking, Tool and Content from Stop confirmation without terminal frames (background=%s)',
  async background => {
    const controller = new ChatController();
    controller.state.sessionKey = 'session-stop';
    controller.state.transcript.sessionKey = 'session-stop';
    controller.state.chatSending = true;
    controller.state.chatRunId = 'run-stop';
    const turn = beginAssistantTurn(
      controller.state.transcript,
      { runId: 'run-stop' },
      {
        now: () => 100,
        createId: prefix => `${prefix}-stop`,
      },
    );
    const base = { runId: turn.runId, firstSeq: 1, lastSeq: 1, startedAt: 100, updatedAt: 100 };
    turn.items.push(
      {
        ...base,
        id: 'thinking-stop',
        type: 'thinking',
        status: 'running',
        text: 'Thinking slowly',
      },
      {
        ...base,
        id: 'tool-stop',
        type: 'tool',
        status: 'running',
        toolCallId: 'call-stop',
        name: 'exec',
      },
      {
        ...base,
        id: 'content-stop',
        type: 'content',
        status: 'streaming',
        sourceMode: 'snapshot',
        text: 'Partial answer',
      },
    );
    if (background) {
      await controller.switchSession('session-other');
      controller.state.chatSending = true;
      controller.state.chatRunId = 'run-other';
    }

    controller.settleConfirmedRun('session-stop', 'run-stop', 'aborted');
    controller.settleConfirmedRun('session-stop', 'run-stop', 'aborted');

    expect(turn.status).toBe('aborted');
    expect(turn.items.map(item => item.status)).toEqual([
      'interrupted',
      'cancelled',
      'interrupted',
      'aborted',
    ]);
    if (background) {
      expect(controller.state.chatRunId).toBe('run-other');
      expect(controller.state.chatSending).toBe(true);
      await controller.switchSession('session-stop');
    }
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.chatMessages).toHaveLength(1);
  },
);
