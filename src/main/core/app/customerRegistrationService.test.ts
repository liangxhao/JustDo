import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BuiltinModelCredential } from '../../providers/builtinModelCredential';
import { buildCustomerApiBaseUrl, CustomerRegistrationService } from './customerRegistrationService';

const directories: string[] = [];
const reportingConfig = vi.hoisted(() => ({ enabled: true }));

vi.mock('../../../config/activityReporting', () => ({
  ACTIVITY_REPORTING_CONFIG: reportingConfig,
}));

const credential = (userAccount = 'alice', accessToken = 'short-lived-token'): BuiltinModelCredential => ({
  userAccount, accessToken, expiresAt: Number.MAX_SAFE_INTEGER,
});
const setup = (getCredential = () => credential()) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-activity-'));
  directories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-User-Account': 'alice', userName: 'Alice', loginTime: '2026-09-22T00:00:00Z',
    mtoken: 'must-not-send', 'X-Cookie': 'must-not-send',
  }));
  const request = vi.fn().mockImplementation(async () => new Response('{}'));
  const service = new CustomerRegistrationService({
    getCredential, baseUrl: 'http://localhost:9108/v1', productName: 'Example',
    version: '1', userInfoPath, fetch: request,
  });
  return { service, request, userInfoPath };
};

afterEach(() => {
  reportingConfig.enabled = true;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('JWT customer activity', () => {
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
    expect(url).toBe('http://localhost:9108/customer/activity');
    expect(options.headers).toMatchObject({
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
    request.mockImplementation(async () => new Response('{}'));
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
    expect(buildCustomerApiBaseUrl('https://model.test/proxy/v1/?secret=x#x'))
      .toBe('https://model.test/proxy');
  });
});
