import { afterEach, describe, expect, it, vi } from 'vitest';

import plugin from '../../../../openclaw-extensions/video-openai/index';
import {
  buildIntranetVideoProvider,
  PROVIDER_ID,
} from '../../../../openclaw-extensions/video-openai/video-provider';

const sdk = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; init: RequestInit; timeout: number; options?: unknown }>,
  release: vi.fn(async () => undefined),
  httpRead: vi.fn(),
  jsonRead: vi.fn(),
  binary: vi.fn(async (response: Response, _options?: unknown) => ({
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: 'video/mp4',
  })),
  now: 0,
}));
vi.mock('openclaw/plugin-sdk/provider-http', () => ({
  assertOkOrThrowHttpError: async (response: Response, label: string, options: unknown) => {
    sdk.httpRead(response, label, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
  },
  createProviderOperationDeadline: ({ timeoutMs }: { timeoutMs: number }) => ({
    deadlineAtMs: sdk.now + timeoutMs,
  }),
  createProviderOperationTimeoutResolver:
    ({ deadline }: { deadline: { deadlineAtMs: number } }) =>
    () => {
      const remaining = deadline.deadlineAtMs - sdk.now;
      if (remaining <= 0) throw new Error('timed out');
      return remaining;
    },
  readProviderJsonObjectResponse: (response: Response, label: string, options: unknown) => {
    sdk.jsonRead(response, label, options);
    return response.json();
  },
  resolveProviderHttpRequestConfig: (options: {
    baseUrl: string;
    defaultHeaders: HeadersInit;
    request?: { allowPrivateNetwork?: boolean };
  }) => ({
    baseUrl: options.baseUrl,
    headers: new Headers(options.defaultHeaders),
    allowPrivateNetwork: options.request?.allowPrivateNetwork === true,
    dispatcherPolicy: { mode: 'configured' },
  }),
  sanitizeConfiguredModelProviderRequest: (value: unknown) => value,
  waitProviderOperationPollInterval: async ({ pollIntervalMs }: { pollIntervalMs: number }) => {
    sdk.now += pollIntervalMs;
  },
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init: RequestInit;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  }) => {
    sdk.requests.push({
      url: params.url,
      init: params.init,
      timeout: params.timeoutMs,
      options: params,
    });
    return { response: await params.fetchImpl(params.url, params.init), release: sdk.release };
  },
}));
vi.mock('openclaw/plugin-sdk/media-generation-runtime', () => ({
  readGeneratedVideoAsset: (response: Response, options: unknown) => sdk.binary(response, options),
  resolveGeneratedMediaMaxBytes: () => 100 * 1024 * 1024,
}));

const config = (apiKey?: unknown) => ({
  models: {
    providers: {
      [PROVIDER_ID]: {
        baseUrl: 'http://video.lan:8091/v1',
        ...(apiKey === undefined ? {} : { apiKey }),
        request: { allowPrivateNetwork: true },
      },
      openai: { apiKey: 'chat-secret', baseUrl: 'http://chat.lan/v1' },
    },
  },
});
const request = (apiKey?: unknown) => ({
  provider: PROVIDER_ID,
  model: 'Wan-AI/internal-video',
  prompt: 'A lake',
  cfg: config(apiKey),
});
const json = (id: string, status: string) =>
  new Response(JSON.stringify({ id, status }), { headers: { 'content-type': 'application/json' } });
const run = (req = request()) =>
  buildIntranetVideoProvider().generateVideo(
    req as Parameters<ReturnType<typeof buildIntranetVideoProvider>['generateVideo']>[0],
  );
afterEach(() => {
  sdk.requests.length = 0;
  sdk.now = 0;
  sdk.release.mockClear();
  sdk.httpRead.mockClear();
  sdk.jsonRead.mockClear();
  sdk.binary.mockClear();
  vi.unstubAllGlobals();
});

