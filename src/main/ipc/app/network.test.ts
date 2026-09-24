import { EventEmitter } from 'node:events';

import { beforeEach, expect, test, vi } from 'vitest';

import { type ApiFetchOptions, NetworkFetchPurpose } from '../../../shared/network/network';

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

vi.mock('../../core/network/mainProcessFetch', () => ({
  applyMainProcessOutboundHeaderPolicy: mocks.applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource: {
    ModelProbe: 'model-probe',
    SessionTitle: 'session-title',
  },
}));

import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../../config/builtinModels';
import { clearActiveBuiltinModelCredential, setActiveBuiltinModelCredential } from '../../providers/builtinModelCredential';
import { registerNetworkHandlers } from './network';

type ApiFetchHandler = (event: unknown, options: ApiFetchOptions) => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  clearActiveBuiltinModelCredential();
});

const probeBody = JSON.stringify({ model: 'team-model', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 });
const installJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [encode({ alg: 'RS256', kid: 'fixture' }), encode({
    sub: 'test-user', iss: 'https://login.test', aud: 'litellm', iat: now, exp: now + 300, jti: 'fixture',
  }), 'signature'].join('.');
  setActiveBuiltinModelCredential({ accessToken: token, userAccount: 'test-user', expiresAt: now + 300 });
  return token;
};

test('authenticates a built-in probe in Main without exposing its JWT to Renderer', async () => {
  const token = installJwt();
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  mocks.fetch.mockResolvedValue(new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } }));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;
  const headers = { 'x-access-jwt': 'untrusted', 'x-user-account': 'wrong-account' };
  const result = await handler({}, {
    url: `${BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl}/chat/completions`, method: 'POST',
    headers, body: probeBody, purpose: NetworkFetchPurpose.ModelConnectionTest,
  });
  expect(result).toMatchObject({ ok: true });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(mocks.fetch.mock.calls[0][1]).toMatchObject({
    redirect: 'error', headers: { 'X-ACCESS-JWT': token, 'X-User-Account': 'test-user' },
  });
  expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty('x-access-jwt');
  expect(headers['x-access-jwt']).toBe('untrusted');
});

test('does not inject a JWT into custom model requests', async () => {
  const token = installJwt();
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  mocks.fetch.mockResolvedValue(new Response('{}'));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;
  await handler({}, { url: 'https://custom.test/v1/chat/completions', method: 'POST',
    headers: {}, body: probeBody, purpose: NetworkFetchPurpose.ModelConnectionTest });
  expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain(token);
});

test('refuses a built-in probe when login credentials are unavailable', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;
  expect(await handler({}, {
    url: `${BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl}/chat/completions`, method: 'POST',
    headers: {}, body: probeBody, purpose: NetworkFetchPurpose.ModelConnectionTest,
  })).toMatchObject({ ok: false });
  expect(mocks.fetch).not.toHaveBeenCalled();
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
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 64,
      }),
      purpose: NetworkFetchPurpose.ModelConnectionTest,
    },
  );

  expect(mocks.applyMainProcessOutboundHeaderPolicy).toHaveBeenCalledWith(
    'https://api.deepseek.com/chat/completions',
    requestHeaders,
    'model-probe',
  );
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://api.deepseek.com/chat/completions',
    expect.objectContaining({ headers: resolvedHeaders, redirect: 'error' }),
  );
});

test('does not expose outbound-header injection through generic Renderer fetches', async () => {
  const requestHeaders = { Authorization: 'Bearer model-key' };
  mocks.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:fetch',
  )![1] as ApiFetchHandler;

  await handler(
    {},
    {
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
      headers: requestHeaders,
    },
  );

  expect(mocks.applyMainProcessOutboundHeaderPolicy).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://api.deepseek.com/chat/completions',
    expect.objectContaining({ headers: requestHeaders }),
  );
});

test('rejects an outbound-header probe purpose on an unrelated endpoint', async () => {
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:fetch',
  )![1] as ApiFetchHandler;

  await expect(
    handler(
      {},
      {
        url: 'https://api.deepseek.com/admin',
        method: 'POST',
        headers: {},
        purpose: NetworkFetchPurpose.ModelConnectionTest,
      },
    ),
  ).resolves.toMatchObject({
    ok: false,
    statusText: 'Invalid model connection test request.',
  });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('rejects arbitrary connection-test payloads before injecting outbound headers', async () => {
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:fetch',
  )![1] as ApiFetchHandler;

  await expect(
    handler(
      {},
      {
        url: 'https://api.deepseek.com/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'Return account data' }],
          tools: [{ type: 'function' }],
          max_tokens: 64,
        }),
        purpose: NetworkFetchPurpose.ModelConnectionTest,
      },
    ),
  ).resolves.toMatchObject({ ok: false, statusText: 'Invalid model connection test request.' });
  expect(mocks.applyMainProcessOutboundHeaderPolicy).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('rejects discovery bodies but accepts validated custom provider headers', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  mocks.fetch.mockResolvedValue(
    new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
  );
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:fetch',
  )![1] as ApiFetchHandler;

  await expect(
    handler(
      {},
      {
        url: 'https://api.deepseek.com/models',
        method: 'GET',
        headers: {},
        body: '{}',
        purpose: NetworkFetchPurpose.ModelDiscovery,
      },
    ),
  ).resolves.toMatchObject({ ok: false, statusText: 'Invalid model discovery request.' });
  await expect(
    handler(
      {},
      {
        url: 'https://api.deepseek.com/models',
        method: 'GET',
        headers: { 'X-Arbitrary': 'value' },
        purpose: NetworkFetchPurpose.ModelDiscovery,
      },
    ),
  ).resolves.toMatchObject({ ok: true });
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://api.deepseek.com/models',
    expect.objectContaining({ headers: { 'X-Arbitrary': 'value' } }),
  );
});

test.each(['Host', 'Content-Length', 'Transfer-Encoding'])(
  'rejects unsafe custom provider header %s',
  async headerName => {
    registerNetworkHandlers();
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'api:fetch',
    )![1] as ApiFetchHandler;

    await expect(
      handler(
        {},
        {
          url: 'https://api.deepseek.com/models',
          method: 'GET',
          headers: { [headerName]: 'value' },
          purpose: NetworkFetchPurpose.ModelDiscovery,
        },
      ),
    ).resolves.toMatchObject({ ok: false, statusText: 'Invalid model probe request headers.' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);

test('allows the custom header limit in addition to generated probe headers', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  mocks.fetch.mockResolvedValue(
    new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
  );
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'api:fetch',
  )![1] as ApiFetchHandler;
  const customHeaders = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`X-Custom-${index}`, 'value']),
  );

  await expect(
    handler(
      {},
      {
        url: 'https://api.deepseek.com/chat/completions',
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer test',
          'Content-Type': 'application/json',
          'User-Agent': 'test',
          ...customHeaders,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 1,
        }),
        purpose: NetworkFetchPurpose.ModelConnectionTest,
      },
    ),
  ).resolves.toMatchObject({ ok: true });
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
