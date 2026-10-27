import { EventEmitter } from 'node:events';

import { beforeEach, expect, test, vi } from 'vitest';

import { ManagedMediaPlayback } from './managedMediaPlayback';

const sessionKey = 'agent:main:session-one';
const source = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/11111111-1111-4111-8111-111111111111/full`;

function fixture() {
  const frame = {} as Electron.WebFrameMain;
  const owner = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
  }) as unknown as Electron.WebContents;
  const state = { lifecycle: 1, process: 2, phase: 'running' };
  const manager = Object.assign(new EventEmitter(), {
    getStatus: () => ({ phase: state.phase }),
    getGatewayLifecycleGeneration: () => state.lifecycle,
    getGatewayProcessGeneration: () => state.process,
    getGatewayConnectionInfo: vi.fn(() => ({ port: 12345, token: 'private-test-token' })),
  });
  const fetchMock = vi.fn<typeof fetch>(async () => new Response('0123456789', {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': '10' },
  }));
  const playback = new ManagedMediaPlayback({
    getManager: () => manager as never,
    isTrustedFrame: (sender, candidate) => sender === owner && candidate === owner.mainFrame,
    fetch: fetchMock,
  });
  const prepare = (value: unknown = { source, sessionKey, kind: 'audio' }) =>
    playback.prepare(owner, owner.mainFrame, value);
  const grant = () => {
    const result = prepare();
    if (!result.success) throw new Error(result.error);
    return result.url;
  };
  return { owner, frame, manager, state, fetchMock, playback, prepare, grant };
}

beforeEach(() => vi.restoreAllMocks());

test('issues an opaque grant only for a trusted frame and a canonical audio/video request', () => {
  const f = fixture();
  const result = f.prepare();
  expect(result).toEqual({ success: true, url: expect.stringMatching(/^localmedia:\/\/gateway\/[a-f0-9]{64}$/u) });
  expect(JSON.stringify(result)).not.toContain('private-test-token');
  expect(f.playback.prepare(f.owner, {} as Electron.WebFrameMain, { source, sessionKey, kind: 'audio' }).success).toBe(false);
  for (const value of [
    { source, sessionKey: 'agent:other:session-one', kind: 'audio' },
    { source, sessionKey, kind: 'image' },
    { source: `${source}?extra=1`, sessionKey, kind: 'audio' },
    { source, sessionKey, kind: 'audio', path: '/tmp/audio.wav' },
  ]) expect(f.prepare(value).success).toBe(false);
  expect(f.fetchMock).not.toHaveBeenCalled();
});

test('admits only the captured owner and exact live main frame at the network boundary', () => {
  const f = fixture();
  const url = f.grant();
  const details = { url, webContentsId: f.owner.id, webContents: f.owner, frame: f.frame };
  expect(f.playback.authorize(details)).toBe(true);
  expect(f.playback.authorize({ ...details, webContentsId: undefined })).toBe(false);
  expect(f.playback.authorize({ ...details, frame: undefined })).toBe(false);
  expect(f.playback.authorize({ ...details, webContentsId: 8 })).toBe(false);
  expect(f.playback.authorize({ ...details, frame: {} as Electron.WebFrameMain })).toBe(false);
  Object.assign(f.owner, { mainFrame: {} });
  expect(f.playback.authorize(details)).toBe(false);
});

test('streams authorized bytes without exposing credentials or upstream headers', async () => {
  const f = fixture();
  const url = f.grant();
  const response = await f.playback.respond(new Request(url));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('0123456789');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(f.manager.getGatewayConnectionInfo).toHaveBeenCalledTimes(2);
  expect(f.fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:12345${source}`, expect.objectContaining({
    method: 'GET', redirect: 'error', headers: {
      Accept: 'audio/*', Authorization: 'Bearer private-test-token',
      'x-openclaw-requester-session-key': sessionKey,
    },
  }));
});