describe('intranet video provider', () => {
  it('registers the native provider and requires an explicit endpoint without public defaults', () => {
    const api = { registerVideoGenerationProvider: vi.fn() };
    plugin.register(api as Parameters<typeof plugin.register>[0]);
    const provider = api.registerVideoGenerationProvider.mock.calls[0][0];
    expect(provider.id).toBe(PROVIDER_ID);
    expect(provider.models).toBeUndefined();
    expect(provider.isConfigured({ cfg: {} })).toBe(false);
    expect(
      provider.isConfigured({
        cfg: { models: { providers: { openai: { baseUrl: 'http://chat.lan/v1' } } } },
      }),
    ).toBe(false);
    expect(provider.isConfigured({ cfg: config() })).toBe(true);
  });

  it('submits multipart data once, polls and downloads under one deadline using isolated credentials', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json('video-1', 'queued'))
      .mockResolvedValueOnce(json('video-1', 'in_progress'))
      .mockResolvedValueOnce(json('video-1', 'completed'))
      .mockResolvedValueOnce(new Response('video', { headers: { 'content-type': 'video/mp4' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await run({
      ...request('video-secret'),
      durationSeconds: 5,
      size: '1280x720',
      providerOptions: { seed: 42, fps: 16 },
      inputImages: [{ buffer: Buffer.from('image'), mimeType: 'image/png', role: 'first_frame' }],
    } as ReturnType<typeof request>);
    expect(result.videos[0].buffer?.toString()).toBe('video');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://video.lan:8091/v1/videos',
      'http://video.lan:8091/v1/videos/video-1',
      'http://video.lan:8091/v1/videos/video-1',
      'http://video.lan:8091/v1/videos/video-1/content',
    ]);
    const form = sdk.requests[0].init.body as FormData;
    expect(form.get('model')).toBe('Wan-AI/internal-video');
    expect(form.get('seconds')).toBe('5');
    expect(form.get('seed')).toBe('42');
    expect((form.get('input_reference') as Blob).size).toBe(5);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer video-secret');
      expect(new Headers(init.headers).get('content-type')).toBeNull();
    }
    expect(sdk.requests[3].timeout).toBe(598_000);
    expect(sdk.requests[3].options).toMatchObject({
      policy: { allowPrivateNetwork: true },
      mode: 'strict',
      maxRedirects: 0,
    });
    expect(sdk.binary).toHaveBeenCalledWith(
      expect.any(Response),
      expect.objectContaining({ maxBytes: 100 * 1024 * 1024, validateBinaryResponse: true }),
    );
    for (const [, , options] of sdk.jsonRead.mock.calls) {
      expect(options.requestHeaders.get('authorization')).toBe('Bearer video-secret');
      expect(options.timeoutMs).toEqual(expect.any(Function));
    }
    expect(sdk.binary.mock.calls[0][1]).toMatchObject({
      readOptions: { requestHeaders: expect.any(Headers) },
    });
    expect(sdk.release).toHaveBeenCalledTimes(4);
  });

  it.each(['submission', 'status', 'download'])(
    'passes active credentials and the deadline to %s error normalization',
    async stage => {
      const fetch = vi.fn();
      if (stage === 'status') fetch.mockResolvedValueOnce(json('video-1', 'queued'));
      if (stage === 'download') fetch.mockResolvedValueOnce(json('video-1', 'completed'));
      fetch.mockResolvedValueOnce(new Response('Access denied', { status: 401 }));
      vi.stubGlobal('fetch', fetch);
      await expect(run(request('video-secret'))).rejects.toThrow('HTTP 401');
      const options = sdk.httpRead.mock.calls.at(-1)?.[2];
      expect(options.requestHeaders.get('authorization')).toBe('Bearer video-secret');
      expect(options.bodyTimeoutMs()).toBe(600_000);
      expect(sdk.release).toHaveBeenCalledTimes(stage === 'submission' ? 1 : 2);
    },
  );

  it('supports unauthenticated internal services without borrowing the chat key', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json('video-2', 'completed'))
      .mockResolvedValueOnce(new Response('video'));
    vi.stubGlobal('fetch', fetch);
    await run();
    expect(new Headers(fetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
  });

  it.each(['failed', 'cancelled', 'unknown'])(
    'stops on %s jobs without downloading or resubmitting',
    async status => {
      const fetch = vi.fn().mockResolvedValue(json('video-1', status));
      vi.stubGlobal('fetch', fetch);
      await expect(run()).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sdk.release).toHaveBeenCalledOnce();
    },
  );

  it('never retries an uncertain submission', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connection closed'));
    vi.stubGlobal('fetch', fetch);
    await expect(run()).rejects.toThrow('connection closed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds status polling by the operation deadline and releases each response', async () => {
    const fetch = vi.fn().mockImplementation(async () => json('video-1', 'queued'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      run({ ...request(), timeoutMs: 1_000 } as ReturnType<typeof request>),
    ).rejects.toThrow('timed out');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sdk.release).toHaveBeenCalledTimes(2);
  });

  it.each(['../secret', 'different-id'])('rejects invalid or changed job identity %s', async id => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json('video-1', 'queued'))
      .mockResolvedValueOnce(json(id, 'completed'));
    vi.stubGlobal('fetch', fetch);
    await expect(run()).rejects.toThrow('job ID');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported or oversized references before a generation request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const input of [
      { inputVideos: [{ buffer: Buffer.from('video') }] },
      { inputImages: [{ buffer: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: 'image/png' }] },
      { providerOptions: { unexpected: 1 } },
    ]) {
      await expect(run({ ...request(), ...input } as ReturnType<typeof request>)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when a credential reference has not been resolved', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(run(request({ source: 'file', id: '/secret' }))).rejects.toThrow(
      'not been resolved',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
