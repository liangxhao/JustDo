import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { postFinalHistoryHasCaughtUp } from '@/libs/openclaw-chat/gateway/chat-controller-recovery';
import { beginAssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each([
  { content: [{ type: 'thinking', thinking: 'Still reasoning' }] },
  { content: 'Still working', phase: 'commentary' },
  { content: 'Still working', openclawStreamFallback: { source: 'segment', itemId: 'progress-1' } },
])(
  'does not treat persisted reasoning or commentary as recovered terminal content: %j',
  projection => {
    const controller = new ChatController();
    controller.state.chatMessages = [
      {
        role: 'assistant',
        ...projection,
        __openclaw: { id: 'progress-1', seq: 2, runId: 'run-1' },
      },
    ];
    expect(
      postFinalHistoryHasCaughtUp.call(
        controller as never,
        { runId: 'run-1', baselineMessageSeq: 1, baselineCompleteMessageCount: 0 } as never,
      ),
    ).toBe(false);
  },
);

test('publishes matching side results and keeps their final event out of the transcript', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const listener = vi.fn();
  const streamListener = vi.fn();
  controller.onSideChatResult(listener);
  controller.onSideChatStream(streamListener);
  await controller.sendSideQuestion('what changed?', 'btw-run-1');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'chat.side_result',
    payload: {
      kind: 'btw',
      runId: 'btw-run-1',
      sessionKey: 'agent:main:justdo:session-1',
      question: 'what changed?',
      text: 'Only the sidebar.',
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      runId: 'btw-run-1',
      sessionKey: 'agent:main:justdo:session-1',
      state: 'final',
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: 'agent:main:justdo:session-1',
      runId: 'btw-run-1',
      seq: 3,
      stream: 'assistant',
      data: { text: 'late duplicate side answer' },
    },
  });

  expect(listener).toHaveBeenCalledWith({
    runId: 'btw-run-1',
    sessionKey: 'agent:main:justdo:session-1',
    question: 'what changed?',
    text: 'Only the sidebar.',
    isError: false,
  });
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(streamListener).toHaveBeenCalledWith({
    runId: 'btw-run-1',
    sessionKey: 'agent:main:justdo:session-1',
    turn: null,
    kind: 'terminal',
  });
});

test('classifies the nested participation error returned by OpenClaw', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockRejectedValue({
    gatewayCode: 'INVALID_REQUEST',
    details: { code: 'SESSION_PARTICIPATION_REQUIRED' },
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

  await (
    controller as unknown as {
      loadProgressCard(sessionKey: string, force?: boolean): Promise<void>;
    }
  ).loadProgressCard(sessionKey, true);

  expect(controller.state.progressCardError).toBe('access-denied');
  expect(controller.state.progressCard).toBeNull();
});

test.each([undefined, 'latest/model'])(
  'keeps live progress ahead of earlier appends and honors terminal metadata (%s)',
  async finalModel => {
    const sessionKey = 'agent:main:justdo:session-1';
    const request = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started' });
    const controller = new ChatController();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = sessionKey;
    await controller.sendMessage('switch during a run');
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
        data: { phase: 'progress', stage: 'waiting_model', provider: 'latest', model: 'model' },
      },
    });
    const nativeMessage = {
      role: 'assistant',
      content: 'earlier output',
      provider: 'earlier',
      model: 'model',
      __openclaw: { id: 'native', seq: 1, runId: 'run-1' },
    };
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        runId: 'run-1',
        messageSeq: 1,
        message: nativeMessage,
      },
    });
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe('latest/model');
    request.mockResolvedValue({ messages: [nativeMessage] });
    await controller.loadHistory();
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe('latest/model');
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
    expect(controller.getCurrentTurnTiming()?.modelRef).toBe(finalModel ?? 'earlier/model');
  },
);

