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
  Unconfirmed: 'unconfirmed',
  Pending: 'pending',
  Ready: 'ready',
} as const;

/** Only definite non-dispatch or an authoritative unsupported-method reply permits retry. */
export function isGatewayRestartRequestUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('gatewayCode' in error) {
    return error.gatewayCode === 'INVALID_REQUEST' &&
      'message' in error && error.message === `unknown method: ${GATEWAY_RESTART_REQUEST}`;
  }
  if ('requestSent' in error) return error.requestSent === false;
  // These exact host errors originate before client.request is invoked. Generic
  // transport failures can occur after dispatch and do not establish rejection.
  return error instanceof Error && /^(?:OpenClaw runtime adapter is unavailable\.|OpenClaw gateway client is unavailable\.|OpenClaw engine is not running\.|OpenClaw gateway client connect timeout after \d+ms\.?)$/.test(error.message);
}

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
    if (result.ok === false) return GatewayConfigRestartOutcome.Unavailable;
    if (result.ok !== true ||
      !Object.values(RestartRequestStatus).some(status => status === result.status)) {
      return GatewayConfigRestartOutcome.Unconfirmed;
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
    if (accepted) return GatewayConfigRestartOutcome.Pending;
    return isGatewayRestartRequestUnavailable(error)
      ? GatewayConfigRestartOutcome.Unavailable
      : GatewayConfigRestartOutcome.Unconfirmed;
  }
}
