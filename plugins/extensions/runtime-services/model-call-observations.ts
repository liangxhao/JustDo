import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { isCoworkSessionKey } from './contracts/session-key';

const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);

const tracePart = (value: unknown, length: number): string | undefined =>
  typeof value === 'string' &&
  value.length === length &&
  /^[0-9a-f]+$/.test(value) &&
  /[1-9a-f]/.test(value)
    ? value
    : undefined;

const label = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  /^[A-Za-z0-9._:/@+-]{1,128}$/.test(value) &&
  !/^(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})$/i.test(value)
    ? value
    : undefined;

const metric = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12
    ? value
    : undefined;

type CallContext = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  trace?: { traceId: string; spanId: string };
};

export function projectModelCallObservation(
  phase: 'started' | 'ended',
  event: {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    callId: string;
    provider: string;
    model: string;
    api?: string;
    transport?: string;
    contextTokenBudget?: number;
    contextWindowSource?: string;
    contextWindowReferenceTokens?: number;
    outcome?: 'completed' | 'error';
    durationMs?: number;
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
    errorCategory?: string;
    failureKind?: string;
    upstreamRequestIdHash?: string;
  },
  context: CallContext,
) {
  if (
    !identity(event.runId) ||
    !identity(event.callId) ||
    !identity(event.sessionKey) ||
    !isCoworkSessionKey(event.sessionKey) ||
    !identity(event.sessionId) ||
    event.runId !== context.runId ||
    event.sessionKey !== context.sessionKey ||
    event.sessionId !== context.sessionId
  ) {
    return;
  }
  const traceId = tracePart(context.trace?.traceId, 32);
  return {
    type: 'runtime_services.model_call',
    phase,
    runId: event.runId,
    sessionKey: event.sessionKey,
    sessionId: event.sessionId,
    callId: event.callId,
    traceId,
    spanId: traceId ? tracePart(context.trace?.spanId, 16) : undefined,
    provider: label(event.provider),
    model: label(event.model),
    api: label(event.api),
    transport: label(event.transport),
    contextTokenBudget: metric(event.contextTokenBudget),
    contextWindowSource: label(event.contextWindowSource),
    contextWindowReferenceTokens: metric(event.contextWindowReferenceTokens),
    ...(phase === 'ended'
      ? {
          outcome:
            event.outcome === 'completed' || event.outcome === 'error' ? event.outcome : undefined,
          durationMs: metric(event.durationMs),
          requestPayloadBytes: metric(event.requestPayloadBytes),
          responseStreamBytes: metric(event.responseStreamBytes),
          timeToFirstByteMs: metric(event.timeToFirstByteMs),
          errorCategory: label(event.errorCategory),
          failureKind: label(event.failureKind),
          upstreamRequestIdHash:
            typeof event.upstreamRequestIdHash === 'string' &&
            /^sha256:[a-f0-9]{12}$/.test(event.upstreamRequestIdHash)
              ? event.upstreamRequestIdHash
              : undefined,
        }
      : {}),
  };
}

export function registerModelCallObservations(api: OpenClawPluginApi): void {
  const observe = (
    phase: Parameters<typeof projectModelCallObservation>[0],
    event: Parameters<typeof projectModelCallObservation>[1],
    context: CallContext,
  ) => {
    try {
      const entry = projectModelCallObservation(phase, event, context);
      if (!entry) return;
      api.runtime.logging
        .getChildLogger({ subsystem: 'plugins/runtime-services' })
        .info(JSON.stringify(entry));
    } catch {
      // Diagnostics must not change model execution.
    }
  };
  api.on('model_call_started', (event, context) => observe('started', event, context));
  api.on('model_call_ended', (event, context) => observe('ended', event, context));
}