test('repairs the cached final model from history when the native append was missed', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  await controller.sendMessage('use fallback');
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
      data: { phase: 'progress', stage: 'waiting_model', provider: 'initial', model: 'model' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'done' },
    },
  });
  expect(controller.getCurrentTurnTiming()?.modelRef).toBe('initial/model');
  request.mockResolvedValue({
    messages: [
      { role: 'user', content: 'use fallback', timestamp: Date.now() - 10 },
      {
        role: 'assistant',
        content: 'done',
        provider: 'fallback',
        model: 'actual-model',
        __openclaw: { id: 'native-final', seq: 2, runId: 'run-1' },
      },
    ],
  });

  await controller.loadHistory();

  expect(controller.getCurrentTurnTiming()?.modelRef).toBe('fallback/actual-model');
});

test('does not resurrect a terminal run from a stale in-flight snapshot', () => {
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
      sessionKey,
      runId: 'run-finished',
      seq: 4,
      stream: 'assistant',
      data: { text: 'finished answer' },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'run-finished',
      state: 'final',
      message: { role: 'assistant', content: 'finished answer' },
    },
  });

  (
    controller as unknown as {
      applyInFlightRunSnapshot(
        snapshot: Record<string, unknown>,
        sessionKey: string,
        sessionId: string | null,
        requestRunId: string | null,
        sessionInfo: Record<string, unknown>,
      ): void;
    }
  ).applyInFlightRunSnapshot(
    {
      runId: 'run-finished',
      text: 'stale partial',
      events: [
        {
          runId: 'run-finished',
          seq: 1,
          stream: 'thinking',
          ts: 1_000,
          sessionKey,
          data: { thinking: 'stale reasoning' },
        },
      ],
    },
    sessionKey,
    null,
    null,
    { hasActiveRun: true, activeRunIds: ['run-finished'] },
  );

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.transcript.activeTurn?.status).toBe('final');
  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: 'finished answer' },
  ]);
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

test('removes a rejected managed-terminal candidate before the revision continues', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  const streamListener = vi.fn();
  controller.onStream(streamListener);
  controller.state.sessionKey = sessionKey;
  const internal = controller as unknown as {
    assistantSnapshotRunId: string | null;
    handleEvent(event: { event: string; payload: unknown }): void;
  };

  internal.handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  internal.handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 2,
      stream: 'assistant',
      data: {
        text: 'Rejected candidate',
        justdoTerminalGuardObservation: { token: 'candidate-1', action: 'update' },
      },
    },
  });
  expect(controller.state.transcript.activeTurn?.items).toMatchObject([
    { type: 'content', text: 'Rejected candidate' },
  ]);
  expect(internal.assistantSnapshotRunId).toBe('run-1');

  streamListener.mockClear();
  internal.handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'run-1',
      seq: 3,
      stream: 'assistant',
      data: {
        justdoTerminalGuardObservation: { token: 'candidate-1', action: 'rollback' },
      },
    },
  });

  expect(controller.state.transcript.activeTurn?.items).toEqual([]);
  expect(internal.assistantSnapshotRunId).toBeNull();
  expect(streamListener).toHaveBeenCalledWith('terminal');
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

test('reconciles a pending transcript invalidation after a renderable final message', async () => {
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
    limit: 250,
    maxChars: 500_000,
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'Final answer' }],
    }),
  ]);
});

test('never lets a truncated final overwrite the complete live assistant snapshot', async () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:justdo:session-1';
  const fullText = `head:${'x'.repeat(9_000)}:tail`;
  const request = vi.fn().mockResolvedValue({
    messages: [
      {
        role: 'assistant',
        content: fullText,
        __openclaw: { id: 'assistant-1', seq: 1, runId: 'run-1' },
      },
    ],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: null },
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
      sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'assistant',
      data: { text: fullText },
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'run-1',
      state: 'final',
      message: {
        role: 'assistant',
        content: `${fullText.slice(0, 8_000)}\n...(truncated)...`,
        __openclaw: { id: 'assistant-1', truncated: true, reason: 'display-cap' },
      },
    },
  });

  expect(JSON.stringify(controller.state.chatMessages)).not.toContain('...(truncated)...');
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: fullText, runId: 'run-1' }),
  ]);

  await vi.advanceTimersByTimeAsync(100);
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey,
    limit: 250,
    maxChars: 500_000,
  });
  expect(JSON.stringify(controller.state.chatMessages)).not.toContain('...(truncated)...');
});

