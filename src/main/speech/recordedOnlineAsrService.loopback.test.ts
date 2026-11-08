import { randomInt } from 'node:crypto';
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import {
  MAX_RECORDED_ASR_RESPONSE_BYTES,
  resolveRecordedOnlineAsrProfile,
  transcribeRecordedOnlineAudio,
} from './recordedOnlineAsrService';

// Isolate desktop preferences only. The real Main transport, fetch, sockets and proxy agent run.
const preferences = vi.hoisted(() => ({ proxy: null as string | null }));
vi.mock('../core/network/systemProxy', () => ({
  getFixedProxyUrl: () => preferences.proxy,
  isSystemProxyEnabled: () => false,
  resolveSystemProxyUrl: async () => null,
}));
vi.mock('../core/network/outboundHeaderPolicyConfig', () => ({
  getOutboundHeaderPolicyConfig: vi.fn(), getOutboundHeaderUserInfo: vi.fn(),
}));
vi.mock('../core/network/outboundHeaderProxy', () => ({
  applyOutboundHeaders: vi.fn(), resolveOutboundHeaderNamesForRequest: vi.fn(),
  resolveOutboundHeaderProxyConfig: vi.fn(), shouldApplyOutboundHeadersForRequest: vi.fn(),
}));

interface CapturedRequest { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer }
type Route = (request: CapturedRequest, response: ServerResponse) => void;
const servers: http.Server[] = [];
const DEPLOYMENT = '/tenant/speech/v1';
const TOKEN = 'loopback-fixture-key';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function listenOnLoopback(server: http.Server): Promise<void> {
  // Windows can allocate port 0 from a range containing fetch-forbidden ports.
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(randomInt(49152, 65536), '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No available high loopback port for the speech fixture.');
}

async function serve(routes: Record<string, Route>) {
  const requests: CapturedRequest[] = [];
  const arrivals: Array<{ method?: string; path?: string }> = [];
  const received = deferred<CapturedRequest>();
  const responseClosed = deferred<void>();
  const server = http.createServer((request, response) => {
    arrivals.push({ method: request.method, path: request.url });
    response.once('close', () => responseClosed.resolve());
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const capture = { method: request.method ?? '', path: request.url ?? '',
        headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(capture);
      received.resolve(capture);
      const route = routes[`${capture.method} ${capture.path}`];
      if (route) route(capture, response);
      else { response.writeHead(404); response.end('Unexpected fake-service route.'); }
    })().catch(() => response.destroy());
  });
  servers.push(server);
  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener.');
  return { origin: `http://127.0.0.1:${address.port}`, requests, arrivals,
    received: received.promise, responseClosed: responseClosed.promise };
}

