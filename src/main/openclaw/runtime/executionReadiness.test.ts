import { describe, expect, it, vi } from 'vitest';

import { ensureExecutionReady } from './executionReadiness';
import type { OpenClawEngineStatus } from './openclawEngineManager';

const running: OpenClawEngineStatus = {
  phase: 'running', version: 'v2026.10.4', canRetry: false,
};

function harness(status: OpenClawEngineStatus = running) {
  let current = status;
  return {
    manager: {
      getStatus: vi.fn(() => current),
      startGateway: vi.fn(async () => (current = running)),
      setExternalError: vi.fn((message: string) =>
        (current = { ...current, phase: 'error', message })),
    },
    verifyPermissionPolicy: vi.fn(async () => ({ success: true })),
  };
}

describe('ensureExecutionReady', () => {
  it('reuses a running Gateway and only verifies its active permission boundary', async () => {
    const dependencies = harness();
    await expect(ensureExecutionReady(dependencies)).resolves.toEqual(running);
    expect(dependencies.manager.startGateway).not.toHaveBeenCalled();
    expect(dependencies.verifyPermissionPolicy).toHaveBeenCalledOnce();
  });

  it.each(['ready', 'starting'] as const)('joins process readiness from %s', async phase => {
    const dependencies = harness({ ...running, phase });
    await expect(ensureExecutionReady(dependencies)).resolves.toEqual(running);
    expect(dependencies.manager.startGateway).toHaveBeenCalledOnce();
    expect(dependencies.verifyPermissionPolicy).toHaveBeenCalledOnce();
  });

  it('does not verify or admit a Gateway whose startup failed', async () => {
    const failed: OpenClawEngineStatus = { ...running, phase: 'error' };
    const dependencies = harness(failed);
    dependencies.manager.startGateway.mockResolvedValue(failed);
    await expect(ensureExecutionReady(dependencies)).resolves.toEqual(failed);
    expect(dependencies.verifyPermissionPolicy).not.toHaveBeenCalled();
  });

  it('retains the failed-closed status from permission verification', async () => {
    const dependencies = harness();
    const failed: OpenClawEngineStatus = { ...running, phase: 'error' };
    dependencies.verifyPermissionPolicy = vi.fn(async () => ({ success: false, status: failed }));
    await expect(ensureExecutionReady(dependencies)).resolves.toEqual(failed);
    expect(dependencies.manager.setExternalError).not.toHaveBeenCalled();
  });
});
