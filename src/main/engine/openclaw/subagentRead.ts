import { SubagentReadFailure } from '../../../shared/cowork/subagentDetails';
import { isRetiredPluginReadError } from '../gateway/sessionReadRecovery';
import type { GatewayResponseContext } from '../gateway/types';
import type { GatewayRequestClient } from './subagentGateway';

const READ_RETRY_DELAYS_MS = [250, 750] as const;
const READ_RECOVERY_BUDGET_MS = 10_000;

export class SubagentReadError extends Error {
  constructor(readonly reason: SubagentReadFailure, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function isCatalogUpdating(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isRetiredPluginReadError(error)) return true;
  const { gatewayCode, retryable, details } = error as Error & {
    gatewayCode?: unknown;
    retryable?: unknown;
    details?: { code?: unknown };
  };
  return gatewayCode === 'UNAVAILABLE' && (
    (retryable === true && details?.code === 'agent-database-inspection-pending') ||
    /^(?:Error: )?(?:Session row facts changed before the prepared read|Session changed while preparing its description); retry the request$/.test(error.message)
  );
}

export function subagentReadFailure(error: unknown): SubagentReadFailure {
  if (error instanceof SubagentReadError) return error.reason;
  if (!(error instanceof Error)) return SubagentReadFailure.Unexpected;
  const { code, gatewayCode } = error as Error & { code?: unknown; gatewayCode?: unknown };
  if (code === 'CLIENT_TIMEOUT') return SubagentReadFailure.TimedOut;
  if (gatewayCode === 'FORBIDDEN') return SubagentReadFailure.PermissionDenied;
  if (isCatalogUpdating(error)) return SubagentReadFailure.CatalogUpdating;
  if (typeof gatewayCode === 'string') return SubagentReadFailure.EngineRejected;
  return SubagentReadFailure.Unexpected;
}

/** Re-read from the start on a verified transient rejection on this connection. */
export async function readSubagentProjection<T>(
  client: GatewayRequestClient,
  isCurrent: () => boolean,
  captureResponse: () => GatewayResponseContext | null,
  read: (client: GatewayRequestClient) => Promise<T>,
): Promise<T> {
  let recovery: {
    deadline: number;
    signal: AbortSignal;
    response: GatewayResponseContext;
    error: unknown;
  } | undefined;
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new SubagentReadError(SubagentReadFailure.Disconnected, 'Gateway connection changed during subagent read');
    }
    if (recovery && !recovery.response.isCurrent()) throw recovery.error;
    if (recovery && (recovery.signal.aborted || performance.now() >= recovery.deadline)) {
      throw new SubagentReadError(SubagentReadFailure.TimedOut, 'Subagent read recovery timed out');
    }
  };
  const guardedClient: GatewayRequestClient = {
    request: (method, params) => {
      assertCurrent();
      if (!recovery) return client.request(method, params);
      return client.request(method, params, {
        signal: recovery.signal,
        timeoutMs: Math.max(1, Math.ceil(recovery.deadline - performance.now())),
      });
    },
  };
  for (let attempt = 0; ; attempt += 1) {
    assertCurrent();
    let result: T;
    try {
      result = await read(guardedClient);
    } catch (error) {
      assertCurrent();
      const delay = READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isCatalogUpdating(error)) throw error;
      const response = captureResponse();
      if (!response?.isCurrent() || !response.isResponseError(error)) throw error;
      if (!recovery) {
        const deadline = performance.now() + READ_RECOVERY_BUDGET_MS;
        const signal = AbortSignal.timeout(READ_RECOVERY_BUDGET_MS);
        recovery = { deadline, signal, response, error };
      }
      if (delay >= recovery.deadline - performance.now()) {
        throw new SubagentReadError(SubagentReadFailure.TimedOut, 'Subagent read recovery timed out');
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    assertCurrent();
    return result;
  }
}
