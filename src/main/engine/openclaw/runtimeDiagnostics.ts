import { randomUUID } from 'node:crypto';

import { diagnosticErrorCodes } from '../../../shared/cowork/diagnostics/diagnosticLogDetails';
import type {
  DiagnosticErrorCategory,
  DiagnosticEvent,
  DiagnosticPhase,
  DiagnosticStopReason,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import {
  diagnosticLoopExits,
  diagnosticResponseShapes,
  diagnosticTimeoutPhases,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
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

/** Project only finite machine details; never tool names, arguments, output or error text. */
function failureDetails(value: unknown): Pick<DiagnosticEvent, 'errorCode' | 'statusCode' | 'durationMs'> {
  const data = record(value);
  const error = record(data.error);
  const code = data.errorCode ?? error.code ?? data.code;
  const errorCode = diagnosticErrorCodes.find(item => item === code);
  const status = data.httpStatus ?? data.statusCode ?? error.statusCode;
  const duration = data.durationMs;
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { statusCode: status } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 1e12 ? { durationMs: duration } : {}),
  };
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
      ...base, ...failureDetails(payload.errorDetail), kind: 'chat', phase: payload.state as DiagnosticPhase,
      ...(errorCategory(payload.errorDetail) ? { errorCategory: errorCategory(payload.errorDetail) } : {}),
      ...(record(payload.errorDetail).failoverReason === 'empty_response' ? { responseIssue: 'empty_response' as const } : {}),
    } };
  }
  const occurredAt = timestamp(data.endedAt) ?? timestamp(data.startedAt) ?? timestamp(payload.ts);
  if (payload.stream === 'lifecycle') {
    if (!['start', 'finishing', 'end', 'error'].includes(String(data.phase))) return;
    // Retain only the closed disposition, never terminal reply text.
    const disposition = record(data.terminalReply).disposition;
    const stopReason = typeof data.stopReason === 'string'
      ? stops.has(data.stopReason as DiagnosticStopReason) ? data.stopReason as DiagnosticStopReason : 'unknown'
      : undefined;
    const category = errorCategory(data.errorObservation);
    return { sessionKey, nativeRunId, event: {
      ...base, ...failureDetails(data.errorObservation), kind: 'lifecycle', phase: data.phase as DiagnosticPhase,
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(stopReason ? { stopReason } : {}),
      ...(category ? { errorCategory: category } : {}),
      ...(diagnosticLoopExits.includes(data.justDoLoopExit as typeof diagnosticLoopExits[number]) ? { loopExit: data.justDoLoopExit as typeof diagnosticLoopExits[number] } : {}),
      ...(diagnosticResponseShapes.includes(data.justDoResponseShape as typeof diagnosticResponseShapes[number]) ? { responseShape: data.justDoResponseShape as typeof diagnosticResponseShapes[number] } : {}),
      ...(['visible', 'silent', 'empty'].includes(String(disposition)) ? { replyDisposition: disposition as 'visible' | 'silent' | 'empty' } : {}),
      ...(record(data.errorObservation).failoverReason === 'empty_response' ? { responseIssue: 'empty_response' as const } : {}),
      ...(diagnosticTimeoutPhases.includes(data.timeoutPhase as typeof diagnosticTimeoutPhases[number]) ? { timeoutPhase: data.timeoutPhase as typeof diagnosticTimeoutPhases[number] } : {}),
      ...(typeof data.executionSettled === 'boolean' ? { executionSettled: data.executionSettled } : {}),
      ...(typeof data.aborted === 'boolean' ? { aborted: data.aborted } : {}),
      ...(typeof data.yielded === 'boolean' ? { yielded: data.yielded } : {}),
      ...(typeof data.providerStarted === 'boolean' ? { providerStarted: data.providerStarted } : {}),
    } };
  }
  // Native command_output terminals carry these fields separately from the tool result.
  // Do not mark toolFailed again: the corresponding tool result owns that counter.
  if (payload.stream === 'command_output' && data.phase === 'end' &&
    ['completed', 'failed', 'blocked'].includes(String(data.status))) {
    const exitCode = typeof data.exitCode === 'number' && Number.isInteger(data.exitCode) &&
      Math.abs(data.exitCode) <= 1e12 ? data.exitCode : undefined;
    const failed = data.status === 'failed' || data.status === 'blocked' ||
      (exitCode !== undefined && exitCode !== 0);
    const details = failureDetails({ durationMs: data.durationMs });
    return { sessionKey, nativeRunId, event: {
      ...base, ...details, kind: 'command', phase: failed ? 'failed' : 'end',
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(exitCode === undefined ? {} : { exitCode }),
    } };
  }
  if (payload.stream === 'tool' && ['start', 'result', 'end'].includes(String(data.phase))) {
    const operations: Record<string, NonNullable<DiagnosticEvent['operation']>> = {
      exec: 'command', bash: 'command', read: 'file_read', write: 'file_write',
      edit: 'file_edit', apply_patch: 'file_edit', browser: 'browser',
      web_search: 'search', web_fetch: 'fetch', process: 'process',
    };
    const operation = typeof data.name === 'string' && Object.hasOwn(operations, data.name)
      ? operations[data.name] : undefined;
    // Exact upstream boundary-prepared validation summary, never arbitrary error text.
    const validationFailed = data.isError === true && typeof data.name === 'string' &&
      data.name.length > 0 && data.name.length <= 80 &&
      data.toolErrorSummary === `${data.name} tool validation failed: invalid arguments`;

    return { sessionKey, nativeRunId, event: {
      ...base, ...failureDetails(data),
      ...(operation ? { operation } : {}),
      ...(validationFailed ? { toolValidationFailed: true } : {}),
      kind: 'tool', phase: data.phase === 'start' ? 'start' : 'end',
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(data.status === 'timeout' ? { stopReason: 'timeout' as const } : {}),
      toolFailed: data.isError === true || data.is_error === true || data.error === true ||
        data.status === 'error' || data.status === 'failed' || data.status === 'timeout' ||
        (typeof data.error === 'string' && data.error.length > 0),
    } };
  }
}
