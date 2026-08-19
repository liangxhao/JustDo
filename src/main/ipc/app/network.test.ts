import { EventEmitter } from 'node:events';

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applyMainProcessOutboundHeaderPolicy: vi.fn(),
  fetch: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    on: mocks.on,
    removeAllListeners: mocks.removeAllListeners,
  },
  session: {
    defaultSession: {
      fetch: mocks.fetch,
    },
  },
}));

vi.mock('../../core/mainProcessFetch', () => ({
  applyMainProcessOutboundHeaderPolicy: mocks.applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource: {
    RendererFetch: 'renderer-fetch',
    SessionTitle: 'session-title',
  },
}));

import { registerNetworkHandlers } from './network';

type ApiFetchHandler = (
  event: unknown,
  options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    requestId?: string;
  },
) => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

test('applies the outbound-header policy to API fetch requests', async () => {
  const requestHeaders = { Authorization: 'Bearer model-key' };
  const resolvedHeaders = {
    ...requestHeaders,
    'X-User-Account': 'user-123',
  };
  mocks.applyMainProcessOutboundHeaderPolicy.mockReturnValue(resolvedHeaders);
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  registerNetworkHandlers();
  const registration = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch');
  expect(registration).toBeDefined();
  const handler = registration?.[1] as ApiFetchHandler;

  await handler(
    {},
    {
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: requestHeaders,
      body: '{"model":"deepseek-chat"}',
    },
  );

  expect(mocks.applyMainProcessOutboundHeaderPolicy).toHaveBeenCalledWith(
    'https://api.deepseek.com/chat/completions',
    requestHeaders,
    'renderer-fetch',
  );
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://api.deepseek.com/chat/completions',
    expect.objectContaining({ headers: resolvedHeaders }),
  );
});

test('aborts a pending API fetch when the renderer cancels its request ID', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation(
    (_url: string, headers: Record<string, string>) => headers,
  );
  mocks.fetch.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  registerNetworkHandlers();

  const fetchRegistration = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch');
  const cancelRegistration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:cancelFetch',
  );
  const fetchHandler = fetchRegistration?.[1] as ApiFetchHandler;
  const cancelHandler = cancelRegistration?.[1] as (event: unknown, requestId: string) => void;
  const sender = Object.assign(new EventEmitter(), {
    id: 42,
    isDestroyed: () => false,
  });
  const event = { sender };

  const resultPromise = fetchHandler(event, {
    url: 'https://example.com/chat/completions',
    method: 'POST',
    headers: {},
    requestId: 'connection-test-1',
  });
  const signal = (mocks.fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

  cancelHandler(event, 'connection-test-1');

  expect(signal?.aborted).toBe(true);
  await expect(resultPromise).resolves.toMatchObject({ ok: false, status: 0 });
});

test('aborts a pending API fetch when its renderer window is destroyed', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation(
    (_url: string, headers: Record<string, string>) => headers,
  );
  mocks.fetch.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  registerNetworkHandlers();

  const fetchRegistration = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch');
  const fetchHandler = fetchRegistration?.[1] as ApiFetchHandler;
  let destroyed = false;
  const sender = Object.assign(new EventEmitter(), {
    id: 43,
    isDestroyed: () => destroyed,
  });
  const resultPromise = fetchHandler(
    { sender },
    {
      url: 'https://example.com/chat/completions',
      method: 'POST',
      headers: {},
      requestId: 'connection-test-2',
    },
  );
  const signal = (mocks.fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

  destroyed = true;
  sender.emit('destroyed');

  expect(signal?.aborted).toBe(true);
  await expect(resultPromise).resolves.toMatchObject({ ok: false, status: 0 });
});
