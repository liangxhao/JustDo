import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
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

test.each(['a', 'b'])(
  'accepts a rewind to %s after durable appends advance beyond the last loaded leaf',
  async leaf => {
    const controller = new ChatController();
    const sessionKey = 'agent:main:justdo:live-rewind';
    const sessionId = 'native-live-rewind';
    const messages = ['a', 'b', 'c'].map((id, index) => ({
      role: 'user',
      content: id,
      __openclaw: { id, seq: index + 1 },
    }));
    let response = messages.slice(0, 1);
    const request = vi.fn(async () => ({
      messages: response,
      sessionId,
      sessionInfo: { sessionId, activeLeafEntryId: response[response.length - 1]?.__openclaw.id },
    }));
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = sessionKey;
    await expect(controller.loadHistory()).resolves.toBe(true);
    const generation = controller.state.transcript.historyGeneration;
    const handleEvent = (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent.bind(controller);
    for (const message of messages.slice(1)) {
      handleEvent({
        event: 'session.message',
        payload: { sessionKey, sessionId, message, messageSeq: message.__openclaw.seq },
      });
    }
    expect(controller.state.chatMessages).toEqual(messages);
    response = messages.slice(0, leaf === 'a' ? 1 : 2);

    await expect(controller.loadHistory()).resolves.toBe(true);

    expect(controller.state.chatMessages).toEqual(response);
    expect(controller.state.transcript.historyGeneration).toBeGreaterThan(generation);
    await expect(controller.loadHistory()).resolves.toBe(true);
    expect(controller.state.chatMessages).toEqual(response);
  },
);

test('rewinds a persisted user message and reloads the authoritative branch', async () => {
  const controller = new ChatController();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') return { session: { goal: null } };
    if (method === 'sessions.rewind') {
      return {
        editorText: composeBrowserGatewayPrompt('original prompt\nMEDIA:C:\\workspace\\brief.pdf', [
          {
            id: 'browser-1',
            modelContext: 'private browser context',
            title: 'Example',
            displayUrl: 'https://example.com',
            markedRegionCount: 0,
            inspectedElement: false,
            dataUrl: 'data:image/png;base64,aW1hZ2U=',
            fileName: 'browser.png',
            addedAt: 1,
          },
        ]),
        editorAttachments: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
      };
    }
    if (method === 'chat.history') {
      return {
        messages: [
          {
            role: 'user',
            content: 'earlier prompt',
            __openclaw: { id: 'earlier-user', seq: 1 },
          },
        ],
        sessionId: 'gateway-session',
        sessionInfo: {
          sessionId: 'gateway-session',
          activeLeafEntryId: 'earlier-user',
        },
      };
    }
    return {};
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'gateway-session';
  seedControllerMessages(controller, [
    { role: 'user', content: 'latest prompt', __openclaw: { id: 'latest-user' } },
  ]);

  await expect(controller.rewindToUserMessage('latest-user')).resolves.toEqual({
    text: 'original prompt',
    attachments: [
      {
        name: 'restored-attachment-1.png',
        mimeType: 'image/png',
        base64Data: 'aW1hZ2U=',
      },
    ],
    filePaths: ['C:\\workspace\\brief.pdf'],
  });
  expect(request).toHaveBeenNthCalledWith(1, 'sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(request).toHaveBeenNthCalledWith(2, 'sessions.rewind', {
    sessionKey: 'agent:main:justdo:session-1',
    entryId: 'latest-user',
  });
  expect(request).toHaveBeenNthCalledWith(3, 'chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 250,
    maxChars: 500_000,
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ role: 'user', content: 'earlier prompt' }),
  ]);
});

test('returns the editor draft and schedules a retry when rewind history reload fails', async () => {
  const controller = new ChatController();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') return { session: { goal: null } };
    if (method === 'sessions.rewind') return { editorText: 'recover me' };
    throw new Error('history unavailable');
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-reload';
  seedControllerMessages(controller, [
    { role: 'user', content: 'latest prompt', __openclaw: { id: 'latest-user' } },
  ]);
  const internals = controller as unknown as {
    scheduleDeferredHistoryReload(sessionKey: string, reason: string): void;
  };
  const scheduleReload = vi
    .spyOn(internals, 'scheduleDeferredHistoryReload')
    .mockImplementation(() => undefined);

  await expect(controller.rewindToUserMessage('latest-user')).resolves.toEqual({
    text: 'recover me',
    attachments: [],
    filePaths: [],
  });
  expect(scheduleReload).toHaveBeenCalledWith(
    'agent:main:justdo:session-reload',
    'rewind-reload-failed',
  );
});

