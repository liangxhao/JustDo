import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId: 'gateway-run-1',
    stream: 'assistant',
    session: 'agent:main:justdo:session-1',
    data: { text: 'first response chunk' },
  });

  expect(controller.state.chatRunId).toBe('gateway-run-1');
  expect(controller.state.chatStream).toBe('first response chunk');

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
      handleAgentEvent(payload: Record<string, unknown>): void;
    }
  ).handleAgentEvent({
    runId: 'gateway-run-1',
    stream: 'assistant',
    session: 'agent:main:justdo:session-1',
    data: { text: 'still running' },
  });
  rejectSend?.(new Error('request timeout: chat.send'));
  await sending;

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('gateway-run-1');
  expect(controller.state.chatStream).toBe('still running');
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
    .mockResolvedValueOnce({ messages: [] })
    .mockResolvedValueOnce({
      checkpoints: [
        {
          checkpointId: 'checkpoint-1',
          summary: 'The compacted conversation summary.',
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
        id: 'checkpoint-1',
        summary: 'The compacted conversation summary.',
        tokensBefore: 25_329,
        tokensAfter: 1_069,
      },
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

test('renders an error result and does not refresh history when session compaction fails', async () => {
  const request = vi.fn().mockRejectedValue(new Error('compact unavailable'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage('/compact keep recent decisions');

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

test('uses the latest checkpoint when the history marker id differs', async () => {
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
        id: 'checkpoint-1',
        summary: 'Persisted compact summary.',
        tokensBefore: 25_329,
        tokensAfter: 1_069,
      },
    }),
  ]);
});

test('loads older history pages from the OpenClaw REST cursor API', async () => {
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
    'http://127.0.0.1:4173/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=1000',
    expect.anything(),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'http://127.0.0.1:4173/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=1000&cursor=2',
    expect.anything(),
  );
  expect(
    controller.state.chatMessages.map(message => (message as { content?: unknown }).content),
  ).toEqual(['older', 'recent 1', 'recent 2']);
});

test('loads paged REST history for Electron loopback gateway sessions', async () => {
  vi.stubGlobal('window', { electron: {} });
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

  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:42871/sessions/agent%3Amain%3Ajustdo%3Asession-1/history?limit=1000',
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

  expect(controller.state.chatToolMessages).toHaveLength(1);
  expect(controller.state.chatToolMessages[0]).toEqual(
    expect.objectContaining({ __justdoToolActive: false }),
  );
  expect(request).not.toHaveBeenCalled();

  await vi.runOnlyPendingTimersAsync();

  expect(controller.state.chatToolMessages).toHaveLength(0);
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
      stream: 'assistant',
      data: { text: 'NO_REPLY' },
    },
  });

  expect(controller.state.chatStream).toBeNull();
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
      stream: 'lifecycle',
      data: { phase: 'finishing' },
    },
  });

  expect(controller.state.chatStream).toBeNull();
  expect(streamListener).toHaveBeenCalledTimes(1);
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

test('clears stream overlays and completes live tools after a renderable final', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  controller.state.chatMessages = [
    {
      role: 'assistant',
      content: 'previous content',
      timestamp: 1000,
    },
  ];
  controller.state.chatThinkingMessages = [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'thinking 1' }],
      timestamp: 1100,
      __openclawLiveThinking: true,
    },
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'thinking 2' }],
      timestamp: 1300,
      __openclawLiveThinking: true,
    },
  ];
  controller.state.chatToolMessages = [
    {
      role: 'assistant',
      toolCallId: 'tool-1',
      toolName: 'Read',
      timestamp: 1200,
      content: [{ type: 'toolcall', toolCallId: 'tool-1', name: 'Read' }],
    },
    {
      role: 'assistant',
      toolCallId: 'tool-2',
      toolName: 'Write',
      timestamp: 1400,
      content: [{ type: 'toolcall', toolCallId: 'tool-2', name: 'Write' }],
    },
  ];
  controller.state.chatStreamSegments = [
    { text: 'content 1', ts: 1250 },
    { text: 'content 2', ts: 1450 },
  ];
  controller.state.chatStream = 'final content';
  controller.state.chatThinkingStream = 'thinking 3';

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
      content: 'final content',
      timestamp: 1500,
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatStream).toBeNull();
  expect(controller.state.chatThinkingStream).toBeNull();
  expect(controller.state.chatThinkingMessages).toHaveLength(0);
  expect(controller.state.chatToolMessages).toHaveLength(2);
  expect(controller.state.chatToolMessages).toEqual([
    expect.objectContaining({ toolCallId: 'tool-1', __justdoToolActive: false }),
    expect.objectContaining({ toolCallId: 'tool-2', __justdoToolActive: false }),
  ]);
  expect(controller.state.chatStreamSegments).toHaveLength(0);
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
  controller.state.chatThinkingMessages = [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '确认文件已经写入，然后汇报结果。' }],
      timestamp: 1300,
      __openclawLiveThinking: true,
    },
  ];

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

test('backfills live thinking from history while preserving an active run display', async () => {
  const visibleMessage = {
    role: 'assistant',
    content: 'previous content',
    timestamp: 1000,
  };
  const persistedLiveMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'history thinking for live announce' },
      { type: 'text', text: 'Group2 也完成了（但内容截断）。继续等待 group1 和 group4：' },
    ],
    timestamp: 2000,
  };
  const request = vi.fn().mockResolvedValueOnce({
    messages: [visibleMessage, persistedLiveMessage],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'announce:v1:agent:main:subagent:child:run-1';
  controller.state.chatMessages = [visibleMessage];
  controller.state.chatStream = 'Group2 也完成了（但内容截断）。继续等待 group1 和 group4：';

  await controller.loadHistory();

  expect(controller.state.chatMessages).toEqual([visibleMessage]);
  expect(controller.state.chatThinkingStream).toBe('history thinking for live announce');
  expect(controller.state.chatSending).toBe(true);
});

test('merges later non-empty tool arguments over an earlier empty tool call', () => {
  const controller = new ChatController();
  const merged = (
    controller as unknown as {
      mergeToolMessageContent(existingContent: unknown, nextContent: unknown): unknown[];
    }
  ).mergeToolMessageContent(
    [
      {
        type: 'toolcall',
        toolCallId: 'tool-1',
        name: 'exec',
        arguments: {},
      },
    ],
    [
      {
        type: 'toolcall',
        toolCallId: 'tool-1',
        name: 'exec',
        arguments: { command: 'Remove-Item tmp.js', timeout: 5 },
      },
      {
        type: 'toolresult',
        toolCallId: 'tool-1',
        name: 'exec',
        text: '(no output)',
      },
    ],
  );

  expect((merged[0] as Record<string, unknown>).arguments).toEqual({
    command: 'Remove-Item tmp.js',
    timeout: 5,
  });
  expect((merged[1] as Record<string, unknown>).text).toBe('(no output)');
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
