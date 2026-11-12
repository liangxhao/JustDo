import type { GatewayClientLike } from '../../gateway/types';
import type { AutomaticErrorRetryBinding, AutomaticErrorRetrySettledReceipt } from './coordinator';
import { CONTEXT_OVERFLOW_ERROR_CODE, SESSION_READER_FAILURE_CODE } from './rules';
import { logSessionReaderRecovery } from './sessionReaderRecoveryLog';

export const AUTOMATIC_ERROR_RETRY_FAILURE_METHOD = 'runtimeServices.executionFailure';
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const SESSION_READER_ERROR = 'Session reader operation is no longer current';
const SESSION_READER_CAUSES = [
  SESSION_READER_ERROR,
  `SessionWorkStartChangedError: ${SESSION_READER_ERROR}`,
  `Error: ${SESSION_READER_ERROR}`,
];
const SESSION_READER_REPORTS = SESSION_READER_CAUSES.map(cause => `Your request couldn't be completed: ${cause}`);

/** A native chat error can request verification, but does not establish a failure or authorize a send. */
export function isSessionReaderErrorHint(error: unknown): error is string {
  return typeof error === 'string' &&
    (SESSION_READER_CAUSES.includes(error) || SESSION_READER_REPORTS.includes(error));
}

/** Call only for an admitted, failed, whole-run terminal. Retain only the typed context signal. */
export function readBlockedContextOverflow(
  data: Record<string, unknown>,
): typeof CONTEXT_OVERFLOW_ERROR_CODE | undefined {
  if (
    data.phase === 'error' && data.livenessState === 'blocked' &&
    record(data.errorObservation)?.failoverReason === CONTEXT_OVERFLOW_ERROR_CODE
  ) {
    return CONTEXT_OVERFLOW_ERROR_CODE;
  }
  return undefined;
}

/** Uses a settled run and native evidence; an error hint alone never selects a rule. */
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
  const sessionReaderError = isSessionReaderErrorHint(receipt.error);
  const log = (check: Parameters<typeof logSessionReaderRecovery>[1]) => {
    if (sessionReaderError) logSessionReaderRecovery({ sessionId: binding.sessionId, runId: receipt.runId }, check);
  };
  let response: Record<string, unknown> | null;
  try {
    response = record(await client.request(AUTOMATIC_ERROR_RETRY_FAILURE_METHOD, {
      sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
      lifecycleRevision: binding.lifecycleRevision, runId: receipt.runId,
    }, { signal, timeoutMs: 10_000 }));
    signal?.throwIfAborted();
  } catch (error) {
    log({ stage: 'execution_failure', outcome: signal?.aborted ? 'cancelled' : 'request_failed' });
    throw error;
  }
  if (!response || response.sessionKey !== binding.sessionKey || response.sessionId !== binding.nativeSessionId ||
      response.lifecycleRevision !== binding.lifecycleRevision || response.runId !== receipt.runId ||
      response.identityMatched === false) {
    log({ stage: 'execution_failure', outcome: 'identity_unconfirmed' });
    return null;
  }
  if (typeof response.errorCode === 'string' && response.errorCode !== CONTEXT_OVERFLOW_ERROR_CODE &&
      response.errorCode !== SESSION_READER_FAILURE_CODE &&
      /^[A-Za-z0-9_.:-]{1,128}$/u.test(response.errorCode)) {
    log({ stage: 'execution_failure', outcome: 'different_failure' });
    return response.errorCode;
  }
  if (response.identityMatched !== true) {
    log({ stage: 'execution_failure', outcome: 'identity_unconfirmed' });
    return null;
  }
  if ((response.errorCode === null || response.errorCode === CONTEXT_OVERFLOW_ERROR_CODE) &&
      !('source' in receipt) && receipt.observedFailureCode === CONTEXT_OVERFLOW_ERROR_CODE) {
    return CONTEXT_OVERFLOW_ERROR_CODE;
  }
  if (!sessionReaderError) return null;
  if (response.errorCode !== null) {
    log({ stage: 'execution_failure', outcome: 'failure_unconfirmed' });
    return null;
  }
  if ('source' in receipt && (typeof receipt.endedAt !== 'number' || !Number.isFinite(receipt.endedAt) ||
      (receipt.stopReason !== undefined && receipt.stopReason !== 'error'))) return null;
  let history: Record<string, unknown> | null;
  try {
    history = record(await client.request('chat.history', {
      sessionKey: binding.sessionKey, limit: 8, maxBytes: 16_384, maxChars: 1024,
    }, { signal, timeoutMs: 5_000 }));
    signal?.throwIfAborted();
  } catch (error) {
    log({ stage: 'chat.history', outcome: signal?.aborted ? 'cancelled' : 'request_failed' });
    throw error;
  }
  if (history?.sessionKey !== binding.sessionKey || history.sessionId !== binding.nativeSessionId ||
      record(history.sessionInfo)?.sessionId !== binding.nativeSessionId || !Array.isArray(history.messages)) {
    log({ stage: 'chat.history', outcome: 'identity_unconfirmed' });
    return null;
  }
  const userIndex = history.messages.findLastIndex((value: unknown) => record(value)?.role === 'user');
  const user = record(history.messages[userIndex]);
  const userMetadata = record(user?.__openclaw);
  // The native chat.send recorder binds the saved input to the exact client run ID.
  if (!user || (user.idempotencyKey ?? userMetadata?.idempotencyKey) !== `${receipt.runId}:user` ||
      user.display === false || user.excludeFromContext === true || userMetadata?.contextFreeCommand === true ||
      userMetadata?.steerTargetRunId) {
    log({ stage: 'chat.history', outcome: 'saved_input_mismatch' });
    return null;
  }
  const matched = history.messages.slice(userIndex + 1).some((value: unknown) => {
    const report = record(value);
    return report?.role === 'custom' && report.customType === 'run-failed-before-reply' &&
      record(report.__openclaw)?.runId === receipt.runId &&
      typeof report.content === 'string' && SESSION_READER_REPORTS.includes(report.content);
  });
  log({ stage: 'chat.history', outcome: matched ? 'verified' : 'failure_receipt_missing' });
  return matched ? SESSION_READER_FAILURE_CODE : null;
}