test('keeps a rotated Gateway session identity while rebuilding the rewound branch', async () => {
  const controller = new ChatController();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') return { session: { goal: null } };
    if (method === 'sessions.rewind') {
      controller.state.currentSessionId = 'gateway-session-rotated';
      return { editorText: 'rotated draft' };
    }
    if (method === 'chat.history') {
      return {
        messages: [],
        sessionId: 'gateway-session-rotated',
        sessionInfo: { sessionId: 'gateway-session-rotated' },
      };
    }
    return {};
  });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-rotated';
  controller.state.currentSessionId = 'gateway-session-original';
  seedControllerMessages(controller, [
    { role: 'user', content: 'latest prompt', __openclaw: { id: 'latest-user' } },
  ]);

  await expect(controller.rewindToUserMessage('latest-user')).resolves.toEqual({
    text: 'rotated draft',
    attachments: [],
    filePaths: [],
  });
  expect(controller.state.transcript.sessionId).toBe('gateway-session-rotated');
  expect(request).toHaveBeenCalledWith('chat.history', {
    sessionKey: 'agent:main:justdo:session-rotated',
    limit: 250,
    maxChars: 500_000,
  });
});

test('rejects rewind when the requested entry is no longer the latest persisted user message', async () => {
  const controller = new ChatController();
  const request = vi.fn();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-stale';
  seedControllerMessages(controller, [
    { role: 'user', content: 'old prompt', __openclaw: { id: 'old-user' } },
    { role: 'assistant', content: 'reply', __openclaw: { id: 'reply' } },
    { role: 'user', content: 'latest prompt', __openclaw: { id: 'latest-user' } },
  ]);

  await expect(controller.rewindToUserMessage('old-user')).rejects.toThrow(
    'Only the latest persisted user message can be updated',
  );
  expect(request).not.toHaveBeenCalled();
});

test('rejects rewind across the Plan implementation reset', async () => {
  const controller = new ChatController();
  const request = vi.fn();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-plan-implementation';
  seedControllerMessages(controller, [
    { role: 'user', content: 'plan this', __openclaw: { id: 'planning-user' } },
    {
      role: 'system',
      content: '',
      __openclaw: { id: 'plan-reset', kind: 'reset', planImplementation: true },
    },
    { role: 'assistant', content: 'implementation finished', __openclaw: { id: 'result' } },
  ]);

  await expect(controller.rewindToUserMessage('planning-user')).rejects.toThrow(
    'Planning messages cannot be updated after implementation has started',
  );
  expect(request).not.toHaveBeenCalled();
});

test('does not rewind history while the session is sending', async () => {
  const controller = new ChatController();
  const request = vi.fn();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.chatSending = true;

  await expect(controller.rewindToUserMessage('latest-user')).rejects.toThrow(
    'Wait for the current session activity to finish',
  );
  expect(request).not.toHaveBeenCalled();
});

