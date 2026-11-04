import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BuiltinModelCredential } from '../../providers/builtinModelCredential';
import { buildActivityApiBaseUrl, UserActivityService } from './userActivityService';

const directories: string[] = [];
const reportingConfig = vi.hoisted(() => ({ enabled: true, endpointPath: '/user/activity' }));

vi.mock('../../../config/activityReporting', () => ({
  ACTIVITY_REPORTING_CONFIG: reportingConfig,
}));

const credential = (userAccount = 'alice', accessToken = 'short-lived-token'): BuiltinModelCredential => ({
  userAccount, accessToken, expiresAt: Number.MAX_SAFE_INTEGER,
});
const setup = (getCredential = () => credential()) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-activity-'));
  directories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-User-Account': 'alice', userName: 'Alice', loginTime: '2026-09-22T00:00:00Z',
    mtoken: 'must-not-send', 'X-Cookie': 'must-not-send',
  }));
  const request = vi.fn().mockImplementation(async () => new Response('{"ok":true}'));
  const service = new UserActivityService({
    getCredential, baseUrl: 'http://localhost:9108/v1', productName: 'Example',
    version: '1', userInfoPath, fetch: request,
  });
  return { service, request, userInfoPath };
};

afterEach(() => {
  reportingConfig.enabled = true;
  reportingConfig.endpointPath = '/user/activity';
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('JWT user activity', () => {
  test.each(['user/activity', '//other.test/path', '/a/../activity', '/activity?x=1', '/activity#x', '/a\\b', '/a\n'])('does not send credentials for invalid endpoint path %j', async endpointPath => {
    reportingConfig.endpointPath = endpointPath;
    const { service, request } = setup();
    await service.sync();
    expect(request).not.toHaveBeenCalled();
  });
  test('uses the configured activity endpoint path', async () => {
    reportingConfig.endpointPath = '/events/activity';
    const { service, request } = setup();
    await service.sync();
    expect(request.mock.calls[0][0]).toBe('http://localhost:9108/events/activity');
  });

  test('disabled reporting does not read user info, access credentials, send requests or schedule timers', async () => {
    vi.useFakeTimers();
    reportingConfig.enabled = false;
    const getCredential = vi.fn(() => credential());
    const { service, request } = setup(getCredential);
    const readFile = vi.spyOn(fs.promises, 'readFile');

    service.start();
    await service.sync();
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    service.start(); // Login callbacks must not restart disabled reporting.
    await service.sync();

    expect(readFile).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('reports using current JWT without calling customer management APIs or sending login secrets', async () => {
    const { service, request } = setup();
    await service.sync();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('http://localhost:9108/user/activity');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer short-lived-token',
      'X-ACCESS-JWT': 'short-lived-token', 'X-User-Account': 'alice',
    });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ user_id: 'alice', event_type: 'startup',
      metadata: { userName: 'Alice', productName: 'Example', version: '1' } });
    expect(options.body).not.toContain('must-not-send');
  });

  test.each([null, credential('bob'), { ...credential(), authType: 'api-key' as const }])(
    'does not report with missing, mismatched or development API key credentials',
    async active => {
      const { service, request } = setup(() => active as BuiltinModelCredential);
      await service.sync();
      expect(request).not.toHaveBeenCalled();
    },
  );

  test('retains event ID on retry while obtaining the renewed JWT for each request', async () => {
    let active = credential();
    const { service, request } = setup(() => active);
    request.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await service.sync();
    active = credential('alice', 'renewed-token');
    await service.sync();
    const first = JSON.parse(request.mock.calls[0][1].body);
    const retry = JSON.parse(request.mock.calls[1][1].body);
    expect(retry.event_id).toBe(first.event_id);
    expect(request.mock.calls[1][1].headers['X-ACCESS-JWT']).toBe('renewed-token');
    await service.sync();
    const heartbeat = JSON.parse(request.mock.calls[2][1].body);
    expect(heartbeat.event_type).toBe('heartbeat');
    expect(heartbeat.event_id).not.toBe(first.event_id);
  });

  test('resets startup identity when the logged-in account changes', async () => {
    let active = credential();
    const { service, request, userInfoPath } = setup(() => active);
    await service.sync();
    active = credential('bob');
    fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': 'bob' }));
    await service.sync();
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({
      user_id: 'bob', event_type: 'startup',
    });
  });

  test('retries with bounded delays, resumes daily reporting, and stops its timer', async () => {
    vi.useFakeTimers();
    const { service, request } = setup();
    request.mockImplementation(async () => new Response('{}', { status: 503 }));
    service.start();
    await service.sync();
    for (const delay of [60_000, 300_000, 900_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await service.sync();
    }
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(request).toHaveBeenCalledTimes(4);
    request.mockImplementation(async () => new Response('{"ok":true}'));
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    await service.sync();
    expect(request).toHaveBeenCalledTimes(5);
    service.stop();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(request).toHaveBeenCalledTimes(5);
  });

  test('coalesces overlapping synchronization', async () => {
    const { service, request } = setup();
    await Promise.all([service.sync(), service.sync()]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('stopping the service aborts an in-flight report', async () => {
    const { service, request } = setup();
    let markRequested!: () => void;
    const requested = new Promise<void>(resolve => { markRequested = resolve; });
    let signal!: AbortSignal;
    request.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      markRequested();
    }));
    const pending = service.sync();
    await requested;
    service.stop();
    expect(signal.aborted).toBe(true);
    await pending;
  });

  test('normalizes versioned model endpoints without retaining query parameters', () => {
    expect(buildActivityApiBaseUrl('https://model.test/proxy/v1/?secret=x#x'))
      .toBe('https://model.test/proxy');
  });
  test('defers unsupported old servers without warning or burst retries, and recovers after upgrade', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, request } = setup();
    request.mockImplementation(async () => new Response('route unavailable', { status: 404 }));
    service.start();
    await expect(service.sync()).resolves.toBeUndefined();
    const firstBody = request.mock.calls[0][1].body;
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementation(async () => new Response('{"ok":true}'));
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 - 21 * 60_000);
    await service.sync();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].body).toBe(firstBody);
    expect(request.mock.calls[1][1].redirect).toBe('error');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    service.stop();
  });

  test.each(['<html>old service</html>', '{"ok":false}', '{"ok":true,"large":"' + 'x'.repeat(4096) + '"}'])(
    'does not acknowledge a bad or oversized success body', async responseBody => {
      const { service, request } = setup();
      request.mockResolvedValueOnce(new Response(responseBody));
      await service.sync();
      request.mockResolvedValueOnce(new Response('{"ok":true}'));
      await service.sync();
      expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body);
      await service.sync();
      expect(JSON.parse(request.mock.calls[2][1].body).event_type).toBe('heartbeat');
    },
  );

  test('freezes extensible metadata on retries and never lets it replace authenticated identity fields', async () => {
    const { userInfoPath, request } = setup();
    let tokens = 12;
    const service = new UserActivityService({
      getCredential: () => credential(), baseUrl: 'http://localhost:9108/v1', productName: 'Example',
      version: '1', userInfoPath, fetch: request,
      getMetadata: () => ({ usage: { total_tokens: tokens, available: true }, optional: null, version: 'untrusted' }),
    });
    request.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await service.sync();
    tokens = 34;
    await service.sync();
    const initial = JSON.parse(request.mock.calls[0][1].body);
    expect(initial).toMatchObject({ user_id: 'alice', metadata: { usage: { total_tokens: 12 }, version: '1' } });
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body);
    await service.sync();
    expect(JSON.parse(request.mock.calls[2][1].body).metadata.usage.total_tokens).toBe(34);
  });

  test('local metadata errors are optional and never reject sync', async () => {
    const { userInfoPath, request } = setup();
    const service = new UserActivityService({
      getCredential: () => credential(), baseUrl: 'http://localhost:9108/v1', productName: 'Example',
      version: '1', userInfoPath, fetch: request, getMetadata: () => { throw new Error('private detail'); },
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(service.sync()).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('private detail');
  });

  test('stopping cancels an unfinished acknowledgement even when the fetch ignores abort', async () => {
    const { service, request } = setup();
    let reading!: () => void;
    const startedReading = new Promise<void>(resolve => { reading = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); },
      pull() { reading(); },
    });
    request.mockResolvedValueOnce(new Response(stream));
    const pending = service.sync();
    await startedReading;
    service.stop();
    await expect(pending).resolves.toBeUndefined();
    await service.sync();
    expect(JSON.parse(request.mock.calls[1][1].body).event_type).toBe('startup');
  });

  test('an interrupted acknowledgement retries after a minute with the identical event', async () => {
    vi.useFakeTimers();
    const { service, request } = setup();
    request.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('private transport error')); },
    })));
    service.start();
    await service.sync();
    const firstBody = request.mock.calls[0][1].body;
    await vi.advanceTimersByTimeAsync(60_000);
    await service.sync();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1].body).toBe(firstBody);
    service.stop();
  });

  test.each(['alice', 'bob'])('a late response after restart cannot acknowledge the new %s report', async account => {
    let active = credential();
    const { service, request, userInfoPath } = setup(() => active);
    let firstResolve!: (response: Response) => void;
    let secondResolve!: (response: Response) => void;
    let firstRequested!: () => void;
    let secondRequested!: () => void;
    const first = new Promise<void>(resolve => { firstRequested = resolve; });
    const second = new Promise<void>(resolve => { secondRequested = resolve; });
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { firstResolve = resolve; firstRequested(); }));
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { secondResolve = resolve; secondRequested(); }));
    service.start();
    await first;
    const pending = service.sync();
    service.stop();
    active = credential(account);
    fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': account }));
    service.start();
    firstResolve(new Response('{"ok":true}'));
    await pending;
    await second;
    const restarted = service.sync();
    const firstEvent = JSON.parse(request.mock.calls[0][1].body);
    const secondEvent = JSON.parse(request.mock.calls[1][1].body);
    expect(secondEvent).toMatchObject({ user_id: account, event_type: 'startup' });
    expect(secondEvent.event_id).not.toBe(firstEvent.event_id);
    expect(request).toHaveBeenCalledTimes(2);
    secondResolve(new Response('{"ok":true}'));
    await restarted;
    service.stop();
  });

});
