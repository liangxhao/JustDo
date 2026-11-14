import {
  diagnosticErrorCodes,
  isDiagnosticMetricValue,
} from '../../../shared/cowork/diagnostics/diagnosticLogDetails';
import { redactDiagnosticLog } from './exportLogs';

const CALL_LIMIT = 512;
const FALLBACK_LIMIT = 256;
const CALL_TYPES = [
  'runtime_services.model_call',
  'model.call.started',
  'model.call.completed',
  'model.call.error',
];
const FALLBACK_TYPES = ['model_fallback_decision', 'embedded_run_failover_decision'];
const FAILURE_KINDS = ['aborted', 'connection_closed', 'connection_reset', 'terminated', 'timeout'];
const ERROR_CATEGORIES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'AggregateError',
  'null',
  'object',
  'undefined',
  'boolean',
  'number',
  'bigint',
  'string',
  'symbol',
  'function',
  'unknown',
];
const FALLBACK_REASONS = [
  'auth',
  'auth_permanent',
  'format',
  'rate_limit',
  'overloaded',
  'billing',
  'server_error',
  'timeout',
  'tls_certificate',
  'context_overflow',
  'model_not_found',
  'session_expired',
  'empty_response',
  'no_error_details',
  'unclassified',
  'unknown',
];
const FALLBACK_DECISIONS = [
  'skip_candidate',
  'probe_cooldown_candidate',
  'candidate_failed',
  'candidate_succeeded',
];
const EMBEDDED_DECISIONS = [
  'rotate_profile',
  'fallback_model',
  'surface_error',
  'retry_same_model',
  'retry_thinking_level',
  'continue_normal',
];
const CONTEXT_SOURCES = ['model', 'modelsConfig', 'agentContextTokens', 'default'];
const RESPONSE_CODES = ['reasoning_only_result', 'empty_result', 'planning_only_result'];
const USAGE_FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoningTokens',
  'promptTokens',
  'total',
];

type Fields = Record<string, unknown>;
type Alias = (value: unknown) => string | undefined;
interface Binding {
  sessionKey?: string | null;
  nativeSessionId?: string;
  runIds?: readonly string[];
  selectedRunIds: readonly string[];
}
interface Observation {
  at?: number;
  runId?: string;
  sessionId?: string;
  selectedRun: boolean;
  basis: 'native_session_id' | 'exclusive_run_id';
  order: number;
}
interface CallObservation extends Observation {
  source: 'runtime_services' | 'native_diagnostic';
  unit: 'request' | 'turn';
  phase: 'started' | 'completed' | 'error';
  callId?: string;
  traceId?: string;
  spanId?: string;
  provider?: string;
  model?: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
  contextWindowSource?: string;
  contextWindowReferenceTokens?: number;
  durationMs?: number;
  timeToFirstByteMs?: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  errorCategory?: string;
  failureKind?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamRequestIdHash?: string;
  usage?: Record<string, number>;
}
interface FallbackObservation extends Observation {
  kind: 'model_fallback_decision' | 'embedded_run_failover_decision';
  decision: string;
  stage?: string;
  reason?: string;
  code?: string;
  statusCode?: number;
  attempt?: number;
  total?: number;
  retryCount?: number;
  profileRotationCount?: number;
  suppressedDuplicateCount?: number;
  outcome?: string;
  provider?: string;
  model?: string;
  requestedProvider?: string;
  requestedModel?: string;
  previousProvider?: string;
  previousModel?: string;
  nextProvider?: string;
  nextModel?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

const own = (value: Fields, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const object = (value: unknown): Fields | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const id = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:/@+-]{1,256}$/.test(value) ? value : undefined;
const label = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9._:/@+ -]{1,160}$/.test(value) && value.trim()
    ? redactDiagnosticLog(value)
    : undefined;
const member = (value: unknown, members: readonly string[]) =>
  typeof value === 'string' && members.includes(value) ? value : undefined;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e12
    ? value
    : undefined;
const time = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
    ? value
    : undefined;
const metric = (key: string, value: unknown) =>
  isDiagnosticMetricValue(key, value) ? value : undefined;