test('preserves validated 206 ranges and 416 responses, and forwards HEAD without a body', async () => {
  const f = fixture();
  const url = f.grant();
  f.fetchMock.mockResolvedValueOnce(new Response('2345', {
    status: 206,
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10' },
  }));
  const partial = await f.playback.respond(new Request(url, { headers: { Range: 'bytes=2-5' } }));
  expect(partial.status).toBe(206);
  expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/10');
  expect(await partial.text()).toBe('2345');
  f.fetchMock.mockResolvedValueOnce(new Response(null, {
    status: 416, headers: { 'Content-Range': 'bytes */10' },
  }));
  const unavailable = await f.playback.respond(new Request(url, { headers: { Range: 'bytes=20-' } }));
  expect(unavailable.status).toBe(416);
  expect(unavailable.headers.get('Content-Range')).toBe('bytes */10');
  f.fetchMock.mockResolvedValueOnce(new Response(null, {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': '10' },
  }));
  const head = await f.playback.respond(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=2-5' } }));
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
  expect(head.headers.get('Content-Length')).toBe('10');
  expect(f.fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('HEAD');
  expect(f.fetchMock.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty('Range');
});

test('rejects ignored or inconsistent ranges, wrong MIME, redirect, and non-read methods', async () => {
  const f = fixture();
  const url = f.grant();
  expect((await f.playback.respond(new Request(url, { headers: { Range: 'bytes=0-1,4-5' } }))).status).toBe(416);
  expect((await f.playback.respond(new Request(url, { method: 'POST' }))).status).toBe(405);
  expect(f.fetchMock).not.toHaveBeenCalled();
  expect((await f.playback.respond(new Request(url, { headers: { Range: 'bytes=2-5' } }))).status).toBe(502);
  for (const response of [
    new Response('html', { headers: { 'Content-Type': 'text/html', 'Content-Length': '4' } }),
    new Response(null, { status: 302, headers: { Location: 'https://example.com' } }),
    new Response('2345', { status: 206, headers: { 'Content-Type': 'audio/wav', 'Content-Length': '4', 'Content-Range': 'bytes 3-6/10' } }),
  ]) {
    f.fetchMock.mockResolvedValueOnce(response);
    expect((await f.playback.respond(new Request(url, { headers: { Range: 'bytes=2-5' } }))).status).toBe(502);
  }
});

test('release and Gateway incarnation changes cancel active streams and revoke their grants', async () => {
  const f = fixture();
  let canceled = false;
  f.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
    cancel: () => { canceled = true; },
  }), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': '10' } }));
  const url = f.grant();
  const response = await f.playback.respond(new Request(url));
  const reading = response.text();
  expect(f.playback.release(f.owner, {} as Electron.WebFrameMain, { url }).success).toBe(false);
  f.state.process++;
  f.manager.emit('status');
  await expect(reading).rejects.toThrow('Media playback is unavailable');
  expect(canceled).toBe(true);
  expect((await f.playback.respond(new Request(url))).status).toBe(404);
  const next = f.grant();
  expect(f.playback.release(f.owner, f.frame, { url: next }).success).toBe(true);
  expect((await f.playback.respond(new Request(next))).status).toBe(404);
});

test('revokes on real navigation or destruction, retains in-page navigation, and bounds grants', async () => {
  const f = fixture();
  const url = f.grant();
  f.owner.emit('did-start-navigation', {}, 'https://app/#section', true, true);
  expect(f.playback.authorize({ url, webContentsId: f.owner.id, frame: f.frame })).toBe(true);
  f.owner.emit('did-start-navigation', {}, 'https://app/', false, true);
  expect((await f.playback.respond(new Request(url))).status).toBe(404);
  for (let index = 0; index < 256; index++) expect(f.prepare().success).toBe(true);
  expect(f.prepare().success).toBe(false);
  f.owner.emit('destroyed');
  expect(f.owner.listenerCount('did-start-navigation')).toBe(0);
  expect(f.manager.listenerCount('status')).toBe(0);
});
