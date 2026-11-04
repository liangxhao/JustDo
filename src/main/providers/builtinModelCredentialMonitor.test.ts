import type fs from 'fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { BuiltinModelCredential } from './builtinModelCredential';
import {
  BuiltinModelCredentialMonitor,
  resolveBuiltinModelCredentialExpiryDelayMs,
} from './builtinModelCredentialMonitor';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BuiltinModelCredentialMonitor', () => {
  test('refreshes shortly before the active JWT becomes unusable', () => {
    expect(
      resolveBuiltinModelCredentialExpiryDelayMs(
        { accessToken: 'token', userAccount: 'user', expiresAt: 1_300 },
        1_000_000,
      ),
    ).toBe(240_000);
  });

  test('watches atomic login-file changes without keeping the app alive', async () => {
    vi.useFakeTimers();
    let listener: ((current: fs.Stats, previous: fs.Stats) => void) | undefined;
    const watchFile = vi.fn((_path, _options, nextListener) => {
      listener = nextListener;
    });
    const unwatchFile = vi.fn();
    const refreshed: BuiltinModelCredential = {
      accessToken: 'token',
      userAccount: 'user',
      expiresAt: 2_000_000_000,
    };
    const refresh = vi.fn(async () => refreshed);
    const monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: 'C:\\AppData\\JustDo\\login-data\\user_info.json',
      refresh,
      watchFile,
      unwatchFile,
    });

    monitor.start(null);
    expect(watchFile).toHaveBeenCalledTimes(1);
    expect(watchFile).toHaveBeenCalledWith(
      expect.any(String),
      { interval: 1_000, persistent: false },
      expect.any(Function),
    );
    listener?.({} as fs.Stats, {} as fs.Stats);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    monitor.stop();
    expect(unwatchFile).toHaveBeenCalledTimes(1);
    expect(unwatchFile).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  test('does not schedule renewal for a static development API key', () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => null);
    const monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: 'C:\\AppData\\JustDo\\login-data\\user_info.json',
      refresh,
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    });
    monitor.start({
      accessToken: 'sk-development',
      userAccount: '',
      expiresAt: Number.MAX_SAFE_INTEGER,
      authType: 'api-key',
    });
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
    monitor.stop();
  });

  test('retries asynchronous application errors without waiting for the next credential deadline', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => null);
    const onError = vi.fn();
    const monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: 'fixture', refresh, onError, watchFile: vi.fn(), unwatchFile: vi.fn(),
    });
    monitor.start(null);
    const failure = new Error('private-auth-fixture\nAuthorization: Bearer private-token-fixture');

    monitor.retryAfterError(failure);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledOnce();

    monitor.stop();
    monitor.retryAfterError(failure);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();

    const records = vi.mocked(console.warn).mock.calls.map(args => {
      expect(args).toHaveLength(1);
      expect(args[0]).not.toMatch(/[\r\n]|private-.*-fixture|Authorization/);
      return JSON.parse(String(args[0]).slice('[BuiltinModelAuth] '.length));
    });
    expect(records).toContainEqual({ event: 'refresh.retry-scheduled', retryDelayMs: 5_000, errorCode: 'unknown' });
  });
});