test('does not apply a later truncated session.message over a complete terminal reply', () => {
  vi.useFakeTimers();
  const sessionKey = 'agent:main:justdo:session-1';
  const fullText = `complete:${'y'.repeat(9_000)}`;
  const controller = new ChatController();
  controller.state.client = { request: vi.fn() } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: null },
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
      sessionKey,
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: fullText },
    },
  });
  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      runId: 'run-1',
      message: {
        role: 'assistant',
        content: `${fullText.slice(0, 8_000)}\n...(truncated)...`,
        __openclaw: {
          id: 'assistant-1',
          seq: 1,
          truncated: true,
          reason: 'display-cap',
        },
      },
    },
  });

  expect(JSON.stringify(controller.state.chatMessages)).not.toContain('...(truncated)...');
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ content: fullText, runId: 'run-1' }),
  ]);
});

test('keeps live tool messages until the subscribed terminal row arrives', async () => {
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

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload?: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      messageSeq: 1,
      messageId: 'assistant-1',
      message: {
        ...persistedFinal,
        __openclaw: { id: 'assistant-1', seq: 1, runId: 'run-1' },
      },
    },
  });

  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'Final answer' }],
      __openclaw: { id: 'assistant-1', seq: 1, runId: 'run-1' },
    }),
  ]);
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

  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 250,
    maxChars: 500_000,
  });
});

test('bounds missing-final recovery when history only gains a tool result', async () => {
  vi.useFakeTimers();
  const persistedUser = {
    role: 'user',
    content: 'Run a tool',
    __openclaw: { id: 'message-1', seq: 1 },
  };
  const persistedTool = {
    role: 'toolResult',
    content: [{ type: 'text', text: 'done' }],
    __openclaw: { id: 'message-2', seq: 2, runId: 'run-1' },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ messages: [persistedUser] })
    .mockResolvedValueOnce({ messages: [persistedUser] })
    .mockResolvedValue({ messages: [persistedUser, persistedTool] });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = [persistedUser];
  controller.state.transcript.persistedMessages = controller.state.chatMessages;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';

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
    },
  });

  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(400);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1500);
  expect(request).toHaveBeenCalledTimes(3);
  expect(controller.state.chatMessages).toEqual([persistedUser, persistedTool]);

  await vi.advanceTimersByTimeAsync(3000);
  expect(request).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request).toHaveBeenCalledTimes(4);
});

test.each([true, false])(
  'recovers a missing final despite matching user and intermediate tool run identities (final runId=%s)',
  async hasFinalRunId => {
    vi.useFakeTimers();
    const user = {
      role: 'user',
      content: 'Request',
      __openclaw: { id: 'user-1', seq: 1, runId: 'run-1' },
    };
    const tool = {
      role: 'toolResult',
      content: 'Tool output',
      __openclaw: { id: 'tool-1', seq: 2, runId: 'run-1' },
    };
    const intermediate = {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Working' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      ],
      __openclaw: { id: 'intermediate-1', seq: 3, runId: 'run-1' },
    };
    const final = {
      role: 'assistant',
      content: 'Recovered answer',
      stopReason: 'stop',
      __openclaw: { id: 'final-1', seq: 4, ...(hasFinalRunId ? { runId: 'run-1' } : {}) },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [user] })
      .mockResolvedValueOnce({ messages: [user, tool] })
      .mockResolvedValueOnce({ messages: [user, tool, intermediate] })
      .mockResolvedValue({ messages: [user, tool, intermediate, final] });
    const controller = new ChatController();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.chatMessages = [user];
    controller.state.transcript.persistedMessages = controller.state.chatMessages;
    controller.state.chatSending = true;
    controller.state.chatRunId = 'run-1';
    (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent({
      event: 'chat',
      payload: { sessionKey: controller.state.sessionKey, runId: 'run-1', state: 'final' },
    });

    for (const [index, delay] of [100, 400, 1500, 3000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(request).toHaveBeenCalledTimes(index + 1);
    }
    expect(controller.state.chatMessages).toEqual([user, tool, intermediate, final]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(4);
  },
);

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
      stream: 'assistant',
      data: { text: '', delta: 'NO_REPLY' },
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
      seq: 3,
      stream: 'lifecycle',
      data: { phase: 'finishing' },
    },
  });

  expect(controller.state.transcript.activeTurn?.items ?? []).toHaveLength(0);
  expect(streamListener).toHaveBeenCalledTimes(1);
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