async function throughProxy(origin: string, path: string) {
  const proxy = await serve({ [`POST ${origin}${path}`]: (capture, response) => {
    const upstream = http.request(`${origin}${path}`, { method: 'POST', headers: capture.headers,
      agent: false }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    response.once('close', () => upstream.destroy());
    upstream.once('error', () => response.destroy());
    upstream.end(capture.body);
  } });
  preferences.proxy = proxy.origin;
  return proxy;
}

function wavFixture(): Uint8Array {
  const bytes = Buffer.alloc(364);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Uint8Array(bytes);
}

function profile(origin: string, key = TOKEN) {
  const selected = resolveRecordedOnlineAsrProfile({ ...defaultLocalSpeechSettings,
    inputEnabled: true, recognitionMode: 'online', onlineAsrModelRef: 'fixture/arbitrary/asr',
    onlineAsrBindingId: 'provider' }, { providers: { fixture: {
      displayName: 'Protocol fixture', baseUrl: `${origin}${DEPLOYMENT}`, apiKey: key,
      protocolId: 'openai-transcription-http',
      models: [{ id: 'arbitrary/asr', name: 'Fixture model' }],
    } } });
  if (!selected) throw new Error('Fixture provider was not selected.');
  return selected;
}

afterEach(async () => {
  preferences.proxy = null;
  for (const server of servers.splice(0).reverse()) {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

describe('recorded ASR over actual loopback HTTP', () => {
  it('serializes multipart audio and parses a split transcription response', async () => {
    const path = `${DEPLOYMENT}/audio/transcriptions`;
    const service = await serve({ [`POST ${path}`]: (_capture, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const text = JSON.stringify({ text: '你好，测试通过。' });
      response.write(text.slice(0, 12));
      setImmediate(() => response.end(text.slice(12)));
    } });
    const audio = wavFixture();
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), audio, 'zh',
      new AbortController().signal, () => {})).resolves.toBe('你好，测试通过。');
    expect(service.requests).toHaveLength(1);
    const request = service.requests[0];
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const form = await new Response(new Uint8Array(request.body), {
      headers: { 'content-type': request.headers['content-type']! },
    }).formData();
    expect([...form.keys()].sort()).toEqual(['file', 'language', 'model']);
    expect(form.get('model')).toBe('arbitrary/asr'); expect(form.get('language')).toBe('zh');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav'); expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(audio));
  });

  it('preserves multipart audio through the real configured proxy transport without adding credentials', async () => {
    const path = `${DEPLOYMENT}/audio/transcriptions`;
    const service = await serve({ [`POST ${path}`]: (_capture, response) => response.end('{"text":"via proxy"}') });
    const proxy = await throughProxy(service.origin, path);
    await expect(transcribeRecordedOnlineAudio(profile(service.origin, ''), wavFixture(), 'auto',
      new AbortController().signal, () => {})).resolves.toBe('via proxy');
    expect(proxy.requests).toHaveLength(1); expect(service.requests).toHaveLength(1);
    expect(service.requests[0].body).toEqual(proxy.requests[0].body);
    expect(service.requests[0].headers.authorization).toBeUndefined();
    expect(service.requests[0].headers['proxy-authorization']).toBeUndefined();
    const form = await new Response(new Uint8Array(service.requests[0].body), {
      headers: { 'content-type': service.requests[0].headers['content-type']! },
    }).formData();
    expect(form.has('language')).toBe(false);
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(Buffer.from(wavFixture()));
  });

  it.each([false, true])('cancels a sent request and closes the remote socket (proxy=%s)', async proxy => {
    const path = `${DEPLOYMENT}/audio/transcriptions`;
    const service = await serve({ [`POST ${path}`]: () => {} });
    if (proxy) await throughProxy(service.origin, path);
    const abort = new AbortController();
    const outcome = transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en', abort.signal, () => {})
      .then(() => null, (error: unknown) => error);
    await service.received;
    abort.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await service.responseClosed;
    expect(service.requests).toHaveLength(1);
  }, 5000);

  it('does not dispatch when the owner is revoked before the real transport begins', async () => {
    const service = await serve({});
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en',
      new AbortController().signal, () => { throw new Error('Owner retired.'); })).rejects.toThrow('Owner retired');
    expect(service.requests).toHaveLength(0);
  });

  it('rejects redirects without sending audio or authorization to the destination', async () => {
    const trap = await serve({ 'POST /capture': (_capture, response) => response.end('{"text":"wrong origin"}') });
    const service = await serve({ [`POST ${DEPLOYMENT}/audio/transcriptions`]: (_capture, response) => {
      response.writeHead(307, { location: `${trap.origin}/capture` }); response.end();
    } });
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en',
      new AbortController().signal, () => {})).rejects.toThrow();
    expect(service.requests.map(request => request.path)).toEqual([`${DEPLOYMENT}/audio/transcriptions`]);
    expect(trap.arrivals).toHaveLength(0);
  });

  it('reports only HTTP status and never retries a rejected service request', async () => {
    const service = await serve({ [`POST ${DEPLOYMENT}/audio/transcriptions`]: (_capture, response) => {
      response.writeHead(401); response.end(`private response ${TOKEN}`);
    } });
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en',
      new AbortController().signal, () => {})).rejects.toMatchObject({ message: 'Speech service returned HTTP 401.' });
    expect(service.requests).toHaveLength(1);
  });

  it('rejects a non-transcription response received through a real connection', async () => {
    const service = await serve({ [`POST ${DEPLOYMENT}/audio/transcriptions`]: (_capture, response) =>
      response.end('{"choices":[{"message":{"content":"wrong response contract"}}]}') });
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en',
      new AbortController().signal, () => {})).rejects.toThrow('transcription result');
    expect(service.requests).toHaveLength(1);
  });

  it('bounds a chunked response by actual bytes rather than trusting Content-Length', async () => {
    const service = await serve({ [`POST ${DEPLOYMENT}/audio/transcriptions`]: (_capture, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      response.end(Buffer.alloc(MAX_RECORDED_ASR_RESPONSE_BYTES + 1, 'x'));
    } });
    await expect(transcribeRecordedOnlineAudio(profile(service.origin), wavFixture(), 'en',
      new AbortController().signal, () => {})).rejects.toThrow('size limit');
    expect(service.requests).toHaveLength(1);
  });
});
