import { randomUUID } from 'node:crypto';

import type {
  DiagnosticErrorCategory,
  DiagnosticEvent,
  DiagnosticPhase,
  DiagnosticStopReason,
} from '../../../shared/cowork/sessionDiagnostics';
import type { GatewayEventFrame } from '../gateway/types';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>) : {};
const identity = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stops = new Set<DiagnosticStopReason>([
  'stop', 'end_turn', 'completed', 'length', 'max_tokens', 'aborted',
  'timeout', 'restart', 'superseded', 'error',
]);
function errorCategory(value: unknown): DiagnosticErrorCategory | undefined {
  const detail = record(value);
  const mapped: Record<string, DiagnosticErrorCategory> = {
    auth: 'auth', auth_permanent: 'auth', rate_limit: 'rate_limit', billing: 'billing',
    timeout: 'timeout', context_overflow: 'context', network: 'network',
  };
  const reason = detail.failoverReason;
  if (typeof reason === 'string' && Object.hasOwn(mapped, reason)) return mapped[reason];
  const status = detail.httpStatus;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) return 'provider';
}

export interface ProjectedDiagnostic {
  sessionKey?: string;
  nativeRunId: string;
  event: Omit<DiagnosticEvent, 'runId'>;
}

/** Content-free projection happens before retaining anything from the wire. */
export function projectDiagnosticEvent(
  frame: GatewayEventFrame,
  epoch: string,
  now = Date.now(),
): ProjectedDiagnostic | undefined {
  if (!['agent', 'chat', 'session.tool'].includes(frame.event)) return;
  const payload = record(frame.payload);
  const data = record(payload.data);
  const nativeRunId = identity(payload.runId);
  if (!nativeRunId || payload.spawnedBy || data.spawnedBy) return;
  const generation = identity(payload.lifecycleGeneration) ?? identity(data.lifecycleGeneration);
  const base = {
    id: randomUUID(), nativeRunId, epoch, observedAt: now,
    ...(generation ? { generation } : {}),
    ...(timestamp(payload.seq) !== undefined ? { sequence: timestamp(payload.seq) } : {}),
  };
  const sessionKey = identity(payload.sessionKey) ?? identity(data.sessionKey);
  if (frame.event === 'chat') {
    if (!['final', 'error', 'aborted'].includes(String(payload.state))) return;
    return { sessionKey, nativeRunId, event: {
      ...base, kind: 'chat', phase: payload.state as DiagnosticPhase,
      ...(errorCategory(payload.errorDetail) ? { errorCategory: errorCategory(payload.errorDetail) } : {}),
    } };
  }
  const occurredAt = timestamp(data.endedAt) ?? timestamp(data.startedAt) ?? timestamp(payload.ts);
  if (payload.stream === 'lifecycle') {
    if (!['start', 'finishing', 'end', 'error'].includes(String(data.phase))) return;
    // Do not retain error strings, errorObservation, terminalReply or arbitrary codes.
    const stopReason = typeof data.stopReason === 'string'
      ? stops.has(data.stopReason as DiagnosticStopReason) ? data.stopReason as DiagnosticStopReason : 'unknown'
      : undefined;
    const category = errorCategory(data.errorObservation);
    return { sessionKey, nativeRunId, event: {
      ...base, kind: 'lifecycle', phase: data.phase as DiagnosticPhase,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(stopReason ? { stopReason } : {}),
      ...(category ? { errorCategory: category } : {}),
      ...(typeof data.executionSettled === 'boolean' ? { executionSettled: data.executionSettled } : {}),
      ...(typeof data.aborted === 'boolean' ? { aborted: data.aborted } : {}),
      ...(typeof data.yielded === 'boolean' ? { yielded: data.yielded } : {}),
      ...(typeof data.providerStarted === 'boolean' ? { providerStarted: data.providerStarted } : {}),
    } };
  }
  if (payload.stream === 'tool' && ['start', 'result', 'end'].includes(String(data.phase))) {
    return { sessionKey, nativeRunId, event: {
      ...base, kind: 'tool', phase: data.phase === 'start' ? 'start' : 'end',
      ...(occurredAt === undefined ? {} : { occurredAt }),
      toolFailed: data.isError === true || data.is_error === true || data.error === true ||
        data.status === 'error' || data.status === 'failed' || data.status === 'timeout' ||
        (typeof data.error === 'string' && data.error.length > 0),
    } };
  }
}
