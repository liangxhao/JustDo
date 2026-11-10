import { t } from '../../core/i18n';

export const GATEWAY_STARTUP_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 1_000;
const OWNER_CHECK_INTERVAL_MS = 250;

/** Observe native startup settlement without starting or mutating the Gateway. */
export async function waitForGatewayStartup(options: {
  port: number;
  assertCurrent: () => void;
}): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;
  const assertCurrent = () => {
    signal.throwIfAborted();
    options.assertCurrent();
  };
  const deadline = setTimeout(() => {
    controller.abort(new Error(t('gatewayStartupUnconfirmed')));
  }, GATEWAY_STARTUP_WAIT_MS);
  const ownerCheck = setInterval(() => {
    try { assertCurrent(); } catch (error) { controller.abort(error); }
  }, OWNER_CHECK_INTERVAL_MS);
  try {
    for (;;) {
      assertCurrent();
      const attempt = new AbortController();
      const timeout = setTimeout(() => attempt.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/startupz`, {
          redirect: 'error',
          signal: AbortSignal.any([signal, attempt.signal]),
        });
        const status: unknown = await response.json();
        assertCurrent();
        const value = status as { ok?: unknown; status?: unknown } | null;
        if (response.status === 200 && value?.ok === true && value.status === 'started') return;
        if (response.status !== 503 || value?.ok !== false || value.status !== 'starting')
          throw new Error(t('gatewayStartupUnconfirmed'));
      } catch (error) {
        assertCurrent();
        // Only a bounded read timeout is retried. Invalid responses, redirects,
        // draining and transport failures must not grant startup readiness.
        if (!attempt.signal.aborted) throw error;
      } finally {
        clearTimeout(timeout);
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, POLL_INTERVAL_MS);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(ownerCheck);
  }
}