test('backfills a delayed in-flight snapshot after a newer live event without rewinding it', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  let resolveHistory:
    | ((value: {
        messages: unknown[];
        sessionId: string;
        sessionInfo: Record<string, unknown>;
        inFlightRun: Record<string, unknown>;
      }) => void)
    | undefined;
  const history = new Promise<{
    messages: unknown[];
    sessionId: string;
    sessionInfo: Record<string, unknown>;
    inFlightRun: Record<string, unknown>;
  }>(resolve => {
    resolveHistory = resolve;
  });
  const controller = new ChatController();
  controller.state.client = { request: vi.fn(() => history) } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  controller.state.chatMessages = [{ role: 'user', content: 'continue', timestamp: 1_000 }];

  const loading = controller.loadHistory();
  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-live',
      seq: 4,
      stream: 'assistant',
      data: { text: 'newer live answer' },
    },
  });
  expect(controller.state.runActivity?.stage).toBe('responding');

  resolveHistory?.({
    messages: [{ role: 'user', content: 'continue', timestamp: 1_000 }],
    sessionId: 'sid-1',
    sessionInfo: {
      sessionId: 'sid-1',
      hasActiveRun: true,
      activeRunIds: ['run-live'],
      status: 'running',
    },
    inFlightRun: {
      runId: 'run-live',
      text: 'older snapshot answer',
      events: [
        {
          runId: 'run-live',
          seq: 1,
          stream: 'thinking',
          ts: 1_001,
          sessionKey,
          data: { thinking: 'recovered reasoning' },
        },
        {
          runId: 'run-live',
          seq: 2,
          stream: 'tool',
          ts: 1_002,
          sessionKey,
          data: {
            phase: 'start',
            toolCallId: 'call-recovered',
            name: 'read',
            args: { path: 'README.md' },
          },
        },
        {
          runId: 'run-live',
          seq: 3,
          stream: 'tool',
          ts: 1_003,
          sessionKey,
          data: {
            phase: 'update',
            toolCallId: 'call-recovered',
            name: 'read',
            partialResult: 'halfway',
          },
        },
      ],
    },
  });
  // Persisted history remains rejected while the live turn owns the pane, but
  // its independently owned in-flight snapshot still repairs missing events.
  await expect(loading).resolves.toBe(false);

  expect(controller.state.runActivity?.stage).toBe('responding');
  expect(controller.state.transcript.activeTurn).toMatchObject({
    runId: 'run-live',
    lastAgentSeq: 4,
    items: [
      { type: 'thinking', status: 'completed', text: 'recovered reasoning' },
      { type: 'tool', status: 'running', toolCallId: 'call-recovered', output: 'halfway' },
      { type: 'content', status: 'streaming', text: 'newer live answer' },
    ],
  });
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
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) =>
    params.offset === 2
      ? Promise.resolve({ messages: [{ role: 'user', content: 'older' }], hasMore: false })
      : Promise.resolve({
          messages: [
            { role: 'assistant', content: 'recent 1' },
            { role: 'assistant', content: 'recent 2' },
          ],
          hasMore: true,
          nextOffset: 2,
        }),
  );

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  expect(request).toHaveBeenNthCalledWith(1, 'chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 250,
    maxChars: 500_000,
  });
  expect(controller.state.historyHasMore).toBe(true);
  expect(
    controller.state.chatMessages.map(message => (message as { content?: unknown }).content),
  ).toEqual(['recent 1', 'recent 2']);

  await controller.loadOlderHistory();

  expect(request).toHaveBeenNthCalledWith(2, 'chat.history', {
    sessionKey: 'agent:main:justdo:session-1',
    limit: 250,
    maxChars: 500_000,
    offset: 2,
  });
  expect(
    controller.getLoadedMessages().map(message => (message as { content?: unknown }).content),
  ).toEqual(['older', 'recent 1', 'recent 2']);
  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.loadedMessageCount).toBe(3);
  expect(controller.state.historyHasMore).toBe(false);
});

test.each([0, 3])(
  'preserves %i intermediate pages when finding the initial subagent task',
  async intermediateCount => {
    const sessionKey = 'agent:main:subagent:child-paged';
    const taskMessage = {
      role: 'user',
      content:
        '[Subagent Context] You are running as a subagent (depth 1/1). Results auto-announce to your requester; do not busy-poll for status.\n\n[Subagent Task]\n\nInspect all pages.',
      __openclaw: { id: 'task-1', seq: 1 },
    };
    const assistantTail = {
      role: 'assistant',
      content: 'working',
      __openclaw: { id: 'assistant-1', seq: 2 },
    };
    const intermediate = Array.from({ length: intermediateCount }, (_, index) => ({
      role: 'assistant',
      content: `intermediate-${index}`,
      __openclaw: { id: `intermediate-${index}`, seq: index + 2 },
    }));
    const request = vi.fn().mockImplementation((method: string, params: { offset?: number }) => {
      if (method === 'chat.startup') {
        return Promise.resolve({ messages: [assistantTail], hasMore: true, nextOffset: 1 });
      }
      if (
        method === 'chat.history' &&
        params.offset !== undefined &&
        params.offset <= intermediateCount
      ) {
        return Promise.resolve({
          messages: [intermediate[intermediateCount - params.offset]],
          hasMore: true,
          nextOffset: params.offset + 1,
        });
      }
      if (method === 'chat.history' && params.offset === intermediateCount + 1) {
        return Promise.resolve({ messages: [taskMessage], hasMore: false });
      }
      return Promise.resolve({});
    });
    const controller = new ChatController({ expectInitialHistory: true });
    controller.state.client = { request } as never;
    controller.state.sessionKey = sessionKey;

    (
      controller as unknown as {
        handleHello(hello: Record<string, unknown>): void;
      }
    ).handleHello({});

    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(request).toHaveBeenCalledWith('chat.history', {
      sessionKey,
      limit: 250,
      maxChars: 500_000,
      offset: 1,
    });
    expect(controller.state.chatMessages).toEqual([taskMessage, ...intermediate, assistantTail]);
    expect(controller.state.historyHasMore).toBe(false);
  },
);

