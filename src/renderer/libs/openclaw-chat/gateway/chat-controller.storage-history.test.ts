import { afterEach, expect, it, vi } from 'vitest';

import { ChatController } from './chat-controller';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  'waits for authoritative history on reconnect with pending old read: %s',
  async queued => {
    let resolveHistory!: (result: unknown) => void;
    const request = vi.fn().mockImplementation((method: string) =>
      method === 'chat.history' || method === 'chat.startup'
        ? new Promise(resolve => {
            resolveHistory = resolve;
          })
        : Promise.resolve({}),
    );
    const controller = new ChatController({ initialHistoryRetryDelaysMs: [] });
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:old';
    controller.state.initialHistoryReady = true;
    const messages = [{ role: 'assistant', content: 'visible history' }];
    controller.state.chatMessages = messages;
    const staleRead = controller.loadHistory();
    const lifecycle = controller as unknown as {
      handleClose(): void;
      handleHello(hello: Record<string, unknown>): void;
    };
    lifecycle.handleClose();
    expect(controller.state.initialHistoryReady).toBe(false);
    // The same client can become connected before the old response settles.
    controller.state.connected = true;
    if (queued) {
      lifecycle.handleHello({});
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith('sessions.messages.subscribe', expect.anything()),
      );
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(controller.state.initialHistoryReady).toBe(false);
    }
    resolveHistory({ messages: [{ role: 'assistant', content: 'stale' }] });
    expect(await staleRead).toBe(false);
    expect(controller.state.chatMessages).toEqual(messages);
    if (!queued) lifecycle.handleHello({});
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([method]) => method === 'chat.history' || method === 'chat.startup',
        ),
      ).toHaveLength(2),
    );
    expect(controller.state.initialHistoryReady).toBe(false);
    resolveHistory({ messages });
    await vi.waitFor(() => expect(controller.state.initialHistoryReady).toBe(true));
    expect(controller.state.chatMessages).toEqual(messages);
    controller.disconnect();
  },
);

it('preserves visible history and blocks submission after native restore failure until a successful read', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const request = vi.fn().mockRejectedValue(new Error('archive missing'));
  const controller = new ChatController();
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:old';
  controller.state.initialHistoryReady = true;
  const messages = [{ role: 'assistant', content: 'previously visible', timestamp: 1 }];
  controller.state.chatMessages = messages;
  expect(await controller.loadHistory()).toBe(false);
  expect(controller.state.chatMessages).toEqual(messages);
  expect(controller.state.historyReadFailed).toBe(true);
  await expect(controller.sendMessage('continue')).rejects.toThrow();
  await expect(controller.sendSideQuestion('side question', 'side-run')).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue({ messages: [], sessionId: 'old' });
  expect(await controller.loadHistory()).toBe(false);
  expect(controller.state.historyReadFailed).toBe(true);
  request.mockResolvedValue({ messages, sessionId: 'old' });
  expect(await controller.loadHistory()).toBe(true);
  expect(controller.state.historyReadFailed).toBe(false);
  expect(controller.state.lastError).toBeNull();
  controller.disconnect();
});

it('ignores a restore error from a replaced connection', async () => {
  let reject!: (error: Error) => void;
  const controller = new ChatController();
  controller.state.client = {
    request: () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:old';
  const loading = controller.loadHistory();
  controller.state.client = { request: vi.fn(), stop: vi.fn() } as never;
  reject(new Error('old socket failed'));
  expect(await loading).toBe(false);
  expect(controller.state.historyReadFailed).not.toBe(true);
  expect(controller.state.lastError).toBeNull();
  controller.disconnect();
});

it('reports a failure during snapshot commit instead of discarding it as a stale page', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [] }),
    stop: vi.fn(),
  } as never;
  controller.state.connected = true;
  vi.spyOn(
    controller as unknown as { applySessionContextUsage(): void },
    'applySessionContextUsage',
  ).mockImplementation(() => {
    throw new Error('snapshot projection failed');
  });
  expect(await controller.loadHistory()).toBe(false);
  expect(controller.state.chatLoading).toBe(false);
  expect(controller.state.historyReadFailed).toBe(true);
  expect(controller.state.lastError).toBe('snapshot projection failed');
  controller.disconnect();
});
