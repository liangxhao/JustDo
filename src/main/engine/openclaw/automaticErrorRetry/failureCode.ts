import type { GatewayClientLike } from '../../gateway/types';
import type { AutomaticErrorRetryBinding, AutomaticErrorRetrySettledReceipt } from './coordinator';

export const AUTOMATIC_ERROR_RETRY_FAILURE_METHOD = 'runtimeServices.executionFailure';
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Reads only native-owned failure identity; neither error text nor display copy is a rule match. */
export async function readAutomaticErrorRetryFailureCode(
  client: Pick<GatewayClientLike, 'request'>,
  binding: AutomaticErrorRetryBinding,
  receipt: AutomaticErrorRetrySettledReceipt,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (receipt.status !== 'failed' || receipt.executionSettled !== true || receipt.runId === '' ||
      receipt.sessionKey !== binding.sessionKey || receipt.sessionId !== binding.nativeSessionId ||
      receipt.clientGeneration !== binding.clientGeneration) return null;
  const response = record(await client.request(AUTOMATIC_ERROR_RETRY_FAILURE_METHOD, {
    sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
    lifecycleRevision: binding.lifecycleRevision, runId: receipt.runId,
  }, { signal, timeoutMs: 10_000 }));
  signal?.throwIfAborted();
  if (!response || response.sessionKey !== binding.sessionKey || response.sessionId !== binding.nativeSessionId ||
      response.lifecycleRevision !== binding.lifecycleRevision || response.runId !== receipt.runId ||
      typeof response.errorCode !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(response.errorCode)) return null;
  return response.errorCode;
}
