import { t } from '../../core/i18n';
import type { GatewayClientLike } from './types';

export const SESSION_STORAGE_PREPARATION_TIMEOUT_MS = 120_000;
const PENDING_AGENT_INSPECTION = 'agent-database-inspection-pending';
const MAX_RETRY_DELAY_MS = 8_000;
const OWNER_CHECK_INTERVAL_MS = 250;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canWaitForStorage(error: unknown, agentId: string): boolean {
  const failure = record(error);
  if (failure?.gatewayCode !== 'UNAVAILABLE' || failure.code !== 'UNAVAILABLE') return false;
  const details = record(failure.details);
  if (failure.details != null && !details) return false;
  if (details && 'agentId' in details && details.agentId !== agentId) return false;
  if (details && 'code' in details) {
    return details.code === PENDING_AGENT_INSPECTION && failure.retryable === true &&
      details.agentId === agentId;
  }
  // The frozen Gateway also returns an unstructured UNAVAILABLE during storage
  // discovery. This is safe to wait on only for this read, never create/send.
  return true;
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try { pending = operation(); } catch (error) { pending = Promise.reject(error); }
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Wait on a native read before the single create attempt; this grants no write authority. */
export async function waitForSessionStorageReadiness(options: {
  client: Pick<GatewayClientLike, 'request'>;
  sessionKey: string;
  agentId: string;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const deadlineAt = Date.now() + SESSION_STORAGE_PREPARATION_TIMEOUT_MS;
  const cancel = () => controller.abort(options.signal?.reason);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadlineAt) {
      controller.abort(new Error(t('sessionStoragePreparationTimeout')));
      signal.throwIfAborted();
    }
    if (!options.isCurrent()) {
      controller.abort(new Error(t('sessionStoragePreparationChanged')));
      signal.throwIfAborted();
    }
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = setTimeout(() => {
    controller.abort(new Error(t('sessionStoragePreparationTimeout')));
  }, SESSION_STORAGE_PREPARATION_TIMEOUT_MS);
  const ownerCheck = setInterval(() => {
    try { assertCurrent(); } catch (error) { controller.abort(error); }
  }, OWNER_CHECK_INTERVAL_MS);
  let retryDelay = 1_000;
  try {
    for (;;) {
      assertCurrent();
      try {
        const result = record(await abortable(() => options.client.request<unknown>(
          'sessions.describe',
          { key: options.sessionKey, agentId: options.agentId },
          { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) },
        ), signal));
        assertCurrent();
        const session = record(result?.session);
        if (result && Object.hasOwn(result, 'session') && (result.session === null ||
          (session?.key === options.sessionKey &&
          (!('agentId' in session) || session.agentId === options.agentId)))) return;
        throw new Error(t('sessionStoragePreparationChanged'));
      } catch (error) {
        assertCurrent();
        if (!canWaitForStorage(error, options.agentId)) throw error;
      }
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(() => new Promise<void>(resolve => {
          retryTimer = setTimeout(resolve, retryDelay);
        }), signal);
      } finally {
        if (retryTimer !== undefined) clearTimeout(retryTimer);
      }
      assertCurrent();
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(ownerCheck);
    options.signal?.removeEventListener('abort', cancel);
  }
}