const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const tracePart = (value: unknown, length: number) =>
  typeof value === 'string' &&
  value.length === length &&
  /^[0-9a-f]+$/.test(value) &&
  /[1-9a-f]/.test(value)
    ? value
    : undefined;

function projectUsage(value: unknown) {
  const usage = object(value);
  if (!usage) return;
  const values = Object.fromEntries(
    USAGE_FIELDS.flatMap(key => {
      const numeric = count(own(usage, key));
      return numeric === undefined ? [] : [[key, numeric]];
    }),
  );
  return Object.keys(values).length ? values : undefined;
}

const chronological = (left: Observation, right: Observation) =>
  Number(left.at === undefined) - Number(right.at === undefined) ||
  (left.at ?? 0) - (right.at ?? 0) ||
  left.order - right.order;
const retainPriority = (left: Observation, right: Observation) =>
  Number(left.selectedRun) - Number(right.selectedRun) ||
  (left.at ?? -1) - (right.at ?? -1) ||
  left.order - right.order;

/** Keep selected-run observations and then the most recent observations in a fixed budget. */
function retain<T extends Observation>(records: T[], record: T, limit: number): void {
  if (records.length === limit) {
    if (retainPriority(record, records[0]) < 0) return;
    records.shift();
  }
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (retainPriority(record, records[mid]) < 0) high = mid;
    else low = mid + 1;
  }
  records.splice(low, 0, record);
}

const isSupported = (fields: Fields) =>
  member(own(fields, 'type'), CALL_TYPES) || member(own(fields, 'event'), FALLBACK_TYPES);

function projectCall(fields: Fields, observation: Observation): CallObservation | undefined {
  const type = own(fields, 'type');
  const hook = type === 'runtime_services.model_call';
  let phase: unknown;
  if (hook) {
    if (own(fields, 'phase') === 'started') phase = 'started';
    if (own(fields, 'phase') === 'ended') phase = own(fields, 'outcome');
  } else if (typeof type === 'string' && type.startsWith('model.call.')) {
    phase = type.slice('model.call.'.length);
  }
  if (phase !== 'started' && phase !== 'completed' && phase !== 'error') return;
  const trace = object(own(fields, 'trace'));
  const hash = own(fields, 'upstreamRequestIdHash');
  return {
    ...observation,
    source: hook ? 'runtime_services' : 'native_diagnostic',
    unit: !hook && own(fields, 'observationUnit') === 'turn' ? 'turn' : 'request',
    phase,
    callId: id(own(fields, 'callId')),
    traceId: tracePart(own(fields, 'traceId') ?? (trace && own(trace, 'traceId')), 32),
    spanId: tracePart(own(fields, 'spanId') ?? (trace && own(trace, 'spanId')), 16),
    provider: label(own(fields, 'provider')),
    model: label(own(fields, 'model')),
    api: label(own(fields, 'api')),
    transport: label(own(fields, 'transport')),
    contextTokenBudget: count(own(fields, 'contextTokenBudget')),
    contextWindowSource: member(own(fields, 'contextWindowSource'), CONTEXT_SOURCES),
    contextWindowReferenceTokens: count(own(fields, 'contextWindowReferenceTokens')),
    durationMs: metric('durationMs', own(fields, 'durationMs')),
    timeToFirstByteMs: metric('timeToFirstByteMs', own(fields, 'timeToFirstByteMs')),
    requestPayloadBytes: metric('requestPayloadBytes', own(fields, 'requestPayloadBytes')),
    responseStreamBytes: metric('responseStreamBytes', own(fields, 'responseStreamBytes')),
    errorCategory: member(own(fields, 'errorCategory'), ERROR_CATEGORIES),
    failureKind: member(own(fields, 'failureKind'), FAILURE_KINDS),
    statusCode: metric('statusCode', own(fields, 'statusCode') ?? own(fields, 'httpStatus')),
    errorCode: member(own(fields, 'errorCode'), diagnosticErrorCodes),
    upstreamRequestIdHash:
      typeof hash === 'string' && /^sha256:[0-9a-f]{12}$/.test(hash) ? hash : undefined,
    usage: projectUsage(own(fields, 'usage')),
  };
}

