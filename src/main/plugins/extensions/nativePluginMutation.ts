import type { GatewayRequestOptions } from '../../engine/types';

const NATIVE_PLUGIN_ADMISSION_BUSY_MESSAGE =
  'Another plugin or config operation is already running; retry when it completes.';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ADMISSION_WAIT_MS = 30_000;

export type NativePluginMutationMethod =
  | 'plugins.install'
  | 'plugins.setEnabled'
  | 'plugins.uninstall'
  | 'plugins.reload'
  | 'plugins.refresh';

export type NativePluginAdmissionProgress = {
  onAdmissionWait?: () => void;
  onAdmissionResume?: () => void;
};
const notify = (callback?: () => void): void => {
  try {
    callback?.();
  } catch {
    // Progress is observational and cannot alter native admission or its outcome.
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** The locked native lifecycle handler emits this refusal only before entering writes. */
export const isNativePluginAdmissionBusy = (
  error: unknown,
): error is Record<string, unknown> & { retryAfterMs: number } => {
  if (
    !isRecord(error) ||
    (error.gatewayCode ?? error.code) !== 'UNAVAILABLE' ||
    (error.code !== undefined && error.code !== 'UNAVAILABLE') ||
    error.message !== NATIVE_PLUGIN_ADMISSION_BUSY_MESSAGE ||
    error.retryable !== true ||
    typeof error.retryAfterMs !== 'number' ||
    !Number.isFinite(error.retryAfterMs) ||
    error.retryAfterMs < 0
  )
    return false;
  const outcomeKeys = [
    'persistence',
    'committed',
    'installationCommitted',
    'installSourceInUse',
    'operationUnconfirmed',
    'runtime',
    'runtimeAttempt',
  ];
  return ![error, error.details, error.cause].some(
    record => isRecord(record) && outcomeKeys.some(key => key in record),
  );
};

/** Wait only after explicit not-entered admission; never repeat an uncertain mutation. */
export const requestNativePluginMutation = async <T>(
  request: (options?: GatewayRequestOptions) => Promise<T>,
  options?: GatewayRequestOptions,
  isCurrent?: () => boolean,
  progress?: NativePluginAdmissionProgress,
): Promise<T> => {
  const startedAt = performance.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;
  const admissionDeadline = startedAt + Math.min(MAX_ADMISSION_WAIT_MS, timeoutMs);
  let requestOptions = options;
  for (;;) {
    try {
      return await request(requestOptions);
    } catch (error) {
      if (!isNativePluginAdmissionBusy(error) || isCurrent?.() === false) throw error;
      // A zero delay still yields to the owner instead of spinning on its lease.
      const delayMs = Math.max(1, error.retryAfterMs);
      if (delayMs >= admissionDeadline - performance.now()) throw error;
      notify(progress?.onAdmissionWait);
      try {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } finally {
        notify(progress?.onAdmissionResume);
      }
      const now = performance.now();
      if (now >= admissionDeadline || now >= deadline || isCurrent?.() === false) throw error;
      const nextOptions: GatewayRequestOptions = {
        ...options,
        timeoutMs: Math.max(1, Math.ceil(deadline - now)),
        assertBeforeSend: () => {
          const assertAdmission = () => {
            const sendingAt = performance.now();
            if (isCurrent?.() === false || sendingAt >= admissionDeadline || sendingAt >= deadline)
              throw error;
            return sendingAt;
          };
          assertAdmission();
          options?.assertBeforeSend?.();
          nextOptions.timeoutMs = Math.max(1, Math.ceil(deadline - assertAdmission()));
        },
      };
      requestOptions = nextOptions;
    }
  }
};
