import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { acquireOpenClawRuntimeDevLease } from './openclawRuntimeDevLease';

describe('OpenClaw runtime development lease', () => {
  test('holds the repo-scoped lease for an unpackaged Electron process', () => {
    const release = vi.fn();
    const acquireRuntimeDevLease = vi.fn(() => release);
    const resolveRuntimeDevLeaseDir = vi.fn(() => 'runtime-lease-dir');
    const loadLeaseModule = vi.fn(() => ({
      acquireRuntimeDevLease,
      resolveRuntimeDevLeaseDir,
    }));
    const appPath = path.resolve('development-app');

    const result = acquireOpenClawRuntimeDevLease({
      appPath,
      isPackaged: false,
      loadLeaseModule,
    });

    expect(loadLeaseModule).toHaveBeenCalledWith(
      path.join(appPath, 'scripts', 'openclaw', 'openclaw-runtime-dev-lease.cjs'),
    );
    expect(resolveRuntimeDevLeaseDir).toHaveBeenCalledWith(appPath);
    expect(acquireRuntimeDevLease).toHaveBeenCalledWith('runtime-lease-dir');
    expect(result).toBe(release);
  });

  test('does not load the development lease module in a packaged app', () => {
    const loadLeaseModule = vi.fn();

    const release = acquireOpenClawRuntimeDevLease({
      appPath: path.resolve('packaged-app'),
      isPackaged: true,
      loadLeaseModule,
    });

    expect(loadLeaseModule).not.toHaveBeenCalled();
    expect(release()).toBeUndefined();
  });
});
