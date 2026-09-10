import { describe, expect, it, vi } from 'vitest';

import { requestGatewayConfigRestart } from './gatewayConfigRestart';
import type { OpenClawEngineManager } from './openclawEngineManager';

function harness() {
  const manager = {
    getStatus: vi.fn(() => ({ phase: 'running' })),
    hasPendingGatewayLaunchEnvironmentChanges: vi.fn(() => false),
    getGatewayPort: vi.fn(() => 12345),
    getConfiguredGatewayPort: vi.fn(() => 12345),
    getGatewayLifecycleGeneration: vi.fn(() => 4),
    waitForGatewayReadyAfter: vi.fn(async () => true),
  };
  const request = vi.fn().mockResolvedValue({ ok: true, status: 'scheduled' });
  return {
    manager, request,
    restart: () => requestGatewayConfigRestart(manager as unknown as OpenClawEngineManager, request, 'config-change'),
  };
}

describe('config in-process restart', () => {
  it('waits for a new ready marker and preserves native workload deferral', async () => {
    const h = harness();
    await expect(h.restart()).resolves.toBe('ready');
    expect(h.request).toHaveBeenCalledWith('gateway.restart.request', {
      reason: 'config-change', skipDeferral: false,
    });
    expect(h.manager.waitForGatewayReadyAfter).toHaveBeenCalledWith(4, 30_000);
  });

  it.each(['deferred', 'coalesced'])('does not compete with a %s native restart', async status => {
    const h = harness();
    h.request.mockResolvedValue({ ok: true, status });
    await expect(h.restart()).resolves.toBe('pending');
    expect(h.manager.waitForGatewayReadyAfter).not.toHaveBeenCalled();
  });

  it('does not schedule a cold restart on an accepted restart timeout', async () => {
    const h = harness();
    h.manager.waitForGatewayReadyAfter.mockResolvedValue(false);
    await expect(h.restart()).resolves.toBe('pending');
  });

  it('retains the native owner if readiness observation throws after acceptance', async () => {
    const h = harness();
    h.manager.waitForGatewayReadyAfter.mockRejectedValue(new Error('observer interrupted'));
    await expect(h.restart()).resolves.toBe('pending');
  });

  it.each(['environment', 'port'])('requires a cold restart for changed %s', async kind => {
    const h = harness();
    if (kind === 'environment') h.manager.hasPendingGatewayLaunchEnvironmentChanges.mockReturnValue(true);
    else h.manager.getConfiguredGatewayPort.mockReturnValue(12346);
    await expect(h.restart()).resolves.toBe('unavailable');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('allows the suspension-fenced fallback when the RPC is unavailable', async () => {
    const h = harness();
    h.request.mockRejectedValue(new Error('unknown method'));
    await expect(h.restart()).resolves.toBe('unavailable');
  });
});