test('persists an ordinary chat error before the history refresh replaces live state', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'physical-session-1';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'physical-session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-1', sessionId: 'physical-session-1', startedAt: 500 },
    { now: () => Date.now(), createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey: 'justdo:session-1',
      sessionId: 'physical-session-1',
      state: 'error',
      errorMessage: 'Provider request failed.',
    },
  });

  const stored = [...values.values()].find(value => value.includes('Provider request failed.'));
  expect(stored).toBeDefined();
  expect(JSON.parse(stored ?? '[]')).toEqual([
    expect.objectContaining({
      sessionKey,
      sessionId: 'physical-session-1',
      runId: 'run-1',
      error: 'Provider request failed.',
      promptTimestamp: 500,
    }),
  ]);
});

test('does not persist a stale chat error rejected by the transcript reducer', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-current';
  beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-current', startedAt: 500 },
    { now: () => Date.now(), createId: prefix => `${prefix}-1` },
  );

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      runId: 'run-stale',
      sessionKey,
      state: 'error',
      errorMessage: 'Stale provider failure.',
    },
  });

  expect([...values.values()].some(value => value.includes('Stale provider failure.'))).toBe(false);
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-current');
});

test('settles an internal managed handoff failure without exposing it to the user', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.transcript.sessionKey = controller.state.sessionKey;
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
    session: controller.state.sessionKey,
    data: {
      phase: 'error',
      error: 'Managed subagent terminal handoff could not be persisted.',
    },
  });
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey: controller.state.sessionKey,
      state: 'error',
      errorMessage: 'Managed subagent terminal handoff could not be persisted.',
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatRunId).toBeNull();
  expect(controller.state.lastError).toBeNull();
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId: 'run-1',
    status: 'final',
    items: [],
  });
  expect(controller.state.transcript.recentRuns.get('run-1')?.terminalStatus).toBe('final');
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

test('keeps a lifecycle failure visible when refreshed history has only the user prompt', async () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'run-1';
  const error = 'Inline API key is temporarily disabled.';
  const timestamp = Date.now();
  const firstController = new ChatController();
  firstController.state.sessionKey = sessionKey;
  firstController.state.chatSending = true;
  firstController.state.chatRunId = runId;
  (
    firstController as unknown as {
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId,
    stream: 'lifecycle',
    session: sessionKey,
    data: { phase: 'error', error },
  });

  const restartedController = new ChatController();
  restartedController.state.sessionKey = sessionKey;
  restartedController.state.connected = true;
  restartedController.state.client = {
    request: vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: 'Continue', timestamp: timestamp - 250 }],
    }),
  } as never;

  await restartedController.loadHistory();

  expect(restartedController.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'user', content: 'Continue' }),
    expect.objectContaining({ role: 'system', content: error, isError: true, runId }),
  ]);
});

test('keeps one assistant row when session.message beats chat.final', () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const prompt = {
    role: 'user',
    content: 'prompt',
    __openclaw: { id: 'message-1', seq: 1, runId: 'run-1' },
  };
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [prompt];
  controller.state.transcript.persistedMessages = [prompt];
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
      runId: 'run-1',
      hasActiveRun: true,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        content: 'durable reply',
        __openclaw: { id: 'message-2', seq: 2, runId: 'run-1' },
      },
    },
  });
  expect(controller.state.chatMessages).toHaveLength(2);

  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'run-1',
      state: 'final',
      message: { role: 'assistant', content: 'durable reply' },
    },
  });

  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.chatMessages[1]).toMatchObject({
    role: 'assistant',
    content: 'durable reply',
    runId: 'run-1',
    __openclaw: { id: 'message-2', seq: 2, runId: 'run-1' },
  });
});

test.each(['completed', 'aborted'] as const)(
  'settles an unknown request from a confirmed %s receipt',
  async state => {
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
        clientTurnId: 'uncertain',
        onRequestUnknown: () => undefined,
      })
      .catch(() => undefined);
    controller.settleConfirmedRun('session-a', 'uncertain', state);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
  },
);
