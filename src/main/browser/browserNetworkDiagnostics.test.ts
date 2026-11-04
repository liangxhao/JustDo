import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  proxyMode: vi.fn(),
  proxyState: vi.fn(),
  observeProxy: vi.fn(),
}));

vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: mocks.createConnection,
}));
vi.mock('../core/network/systemProxyPreference', () => ({
  BrowserProxyStatus: { READY: 'ready' },
  getBrowserProxyMode: mocks.proxyMode,
  getBrowserProxySessionState: mocks.proxyState,
  observeBrowserProxySession: mocks.observeProxy,
}));

import { registerBrowserNetworkDiagnostics } from './browserNetworkDiagnostics';

const flush = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

let nextGuestId = 0;
const guests: EventEmitter[] = [];
const sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];
const observers = new Map<unknown, (state: { generation: number; status: string }) => void>();
let warn: ReturnType<typeof vi.spyOn>;

const fixture = () => {
  let destroyed = false;
  const browserSession = {
    resolveProxy: vi.fn().mockResolvedValue('PROXY 192.0.2.10:8080'),
    resolveHost: vi.fn().mockResolvedValue({ endpoints: [{ address: '192.0.2.11' }] }),
  };
  const guest = Object.assign(new EventEmitter(), {
    id: ++nextGuestId,
    session: browserSession,
    isDestroyed: () => destroyed,
  });
  guests.push(guest);
  const register = () => registerBrowserNetworkDiagnostics(guest as unknown as Electron.WebContents);
  register();
  return {
    guest,
    browserSession,
    register,
    fail: (code = -130, description = 'ERR_PROXY_CONNECTION_FAILED', url = 'https://site.example/page?token=secret', main = true) =>
      guest.emit('did-fail-load', {}, code, description, url, main),
    navigate: () => guest.emit('did-start-navigation', {}, 'https://next.example/', false, true),
    destroy: () => {
      destroyed = true;
      guest.emit('destroyed');
    },
  };
};

const records = (): Array<Record<string, unknown>> => warn.mock.calls.map(([line]) =>
  JSON.parse((line as string).slice('[BrowserNetworkDiagnostics] '.length)),
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T04:00:00Z'));
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.proxyMode.mockReturnValue('system');
  mocks.proxyState.mockReturnValue({ generation: 7, status: 'ready' });
  mocks.observeProxy.mockImplementation((session, observer) => {
    observers.set(session, observer);
    observer({ generation: 7, status: 'ready' });
    return () => observers.delete(session);
  });
  mocks.createConnection.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    sockets.push(socket);
    return socket;
  });
});

