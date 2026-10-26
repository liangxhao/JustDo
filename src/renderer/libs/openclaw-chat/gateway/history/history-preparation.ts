import type { GatewayRequestError } from '../client';

const PENDING_AGENT_INSPECTION = 'agent-database-inspection-pending';
export const HISTORY_PREPARATION_TIMEOUT_MS = 120_000;
const MAX_RETRY_DELAY_MS = 8_000;

export class HistoryPreparationTimeoutError extends Error {
  constructor() {
    super('Native session preparation is still pending. Retry the history read later.');
    this.name = 'HistoryPreparationTimeoutError';
  }
}

function isPendingPreparation(error: unknown, sessionKey: string): boolean {
  const agentId = /^agent:([^:]+):.+$/.exec(sessionKey)?.[1];
  if (!agentId || !error || typeof error !== 'object') return false;
  const failure = error as Partial<GatewayRequestError>;
  const details = failure.details;
  return failure.gatewayCode === 'UNAVAILABLE' && failure.retryable === true &&
    !!details && typeof details === 'object' && !Array.isArray(details) &&
    (details as Record<string, unknown>).code === PENDING_AGENT_INSPECTION &&
    (details as Record<string, unknown>).agentId === agentId;
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<T>;
    try { pending = operation(); } catch (error) { pending = Promise.reject(error); }
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Retry only a native, non-admitted read while this exact selected owner remains current. */
export async function readHistoryAfterPreparation<T>(options: {
  sessionKey: string;
  controller: AbortController;
  isCurrent: () => boolean;
  read: (signal: AbortSignal) => Promise<T>;
  onPending: () => void;
}): Promise<T> {
  const { controller, isCurrent } = options;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1_000;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException('History owner changed', 'AbortError');
  };
  try {
    for (;;) {
      assertCurrent();
      try {
        const result = await abortable(() => options.read(controller.signal), controller.signal);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        if (!isPendingPreparation(error, options.sessionKey)) throw error;
        if (deadline === undefined) {
          deadline = setTimeout(() => controller.abort(new HistoryPreparationTimeoutError()),
            HISTORY_PREPARATION_TIMEOUT_MS);
        }
        options.onPending();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await abortable(() => new Promise<void>(resolve => {
            timer = setTimeout(resolve, retryDelay);
          }), controller.signal);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        assertCurrent();
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
