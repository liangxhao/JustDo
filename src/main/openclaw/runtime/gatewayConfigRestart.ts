import type { OpenClawEngineManager } from './openclawEngineManager';

const GATEWAY_RESTART_REQUEST = 'gateway.restart.request';
const CONFIG_RESTART_READY_TIMEOUT_MS = 30_000;
const RestartRequestStatus = {
  Scheduled: 'scheduled',
  Deferred: 'deferred',
  Coalesced: 'coalesced',
} as const;
export const GatewayConfigRestartOutcome = {
  Unavailable: 'unavailable',
  Pending: 'pending',
  Ready: 'ready',
} as const;

/** Let the native coordinator retain active work and reuse the loaded runtime. */
export async function requestGatewayConfigRestart(
  manager: OpenClawEngineManager,
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>,
  reason: string,
): Promise<(typeof GatewayConfigRestartOutcome)[keyof typeof GatewayConfigRestartOutcome]> {
  if (
    manager.getStatus().phase !== 'running' ||
    manager.hasPendingGatewayLaunchEnvironmentChanges() ||
    manager.getGatewayPort() !== manager.getConfiguredGatewayPort()
  ) {
    return GatewayConfigRestartOutcome.Unavailable;
  }

  const lifecycle = manager.getGatewayLifecycleGeneration();
  const startedAt = Date.now();
  let accepted = false;
  try {
    const result = await requestGateway<{
      ok?: boolean;
      status?: string;
    }>(GATEWAY_RESTART_REQUEST, { reason, skipDeferral: false });
    if (
      result.ok !== true ||
      !Object.values(RestartRequestStatus).some(status => status === result.status)
    ) {
      return GatewayConfigRestartOutcome.Unavailable;
    }
    accepted = true;
    // Accepted work belongs to the native coordinator, including its deferred
    // retry. Never race it with a host cold restart merely because it is busy.
    if (
      result.status === RestartRequestStatus.Deferred ||
      result.status === RestartRequestStatus.Coalesced
    ) {
      return GatewayConfigRestartOutcome.Pending;
    }
    const ready = await manager.waitForGatewayReadyAfter(lifecycle, CONFIG_RESTART_READY_TIMEOUT_MS);
    if (!ready) {
      console.warn('[OpenClaw] Native config restart is still pending; retaining its restart owner.');
    } else {
      console.log(`[OpenClaw] Native config restart ready after ${Date.now() - startedAt}ms.`);
    }
    return ready ? GatewayConfigRestartOutcome.Ready : GatewayConfigRestartOutcome.Pending;
  } catch (error) {
    console.warn(`[OpenClaw] Native config restart request failed: ${String(error)}`);
    return accepted ? GatewayConfigRestartOutcome.Pending : GatewayConfigRestartOutcome.Unavailable;
  }
}
