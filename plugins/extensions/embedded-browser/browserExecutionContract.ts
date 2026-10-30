// Pure transport contract shared with the desktop host. Execution identity is
// supplied by native hooks, never by the model's browser arguments.
import {
  readAppExecutionSourceBinding,
  type AppExecutionSourceBinding,
} from '@app-plugin/sdk/execution-source';
export const EMBEDDED_BROWSER_REQUESTED_EVENT = 'plugin.embedded-browser.requested';
export const EMBEDDED_BROWSER_CANCELLED_EVENT = 'plugin.embedded-browser.cancelled';
export const EMBEDDED_BROWSER_REVOKED_EVENT = 'plugin.embedded-browser.revoked';
export const EMBEDDED_BROWSER_RELEASED_EVENT = 'plugin.embedded-browser.released';
export const EMBEDDED_BROWSER_STOPPED_EVENT = 'plugin.embedded-browser.stopped';

export type BrowserExecutionRun = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string | null;
  runId: string;
  trigger: 'user' | 'cron';
  workspaceDir: string;
  jobId?: string;
};

export type BrowserRequestedEvent = {
  requestId: string;
  sessionKey: string;
  run: BrowserExecutionRun;
  // Plugin-owned tool admission, independent of the native whole-run identity.
  admissionRevision: number;
  toolCallId: string;
  command: Record<string, unknown>;
  policy: { allowLocalFiles: boolean };
  executionSource?: AppExecutionSourceBinding;
};

export type BrowserCancelledEvent = Omit<BrowserRequestedEvent, 'command' | 'policy'>;

export type BrowserRevokedEvent = {
  run: BrowserExecutionRun;
  admissionRevision: number;
};

export type BrowserReleasedEvent = {
  run: BrowserExecutionRun;
  // Source-signal retirement has its own event and never establishes an outcome.
  // Only settled carries independently verified whole-run terminal evidence;
  // revoked here is final service/owner/identity retirement.
  reason: 'settled' | 'revoked';
  discardPages: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readIdentifier = (value: unknown, maximum = 512): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;

const readAdmissionRevision = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

export const readBrowserExecutionRun = (value: unknown): BrowserExecutionRun | null => {
  if (!isRecord(value)) return null;
  const sessionKey = readIdentifier(value.sessionKey);
  const sessionId = readIdentifier(value.sessionId);
  const runId = readIdentifier(value.runId);
  const workspaceDir = readIdentifier(value.workspaceDir, 32_768);
  const jobId = value.jobId === undefined ? undefined : readIdentifier(value.jobId);
  const lifecycleRevision: string | null | undefined =
    value.lifecycleRevision === null
      ? null
      : value.lifecycleRevision === undefined
        ? undefined
        : (readIdentifier(value.lifecycleRevision) ?? undefined);
  if (
    !sessionKey ||
    !sessionId ||
    !runId ||
    !workspaceDir ||
    (value.trigger !== 'user' && value.trigger !== 'cron') ||
    (value.jobId !== undefined && !jobId) ||
    (value.lifecycleRevision !== undefined &&
      value.lifecycleRevision !== null &&
      !lifecycleRevision) ||
    (value.trigger === 'cron' && !jobId) ||
    (value.trigger === 'user' && jobId !== undefined)
  )
    return null;
  return {
    sessionKey,
    sessionId,
    runId,
    trigger: value.trigger,
    workspaceDir,
    ...(lifecycleRevision !== undefined ? { lifecycleRevision } : {}),
    ...(jobId ? { jobId } : {}),
  };
};

export const readBrowserCancelledEvent = (value: unknown): BrowserCancelledEvent | null => {
  if (!isRecord(value)) return null;
  const run = readBrowserExecutionRun(value.run);
  const requestId = readIdentifier(value.requestId);
  const toolCallId = readIdentifier(value.toolCallId);
  const admissionRevision = readAdmissionRevision(value.admissionRevision);
  if (
    !run ||
    !requestId ||
    !toolCallId ||
    !admissionRevision ||
    value.sessionKey !== run.sessionKey
  )
    return null;
  return { requestId, sessionKey: run.sessionKey, run, admissionRevision, toolCallId };
};

export const readBrowserRequestedEvent = (value: unknown): BrowserRequestedEvent | null => {
  const identity = readBrowserCancelledEvent(value);
  const executionSource =
    identity && isRecord(value) && value.executionSource !== undefined
      ? readAppExecutionSourceBinding(
          { executionSource: value.executionSource },
          {
            sessionKey: identity.run.sessionKey,
            nativeSessionId: identity.run.sessionId,
            ...(identity.run.lifecycleRevision !== undefined
              ? { lifecycleRevision: identity.run.lifecycleRevision }
              : {}),
          },
        )
      : null;
  return identity &&
    isRecord(value) &&
    (value.executionSource === undefined || executionSource !== null) &&
    isRecord(value.command) &&
    isRecord(value.policy) &&
    typeof value.policy.allowLocalFiles === 'boolean'
    ? {
        ...identity,
        command: value.command,
        policy: { allowLocalFiles: value.policy.allowLocalFiles },
        ...(executionSource ? { executionSource } : {}),
      }
    : null;
};

export const readBrowserReleasedEvent = (value: unknown): BrowserReleasedEvent | null => {
  if (!isRecord(value)) return null;
  const run = readBrowserExecutionRun(value.run);
  return run &&
    (value.reason === 'settled' || value.reason === 'revoked') &&
    typeof value.discardPages === 'boolean'
    ? { run, reason: value.reason, discardPages: value.discardPages }
    : null;
};

export const readBrowserRevokedEvent = (value: unknown): BrowserRevokedEvent | null => {
  if (!isRecord(value)) return null;
  const run = readBrowserExecutionRun(value.run);
  const admissionRevision = readAdmissionRevision(value.admissionRevision);
  return run && admissionRevision ? { run, admissionRevision } : null;
};
