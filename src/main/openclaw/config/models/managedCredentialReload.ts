import { redactLogText } from '../../../core/logRedaction';
import { resolveManagedCredentialReloadTimeoutMs } from './credentialTimeouts';

const RELOAD_RETRY_DELAYS_MS = [500, 1_500] as const;
const RETRYABLE_GATEWAY_CODES = new Set([
  'UNAVAILABLE', 'CLIENT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ENOTCONN', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const DIAGNOSTIC_GATEWAY_CODES = new Set([
  ...RETRYABLE_GATEWAY_CODES, 'FORBIDDEN', 'INVALID_REQUEST', 'UNAUTHORIZED',
]);

const errorCode = (error: unknown): unknown => {
  if (!error || typeof error !== 'object') return undefined;
  const details = error as { gatewayCode?: unknown; code?: unknown };
  return details.gatewayCode ?? details.code;
};

export const ManagedCredentialReloadOutcome = {
  Applied: 'applied',
  Failed: 'failed',
  Superseded: 'superseded',
} as const;

type ReloadResult =
  | { outcome: typeof ManagedCredentialReloadOutcome.Applied }
  | { outcome: typeof ManagedCredentialReloadOutcome.Superseded }
  | { outcome: typeof ManagedCredentialReloadOutcome.Failed; retryable: boolean };

export const isManagedCredentialReloadRetryable = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const details = error as { requestSent?: unknown };
  const code = errorCode(error);
  // An authoritative permission/protocol refusal must never be bypassed by
  // reconnecting or restarting. Native secret-resolution errors use UNAVAILABLE.
  if (typeof code === 'string') return RETRYABLE_GATEWAY_CODES.has(code);
  if (details.requestSent === false) return true;
  return error instanceof Error && /^(?:gateway (?:not connected|closed\b|client stopped$|transient pre-hello clean close$)|OpenClaw gateway client (?:is unavailable\.|connect timeout after \d+ms\.?$))/i.test(error.message);
};

/** Retry this idempotent snapshot refresh only; never resend chat or tool work. */
export async function reloadManagedCredentials(options: {
  reason: string;
  isCurrent: () => boolean;
  getGatewayPhase: () => string;
  request: (timeoutMs: number) => Promise<{ ok?: boolean }>;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<ReloadResult> {
  const timeoutMs = resolveManagedCredentialReloadTimeoutMs();
  const startedAt = Date.now();
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  for (let attempt = 0; attempt <= RELOAD_RETRY_DELAYS_MS.length; attempt++) {
    if (!options.isCurrent()) return { outcome: ManagedCredentialReloadOutcome.Superseded };
    try {
      const result = await options.request(timeoutMs);
      if (!options.isCurrent()) return { outcome: ManagedCredentialReloadOutcome.Superseded };
      if (result?.ok !== true) throw new Error('Secret snapshot was not refreshed.');
      if (attempt > 0) {
        console.info('[OpenClaw] Managed model provider credentials refreshed after retry:', {
          reason: options.reason, attempts: attempt + 1, elapsedMs: Date.now() - startedAt,
        });
      }
      return { outcome: ManagedCredentialReloadOutcome.Applied };
    } catch (error) {
      if (!options.isCurrent()) return { outcome: ManagedCredentialReloadOutcome.Superseded };
      const retryable = isManagedCredentialReloadRetryable(error);
      const willRetry = retryable && attempt < RELOAD_RETRY_DELAYS_MS.length;
      const code = errorCode(error);
      console.error('[OpenClaw] Failed to refresh managed model provider credentials (secrets.reload):', {
        reason: options.reason,
        gatewayPhase: options.getGatewayPhase(),
        attempt: attempt + 1,
        maxAttempts: RELOAD_RETRY_DELAYS_MS.length + 1,
        elapsedMs: Date.now() - startedAt,
        timeoutMs,
        willRetry,
        ...(typeof code === 'string' && DIAGNOSTIC_GATEWAY_CODES.has(code) ? { errorCode: code } : {}),
        error: redactLogText(error instanceof Error ? error.stack || error.message : String(error)),
      });
      if (!willRetry) return { outcome: ManagedCredentialReloadOutcome.Failed, retryable };
      await wait(RELOAD_RETRY_DELAYS_MS[attempt]);
    }
  }
  return { outcome: ManagedCredentialReloadOutcome.Failed, retryable: false };
}
