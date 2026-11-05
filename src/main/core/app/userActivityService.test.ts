import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BuiltinModelCredential } from '../../providers/builtinModelCredential';
import {
  buildActivityApiBaseUrl,
  type UserActivityMetadata,
  type UserActivityScheduleState,
  UserActivityService,
} from './userActivityService';

const WARMUP_MS = 15 * 60_000;
const WINDOW_MS = 6 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const INITIAL_TIME = Date.parse('2026-11-05T00:00:00+08:00');
const directories: string[] = [];
const services: UserActivityService[] = [];
const reportingConfig = vi.hoisted(() => ({ enabled: true, endpointPath: '/user/activity' }));

vi.mock('../../../config/activityReporting', () => ({
  ACTIVITY_REPORTING_CONFIG: reportingConfig,
}));

type ServiceOptions = ConstructorParameters<typeof UserActivityService>[0];
const credential = (userAccount = 'alice', accessToken = 'short-lived-token'): BuiltinModelCredential => ({
  userAccount, accessToken, expiresAt: Number.MAX_SAFE_INTEGER,
});
const metadata = (totalTokens = 12): UserActivityMetadata => ({
  platform: 'win32',
  usage: {
    daily: [{ date: '2026-11-05', input: totalTokens - 2, output: 2, totalTokens }],
    cacheStatus: { status: 'fresh', cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
    updatedAt: Date.now(),
  },
});
const createStateStore = (initial?: UserActivityScheduleState) => {
  let state: UserActivityScheduleState | undefined = initial && structuredClone(initial);
  return {
    read: vi.fn((): unknown => state && structuredClone(state)),
    write: vi.fn((next: UserActivityScheduleState): void => { state = structuredClone(next); }),
    snapshot: () => state && structuredClone(state),
  };
};
const setup = (overrides: Partial<ServiceOptions> = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-activity-'));
  directories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-User-Account': 'alice', userName: 'Alice', loginTime: '2026-09-22T00:00:00Z',
    mtoken: 'must-not-send', 'X-Cookie': 'must-not-send',
  }));
  const stateStore = createStateStore();
  const request = vi.fn().mockImplementation(async () => new Response('{"ok":true}'));
  const collectMetadata = vi.fn(async (_signal: AbortSignal): Promise<UserActivityMetadata | null> => metadata());
  const isIdle = vi.fn(() => true);
  const options: ServiceOptions = {
    getCredential: () => credential(), baseUrl: 'http://localhost:9108/v1', productName: 'Example',
    version: '1', userInfoPath, fetch: request, stateStore, isIdle, collectMetadata,
    ...overrides,
  };
  const service = new UserActivityService(options);
  services.push(service);
  return { service, request, collectMetadata, isIdle, stateStore, userInfoPath, options };
};
const advance = async (service: UserActivityService, milliseconds: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await service.sync();
};
const startAndReport = async (service: UserActivityService): Promise<void> => {
  service.start();
  await advance(service, WARMUP_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(INITIAL_TIME);
});
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  reportingConfig.enabled = true;
  reportingConfig.endpointPath = '/user/activity';
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('scheduled JWT user activity', () => {
  test('all callers observe startup warmup and a stopped service never reports', async () => {
    const { service, request, collectMetadata, stateStore } = setup();
    await service.sync();
    service.start();
    await Promise.all([service.sync(), service.sync()]);
    await advance(service, WARMUP_MS - 1);
    expect(request).not.toHaveBeenCalled();
    expect(collectMetadata).not.toHaveBeenCalled();
    expect(stateStore.write).not.toHaveBeenCalled();
    await advance(service, 1);
    expect(request).toHaveBeenCalledOnce();
    expect(collectMetadata).toHaveBeenCalledOnce();
    service.stop();
    await advance(service, DAY_MS);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('disabled reporting does not read user info, access credentials or schedule work', async () => {
    reportingConfig.enabled = false;
    const getCredential = vi.fn(() => credential());
    const { service, request, collectMetadata } = setup({ getCredential });
    const readFile = vi.spyOn(fs.promises, 'readFile');
    service.start();
    await advance(service, 2 * DAY_MS);
    service.start();
    await service.sync();
    expect(readFile).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(collectMetadata).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('waits for idle without spending preparation windows', async () => {
    const { service, request, collectMetadata, isIdle, stateStore } = setup();
    isIdle.mockReturnValue(false);
    await startAndReport(service);
    await advance(service, 10 * 60_000);
    expect(collectMetadata).not.toHaveBeenCalled();
    expect(stateStore.snapshot()?.attempts ?? 0).toBe(0);
    isIdle.mockReturnValue(true);
    await advance(service, 5 * 60_000);
    expect(collectMetadata).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  test.each([null, credential('bob'), { ...credential(), authType: 'api-key' as const }])(
    'does not collect or report with missing, mismatched or API key credentials', async active => {
      const { service, request, collectMetadata, stateStore } = setup({ getCredential: () => active });
      await startAndReport(service);
      expect(collectMetadata).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(stateStore.snapshot()?.attempts ?? 0).toBe(0);
    },
  );

  test.each(['user/activity', '//other.test/path', '/a/../activity', '/activity?x=1', '/activity#x', '/a\\b', '/a\n'])(
    'does not send credentials for invalid endpoint path %j', async endpointPath => {
      reportingConfig.endpointPath = endpointPath;
      const { service, request } = setup();
      await startAndReport(service);
      expect(request).not.toHaveBeenCalled();
    },
  );

  test('reports one bounded snapshot using configured route and current JWT without login secrets', async () => {
    reportingConfig.endpointPath = '/events/activity';
    const { service, request } = setup({ getMetadata: () => ({ optional: null, version: 'untrusted' }) });
    await startAndReport(service);
    const [url, options, limits] = request.mock.calls[0];
    expect(url).toBe('http://localhost:9108/events/activity');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer short-lived-token',
      'X-ACCESS-JWT': 'short-lived-token', 'X-User-Account': 'alice' });
    expect(options.redirect).toBe('error');
    expect(limits).toMatchObject({ maxResponseBytes: 4096 });
    expect(JSON.parse(options.body)).toMatchObject({ user_id: 'alice', event_type: 'usage.snapshot',
      metadata: { userName: 'Alice', productName: 'Example', version: '1', optional: null,
        usage: { daily: [{ totalTokens: 12 }] } } });
    expect(options.body).not.toContain('must-not-send');
  });

  test('reserves each window before collection and enforces three windows per Beijing day', async () => {
    const { service, request, collectMetadata, stateStore } = setup();
    collectMetadata.mockImplementation(async () => {
      expect(stateStore.snapshot()?.attempts).toBe(collectMetadata.mock.calls.length);
      return metadata(10 + collectMetadata.mock.calls.length);
    });
    await startAndReport(service);
    await Promise.all([service.sync(), service.sync()]);
    await advance(service, WINDOW_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    await advance(service, 1);
    await advance(service, WINDOW_MS);
    await advance(service, WINDOW_MS);
    expect(request).toHaveBeenCalledTimes(3);
    expect(collectMetadata).toHaveBeenCalledTimes(3);
    expect(stateStore.snapshot()).toMatchObject({ date: '2026-11-05', attempts: 3 });
  });

  test('failed preparation consumes a window and does not cause minute-level retries', async () => {
    const { service, request, collectMetadata, stateStore } = setup();
    collectMetadata.mockRejectedValueOnce(new Error('private detail'));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(startAndReport(service)).resolves.toBeUndefined();
    expect(stateStore.snapshot()?.attempts).toBe(1);
    expect(request).not.toHaveBeenCalled();
    await advance(service, 21 * 60_000);
    expect(collectMetadata).toHaveBeenCalledOnce();
    await advance(service, WINDOW_MS - 21 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(stateStore.snapshot()?.attempts).toBe(2);
    expect(JSON.stringify(info.mock.calls)).not.toContain('private detail');
  });

  test('missing cached metadata skips the request without reporting empty usage', async () => {
    const collectMetadata = vi.fn(async (): Promise<UserActivityMetadata | null> => null);
    const { service, request, stateStore } = setup({ collectMetadata });
    await startAndReport(service);
    expect(request).not.toHaveBeenCalled();
    expect(stateStore.snapshot()?.attempts).toBe(1);
    await advance(service, 21 * 60_000);
    expect(collectMetadata).toHaveBeenCalledOnce();
  });

  test('a persistence failure prevents collection and requests without rejecting callers', async () => {
    const stateStore = { read: () => undefined, write: () => { throw new Error('private storage error'); } };
    const { service, request, collectMetadata } = setup({ stateStore });
    await expect(startAndReport(service)).resolves.toBeUndefined();
    expect(collectMetadata).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('unchanged metadata spends a window but timestamps alone do not create reports', async () => {
    const { service, request, collectMetadata, stateStore } = setup();
    await startAndReport(service);
    await advance(service, WINDOW_MS);
    expect(collectMetadata).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledOnce();
    expect(stateStore.snapshot()?.attempts).toBe(2);
    vi.setSystemTime(INITIAL_TIME + WARMUP_MS + DAY_MS);
    await service.sync();
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('a failed response waits six hours then uses renewed JWT and a fresh cumulative snapshot', async () => {
    let active = credential();
    const { service, request, collectMetadata, stateStore } = setup({ getCredential: () => active });
    request.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await startAndReport(service);
    const first = JSON.parse(request.mock.calls[0][1].body);
    active = credential('alice', 'renewed-token');
    collectMetadata.mockResolvedValue(metadata(34));
    await advance(service, 21 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    await advance(service, WINDOW_MS - 21 * 60_000);
    const next = JSON.parse(request.mock.calls[1][1].body);
    expect(next.event_id).not.toBe(first.event_id);
    expect(next.metadata.usage.daily[0].totalTokens).toBe(34);
    expect(request.mock.calls[1][1].headers['X-ACCESS-JWT']).toBe('renewed-token');
    expect(stateStore.snapshot()?.attempts).toBe(2);
  });

  test('unsupported endpoint cooldown survives restart and reports latest data after deployment', async () => {
    const { service, request, collectMetadata, stateStore, options } = setup();
    request.mockResolvedValueOnce(new Response('route unavailable', { status: 404 }));
    await startAndReport(service);
    const first = JSON.parse(request.mock.calls[0][1].body);
    expect(stateStore.snapshot()?.cooldownUntil).toBe(Date.now() + DAY_MS);
    service.stop();
    collectMetadata.mockResolvedValue(metadata(56));
    const restarted = new UserActivityService(options);
    services.push(restarted);
    restarted.start();
    await advance(restarted, DAY_MS - 1);
    expect(request).toHaveBeenCalledOnce();
    expect(collectMetadata).toHaveBeenCalledOnce();
    await advance(restarted, 1);
    expect(request).toHaveBeenCalledTimes(2);
    const next = JSON.parse(request.mock.calls[1][1].body);
    expect(next.event_id).not.toBe(first.event_id);
    expect(next.metadata.usage.daily[0].totalTokens).toBe(56);
  });

  test('account switches and restarts retain the same daily preparation budget', async () => {
    let active = credential();
    const { service, request, userInfoPath, stateStore, options } = setup({ getCredential: () => active });
    await startAndReport(service);
    service.stop();
    active = credential('bob');
    fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': 'bob' }));
    const restarted = new UserActivityService(options);
    services.push(restarted);
    restarted.start();
    await advance(restarted, WINDOW_MS - 1);
    expect(request).toHaveBeenCalledOnce();
    await advance(restarted, 1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1][1].body).user_id).toBe('bob');
    expect(stateStore.snapshot()?.attempts).toBe(2);
    restarted.stop();
    const third = new UserActivityService(options);
    services.push(third);
    third.start();
    await advance(third, WINDOW_MS);
    await advance(third, WINDOW_MS);
    expect(stateStore.snapshot()?.attempts).toBe(3);
    expect(request.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test('Beijing midnight resets the day budget without clearing the six-hour interval', async () => {
    vi.setSystemTime(Date.parse('2026-11-05T23:40:00+08:00'));
    const { service, request, collectMetadata, stateStore } = setup();
    await startAndReport(service);
    expect(stateStore.snapshot()).toMatchObject({ date: '2026-11-05', attempts: 1 });
    collectMetadata.mockResolvedValue(metadata(34));
    await advance(service, 10 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    await advance(service, WINDOW_MS - 10 * 60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(stateStore.snapshot()).toMatchObject({ date: '2026-11-06', attempts: 1 });
  });

  test.each(['<html>old service</html>', '{"ok":false}', '{"ok":true,"large":"' + 'x'.repeat(4096) + '"}'])(
    'does not acknowledge an invalid or oversized success response', async responseBody => {
      const { service, request, stateStore } = setup();
      request.mockResolvedValueOnce(new Response(responseBody));
      await startAndReport(service);
      expect(stateStore.snapshot()?.lastSuccessAt ?? 0).toBe(0);
      expect(stateStore.snapshot()?.fingerprint ?? null).toBeNull();
      await advance(service, 21 * 60_000);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  test('rechecks current JWT after asynchronous collection before sending', async () => {
    let active = credential();
    const { service, request, collectMetadata } = setup({ getCredential: () => active });
    collectMetadata.mockImplementation(async () => {
      active = credential('alice', 'renewed-after-collection');
      return metadata();
    });
    await startAndReport(service);
    expect(request.mock.calls[0][1].headers['X-ACCESS-JWT']).toBe('renewed-after-collection');
  });

  test('crossing Beijing midnight during collection cannot spend the previous day quota on a request', async () => {
    vi.setSystemTime(Date.parse('2026-11-05T23:44:59.995+08:00'));
    const { service, request, collectMetadata, stateStore } = setup();
    let finish!: (value: UserActivityMetadata) => void;
    let started!: () => void;
    const collecting = new Promise<void>(resolve => { started = resolve; });
    collectMetadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; started(); }));
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await collecting;
    const pending = service.sync();
    expect(stateStore.snapshot()).toMatchObject({ date: '2026-11-05', attempts: 1 });
    await vi.advanceTimersByTimeAsync(10);
    finish(metadata());
    await pending;
    expect(request).not.toHaveBeenCalled();
    await advance(service, WINDOW_MS);
    expect(request).toHaveBeenCalledOnce();
    expect(stateStore.snapshot()).toMatchObject({ date: '2026-11-06', attempts: 1 });
  });

  test('an error response with a non-settling stream cancellation cannot block future windows', async () => {
    const { service, request, stateStore } = setup();
    let cancellationRequested = false;
    request.mockResolvedValueOnce(new Response(new ReadableStream({
      cancel() {
        cancellationRequested = true;
        return new Promise<void>(() => {});
      },
    }), { status: 503 }));
    await expect(startAndReport(service)).resolves.toBeUndefined();
    expect(cancellationRequested).toBe(true);
    expect(stateStore.snapshot()?.attempts).toBe(1);
    await advance(service, WINDOW_MS);
    expect(request).toHaveBeenCalledTimes(2);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('HTTP timeout releases callers even when the transport ignores cancellation', async () => {
    const { service, request, stateStore } = setup();
    let signal!: AbortSignal;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    request.mockImplementationOnce((_url, options) => {
      signal = options.signal;
      started();
      return new Promise(() => {});
    });
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await requested;
    const pending = service.sync();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(stateStore.snapshot()?.attempts).toBe(1);
    await advance(service, WINDOW_MS - 15_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('timed-out collection aborts its signal, resolves callers and waits for the next window', async () => {
    const { service, request, collectMetadata } = setup();
    let signal!: AbortSignal;
    let started!: () => void;
    const collecting = new Promise<void>(resolve => { started = resolve; });
    collectMetadata.mockImplementation((value: AbortSignal) => {
      signal = value;
      started();
      return new Promise(() => {});
    });
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await collecting;
    const pending = service.sync();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(request).not.toHaveBeenCalled();
    await advance(service, 21 * 60_000);
    expect(collectMetadata).toHaveBeenCalledOnce();
  });

  test('stopping aborts in-flight HTTP and retains the reserved window', async () => {
    const { service, request, stateStore } = setup();
    let signal!: AbortSignal;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    request.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      started();
    }));
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await requested;
    const pending = service.sync();
    service.stop();
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
    expect(stateStore.snapshot()?.attempts).toBe(1);
    expect(stateStore.snapshot()?.lastSuccessAt ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stopping cancels an unfinished acknowledgement even when fetch ignores abort', async () => {
    const { service, request, stateStore } = setup();
    let reading!: () => void;
    const startedReading = new Promise<void>(resolve => { reading = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); },
      pull() { reading(); },
    });
    request.mockResolvedValueOnce(new Response(stream));
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await startedReading;
    const pending = service.sync();
    service.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(stateStore.snapshot()?.lastSuccessAt ?? 0).toBe(0);
  });

  test.each(['alice', 'bob'])('late collection after restart cannot publish the new %s report', async account => {
    let active = credential();
    const { service, request, collectMetadata, userInfoPath, stateStore } = setup({ getCredential: () => active });
    let firstResolve!: (value: UserActivityMetadata) => void;
    let collecting!: () => void;
    const started = new Promise<void>(resolve => { collecting = resolve; });
    collectMetadata.mockImplementationOnce(() => new Promise(resolve => { firstResolve = resolve; collecting(); }));
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await started;
    const pending = service.sync();
    service.stop();
    active = credential(account);
    fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': account }));
    service.start();
    firstResolve(metadata(999));
    await pending;
    await service.sync();
    expect(request).not.toHaveBeenCalled();
    expect(stateStore.snapshot()?.attempts).toBe(1);
    await advance(service, WINDOW_MS);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ user_id: account,
      metadata: { usage: { daily: [{ totalTokens: 12 }] } } });
  });

  test.each(['alice', 'bob'])('a late acknowledgement after restart cannot confirm the new %s state', async account => {
    let active = credential();
    const { service, request, userInfoPath, stateStore } = setup({ getCredential: () => active });
    let firstResolve!: (response: Response) => void;
    let requested!: () => void;
    const first = new Promise<void>(resolve => { requested = resolve; });
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { firstResolve = resolve; requested(); }));
    service.start();
    await vi.advanceTimersByTimeAsync(WARMUP_MS);
    await first;
    const pending = service.sync();
    service.stop();
    active = credential(account);
    fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': account }));
    service.start();
    firstResolve(new Response('{"ok":true}'));
    await pending;
    expect(stateStore.snapshot()?.lastSuccessAt ?? 0).toBe(0);
    await advance(service, WINDOW_MS);
    expect(request).toHaveBeenCalledTimes(2);
    const second = JSON.parse(request.mock.calls[1][1].body);
    expect(second.user_id).toBe(account);
    expect(second.event_id).not.toBe(JSON.parse(request.mock.calls[0][1].body).event_id);
  });

  test('normalizes versioned model endpoints without retaining query parameters', () => {
    expect(buildActivityApiBaseUrl('https://model.test/proxy/v1/?secret=x#x'))
      .toBe('https://model.test/proxy');
  });

  test('logs startup and rate-limited idle evidence without affecting eligibility', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const idle = { gatewayConnected: true, activeSessions: false, idleSeconds: 2 };
    const { service, request, isIdle } = setup({ getIdleStatus: () => idle });
    isIdle.mockReturnValue(false);
    service.start();
    await service.sync();
    expect(info.mock.calls.some(([line]) => String(line).includes('"reason":"startup-delay"'))).toBe(true);
    await advance(service, WARMUP_MS);
    const messages = () => info.mock.calls.map(([line]) => JSON.parse(String(line).replace('[UserActivity] ', '')));
    expect(messages().filter(item => item.reason === 'not-idle')).toEqual([
      expect.objectContaining({ event: 'waiting', gatewayConnected: true, activeSessions: false, idleSeconds: 2 }),
    ]);
    idle.idleSeconds = 9;
    await advance(service, 25 * 60_000);
    expect(messages().filter(item => item.reason === 'not-idle')).toHaveLength(1);
    await advance(service, 5 * 60_000);
    expect(messages().filter(item => item.reason === 'not-idle')).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
  });

  test('logs server-confirmed success and useful HTTP failure without private payloads', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { service, request } = setup();
    await startAndReport(service);
    const messages = () => info.mock.calls.map(([line]) => JSON.parse(String(line).replace('[UserActivity] ', '')));
    expect(messages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'collecting', attempt: 1, dailyLimit: 3 }),
      expect.objectContaining({ event: 'sending', attempt: 1 }),
      expect.objectContaining({ event: 'succeeded', httpStatus: 200 }),
    ]));
    request.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await advance(service, DAY_MS);
    expect(messages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'failed', reason: 'http-rejected', httpStatus: 404, nextCheckAt: expect.any(String) }),
    ]));
    const text = info.mock.calls.flat().join('\n');
    for (const secret of ['alice', 'Alice', 'short-lived-token', 'must-not-send', 'localhost', 'totalTokens']) {
      expect(text).not.toContain(secret);
    }
  });

  test('does not call an unacknowledged response successful and logs unavailable statistics', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { service, request, collectMetadata } = setup();
    request.mockResolvedValueOnce(new Response('{"ok":false}'));
    await startAndReport(service);
    expect(info.mock.calls.some(([line]) => String(line).includes('"reason":"response-not-acknowledged"'))).toBe(true);
    expect(info.mock.calls.some(([line]) => String(line).includes('"event":"succeeded"'))).toBe(false);
    collectMetadata.mockResolvedValueOnce(null);
    await advance(service, DAY_MS);
    expect(info.mock.calls.some(([line]) => String(line).includes('"reason":"statistics-unavailable"'))).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  test('diagnostic failures do not change reporting or its window budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('broken logger'); });
    const { service, request, isIdle, stateStore } = setup({ getIdleStatus: () => { throw new Error('broken diagnostic getter'); } });
    isIdle.mockReturnValue(false);
    await startAndReport(service);
    expect(stateStore.write).not.toHaveBeenCalled();
    isIdle.mockReturnValue(true);
    await advance(service, 5 * 60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(stateStore.snapshot()?.attempts).toBe(1);
    expect(stateStore.snapshot()?.lastSuccessAt).toBe(Date.now());
  });

  test('distinguishes failed local cooldown persistence from a network failure', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { service, request, stateStore } = setup();
    const persist = stateStore.write.getMockImplementation()!;
    stateStore.write.mockImplementationOnce(persist).mockImplementationOnce(() => {
      throw new Error('private storage failure details');
    });
    request.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await startAndReport(service);
    const messages = info.mock.calls.map(([line]) => JSON.parse(String(line).replace('[UserActivity] ', '')));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'failed', reason: 'http-rejected', httpStatus: 404 }),
      expect.objectContaining({ event: 'failed', reason: 'state-write-failed', phase: 'cooldown-persistence' }),
    ]));
    expect(info.mock.calls.flat().join('\n')).not.toContain('private storage failure details');
    expect(stateStore.snapshot()?.attempts).toBe(1);
    expect(request).toHaveBeenCalledOnce();
  });
});
