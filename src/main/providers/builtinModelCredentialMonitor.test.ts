import type fs from 'fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { BuiltinModelCredential } from './builtinModelCredential';
import {
  BuiltinModelCredentialMonitor,
  resolveBuiltinModelCredentialExpiryDelayMs,
} from './builtinModelCredentialMonitor';

afterEach(() => {
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
      userInfoPath: 'C:\\AppData\\JustDo\\huawei\\user_info.json',
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
      userInfoPath: 'C:\\AppData\\JustDo\\huawei\\user_info.json',
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
});
