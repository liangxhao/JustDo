import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const { DEV_SHUTDOWN_SWITCH, requestActiveRuntimeDevShutdown } = require('../../../scripts/openclaw/openclaw-runtime-dev-shutdown.cjs') as {
  DEV_SHUTDOWN_SWITCH: string;
  requestActiveRuntimeDevShutdown: (
    repoRoot: string,
    runtimeLeaseDir: string,
    options?: {
      electronPath?: string;
      findActiveLeases?: (runtimeLeaseDir: string) => Array<{ pid: number }>;
      spawnSync?: (...args: unknown[]) => { error?: Error; status?: number };
      timeoutMs?: number;
      wait?: (delayMs: number) => void;
    },
  ) => boolean;
};

describe('OpenClaw development runtime shutdown', () => {
  test('does nothing when no development process holds the runtime', () => {
    const spawnSync = vi.fn();

    expect(
      requestActiveRuntimeDevShutdown('repo', 'leases', {
        findActiveLeases: () => [],
        spawnSync,
      }),
    ).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('requests graceful shutdown and waits for the runtime lease to clear', () => {
    const repoRoot = path.resolve('repo');
    const findActiveLeases = vi
      .fn<() => Array<{ pid: number }>>()
      .mockReturnValueOnce([{ pid: 4242 }])
      .mockReturnValueOnce([{ pid: 4242 }])
      .mockReturnValueOnce([]);
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const wait = vi.fn();

    expect(
      requestActiveRuntimeDevShutdown(repoRoot, 'leases', {
        electronPath: 'electron.exe',
        findActiveLeases,
        spawnSync,
        wait,
      }),
    ).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      'electron.exe',
      [repoRoot, DEV_SHUTDOWN_SWITCH],
      expect.objectContaining({ cwd: repoRoot, stdio: 'ignore', windowsHide: true }),
    );
    expect(wait).toHaveBeenCalledWith(100);
  });

  test('fails instead of rebuilding when the development process does not exit', () => {
    expect(() =>
      requestActiveRuntimeDevShutdown('repo', 'leases', {
        electronPath: 'electron.exe',
        findActiveLeases: () => [{ pid: 5151 }],
        spawnSync: () => ({ status: 0 }),
        timeoutMs: 0,
      }),
    ).toThrow(/Timed out waiting.*PID 5151/);
  });
});
