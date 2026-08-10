import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildCustomerApiBaseUrl,
  CustomerRegistrationService,
} from './customerRegistrationService';

const temporaryDirectories: string[] = [];

const writeUserInfo = (value: unknown): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-customer-registration-'));
  temporaryDirectories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify(value));
  return userInfoPath;
};

const makeService = (
  request: ReturnType<typeof vi.fn>,
  userInfoPath = writeUserInfo({
    'X-User-Account': 'user-123',
    userName: 'Alice',
    loginTime: '2026-08-10T10:00:00+08:00',
  }),
) =>
  new CustomerRegistrationService({
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:9108/v1',
    productName: 'JustDo',
    version: 'v2026.8.10',
    userInfoPath,
    fetch: request,
  });

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('CustomerRegistrationService', () => {
  test('derives customer endpoints from the model v1 URL', () => {
    expect(buildCustomerApiBaseUrl('http://127.0.0.1:9108/v1/')).toBe(
      'http://127.0.0.1:9108',
    );
    expect(buildCustomerApiBaseUrl('https://example.com/gateway')).toBe(
      'https://example.com/gateway',
    );
  });

  test('updates an existing customer with a persisted product alias and metadata', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const service = makeService(request);

    await service.sync();

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9108/customer/update');
    expect(init.headers).toEqual({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({
      user_id: 'user-123',
      alias: 'JustDo v2026.8.10',
      metadata: {
        userName: 'Alice',
        loginTime: '2026-08-10T10:00:00+08:00',
        productName: 'JustDo',
        version: 'v2026.8.10',
      },
    });
  });

  test('creates the customer when update reports it does not exist', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const service = makeService(request);

    await service.sync();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe('http://127.0.0.1:9108/customer/new');
    expect(request.mock.calls[1][1].body).toBe(request.mock.calls[0][1].body);
  });

  test('does not send a request when X-User-Account is missing', async () => {
    const request = vi.fn();
    const service = makeService(request, writeUserInfo({ userName: 'Alice' }));

    await service.sync();

    expect(request).not.toHaveBeenCalled();
  });

  test('runs immediately and then once per configured interval', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const service = new CustomerRegistrationService({
      apiKey: 'sk-test',
      baseUrl: 'http://127.0.0.1:9108/v1',
      productName: 'JustDo',
      version: 'v2026.8.10',
      userInfoPath: writeUserInfo({ 'X-User-Account': 'user-123' }),
      fetch: request,
      syncIntervalMs: 1_000,
    });

    service.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    service.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
