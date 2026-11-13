import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { startLocalModelServer } from '../../../../tests/fixtures/localModelServer';
import { type ApiFetchOptions, NetworkFetchPurpose, NetworkIpc } from '../../../shared/network/network';
import type { OutboundHeaderPolicyConfig } from '../../core/network/outboundHeaderPolicyConfig';

const testProviderConfig = vi.hoisted(() => ({ enabled: true, baseUrl: 'http://127.0.0.1:1/v1' }));
vi.mock('../../../config/builtinModels', () => ({ BUILTIN_MODEL_PROVIDER_CONFIG: testProviderConfig }));

const mocks = vi.hoisted(() => ({
  applyMainProcessOutboundHeaderPolicy: vi.fn(),
  fetch: vi.fn(),
  getOutboundHeaderPolicyConfig: vi.fn<() => OutboundHeaderPolicyConfig>(),
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

vi.mock('../../core/network/outboundHeaderPolicyConfig', async importOriginal => ({
  ...await importOriginal<typeof import('../../core/network/outboundHeaderPolicyConfig')>(),
  getOutboundHeaderPolicyConfig: mocks.getOutboundHeaderPolicyConfig,
}));

import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../../../config/builtinModels';
import { publishOutboundHeaderUserInfoCache } from '../../core/network/outboundHeaderPolicyConfig';
import { clearActiveBuiltinModelCredential, setActiveBuiltinModelCredential } from '../../providers/builtinModelCredential';
import { registerNetworkHandlers as registerHandlers } from './network';

type ApiFetchHandler = (event: unknown, options: ApiFetchOptions) => Promise<unknown>;
const registerNetworkHandlers = (getMainWindow = (): BrowserWindow | null => null) =>
  registerHandlers({ getMainWindow });

beforeEach(() => {
  testProviderConfig.baseUrl = 'http://127.0.0.1:1/v1';
  vi.clearAllMocks();
  clearActiveBuiltinModelCredential();
});

test('shows effective outbound header values from memory for each target to the current main frame', () => {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  mocks.getOutboundHeaderPolicyConfig.mockReturnValue({
    enabled: true,
    groups: [
      { baseUrlWhitelist: ['http://127.0.0.1/'], headerNames: ['X-Ignored'] },
      {
        baseUrlWhitelist: ['https://test-user:test-password@internal.example/v1/?token=test-query#test-fragment'],
        headerNames: [
          'X-Account',
          { name: 'X-Tenant', from: 'tenant_id' },
          { name: 'X-Token', value: ' fixed fixture ' },
          { name: 'X-Empty', from: 'missing_field' },
          { name: 'X-Invalid', from: 'invalid_field' },
        ],
      },
      {
        baseUrlWhitelist: ['https://internal.example/v1/', 'https://internal.example/v1/private/'],
        headerNames: ['x-token'],
      },
      {
        baseUrlWhitelist: ['https://internal.example/v1/private/'],
        headerNames: [{ name: 'x-token', from: 'private_token' }],
      },
      {
        baseUrlWhitelist: ['https://other.example/', 'https://other.example//'],
        headerNames: [{ name: 'X-Route', value: 'test-route' }],
      },
    ],
  });
  const sourceKeys = ['X-Account', 'tenant_id', 'missing_field', 'invalid_field', 'private_token'];
  const userInfo = {
    'X-Account': ' test-account ',
    tenant_id: 42,
    invalid_field: '测试',
    private_token: 'test-private',
    unrelated: 'test-unrelated',
  };
  registerNetworkHandlers(() => window);
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === NetworkIpc.GetOutboundHeaderPolicy)![1];

  expect(() => handler({ ...event, senderFrame: {} })).toThrow('main application frame');
  expect(() => handler({ ...event, sender: { ...contents } })).toThrow('main application frame');
  expect(mocks.getOutboundHeaderPolicyConfig).not.toHaveBeenCalled();
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  try {
    expect(handler(event).targets[0].headers).toEqual(expect.arrayContaining([
      { name: 'X-Tenant', sourceField: 'tenant_id', value: null },
      { name: 'X-Token', sourceField: null, value: ' fixed fixture ' },
    ]));
    publishOutboundHeaderUserInfoCache(userInfo, sourceKeys);
    const commonHeaders = [
      { name: 'X-Account', sourceField: 'X-Account', value: 'test-account' },
      { name: 'X-Tenant', sourceField: 'tenant_id', value: '42' },
    ];
    const trailingHeaders = [
      { name: 'X-Empty', sourceField: 'missing_field', value: '' },
      { name: 'X-Invalid', sourceField: 'invalid_field', value: null },
    ];
    expect(handler(event)).toEqual({
      enabled: true,
      targets: [
        {
          url: 'https://internal.example/v1/',
          headers: [...commonHeaders, { name: 'X-Token', sourceField: null, value: ' fixed fixture ' }, ...trailingHeaders],
        },
        {
          url: 'https://internal.example/v1/private/',
          headers: [...commonHeaders, { name: 'x-token', sourceField: 'private_token', value: 'test-private' }, ...trailingHeaders],
        },
        {
          url: 'https://other.example/',
          headers: [{ name: 'X-Route', sourceField: null, value: 'test-route' }],
        },
        {
          url: 'https://other.example//',
          headers: [{ name: 'X-Route', sourceField: null, value: 'test-route' }],
        },
      ],
    });

    publishOutboundHeaderUserInfoCache({ ...userInfo, tenant_id: 43 }, sourceKeys);
    expect(handler(event).targets[0].headers[1].value).toBe('43');
    mocks.getOutboundHeaderPolicyConfig.mockReturnValue({ enabled: false, groups: [] });
    expect(handler(event)).toEqual({ enabled: false, targets: [] });
    expect(readFileSync).not.toHaveBeenCalled();
  } finally {
    readFileSync.mockRestore();
  }
});

const probeBody = JSON.stringify({ model: 'team-model', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 });
const installJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [encode({ alg: 'RS256', kid: 'fixture' }), encode({
    sub: 'test-user', iss: 'https://login.test', aud: 'justdo-litellm', iat: now, exp: now + 300, jti: 'fixture',
  }), 'signature'].join('.');
  setActiveBuiltinModelCredential({ accessToken: token, userAccount: 'test-user', expiresAt: now + 300 });
  return token;
};

test('completes an authenticated model probe against a real loopback fake model', async () => {
  const local = await startLocalModelServer();
  try {
    testProviderConfig.baseUrl = local.baseUrl;
    const token = installJwt();
    mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
    mocks.fetch.mockImplementation((url, init) => fetch(url, init));
    registerNetworkHandlers();
    const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;
    const result = await handler({}, {
      url: `${local.baseUrl}/chat/completions`, method: 'POST', headers: {},
      body: probeBody, purpose: NetworkFetchPurpose.ModelConnectionTest,
    });
    expect(result).toMatchObject({ ok: true, data: { choices: [{ message: { content: 'local fixture reply' } }] } });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].headers['x-access-jwt']).toBe(token);
    expect(local.requests[0].headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(local.requests[0].body)).toEqual(JSON.parse(probeBody));
    expect(JSON.stringify(result)).not.toContain(token);
  } finally {
    await local.close();
  }
});

