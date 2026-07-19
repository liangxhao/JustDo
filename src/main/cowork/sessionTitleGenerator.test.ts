import { afterEach, expect, test, vi } from 'vitest';

import { SessionTitleGenerator } from './sessionTitleGenerator';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('generateTitle calls the current model directly without a Gateway session', async () => {
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

  await expect(handler.generateTitle('你好，请介绍一下你自己')).resolves.toBe('问候与介绍');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://model.example/v1/chat/completions');
  expect(init?.headers).toEqual({
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret-key',
  });
  const requestBody = JSON.parse(String(init?.body));
  expect(requestBody).toMatchObject({
    model: 'current-model',
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

  const titlePromise = handler.generateTitle('请帮我介绍一下 JustDo', 1_000);
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
