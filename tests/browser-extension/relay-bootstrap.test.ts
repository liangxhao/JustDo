import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAppServer } from '../../resources/browser-extension/conversation-overlay/modules/app-server-background.js';
import { requestLocalBootstrap } from '../../resources/browser-extension/conversation-overlay/modules/relay-bootstrap.js';

vi.mock(
  '../../resources/browser-extension/conversation-overlay/modules/app-server-background.js',
  () => ({
    ensureAppServer: vi.fn(),
  }),
);

class FixtureSocket {
  static current: FixtureSocket;
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  sent: Array<Record<string, unknown>> = [];
  close = vi.fn(() => this.emit('close'));
  constructor(readonly url: string) {
    FixtureSocket.current = this;
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  emit(type: string, response?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(response === undefined ? {} : { data: JSON.stringify(response) });
    }
  }
}

const request = { v: 1, op: 'bootstrap', nonce: 'test-nonce' };
const begin = async () => {
  const result = requestLocalBootstrap({}, request);
  await Promise.resolve();
  return { result, socket: FixtureSocket.current };
};

describe('product relay bootstrap transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FixtureSocket);
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '2.3.0' }) } });
    vi.mocked(ensureAppServer).mockReset().mockResolvedValue({
      localAppServerUrl: 'ws://127.0.0.1:42870/app-server?token=fixture',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('discovers the product host and returns native pairing after initializing its socket', async () => {
    const { result, socket } = await begin();
    expect(ensureAppServer).toHaveBeenCalledWith(false, 'browser-bootstrap');
    socket.emit('open');
    expect(socket.sent[0]).toMatchObject({ method: 'initialize' });
    expect(socket.sent).toHaveLength(1);
    socket.emit('message', { id: 'unrelated', result: {} });
    socket.emit('message', { id: 'relay:init:test-nonce', result: {} });
    expect(socket.sent.slice(1)).toEqual([
      { method: 'initialized' },
      { id: 'relay:pair:test-nonce', method: 'browser/extension/pair', params: {} },
    ]);
    socket.emit('message', {
      id: 'relay:pair:test-nonce',
      result: { pairingString: 'private-pairing' },
    });
    expect(await result).toEqual({
      v: 1,
      ok: true,
      nonce: 'test-nonce',
      pairingString: 'private-pairing',
    });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'close'])('returns a retryable result and closes on %s', async type => {
    const { result, socket } = await begin();
    socket.emit(type);
    expect(await result).toEqual({ v: 1, ok: false, code: 'pairing_unavailable' });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out without retaining a live bootstrap socket', async () => {
    const { result, socket } = await begin();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ ok: false, code: 'pairing_unavailable' });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('redacts server errors and rejects malformed pairing responses', async () => {
    for (const response of [
      { error: { message: 'private credential' } },
      { result: { pairingString: null } },
    ]) {
      const { result, socket } = await begin();
      socket.emit('message', { id: 'relay:pair:test-nonce', ...response });
      expect(await result).toEqual({ v: 1, ok: false, code: 'pairing_unavailable' });
    }
  });

  it('retains missing-host errors for the upstream retry policy', async () => {
    vi.mocked(ensureAppServer).mockRejectedValue(
      new Error('Specified native messaging host not found.'),
    );
    await expect(requestLocalBootstrap({}, request)).rejects.toThrow('host not found');
  });

  it('ignores late responses after timing out and handles malformed frames', async () => {
    const { result, socket } = await begin();
    socket.emit('message', null);
    expect(await result).toMatchObject({ ok: false });
    socket.emit('open');
    socket.emit('message', { id: 'relay:init:test-nonce', result: {} });
    expect(socket.sent).toHaveLength(0);
  });
});
