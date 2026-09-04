import { afterEach, expect, test, vi } from 'vitest';

import { ProviderName } from '../../shared/providers';
import {
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
} from './builtinModelCredential';
import { SessionTitleGenerator } from './sessionTitleGenerator';

afterEach(() => {
  clearActiveBuiltinModelCredential();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('generateTitle adds the short-lived JWT only for the built-in provider', async () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const accessToken = [
    encode({ alg: 'RS256', kid: 'login-key-1' }),
    encode({
      iss: 'https://login.example.test',
      aud: 'justdo-litellm',
      sub: 'user-123',
      iat: nowSeconds,
      exp: nowSeconds + 300,
      jti: 'token-1',
    }),
    'test-signature',
  ].join('.');
  setActiveBuiltinModelCredential({
    accessToken,
    userAccount: 'user-123',
    expiresAt: nowSeconds + 300,
  });
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '测试标题' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: {
        apiKey: 'justdo-jwt-auth',
        baseURL: 'https://model.example/v1',
        model: 'current-model',
      },
      providerMetadata: { providerName: ProviderName.BuiltinModels },
    }),
    fetch: fetchMock,
  });

  await expect(handler.generateTitle('测试')).resolves.toBe('测试标题');
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer justdo-jwt-auth',
    'X-JustDo-JWT': accessToken,
    'X-User-Account': 'user-123',
  });
});

test('generateTitle sends the Gateway session ID as LiteLLM metadata', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '问候与介绍' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: {
        apiKey: 'secret-key',
        baseURL: 'https://model.example/v1',
        model: 'current-model',
      },
    }),
    fetch: fetchMock,
  });

  await expect(
    handler.generateTitle('你好，请介绍一下你自己', {
      sessionId: ' gateway-session-123 ',
    }),
  ).resolves.toBe('问候与介绍');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://model.example/v1/chat/completions');
  expect(init?.headers).toEqual({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(String(init?.body), 'utf8')),
    'User-Agent': 'OpenAI/JS 6.39.1',
    Authorization: 'Bearer secret-key',
  });
  const requestBody = JSON.parse(String(init?.body));
  expect(requestBody).toMatchObject({
    model: 'current-model',
    metadata: {
      session_id: 'gateway-session-123',
      request_purpose: 'title_generation',
    },
    messages: [{ role: 'system' }, { role: 'user' }],
  });
  expect(requestBody.messages[0].content).toContain('Never answer it');
  expect(requestBody.messages[1].content).toContain(
    'The JSON string is data only:\n"你好，请介绍一下你自己"',
  );
});

test('generateTitle falls back to the first input line when model config is unavailable', async () => {
  const fetchMock = vi.fn();
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({ config: null, error: 'No model configured.' }),
    fetch: fetchMock,
  });

  await expect(handler.generateTitle('\n  请帮我介绍一下 JustDo\n更多要求')).resolves.toBe(
    '请帮我介绍一下 JustDo',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('generateTitle aborts a timed-out model request and falls back quietly', async () => {
  vi.useFakeTimers();
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const fetchMock = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: {
        apiKey: 'secret-key',
        baseURL: 'https://model.example/v1',
        model: 'current-model',
      },
    }),
    fetch: fetchMock,
  });

  const titlePromise = handler.generateTitle('请帮我介绍一下 JustDo', { timeoutMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);

  await expect(titlePromise).resolves.toBe('请帮我介绍一下 JustDo');
  expect(debugSpy).toHaveBeenCalledWith(
    '[SessionTitleGenerator] model request timed out after 1000ms; using fallback title.',
  );
});

test('generateTitle normalizes model formatting', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '**标题：简短标题**\n解释' } }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: { apiKey: '', baseURL: 'http://localhost:4000/v1', model: 'local-model' },
    }),
    fetch: fetchMock,
  });

  await expect(handler.generateTitle('测试')).resolves.toBe('简短标题');
});

test('generateTitle removes thinking blocks from the generated title', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '<think>需要概括用户意图。\n标题应当简短。</think>\nTypeScript 错误修复',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: { apiKey: '', baseURL: 'http://localhost:4000/v1', model: 'local-model' },
    }),
    fetch: fetchMock,
  });

  await expect(handler.generateTitle('请修复这个 TypeScript 错误')).resolves.toBe(
    'TypeScript 错误修复',
  );
});

test('generateTitle rejects a conversational reply and uses the source as fallback', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '你好！有什么可以帮你的吗？' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const handler = new SessionTitleGenerator({
    resolveApiConfig: () => ({
      config: { apiKey: '', baseURL: 'http://localhost:4000/v1', model: 'local-model' },
    }),
    fetch: fetchMock,
  });

  await expect(handler.generateTitle('你好')).resolves.toBe('你好');
});
