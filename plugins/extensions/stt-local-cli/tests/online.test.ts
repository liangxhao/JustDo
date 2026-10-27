import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readOnlineConfig, requestOnlineTranscription, transcribeOnlineFile } from '../online';
import { readConfig, type RunCommand } from '../transcribe';

const http = vi.hoisted(() => ({
  fetch: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  read: vi.fn(),
  ok: vi.fn(),
}));
const fileAccess = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('openclaw/plugin-sdk/file-access-runtime', () => ({
  root: async (rootDir: string) => ({
    read: async (relative: string, options: unknown) => {
      fileAccess.read(rootDir, relative, options);
      return { buffer: await fs.readFile(path.join(rootDir, relative)) };
    },
  }),
}));
vi.mock('openclaw/plugin-sdk/provider-http', () => ({
  resolveProviderHttpRequestConfig: (input: { baseUrl: string; defaultHeaders: HeadersInit }) => {
    http.resolve(input);
    return { baseUrl: input.baseUrl, headers: new Headers(input.defaultHeaders) };
  },
  buildAudioTranscriptionFormData: (input: {
    fields: Record<string, string | undefined>;
    buffer: Buffer;
  }) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(input.fields))
      if (value !== undefined) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(input.buffer)]), 'audio.wav');
    return form;
  },
  assertOkOrThrowHttpError: (...args: unknown[]) => http.ok(...args),
  readProviderJsonObjectResponse: (...args: unknown[]) => http.read(...args),
  requireTranscriptionText: (value: string | undefined, message: string) => {
    if (!value?.trim()) throw new Error(message);
    return value.trim();
  },
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => ({
    allowedOrigins: [new URL(baseUrl).origin],
  }),
  fetchWithSsrFGuard: (...args: unknown[]) => http.fetch(...args),
}));

const config = readOnlineConfig({
  mode: 'online',
  baseUrl: 'http://asr.intranet:8080/v1',
  model: 'meeting',
  language: 'auto',
});
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-test-'));
  roots.push(root);
  const input = path.join(root, 'recording.wav');
  await fs.writeFile(input, 'audio');
  return { root, input };
}
const decode: RunCommand = async (_command, args) => {
  await fs.writeFile(args.at(-1)!.replace('%04d', '0000'), Buffer.alloc(32078));
  await fs.writeFile(args.at(-1)!.replace('%04d', '0001'), Buffer.alloc(32078));
  return '';
};

describe('configured online attachment transcription', () => {
  it('requires explicit online fields and resolved credentials without a public or local default', () => {
    expect(config.apiKey).toBe('');
    expect(
      readConfig({ command: path.resolve('asr.exe'), args: [], modelId: 'old', language: 'en' }),
    ).toBeNull();
    for (const value of [
      { mode: 'online' },
      { ...config, baseUrl: 'file:///audio' },
      { ...config, baseUrl: 'http://user:password@asr/' },
      { ...config, apiKey: { source: 'file' } },
    ])
      expect(() => readOnlineConfig(value)).toThrow();
  });
  it('uses native multipart, origin trust and zero redirects, with no authorization header for an empty key', async () => {
    http.fetch.mockImplementation(async (request: { beforeRequest: () => void }) => {
      request.beforeRequest();
      return { response: new Response(), release: http.release };
    });
    http.read.mockResolvedValue({ text: 'transcript' });
    const assertCurrent = vi.fn();
    const signal = new AbortController().signal;
    await expect(
      requestOnlineTranscription({ config, buffer: Buffer.from('audio'), signal, assertCurrent }),
    ).resolves.toBe('transcript');
    const request = http.fetch.mock.calls[0][0];
    expect(request).toMatchObject({
      url: 'http://asr.intranet:8080/v1/audio/transcriptions',
      maxRedirects: 0,
      mode: 'strict',
      policy: { allowedOrigins: ['http://asr.intranet:8080'] },
    });
    expect(request.init.signal).toBe(signal);
    expect(request.init.headers.has('Authorization')).toBe(false);
    expect(request.init.body.get('model')).toBe('meeting');
    expect(request.init.body.has('language')).toBe(false);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    expect(http.release).toHaveBeenCalledOnce();
  });
  it('rechecks invocation admission immediately before upload and releases failed responses', async () => {
    http.fetch.mockImplementation(async (request: { beforeRequest: () => void }) => {
      request.beforeRequest();
      return { response: new Response(), release: http.release };
    });
    http.ok.mockRejectedValueOnce(new Error('service rejected upload'));
    await expect(
      requestOnlineTranscription({
        config: { ...config, apiKey: 'test-key' },
        buffer: Buffer.from('audio'),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('service rejected');
    expect(http.fetch.mock.calls[0][0].init.headers.get('Authorization')).toBe('Bearer test-key');
    expect(http.release).toHaveBeenCalledOnce();
    http.fetch.mockClear();
    const abort = new AbortController();
    abort.abort();
    await expect(
      requestOnlineTranscription({ config, buffer: Buffer.from('audio'), signal: abort.signal }),
    ).rejects.toThrow();
    expect(http.fetch).not.toHaveBeenCalled();
  });
  it('decodes bounded local segments and cancels without partial success or a fallback', async () => {
    const { input, root } = await fixture();
    const abort = new AbortController();
    const send = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      abort.abort();
      return 'partial';
    });
    const run = vi.fn(decode);
    await expect(
      transcribeOnlineFile(input, config, {
        run,
        send,
        workspaceDir: root,
        workspaceOnly: true,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    await expect(fs.stat(path.dirname(run.mock.calls[0][1].at(-1)!))).rejects.toThrow();
  });
  it('enforces the same file/workspace/duration admission before any upload', async () => {
    const { input } = await fixture();
    const { root } = await fixture();
    const send = vi.fn();
    const run = vi.fn(decode);
    await expect(
      transcribeOnlineFile(input, config, { run, send, workspaceDir: root, workspaceOnly: true }),
    ).rejects.toThrow('outside');
    await expect(
      transcribeOnlineFile('https://asr/audio.wav', config, { run, send }),
    ).rejects.toThrow('absolute local');
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('snapshots within the effective root and fails a native file-identity rejection before decoding or upload', async () => {
    const { input, root } = await fixture();
    const run = vi.fn(decode);
    const send = vi.fn(async () => 'text');
    await transcribeOnlineFile(input, config, {
      run,
      send,
      workspaceDir: root,
      workspaceOnly: true,
    });
    expect(fileAccess.read).toHaveBeenCalledWith(root, 'recording.wav', {
      maxBytes: 256 * 1024 * 1024,
      hardlinks: 'reject',
      symlinks: 'reject',
    });
    run.mockClear();
    send.mockClear();
    fileAccess.read.mockImplementationOnce(() => {
      throw new Error('File replaced by a link');
    });
    await expect(
      transcribeOnlineFile(input, config, { run, send, workspaceDir: root, workspaceOnly: true }),
    ).rejects.toThrow('replaced by a link');
    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