test('preserves a newer window selected while an older page is loading', async () => {
  const recent = Array.from({ length: 1_000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `recent-${index}`,
    __openclaw: { id: `recent-${index}` },
  }));
  const older = Array.from({ length: 250 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `older-${index}`,
    __openclaw: { id: `older-${index}` },
  }));
  let resolveOlderPage: ((value: { messages: typeof older; hasMore: false }) => void) | undefined;
  const olderPage = new Promise<{
    messages: typeof older;
    hasMore: false;
  }>(resolve => {
    resolveOlderPage = resolve;
  });
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) =>
    params.offset !== undefined
      ? olderPage
      : Promise.resolve({
          messages: recent,
          hasMore: true,
          nextOffset: 1_000,
        }),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();
  await expect(controller.showOlderHistory()).resolves.toBe(true);
  expect(controller.state.historyWindowStart).toBe(0);
  expect(controller.state.historyWindowEnd).toBe(750);

  const olderLoad = controller.loadOlderHistory();
  expect(controller.showNewerHistory()).toBe(true);
  expect(controller.state.historyWindowStart).toBe(250);
  expect(controller.state.historyWindowEnd).toBe(1_000);

  resolveOlderPage?.({ messages: older, hasMore: false });
  await expect(olderLoad).resolves.toBe(true);

  expect(controller.state.historyWindowStart).toBe(500);
  expect(controller.state.historyWindowEnd).toBe(1_250);
  expect(controller.state.visibleChatMessages[0]).toMatchObject({ content: 'recent-250' });
  expect(
    controller.state.visibleChatMessages[controller.state.visibleChatMessages.length - 1],
  ).toMatchObject({ content: 'recent-999' });
});

test.each(['newer', 'latest'] as const)(
  'honors a no-op %s intent while an older page is loading',
  async navigation => {
    const recent = Array.from({ length: 750 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `recent-${index}`,
      __openclaw: { id: `recent-${index}` },
    }));
    const older = Array.from({ length: 250 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `older-${index}`,
      __openclaw: { id: `older-${index}` },
    }));
    let resolveOlderPage: ((value: { messages: typeof older; hasMore: false }) => void) | undefined;
    const olderPage = new Promise<{
      messages: typeof older;
      hasMore: false;
    }>(resolve => {
      resolveOlderPage = resolve;
    });
    const request = vi
      .fn()
      .mockImplementation((_method: string, params: { offset?: number }) =>
        params.offset !== undefined
          ? olderPage
          : Promise.resolve({ messages: recent, hasMore: true, nextOffset: 750 }),
      );
    const controller = new ChatController();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:session-1';

    await controller.loadHistory();
    const olderLoad = controller.loadOlderHistory();
    expect(
      navigation === 'newer' ? controller.showNewerHistory() : controller.showLatestHistory(),
    ).toBe(false);

    resolveOlderPage?.({ messages: older, hasMore: false });
    await expect(olderLoad).resolves.toBe(true);

    expect(controller.state.historyWindowStart).toBe(250);
    expect(controller.state.historyWindowEnd).toBe(1_000);
    expect(controller.state.visibleChatMessages[0]).toMatchObject({ content: 'recent-0' });
    expect(
      controller.state.visibleChatMessages[controller.state.visibleChatMessages.length - 1],
    ).toMatchObject({ content: 'recent-749' });
  },
);

