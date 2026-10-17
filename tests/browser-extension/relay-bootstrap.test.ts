import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_NOT_RUNNING_CODE,
  ensureAppServer,
} from '../../resources/browser-extension/conversation-overlay/modules/app-server-background.js';
import { requestLocalBootstrap } from '../../resources/browser-extension/conversation-overlay/modules/relay-bootstrap.js';
import { parsePairingString } from '../../resources/browser-extension/openclaw/modules/relay-core.js';
import { hasExactKeys } from '../../resources/browser-extension/openclaw/modules/strict-json.js';

const { prepareBrowserExtension } = require('../../scripts/browser/prepare-browser-extension.cjs');

vi.mock(
  '../../resources/browser-extension/conversation-overlay/modules/app-server-background.js',
  () => ({
    APP_NOT_RUNNING_CODE: 'APP_NOT_RUNNING',
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
    expect(ensureAppServer).toHaveBeenCalledWith('browser-bootstrap');
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

  it('keeps automatic pairing retryable until the user starts the desktop app', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-bootstrap-recovery-'));
    try {
      const projectRoot = path.resolve(__dirname, '../..');
      fs.cpSync(
        path.join(projectRoot, 'resources/browser-extension'),
        path.join(directory, 'resources/browser-extension'),
        { recursive: true },
      );
      fs.cpSync(
        path.join(projectRoot, 'resources/icons/png'),
        path.join(directory, 'resources/icons/png'),
        {
          recursive: true,
        },
      );
      fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(directory, 'package.json'));
      const prepared = prepareBrowserExtension({
        repoRoot: directory,
      });
      const source = fs.readFileSync(
        path.join(prepared.outputDir, 'modules/native-bootstrap.js'),
        'utf8',
      );
      const createController = vm.runInNewContext(
        source.replace(/^import .*;$/gm, '').replace(/\bexport /g, '') +
          ';createNativeBootstrapController',
        {
          randomRelayBase64Url: () => request.nonce,
          parsePairingString,
          hasExactKeys,
          ACCESS_MODE_ALL: 'all',
          crypto: {},
        },
      );
      const stored: Record<string, unknown> = {};
      const applyPairing = vi.fn(async () => ({ ok: true }));
      const controller = createController({
        chromeApi: {
          storage: {
            local: {
              get: async () => ({ ...stored }),
              set: async (values: Record<string, unknown>) => Object.assign(stored, values),
              remove: async (keys: string[]) =>
                keys.forEach(key => {
                  delete stored[key];
                }),
            },
          },
        },
        getPairing: async () => undefined,
        applyPairing,
        requestBootstrap: requestLocalBootstrap,
      });
      vi.mocked(ensureAppServer).mockRejectedValueOnce(
        Object.assign(new Error('App is not running.'), { code: APP_NOT_RUNNING_CODE }),
      );

      expect(await controller.attempt()).toEqual({
        status: 'retrying',
        code: 'pairing_unavailable',
      });
      expect(applyPairing).not.toHaveBeenCalled();

      const previousSocket = FixtureSocket.current;
      const recovered = controller.attempt();
      for (let index = 0; index < 20 && FixtureSocket.current === previousSocket; index += 1)
        await Promise.resolve();
      const socket = FixtureSocket.current;
      expect(socket).not.toBe(previousSocket);
      socket.emit('open');
      socket.emit('message', { id: `relay:init:${request.nonce}`, result: {} });
      socket.emit('message', {
        id: `relay:pair:${request.nonce}`,
        result: { pairingString: `ws://127.0.0.1:42870/browser/extension#${'c'.repeat(64)}` },
      });

      expect(await recovered).toEqual({ status: 'paired' });
      expect(applyPairing).toHaveBeenCalledOnce();
      expect(stored.nativeBootstrapState).toBe('ready');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
