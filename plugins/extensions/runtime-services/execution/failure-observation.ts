import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntryAsync } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

const METHOD = 'runtimeServices.executionFailure';
type Entry = { sessionId?: string; lifecycleRevision?: string };
type Identity = { sessionKey: string; sessionId: string; lifecycleRevision: string | null; runId: string };
type Dependencies = {
  readEntry(sessionKey: string): Promise<Entry | undefined>;
  readMessages(identity: Identity): Promise<readonly { message: unknown }[]>;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

/** Keeps raw errors and task content inside native storage. */
export async function readExecutionFailureObservation(value: unknown, dependencies: Dependencies) {
  const params = record(value);
  if (!params || !identifier(params.sessionKey) || !identifier(params.sessionId) || !identifier(params.runId) ||
      (params.lifecycleRevision !== null && !identifier(params.lifecycleRevision)))
    throw new Error('Invalid native failure identity');
  const identity: Identity = {
    sessionKey: params.sessionKey, sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision as string | null, runId: params.runId,
  };
  const matches = (entry: Entry | undefined) => entry?.sessionId === identity.sessionId &&
    (entry.lifecycleRevision ?? null) === identity.lifecycleRevision;
  if (!matches(await dependencies.readEntry(identity.sessionKey))) {
    return { ...identity, identityMatched: false, errorCode: null };
  }
  const entries = await dependencies.readMessages(identity);
  let errorCode: string | null = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = record(entries[index].message);
    if (!message || record(message.__openclaw)?.runId !== identity.runId || message.role !== 'assistant') continue;
    // Never select an older attempt's error if the run's last assistant is not that failure.
    if (message.stopReason === 'error' && typeof message.errorCode === 'string' &&
        /^[A-Za-z0-9_.:-]{1,128}$/u.test(message.errorCode)) errorCode = message.errorCode;
    break;
  }
  const identityMatched = matches(await dependencies.readEntry(identity.sessionKey));
  return { ...identity, identityMatched, errorCode: identityMatched ? errorCode : null };
}

export function registerExecutionFailureObservation(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(METHOD, async ({ params, respond }) => {
    try {
      const observation = await readExecutionFailureObservation(params, {
        readEntry: sessionKey => getSessionEntryAsync({ sessionKey, readConsistency: 'latest' }),
        readMessages: identity => readVisibleSessionTranscriptMessageEntries({
          sessionKey: identity.sessionKey, sessionId: identity.sessionId,
        }),
      });
      respond(true, observation);
    } catch {
      respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Native failure observation is unavailable' });
    }
  }, { scope: 'operator.read' });
}