function projectFallback(
  fields: Fields,
  observation: Observation,
): FallbackObservation | undefined {
  const kind = own(fields, 'event');
  if (kind !== 'model_fallback_decision' && kind !== 'embedded_run_failover_decision') return;
  const model = kind === 'model_fallback_decision';
  const decision = member(own(fields, 'decision'), model ? FALLBACK_DECISIONS : EMBEDDED_DECISIONS);
  if (!decision) return;
  return {
    ...observation,
    kind,
    decision,
    stage: member(own(fields, 'stage'), ['prompt', 'assistant']),
    reason: member(own(fields, model ? 'reason' : 'failoverReason'), FALLBACK_REASONS),
    code: member(own(fields, 'code'), [...diagnosticErrorCodes, ...RESPONSE_CODES]),
    statusCode: metric('statusCode', own(fields, 'status') ?? own(fields, 'httpCode')),
    attempt: count(own(fields, model ? 'attempt' : 'attemptCount')),
    total: count(own(fields, 'total')),
    retryCount: count(own(fields, 'retryCount')),
    profileRotationCount: count(own(fields, 'profileRotationCount')),
    suppressedDuplicateCount: count(own(fields, 'suppressedDuplicateCount')),
    outcome: member(own(fields, 'fallbackStepFinalOutcome'), [
      'next_fallback',
      'succeeded',
      'chain_exhausted',
    ]),
    provider: label(own(fields, model ? 'candidateProvider' : 'provider')),
    model: label(own(fields, model ? 'candidateModel' : 'model')),
    requestedProvider: label(own(fields, 'requestedProvider')),
    requestedModel: label(own(fields, 'requestedModel')),
    previousProvider: label(own(fields, 'sourceProvider')),
    previousModel: label(own(fields, 'sourceModel')),
    nextProvider: label(own(fields, 'nextCandidateProvider')),
    nextModel: label(own(fields, 'nextCandidateModel')),
    timedOut: bool(own(fields, 'timedOut')),
    aborted: bool(own(fields, 'aborted')),
  };
}

const pairKey = (item: CallObservation): string | undefined =>
  item.runId && item.callId && item.traceId && item.spanId
    ? JSON.stringify([
        item.source,
        item.unit,
        item.sessionId,
        item.runId,
        item.callId,
        item.traceId,
        item.spanId,
      ])
    : undefined;

function projectCallForExport(
  start: CallObservation | undefined,
  end: CallObservation | undefined,
  alias: Alias,
) {
  const observation = start ?? end!;
  const { source, unit, callId, runId, sessionId, selectedRun, traceId, spanId } = observation;
  const metadata = end ?? observation;
  return {
    source,
    unit,
    association: selectedRun ? 'selected_run' : 'conversation',
    basis: observation.basis,
    run: alias(runId),
    nativeSession: alias(sessionId),
    call: alias(callId),
    trace: alias(traceId),
    span: alias(spanId),
    observations: start && end ? 'start_and_end' : start ? 'start_only' : 'end_only',
    startedAt: start?.at,
    endedAt: end?.at,
    outcome: end?.phase,
    provider: metadata.provider ?? start?.provider,
    model: metadata.model ?? start?.model,
    api: metadata.api ?? start?.api,
    transport: metadata.transport ?? start?.transport,
    contextTokenBudget: metadata.contextTokenBudget ?? start?.contextTokenBudget,
    contextWindowSource: metadata.contextWindowSource ?? start?.contextWindowSource,
    contextWindowReferenceTokens:
      metadata.contextWindowReferenceTokens ?? start?.contextWindowReferenceTokens,
    durationMs: end?.durationMs,
    timeToFirstByteMs: end?.timeToFirstByteMs,
    requestPayloadBytes: end?.requestPayloadBytes,
    responseStreamBytes: end?.responseStreamBytes,
    errorCategory: end?.errorCategory,
    failureKind: end?.failureKind,
    statusCode: end?.statusCode,
    errorCode: end?.errorCode,
    upstreamRequestIdHash: end?.upstreamRequestIdHash,
    usage: end?.usage,
  };
}

