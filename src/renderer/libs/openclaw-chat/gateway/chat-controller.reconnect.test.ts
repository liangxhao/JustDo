import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:justdo:offline-start';

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

test.each(['failed', 'killed', 'done'])(
  'settles native %s without a visible reply or hasActiveRun',
  async status => {
    const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
    controllers.push(controller);
    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'sessions.describe'
            ? { session: { status, lastRunId: 'terminal-run' } }
            : {
                messages: [
                  {
                    role: 'user',
                    content: 'task',
                    __openclaw: { idempotencyKey: 'terminal-run:user' },
                  },
                ],
              },
        ),
      );
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.setPendingUserMessage('task');
    controller.state.chatRunId = 'terminal-run';
    (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello(
      {},
    );
    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.terminalRunIds.has('terminal-run')).toBe(true);
    if (status === 'failed') expect(controller.state.lastError).toBeTruthy();
    else expect(controller.state.lastError).toBeNull();
  },
);

test.each(['failed', 'killed', 'done'])(
  'does not settle from another run native %s status',
  async status => {
    const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
    controllers.push(controller);
    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'sessions.describe'
            ? { session: { status, lastRunId: 'old-run' } }
            : { messages: [] },
        ),
      );
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.setPendingUserMessage('task');
    controller.state.chatRunId = 'new-run';
    (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello(
      {},
    );
    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe('new-run');
  },
);

test('keeps an exact native running status without hasActiveRun or redundant retries', async () => {
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [0, 0] });
  controllers.push(controller);
  const request = vi
    .fn()
    .mockImplementation((method: string) =>
      Promise.resolve(
        method === 'chat.startup'
          ? { messages: [] }
          : method === 'sessions.describe'
            ? { session: { status: 'running', lastRunId: 'active-run' } }
            : {},
      ),
    );
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.setPendingUserMessage('active task');
  controller.state.chatRunId = 'active-run';
  (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello({});
  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('active-run');
  expect(request.mock.calls.filter(([method]) => method === 'chat.startup')).toHaveLength(1);
});

test.each(['text', 'attachment'])(
  'settles an offline Main run with a durable %s reply',
  async type => {
    const messages = [
      {
        role: 'user',
        content: 'offline task',
        __openclaw: { seq: 1, idempotencyKey: 'offline-run:user' },
      },
      {
        role: 'assistant',
        content:
          type === 'text'
            ? [{ type: 'text', text: 'completed answer' }]
            : [
                {
                  type: 'attachment',
                  attachment: { kind: 'file', url: 'file:///test/result.txt', label: 'result.txt' },
                },
              ],
        stopReason: 'stop',
        __openclaw: { seq: 2, runId: 'offline-run' },
      },
    ];
    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'chat.startup'
            ? { messages, sessionInfo: { key: sessionKey, hasActiveRun: false } }
            : method === 'sessions.describe'
              ? { session: { key: sessionKey, status: 'done', lastRunId: 'offline-run' } }
              : {},
        ),
      );
    const controller = new ChatController({ initialHistoryRetryDelaysMs: [0, 0] });
    controllers.push(controller);
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.state.connected = true;
    const lifecycle = controller as unknown as {
      handleClose(): void;
      handleHello(hello: Record<string, unknown>): void;
    };

    lifecycle.handleClose();
    expect(controller.state.transportStatus).toBe('disconnected');
    // Main uses its own connection and can finish before the renderer reconnects.
    controller.setPendingUserMessage('offline task');
    controller.state.chatRunId = 'offline-run';
    lifecycle.handleHello({});

    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(controller.state.chatMessages).toEqual(messages);
    expect(controller.state.pendingUserMessage).toBeNull();
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.runActivity).toBeNull();
    expect(controller.state.transcript.activeTurn).toBeNull();
  },
);

test('keeps pending Main work when reconnect startup fails', async () => {
  const request = vi
    .fn()
    .mockImplementation((method: string) =>
      method === 'chat.startup'
        ? Promise.reject(new Error('snapshot unavailable'))
        : Promise.resolve({}),
    );
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [0, 0] });
  controllers.push(controller);
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.setPendingUserMessage('pending task');
  controller.state.chatRunId = 'pending-run';

  (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.chatRunId).toBe('pending-run');
  expect(controller.state.pendingUserMessage).not.toBeNull();
});

test('retries an inactive pre-dispatch snapshot until this run has a durable result', async () => {
  let reads = 0;
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [0, 0] });
  controllers.push(controller);
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'chat.startup') {
      reads += 1;
      expect(controller.state.chatSending).toBe(true);
      return Promise.resolve({
        messages:
          reads === 1
            ? []
            : [
                { role: 'user', content: 'pending task' },
                {
                  role: 'assistant',
                  content: 'done',
                  stopReason: 'stop',
                  __openclaw: { runId: 'pending-run' },
                },
              ],
      });
    }
    return Promise.resolve(
      method === 'sessions.describe'
        ? {
            session: {
              hasActiveRun: false,
              status: 'done',
              lastRunId: reads === 1 ? 'previous-run' : 'pending-run',
            },
          }
        : {},
    );
  });
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.setPendingUserMessage('pending task');
  controller.state.chatRunId = 'pending-run';
  (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello({});

  await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
  expect(reads).toBe(2);
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.transcript.terminalRunIds.has('pending-run')).toBe(true);
});

test.each(['other-run', 'thinking', 'commentary', 'segment'])(
  'does not settle pending work from %s history',
  async kind => {
    const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
    controllers.push(controller);
    const reply = {
      role: 'assistant',
      content:
        kind === 'thinking' ? [{ type: 'thinking', thinking: 'thinking text' }] : 'visible text',
      ...(kind === 'other-run' ? { __openclaw: { runId: 'other-run' } } : {}),
      ...(kind === 'commentary' ? { phase: 'commentary' } : {}),
      ...(kind === 'segment' ? { openclawStreamFallback: { source: 'segment' } } : {}),
    };
    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'chat.startup'
            ? { messages: [{ role: 'user', content: 'pending task' }, reply] }
            : method === 'sessions.describe'
              ? { session: { hasActiveRun: false } }
              : {},
        ),
      );
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.sessionKey = sessionKey;
    controller.state.transcript.sessionKey = sessionKey;
    controller.setPendingUserMessage('pending task');
    controller.state.chatRunId = 'pending-run';
    (controller as unknown as { handleHello(hello: Record<string, unknown>): void }).handleHello(
      {},
    );

    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe('pending-run');
  },
);