afterEach(async () => {
  for (const guest of guests.splice(0)) guest.emit('destroyed');
  await flush();
  for (const call of warn.mock.calls) {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('string');
    expect(call[0]).not.toMatch(/[\r\n]/u);
    expect(() => JSON.parse(call[0].slice('[BrowserNetworkDiagnostics] '.length))).not.toThrow();
  }
  sockets.splice(0);
  observers.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('sidebar browser network diagnostics', () => {
  test('uses the exact failed guest session and logs only single-string JSON lines', async () => {
    const f = fixture();
    f.register();

    f.fail();
    await flush();
    sockets[0].emit('connect');
    await flush();

    expect(f.browserSession.resolveProxy).toHaveBeenCalledExactlyOnceWith('https://site.example/page?token=secret');
    expect(f.browserSession.resolveHost).not.toHaveBeenCalled();
    expect(mocks.createConnection).toHaveBeenCalledExactlyOnceWith({ host: '192.0.2.10', port: 8080 });
    expect(sockets[0].destroy).toHaveBeenCalledOnce();
    expect(records()).toEqual([
      expect.objectContaining({
        event: 'load-failed', guestId: f.guest.id, origin: 'https://site.example',
        errorCode: -130, error: 'ERR_PROXY_CONNECTION_FAILED', proxyMode: 'system',
        proxyGeneration: 7, proxyStatus: 'ready', check: 'started',
      }),
      expect.objectContaining({
        event: 'proxy-check', status: 'complete', routeObservation: 'after-failure',
        resolvedRoutes: [{ scheme: 'http', host: '192.0.2.10', port: 8080 }],
        probeTransport: 'main-tcp',
        probes: [{ scheme: 'http', host: '192.0.2.10', port: 8080, status: 'complete', addresses: [{ address: '192.0.2.10', status: 'connected' }] }],
      }),
    ]);
    expect(records()[0].diagnosticId).toBe(records()[1].diagnosticId);
    for (const call of warn.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0]).toMatch(/^\[BrowserNetworkDiagnostics\] \{.*\}$/u);
      expect(call[0]).not.toMatch(/[\r\n]/u);
    }
  });

  test('ignores cancelled navigations, subframes and local files', async () => {
    const f = fixture();
    f.fail(-3, 'ERR_ABORTED');
    f.fail(-130, 'ERR_PROXY_CONNECTION_FAILED', 'https://site.example/', false);
    f.fail(-6, 'ERR_FILE_NOT_FOUND', 'file:///C:/private/report.html');

    await flush();

    expect(warn).not.toHaveBeenCalled();
    expect(f.browserSession.resolveProxy).not.toHaveBeenCalled();
  });

  test('omits URL secrets, malformed proxy text and raw errors', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('PROXY user:password@proxy.example:8080\nprivate; PROXY proxy.internal:8080; DIRECT');

    f.fail(-105, 'ERR_NAME_NOT_RESOLVED\nsecret detail', 'https://user:password@site.example/private/path?token=secret#private');
    await flush();

    expect(records()[0]).toMatchObject({ origin: 'https://site.example', error: 'UNKNOWN' });
    expect(records()[1]).toMatchObject({
      unrecognizedRoutes: 1,
      resolvedRoutes: [{ scheme: 'http', host: 'proxy.internal', port: 8080 }, { scheme: 'direct' }],
      probes: [],
    });
    const output = warn.mock.calls.flat().join('');
    expect(output).not.toMatch(/user|password|private|token=|secret detail|\n/u);
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test('resolves proxy DNS through the same browser session and records refused TCP', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('HTTPS proxy.company.example:8443');

    f.fail();
    await flush();
    sockets[0].emit('error', Object.assign(new Error('private socket detail\nsecret'), { code: 'ECONNREFUSED' }));
    await flush();

    expect(f.browserSession.resolveHost).toHaveBeenCalledExactlyOnceWith('proxy.company.example');
    expect(records()[1]).toMatchObject({
      probes: [{ host: 'proxy.company.example', addresses: [{ address: '192.0.2.11', status: 'failed', error: 'ECONNREFUSED' }] }],
    });
    expect(warn.mock.calls.flat().join('')).not.toContain('private socket detail');
  });

  test('never probes the destination for DIRECT or an unrecognized route', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('DIRECT; PROXY https://user:password@proxy.example/path');

    f.fail();
    await flush();

    expect(records()[1]).toMatchObject({ resolvedRoutes: [{ scheme: 'direct' }], unrecognizedRoutes: 1, probes: [] });
    expect(f.browserSession.resolveHost).not.toHaveBeenCalled();
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test('does not probe before the session proxy is ready', async () => {
    mocks.proxyState.mockReturnValue({ generation: 7, status: 'failed' });
    const f = fixture();

    f.fail();
    await flush();

    expect(records()[0].proxyStatus).toBe('failed');
    expect(f.browserSession.resolveProxy).toHaveBeenCalledOnce();
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test('rejects metadata proxy names and DNS results', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('PROXY metadata.google.internal:80; PROXY proxy.internal:8080');
    f.browserSession.resolveHost.mockResolvedValue({ endpoints: [{ address: '169.254.169.254' }] });

    f.fail();
    await flush();

    expect(f.browserSession.resolveHost).toHaveBeenCalledExactlyOnceWith('proxy.internal');
    expect(records()[1]).toMatchObject({ probes: [{ status: 'blocked' }, { status: 'blocked' }] });
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test('blocks expanded and IPv4-mapped metadata addresses in routes and DNS results', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('PROXY [0:0:0:0:0:ffff:a9fe:a9fe]:80; PROXY proxy.internal:8080');
    f.browserSession.resolveHost.mockResolvedValue({ endpoints: [
      { address: 'fd00:ec2:0:0:0:0:0:254' },
      { address: '::ffff:6464:64c8' },
    ] });

    f.fail();
    await flush();

    expect(records()[1]).toMatchObject({ probes: [
      { host: '169.254.169.254', status: 'blocked' },
      { host: 'proxy.internal', status: 'blocked' },
    ] });
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test('bounds proxy candidates and supports IPv6 proxy addresses', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('PROXY [2001:db8::10]:8080; PROXY 192.0.2.20:8080; PROXY 192.0.2.30:8080; DIRECT; PROXY 192.0.2.40:8080');

    f.fail();
    await flush();
    sockets[0].emit('connect');
    await flush();
    sockets[1].emit('connect');
    await flush();

    expect(mocks.createConnection.mock.calls.map(([options]) => options.host)).toEqual(['2001:db8::10', '192.0.2.20']);
    expect(records()[1]).toMatchObject({ routesTruncated: true, probes: [{ host: '2001:db8::10' }, { host: '192.0.2.20' }] });
  });

  test('limits DNS results to two distinct addresses and records a TCP timeout', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('PROXY proxy.internal:8080');
    f.browserSession.resolveHost.mockResolvedValue({ endpoints: [
      { address: '192.0.2.11' }, { address: '192.0.2.11' }, { address: '192.0.2.12' }, { address: '192.0.2.13' },
    ] });

    f.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    sockets[1].emit('connect');
    await flush();

    expect(mocks.createConnection).toHaveBeenCalledTimes(2);
    expect(records()[1]).toMatchObject({ probes: [{ addresses: [
      { address: '192.0.2.11', status: 'timeout' }, { address: '192.0.2.12', status: 'connected' },
    ] }] });
    expect(sockets.every(socket => socket.destroy.mock.calls.length === 1)).toBe(true);
  });

  test('records failed native resolution without raw error text', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockRejectedValue(new Error('proxy failed: user:password\nprivate'));

    f.fail();
    await flush();

    expect(records()[1]).toMatchObject({ status: 'failed', checkError: 'UNKNOWN' });
    expect(warn.mock.calls.flat().join('')).not.toMatch(/password|private|\n/u);
  });

  test('throttles repeated failure logs and shares probe cooldown across tabs', async () => {
    const f = fixture();
    f.browserSession.resolveProxy.mockResolvedValue('DIRECT');
    f.fail();
    f.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const other = Object.assign(new EventEmitter(), { id: ++nextGuestId, session: f.browserSession, isDestroyed: () => false });
    guests.push(other);
    registerBrowserNetworkDiagnostics(other as unknown as Electron.WebContents);

    other.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', 'https://other.example/', true);
    await flush();

    expect(records()).toHaveLength(3);
    expect(records()[2]).toMatchObject({ event: 'load-failed', check: 'cooldown' });
    expect(f.browserSession.resolveProxy).toHaveBeenCalledOnce();
  });

  test('shares cooldown across different wrappers of the same persistent session', async () => {
    const first = fixture();
    const second = fixture();
    Object.assign(first.browserSession, { storagePath: `/browser/profile-${first.guest.id}` });
    Object.assign(second.browserSession, { storagePath: `/browser/profile-${first.guest.id}` });
    first.browserSession.resolveProxy.mockResolvedValue('DIRECT');

    first.fail();
    await flush();
    second.fail();
    await flush();

    expect(records().at(-1)).toMatchObject({ guestId: second.guest.id, check: 'cooldown' });
    expect(second.browserSession.resolveProxy).not.toHaveBeenCalled();
  });

  test('retains the observed proxy route when DNS exceeds the total deadline', async () => {
    const f = fixture();
    let release!: (value: { endpoints: Array<{ address: string }> }) => void;
    f.browserSession.resolveProxy.mockResolvedValue('PROXY proxy.internal:8080');
    f.browserSession.resolveHost.mockReturnValue(new Promise(resolve => { release = resolve; }));
    f.fail();
    await flush();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(records()[1]).toMatchObject({
      status: 'timeout', stage: 'proxy-dns',
      resolvedRoutes: [{ scheme: 'http', host: 'proxy.internal', port: 8080 }],
    });
    release({ endpoints: [{ address: '192.0.2.11' }] });
    await flush();
    expect(mocks.createConnection).not.toHaveBeenCalled();
    expect(records()).toHaveLength(2);
  });

  test('keeps native-operation slots occupied after timeout until actual settlement', async () => {
    const first = fixture();
    const second = fixture();
    let releaseFirst!: (value: string) => void;
    let releaseSecond!: (value: string) => void;
    first.browserSession.resolveProxy.mockReturnValue(new Promise(resolve => { releaseFirst = resolve; }));
    second.browserSession.resolveProxy.mockReturnValue(new Promise(resolve => { releaseSecond = resolve; }));
    first.fail();
    second.fail();
    await vi.advanceTimersByTimeAsync(5_000);
    const third = fixture();
    third.browserSession.resolveProxy.mockResolvedValue('DIRECT');

    third.fail();
    await flush();

    expect(records().filter(record => record.status === 'timeout')).toHaveLength(2);
    expect(records().at(-1)).toMatchObject({ guestId: third.guest.id, check: 'busy' });
    expect(third.browserSession.resolveProxy).not.toHaveBeenCalled();
    releaseFirst('DIRECT');
    releaseSecond('DIRECT');
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    third.fail();
    await flush();
    expect(third.browserSession.resolveProxy).toHaveBeenCalledOnce();
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });

  test.each(['navigation', 'destroy', 'proxy-generation'] as const)('cancels active sockets on %s', async reason => {
    const f = fixture();
    f.fail();
    await flush();

    if (reason === 'navigation') f.navigate();
    else if (reason === 'destroy') f.destroy();
    else observers.get(f.browserSession)!({ generation: 8, status: 'pending' });
    await flush();

    expect(sockets[0].destroy).toHaveBeenCalledOnce();
    expect(records()).toHaveLength(1);
    expect(observers.has(f.browserSession)).toBe(false);
    if (reason === 'destroy') expect(f.guest.listenerCount('did-fail-load')).toBe(0);
  });

  test('drops late proxy resolution after a new navigation', async () => {
    const f = fixture();
    let release!: (value: string) => void;
    f.browserSession.resolveProxy.mockReturnValue(new Promise(resolve => { release = resolve; }));
    f.fail();
    f.navigate();
    await flush();

    release('PROXY 192.0.2.10:8080');
    await flush();

    expect(records()).toHaveLength(1);
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });
});