/** Collect only native structured observations with exact session or exclusive run attribution. */
export class DiagnosticExportRequests {
  private readonly selectedRunIds: ReadonlySet<string>;
  private readonly trustedRunIds: ReadonlySet<string>;
  private readonly calls: CallObservation[] = [];
  private readonly fallbacks: FallbackObservation[] = [];
  private callCount = 0;
  private fallbackCount = 0;
  private unattributed = 0;

  constructor(private readonly binding: Binding) {
    this.selectedRunIds = new Set(binding.selectedRunIds);
    this.trustedRunIds = new Set([...binding.selectedRunIds, ...(binding.runIds ?? [])]);
  }

  append(fields: readonly Fields[], timestamp?: number): boolean {
    const candidates = fields.filter(isSupported);
    if (!candidates.length) return false;
    if (candidates.length !== 1) {
      this.unattributed++;
      return false;
    }
    const [candidate] = candidates;
    const sessionId = id(own(candidate, 'sessionId'));
    const runId = id(own(candidate, 'runId'));
    if (
      (this.binding.sessionKey &&
        fields.some(
          value =>
            own(value, 'sessionKey') !== undefined &&
            own(value, 'sessionKey') !== this.binding.sessionKey,
        )) ||
      (this.binding.nativeSessionId &&
        fields.some(
          value =>
            own(value, 'sessionId') !== undefined &&
            own(value, 'sessionId') !== this.binding.nativeSessionId,
        )) ||
      (runId &&
        fields.some(value => own(value, 'runId') !== undefined && own(value, 'runId') !== runId))
    ) {
      this.unattributed++;
      return false;
    }
    // A session key can be reused after a native reset. Require either the verified
    // physical identity or an exclusive persisted run identity even for a matching key.
    const verifiedSession = sessionId !== undefined && sessionId === this.binding.nativeSessionId;
    if (!verifiedSession && !(runId && this.trustedRunIds.has(runId))) {
      this.unattributed++;
      return false;
    }

    const observation: Observation = {
      at: time(timestamp) ?? time(own(candidate, 'ts')),
      runId,
      sessionId,
      selectedRun: Boolean(runId && this.selectedRunIds.has(runId)),
      basis: verifiedSession ? 'native_session_id' : 'exclusive_run_id',
      order: this.callCount + this.fallbackCount,
    };
    const call = projectCall(candidate, observation);
    if (call) {
      this.callCount++;
      retain(this.calls, call, CALL_LIMIT);
      return true;
    }
    const fallback = projectFallback(candidate, observation);
    if (!fallback) return false;
    this.fallbackCount++;
    retain(this.fallbacks, fallback, FALLBACK_LIMIT);
    return true;
  }

  finish(alias: Alias) {
    const calls = [...this.calls].sort(chronological);
    const groups = new Map<string, CallObservation[]>();
    for (const item of calls) {
      const key = pairKey(item);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    const consumed = new Set<CallObservation>();
    const projectedCalls = calls.flatMap(item => {
      if (consumed.has(item)) return [];
      const key = pairKey(item);
      const group = key ? groups.get(key) : undefined;
      if (group?.length === 2) {
        const start = group.find(value => value.phase === 'started');
        const end = group.find(value => value.phase !== 'started');
        if (
          start &&
          end &&
          (start.at === undefined || end.at === undefined || start.at <= end.at)
        ) {
          consumed.add(start);
          consumed.add(end);
          return [projectCallForExport(start, end, alias)];
        }
      }
      return [
        item.phase === 'started'
          ? projectCallForExport(item, undefined, alias)
          : projectCallForExport(undefined, item, alias),
      ];
    });
    return {
      scope: 'conversation',
      coverage: {
        callObservations: this.callCount,
        callObservationsOmitted: this.callCount - this.calls.length,
        fallbackObservations: this.fallbackCount,
        fallbackObservationsOmitted: this.fallbackCount - this.fallbacks.length,
        ...(this.unattributed ? { unattributedNativeRecords: this.unattributed } : {}),
      },
      calls: projectedCalls,
      fallbackDecisions: [...this.fallbacks]
        .sort(chronological)
        .map(({ order: _order, runId, sessionId, selectedRun, ...fallback }) => ({
          ...fallback,
          association: selectedRun ? 'selected_run' : 'conversation',
          run: alias(runId),
          nativeSession: alias(sessionId),
        })),
    };
  }
}
