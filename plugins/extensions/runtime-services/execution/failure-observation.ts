import { createHash } from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry, getSessionEntryAsync } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import { normalizeExecutionFailureCopy } from '../contracts/execution-failure-copy';

const METHOD = 'runtimeServices.executionFailure';
const TERMINAL_FAILURE_TTL_MS = 60_000;
const MAX_TERMINAL_FAILURES = 128;
type Entry = { sessionId?: string; lifecycleRevision?: string };
type Identity = { sessionKey: string; sessionId: string; lifecycleRevision: string | null; runId: string };
type TerminalFailureCode = 'context_overflow' | 'reply_generation_exhausted';
type TerminalFailureIdentity = Identity & { endedAt: number };
type TerminalFailureReceipt = TerminalFailureIdentity & { stopReason?: 'error'; errorFingerprint?: string };
type TerminalFailure = TerminalFailureIdentity & { code: TerminalFailureCode; observedAt: number; errorFingerprint?: string };
type Dependencies = {
  readEntry(sessionKey: string): Promise<Entry | undefined>;
  readMessages(identity: Identity): Promise<readonly { message: unknown }[]>;
  readTerminalFailure?(receipt: TerminalFailureReceipt): TerminalFailureCode | undefined;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

function readTerminalFailureCode(data: Record<string, unknown>): TerminalFailureCode | undefined {
  if (data.phase !== 'error' || data.executionSettled !== true || data.aborted === true ||
      data.yielded === true || data.timeoutPhase || data.status === 'timeout' || data.status === 'timed_out' ||
      (data.stopReason !== undefined && data.stopReason !== 'error')) return;
  if (data.replyGenerationExhausted === true && data.stopReason === 'error' && data.executionStarted !== false) {
    return 'reply_generation_exhausted';
  }
  if (data.livenessState === 'blocked' && record(data.errorObservation)?.failoverReason === 'context_overflow') {
    return 'context_overflow';
  }
}

/** Keeps raw errors and task content inside native storage. */
export async function readExecutionFailureObservation(value: unknown, dependencies: Dependencies) {
  const params = record(value);
  if (!params || !identifier(params.sessionKey) || !identifier(params.sessionId) || !identifier(params.runId) ||
      (params.lifecycleRevision !== null && !identifier(params.lifecycleRevision)) ||
      (params.endedAt !== undefined && !timestamp(params.endedAt)) ||
      (params.stopReason !== undefined && (params.stopReason !== 'error' || !timestamp(params.endedAt))) ||
      (params.errorFingerprint !== undefined && (!fingerprint(params.errorFingerprint) || !timestamp(params.endedAt))))
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
  // A matched whole-run terminal is authoritative. Reading the full transcript
  // here could time out precisely when an oversized history needs recovery.
  const terminalFailureCode = timestamp(params.endedAt)
    ? dependencies.readTerminalFailure?.({
        ...identity, endedAt: params.endedAt,
        ...(params.stopReason === 'error' ? { stopReason: params.stopReason } : {}),
        ...(fingerprint(params.errorFingerprint) ? { errorFingerprint: params.errorFingerprint } : {}),
      })
    : undefined;
  if (terminalFailureCode) {
    return { ...identity, identityMatched: true, errorCode: null, terminalFailureCode };
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
  return {
    ...identity,
    identityMatched,
    errorCode: identityMatched ? errorCode : null,
  };
}

export function registerExecutionFailureObservation(api: OpenClawPluginApi): void {
  // Native agent.wait retains settlement and timing. Keep the missing structured
  // classification briefly so a caller that missed live delivery can correlate it.
  const terminalFailures = new Map<string, TerminalFailure>();
  let lifecycleGeneration: string | undefined;
  const stopEvents = api.runtime.events.onAgentEvent(event => {
    if (event.stream !== 'lifecycle' || !identifier(event.lifecycleGeneration) ||
        !Number.isSafeInteger(event.seq) || event.seq < 0 || 'pluginId' in event.data) return;
    if (event.lifecycleGeneration !== lifecycleGeneration) {
      terminalFailures.clear();
      lifecycleGeneration = event.lifecycleGeneration;
    }
    if (!identifier(event.sessionKey) || !identifier(event.runId)) return;
    if (event.data.phase === 'start') {
      terminalFailures.delete(event.runId);
      return;
    }
    if (event.data.executionSettled !== true || (event.data.phase !== 'end' && event.data.phase !== 'error')) return;
    const code = readTerminalFailureCode(event.data);
    const { endedAt } = event.data;
    terminalFailures.delete(event.runId);
    if (!code || !timestamp(endedAt) || !identifier(event.sessionId)) return;
    try {
      const entry = getSessionEntry({ sessionKey: event.sessionKey, readConsistency: 'latest' });
      if (entry?.sessionId !== event.sessionId) return;
      const copy = normalizeExecutionFailureCopy(event.data.error);
      terminalFailures.set(event.runId, {
        sessionKey: event.sessionKey, sessionId: event.sessionId, lifecycleRevision: entry.lifecycleRevision ?? null,
        runId: event.runId, endedAt, code, observedAt: Date.now(),
        ...(copy === undefined ? {} : { errorFingerprint: createHash('sha256').update(copy).digest('hex') }),
      });
      if (terminalFailures.size > MAX_TERMINAL_FAILURES) {
        const oldest = terminalFailures.keys().next().value;
        if (oldest !== undefined) terminalFailures.delete(oldest);
      }
    } catch {
      // An unavailable native identity leaves this terminal unclassified.
    }
  });
  api.lifecycle.onDispose?.(() => {
    stopEvents();
    terminalFailures.clear();
  });
  api.registerGatewayMethod(METHOD, async ({ params, respond }) => {
    try {
      const observation = await readExecutionFailureObservation(params, {
        readEntry: sessionKey => getSessionEntryAsync({ sessionKey, readConsistency: 'latest' }),
        readMessages: identity => readVisibleSessionTranscriptMessageEntries({
          sessionKey: identity.sessionKey, sessionId: identity.sessionId,
        }),
        readTerminalFailure: receipt => {
          const proof = terminalFailures.get(receipt.runId);
          // The Gateway can use a later publication time for the same RPC failure.
          if (!proof || proof.sessionKey !== receipt.sessionKey || proof.sessionId !== receipt.sessionId ||
              proof.lifecycleRevision !== receipt.lifecycleRevision || receipt.endedAt < proof.endedAt ||
              (receipt.endedAt > proof.endedAt && receipt.stopReason !== 'error' &&
                (!receipt.errorFingerprint || receipt.errorFingerprint !== proof.errorFingerprint))) return;
          if (Date.now() - proof.observedAt > TERMINAL_FAILURE_TTL_MS) {
            terminalFailures.delete(receipt.runId);
            return;
          }
          return proof.code;
        },
      });
      respond(true, observation);
    } catch {
      respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Native failure observation is unavailable' });
    }
  }, { scope: 'operator.read' });
}
