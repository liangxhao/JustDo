export type AgentDeliveryEvent = 'agent' | 'session.tool';

export const TERMINAL_GUARD_OBSERVATION_KEY = 'justdoTerminalGuardObservation';

export interface TerminalGuardObservation {
  token: string;
  action: 'update' | 'commit' | 'rollback';
}

export interface NormalizedAgentEvent {
  runId: string;
  sessionKey: string | null;
  sessionId: string | null;
  lifecycleGeneration: string | null;
  agentId: string | null;
  spawnedBy: string | null;
  agentSeq: number;
  frameSeq: number | null;
  deliveryEvent: AgentDeliveryEvent;
  stream: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface NormalizedChatEvent {
  runId: string | null;
  sessionKey: string;
  sessionId: string | null;
  lifecycleGeneration: string | null;
  frameSeq: number | null;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: unknown;
  deltaText?: string;
  replace: boolean;
  errorMessage?: string;
}

export interface AgentEventNormalizationResult {
  event: NormalizedAgentEvent | null;
  reason?: 'invalid-payload' | 'missing-run' | 'missing-sequence' | 'missing-stream';
  usedAseqFallback: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readTerminalGuardObservation(
  data: Record<string, unknown>,
): TerminalGuardObservation | null {
  const value = asRecord(data[TERMINAL_GUARD_OBSERVATION_KEY]);
  const token = nonEmptyString(value?.token);
  const action = value?.action;
  if (!token || (action !== 'update' && action !== 'commit' && action !== 'rollback')) {
    return null;
  }
  return { token, action };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeAgentEvent(params: {
  deliveryEvent: AgentDeliveryEvent;
  payload: unknown;
  frameSeq?: unknown;
  now?: number;
  allowAseqFallback?: boolean;
}): AgentEventNormalizationResult {
  const payload = asRecord(params.payload);
  if (!payload) return { event: null, reason: 'invalid-payload', usedAseqFallback: false };

  const data = asRecord(payload.data) ?? {};
  const runId = nonEmptyString(payload.runId);
  if (!runId) return { event: null, reason: 'missing-run', usedAseqFallback: false };

  const canonicalSeq = safeInteger(payload.seq);
  const fallbackSeq = params.allowAseqFallback === false ? null : safeInteger(payload.aseq);
  const agentSeq = canonicalSeq ?? fallbackSeq;
  if (agentSeq === null) {
    return { event: null, reason: 'missing-sequence', usedAseqFallback: false };
  }

  const stream = nonEmptyString(payload.stream);
  if (!stream) return { event: null, reason: 'missing-stream', usedAseqFallback: false };

  const now = finiteTimestamp(params.now, Date.now());
  return {
    event: {
      runId,
      sessionKey: firstString(
        payload.sessionKey,
        payload.session,
        payload.key,
        data.sessionKey,
        data.session,
        data.key,
      ),
      sessionId: firstString(payload.sessionId, data.sessionId),
      lifecycleGeneration: firstString(
        payload.lifecycleGeneration,
        payload.gatewayGeneration,
        data.lifecycleGeneration,
        data.gatewayGeneration,
      ),
      agentId: firstString(payload.agentId, data.agentId),
      spawnedBy: firstString(payload.spawnedBy, data.spawnedBy),
      agentSeq,
      frameSeq: safeInteger(params.frameSeq),
      deliveryEvent: params.deliveryEvent,
      stream,
      timestamp: finiteTimestamp(payload.ts ?? payload.timestamp ?? data.ts, now),
      data,
    },
    usedAseqFallback: canonicalSeq === null && fallbackSeq !== null,
  };
}

export function normalizeChatEvent(params: {
  payload: unknown;
  frameSeq?: unknown;
}): NormalizedChatEvent | null {
  const payload = asRecord(params.payload);
  if (!payload) return null;
  const state = payload.state;
  if (state !== 'delta' && state !== 'final' && state !== 'aborted' && state !== 'error') {
    return null;
  }
  const sessionKey = nonEmptyString(payload.sessionKey);
  if (!sessionKey) return null;

  return {
    runId: nonEmptyString(payload.runId),
    sessionKey,
    sessionId: nonEmptyString(payload.sessionId),
    lifecycleGeneration: firstString(
      payload.lifecycleGeneration,
      payload.gatewayGeneration,
    ),
    frameSeq: safeInteger(params.frameSeq),
    state,
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(typeof payload.deltaText === 'string' ? { deltaText: payload.deltaText } : {}),
    replace: payload.replace === true,
    ...(typeof payload.errorMessage === 'string'
      ? { errorMessage: payload.errorMessage }
      : {}),
  };
}