test('hydrates a truncated message while loading an older history page', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockImplementation((method: string, params: unknown) => {
    if (method === 'chat.history') {
      return (params as { offset?: number }).offset === 1
        ? Promise.resolve({
            messages: [
              {
                role: 'assistant',
                content: '[chat.history omitted: message too large]',
                __openclaw: { id: 'older-1', seq: 1, truncated: true, reason: 'oversized' },
              },
            ],
            hasMore: false,
          })
        : Promise.resolve({
            messages: [
              {
                role: 'assistant',
                content: 'recent response',
                __openclaw: { id: 'recent-1' },
              },
            ],
            hasMore: true,
            nextOffset: 1,
          });
    }
    if (method === 'chat.message.get') {
      expect(params).toEqual({
        sessionKey,
        messageId: 'older-1',
        maxChars: 2_000_000,
      });
      return Promise.resolve({
        ok: true,
        message: { role: 'assistant', content: 'complete older response' },
      });
    }
    return Promise.resolve({});
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
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

test('does not rewind an advanced older-page cursor when the recent tail refreshes', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const requestedOffsets: Array<number | undefined> = [];
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    requestedOffsets.push(params.offset);
    if (params.offset === 250) {
      return Promise.resolve({
        messages: [{ role: 'assistant', content: 'older page one', __openclaw: { id: 'older-1' } }],
        hasMore: true,
        nextOffset: 500,
      });
    }
    if (params.offset === 500) {
      return Promise.resolve({
        messages: [{ role: 'user', content: 'older page two', __openclaw: { id: 'older-2' } }],
        hasMore: false,
      });
    }
    return Promise.resolve({
      messages: [{ role: 'assistant', content: 'recent', __openclaw: { id: 'recent-1' } }],
      hasMore: true,
      nextOffset: 250,
    });
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await controller.loadHistory();
  await controller.loadOlderHistory();
  await controller.loadHistory();
  await controller.loadOlderHistory();

  expect(requestedOffsets).toEqual([undefined, 250, undefined, 500]);
  expect(controller.getLoadedMessages()).toEqual([
    expect.objectContaining({ content: 'older page two' }),
    expect.objectContaining({ content: 'older page one' }),
    expect.objectContaining({ content: 'recent' }),
  ]);
});

test('skips duplicate older pages until a page adds visible history', async () => {
  const recent = {
    role: 'assistant',
    content: 'recent',
    __openclaw: { id: 'recent-1' },
  };
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    if (params.offset === 2) {
      return Promise.resolve({
        messages: [
          { role: 'user', content: 'older visible message', __openclaw: { id: 'older-1' } },
        ],
        hasMore: false,
      });
    }
    return Promise.resolve({
      messages: [recent],
      hasMore: true,
      nextOffset: params.offset === 1 ? 2 : 1,
    });
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  await expect(controller.loadOlderHistory()).resolves.toBe(true);

  expect(request).toHaveBeenCalledTimes(3);
  expect(
    controller.getLoadedMessages().map(message => (message as { content?: unknown }).content),
  ).toEqual(['older visible message', 'recent']);
  expect(controller.state.historyHasMore).toBe(false);
  expect(controller.state.historyNextCursor).toBeNull();
});

test('continues duplicate-only history pages without an artificial page cap', async () => {
  const recent = {
    role: 'assistant',
    content: 'recent',
    __openclaw: { id: 'recent-1' },
  };
  let olderRequestCount = 0;
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    if (params.offset === undefined) {
      return Promise.resolve({
        messages: [recent],
        hasMore: true,
        nextOffset: 1,
      });
    }
    olderRequestCount += 1;
    if (olderRequestCount <= 8) {
      return Promise.resolve({
        messages: [recent],
        hasMore: true,
        nextOffset: olderRequestCount + 1,
      });
    }
    return Promise.resolve({
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
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  await expect(controller.loadOlderHistory()).resolves.toBe(true);

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
  const request = vi
    .fn()
    .mockResolvedValueOnce({ messages: [recent], hasMore: true, nextOffset: 1 })
    .mockRejectedValueOnce(new Error('temporary paging failure'));
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();
  await controller.loadHistory();

  expect(controller.state.historyHasMore).toBe(true);
  expect(controller.state.historyNextCursor).toBe('offset:1');
});

test('does not truncate loaded history or hide an older cursor', async () => {
  const messages = Array.from({ length: 2105 }, (_, index) => ({
    role: 'assistant',
    content: `message-${index}`,
    __openclaw: { id: `message-${index}` },
  }));
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    if (params.offset === 2_000) {
      return Promise.resolve({
        messages: messages.slice(1_000, 2_000),
        hasMore: true,
        nextOffset: 1_000,
      });
    }
    if (params.offset === 1_000) {
      return Promise.resolve({ messages: messages.slice(0, 1_000), hasMore: false });
    }
    return Promise.resolve({
      messages: messages.slice(2_000),
      hasMore: true,
      nextOffset: 2_000,
    });
  });

  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  await controller.loadHistory();

  expect(controller.state.chatMessages).toHaveLength(105);
  expect(controller.state.historyHasMore).toBe(true);
  expect(controller.state.historyNextCursor).toBe('offset:2000');

  await controller.loadOlderHistory();
  await controller.loadOlderHistory();

  expect(controller.getLoadedMessages()).toHaveLength(2105);
  expect((controller.getLoadedMessages()[0] as { content: string }).content).toBe('message-0');
  expect(controller.state.visibleChatMessages.length).toBeGreaterThan(0);
  expect(controller.state.visibleChatMessages.length).toBeLessThanOrEqual(750);
  expect(controller.state.historyHasMore).toBe(false);
  expect(controller.state.historyNextCursor).toBeNull();
});

test('deduplicates an RPC fallback snapshot against already loaded older pages', async () => {
  const messages = Array.from({ length: 1000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    __openclaw: { id: `message-${index}` },
  }));
  let refreshed = false;
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    if (refreshed) {
      return Promise.resolve({
        messages: messages.map(message => ({
          ...message,
          content: `${message.content} authoritative`,
        })),
        hasMore: false,
      });
    }
    const end = params.offset ?? messages.length;
    const start = Math.max(0, end - 250);
    return Promise.resolve({
      messages: messages.slice(start, end),
      hasMore: start > 0,
      ...(start > 0 ? { nextOffset: start } : {}),
    });
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

  refreshed = true;
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

test('retains loaded older pages when the native leaf advances along the same branch', async () => {
  const first = { role: 'assistant', content: 'first', __openclaw: { id: 'leaf-1', seq: 2 } };
  const next = { role: 'assistant', content: 'next', __openclaw: { id: 'leaf-2', seq: 3 } };
  const older = { role: 'user', content: 'older', __openclaw: { id: 'root', seq: 1 } };
  let reads = 0;
  const request = vi.fn(async (_method: string, params: { offset?: number }) => {
    if (params.offset !== undefined) return { messages: [older], hasMore: false };
    reads += 1;
    return {
      messages: reads === 1 ? [first] : [first, next],
      hasMore: true,
      nextOffset: reads,
      sessionId: 'sid-1',
      sessionInfo: { sessionId: 'sid-1', activeLeafEntryId: reads === 1 ? 'leaf-1' : 'leaf-2' },
    };
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:leaf-advance';
  await controller.loadHistory();
  await controller.loadOlderHistory();
  await controller.loadHistory();
  expect(controller.getLoadedMessages()).toEqual([older, first, next]);
  expect(controller.state.historyHasMore).toBe(false);
  controller.state.client = null;
  controller.disconnect();
});

test('replaces loaded pages when activeLeafEntryId selects another branch', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  let tailRead = 0;
  const request = vi.fn().mockImplementation((_method: string, params: { offset?: number }) => {
    if (params.offset === 1) {
      return Promise.resolve({
        messages: [{ role: 'user', content: 'branch one root', __openclaw: { id: 'old-1' } }],
        hasMore: false,
      });
    }
    tailRead += 1;
    return tailRead === 1
      ? Promise.resolve({
          messages: [
            { role: 'assistant', content: 'branch one tail', __openclaw: { id: 'old-2' } },
          ],
          hasMore: true,
          nextOffset: 1,
          sessionId: 'sid-1',
          sessionInfo: { sessionId: 'sid-1', activeLeafEntryId: 'leaf-one' },
        })
      : Promise.resolve({
          messages: [
            { role: 'assistant', content: 'branch two only', __openclaw: { id: 'new-1' } },
          ],
          hasMore: false,
          sessionId: 'sid-1',
          sessionInfo: { sessionId: 'sid-1', activeLeafEntryId: 'leaf-two' },
        });
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;

  await controller.loadHistory();
  await controller.loadOlderHistory();
  expect(controller.getLoadedMessages()).toHaveLength(2);

  await controller.loadHistory();

  expect(controller.getLoadedMessages()).toEqual([
    expect.objectContaining({ content: 'branch two only' }),
  ]);
  expect(controller.state.historyHasMore).toBe(false);
  expect(controller.state.historyNextCursor).toBeNull();
});

test('keeps history and the live turn visible until a changed leaf can be reconciled', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const messages = [
    { role: 'user', content: 'first prompt', __openclaw: { id: 'user-1' } },
    { role: 'assistant', content: 'billing error', __openclaw: { id: 'error-1' } },
    { role: 'user', content: 'retry with another model', __openclaw: { id: 'user-2' } },
  ];
  let leaf = 'failed-leaf';
  const request = vi.fn().mockImplementation(() =>
    Promise.resolve({
      messages,
      sessionId: 'sid-1',
      sessionInfo: { sessionId: 'sid-1', activeLeafEntryId: leaf },
    }),
  );
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  await controller.loadHistory();
  const activeTurn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'retry-run', sessionId: 'sid-1' },
    { now: () => 1000, createId: prefix => `${prefix}-1` },
  );
  controller.state.chatSending = true;
  controller.state.chatRunId = activeTurn.runId;
  const generation = controller.state.transcript.historyGeneration;
  const visibleMessages = controller.state.visibleChatMessages;

  for (const nextLeaf of ['thinking-leaf', 'content-leaf']) {
    leaf = nextLeaf;
    expect(await controller.loadHistory()).toBe(false);
    expect(controller.state.visibleChatMessages).toEqual(visibleMessages);
    expect(controller.getLoadedMessages()).toEqual(messages);
    expect(controller.state.transcript.activeTurn).toBe(activeTurn);
    expect(controller.state.transcript.historyGeneration).toBe(generation);
  }

  controller.state.chatSending = false;
  activeTurn.status = 'final';
  expect(await controller.loadHistory()).toBe(true);
  expect(controller.state.visibleChatMessages).toEqual(messages);
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.transcript.historyGeneration).toBeGreaterThan(generation);
});

test.each(['starts', 'finishes'] as const)(
  'rechecks branch replacement when a run %s during history hydration',
  async transition => {
    const sessionKey = 'agent:main:justdo:session-1';
    const initialMessages = [{ role: 'user', content: 'prompt', __openclaw: { id: 'user-1' } }];
    const finalMessage = {
      role: 'assistant',
      content: 'complete answer',
      __openclaw: { id: 'answer-1' },
    };
    let resolveMessage!: (value: unknown) => void;
    let tailRead = 0;
    const request = vi.fn().mockImplementation((method: string) => {
      if (method === 'chat.message.get')
        return new Promise(resolve => {
          resolveMessage = resolve;
        });
      tailRead += 1;
      return Promise.resolve({
        messages:
          tailRead === 1
            ? initialMessages
            : [
                ...initialMessages,
                {
                  ...finalMessage,
                  content: 'preview',
                  __openclaw: { id: 'answer-1', truncated: true },
                },
              ],
        sessionId: 'sid-1',
        sessionInfo: {
          sessionId: 'sid-1',
          activeLeafEntryId: tailRead === 1 ? 'old-leaf' : 'new-leaf',
        },
      });
    });
    const controller = new ChatController();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = sessionKey;
    await controller.loadHistory();
    const startRun = () => {
      const turn = beginAssistantTurn(
        controller.state.transcript,
        { runId: 'run-1', sessionId: 'sid-1' },
        { now: () => 1000, createId: prefix => `${prefix}-1` },
      );
      controller.state.chatSending = true;
      controller.state.chatRunId = turn.runId;
      return turn;
    };
    let activeTurn = transition === 'finishes' ? startRun() : null;
    const generation = controller.state.transcript.historyGeneration;
    const load = controller.loadHistory();
    await vi.waitFor(() => expect(resolveMessage).toBeTypeOf('function'));

    if (transition === 'starts') activeTurn = startRun();
    else {
      controller.state.chatSending = false;
      activeTurn!.status = 'final';
    }
    resolveMessage({ ok: true, message: finalMessage });

    expect(await load).toBe(transition === 'finishes');
    if (transition === 'starts') {
      expect(controller.state.visibleChatMessages).toEqual(initialMessages);
      expect(controller.state.transcript.activeTurn).toBe(activeTurn);
      expect(controller.state.transcript.historyGeneration).toBe(generation);
    } else {
      expect(controller.state.visibleChatMessages).toEqual([...initialMessages, finalMessage]);
      expect(controller.state.transcript.activeTurn).toBeNull();
      expect(controller.state.transcript.historyGeneration).toBeGreaterThan(generation);
    }
  },
);

test('projects context usage from sessions.changed and rejects an older snapshot', () => {
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:session-1';
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'sid-1';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'sid-1';
  const listener = vi.fn();
  controller.subscribe(listener);
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey,
      sessionId: 'sid-1',
      updatedAt: 200,
      totalTokens: 160_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      modelProvider: 'openai',
      model: 'gpt-5.6-sol',
    },
  });
  handleEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey,
      sessionId: 'sid-1',
      updatedAt: 100,
      totalTokens: 190_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
    },
  });

  expect(controller.state.contextUsage).toEqual({
    sessionKey,
    sessionId: 'sid-1',
    totalTokens: 160_000,
    totalTokensFresh: true,
    contextTokens: 200_000,
    updatedAt: 200,
    modelRef: 'openai/gpt-5.6-sol',
  });
  expect(listener).toHaveBeenCalledTimes(1);

  handleEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey,
      sessionId: 'sid-1',
      updatedAt: 300,
      totalTokens: 24_000,
      totalTokensFresh: true,
      contextTokens: 200_000,
      modelProvider: 'openai',
      model: 'gpt-5.6-sol',
    },
  });

  expect(controller.state.contextUsage?.totalTokens).toBe(24_000);
  expect(controller.state.contextUsage?.updatedAt).toBe(300);
  expect(listener).toHaveBeenCalledTimes(2);

  handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      sessionId: 'sid-1',
      session: {
        sessionId: 'sid-1',
        updatedAt: 400,
        totalTokens: 26_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
        modelProvider: 'openai',
        model: 'gpt-5.6-sol',
      },
    },
  });

  expect(controller.state.contextUsage?.totalTokens).toBe(26_000);
  expect(controller.state.contextUsage?.updatedAt).toBe(400);
  expect(listener).toHaveBeenCalledTimes(3);
});

test('does not terminate a replacement run when an older Stop confirmation arrives', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-stop';
  controller.state.transcript.sessionKey = 'session-stop';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-new';
  const turn = beginAssistantTurn(
    controller.state.transcript,
    { runId: 'run-new' },
    {
      now: () => 100,
      createId: prefix => `${prefix}-new`,
    },
  );

  controller.settleConfirmedRun('session-stop', 'run-old', 'aborted');

  expect(turn.status).toBe('running');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-new');
  expect(controller.state.chatMessages).toEqual([]);
});

test('clears a stopped background startup placeholder without clearing the selected run', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'session-starting';
  controller.state.transcript.sessionKey = 'session-starting';
  controller.setPendingUserMessage('first prompt');
  await controller.switchSession('session-other');
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-other';

  controller.settleConfirmedRun('session-starting', 'justdo-starting', 'aborted');
  controller.clearSending('session-starting', null);

  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('run-other');
  await controller.switchSession('session-starting');
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.transcript.recentRuns.get('justdo-starting')?.terminalStatus).toBe(
    'aborted',
  );
});