test('preserves the HTTP status and structured server error for a failed model discovery', async () => {
  mocks.applyMainProcessOutboundHeaderPolicy.mockImplementation((_url, headers) => headers);
  const data = { error: { message: 'The requested models endpoint does not exist.' } };
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(data), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'application/problem+json', 'x-request-id': 'discovery-404' },
  }));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;

  await expect(handler({}, {
    url: 'https://model.test/v1/models', method: 'GET', headers: {},
    purpose: NetworkFetchPurpose.ModelDiscovery,
  })).resolves.toMatchObject({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: { 'x-request-id': 'discovery-404' },
    data,
  });
});

test.each([
  ['application/json', '{"error": incomplete'],
  ['text/plain', 'The configured service has no models endpoint.'],
])('preserves the HTTP error and raw %s response', async (contentType, body) => {
  mocks.fetch.mockResolvedValue(new Response(body, {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': contentType },
  }));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;

  await expect(handler({}, {
    url: 'https://model.test/v1/models', method: 'GET', headers: {},
  })).resolves.toMatchObject({ ok: false, status: 404, statusText: 'Not Found', data: body });
});

test('preserves received HTTP metadata when reading the response body fails', async () => {
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error('net::ERR_CONNECTION_CLOSED'));
    },
  }), {
    status: 502,
    statusText: 'Bad Gateway',
    headers: { 'x-request-id': 'discovery-502' },
  }));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;

  await expect(handler({}, {
    url: 'https://model.test/v1/models', method: 'GET', headers: {},
  })).resolves.toMatchObject({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    headers: { 'x-request-id': 'discovery-502' },
    data: null,
    error: 'net::ERR_CONNECTION_CLOSED',
  });
});

test('retains the transport error when no HTTP response was received', async () => {
  mocks.fetch.mockRejectedValue(new Error('net::ERR_CONNECTION_CLOSED'));
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;

  await expect(handler({}, {
    url: 'https://model.test/v1/models', method: 'GET', headers: {},
  })).resolves.toMatchObject({
    ok: false,
    status: 0,
    statusText: 'net::ERR_CONNECTION_CLOSED',
    data: null,
    error: 'net::ERR_CONNECTION_CLOSED',
  });
});

test('rejects an unconfigured built-in probe without sending credentials or making a request', async () => {
  testProviderConfig.baseUrl = '';
  installJwt();
  registerNetworkHandlers();
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'api:fetch')![1] as ApiFetchHandler;
  expect(await handler({}, {
    url: '/chat/completions', method: 'POST', headers: {},
    body: probeBody, purpose: NetworkFetchPurpose.ModelConnectionTest,
  })).toMatchObject({ ok: false });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

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
    redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'X-ACCESS-JWT': token, 'X-User-Account': 'test-user' },
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
