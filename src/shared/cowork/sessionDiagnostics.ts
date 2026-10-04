import type {
  DiagnosticErrorCode,
  DiagnosticOperation,
  DiagnosticStage,
} from './diagnosticLogDetails';

export const SessionDiagnosticsIpc = {
  List: 'cowork:diagnostics:list',
  Read: 'cowork:diagnostics:read',
  Refresh: 'cowork:diagnostics:refresh',
  Collect: 'cowork:diagnostics:collect',
  Progress: 'cowork:diagnostics:progress',
  Cancel: 'cowork:diagnostics:cancel',
  Export: 'cowork:diagnostics:export',
} as const;

export const DiagnosticReason = {
  Unknown: 'unknown',
  Running: 'running',
  Completed: 'completed',
  ReplyEnded: 'reply_ended',
  ReplyAborted: 'reply_aborted',
  UserStopped: 'user_stopped',
  Aborted: 'aborted',
  Timeout: 'timeout',
  Restart: 'restart',
  Superseded: 'superseded',
  Length: 'length',
  Failed: 'failed',
  Disconnected: 'disconnected',
  Conflict: 'conflict',
  Waiting: 'waiting',
} as const;
export type DiagnosticReason = (typeof DiagnosticReason)[keyof typeof DiagnosticReason];
export type DiagnosticKind = 'lifecycle' | 'chat' | 'tool' | 'command' | 'connection' | 'cancel';
export type DiagnosticPhase =
  | 'start'
  | 'finishing'
  | 'end'
  | 'error'
  | 'final'
  | 'aborted'
  | 'connected'
  | 'disconnected'
  | 'requested'
  | 'acknowledged'
  | 'failed';
export type DiagnosticStopReason =
  | 'stop'
  | 'end_turn'
  | 'completed'
  | 'length'
  | 'max_tokens'
  | 'aborted'
  | 'timeout'
  | 'restart'
  | 'superseded'
  | 'error'
  | 'unknown';
export type DiagnosticErrorCategory =
  'auth' | 'rate_limit' | 'billing' | 'timeout' | 'network' | 'context' | 'provider' | 'unknown';

/** Closed-value projection: never a raw Gateway payload or error text. */
export interface DiagnosticEvent {
  id: string;
  runId: string;
  nativeRunId?: string;
  generation?: string;
  sequence?: number;
  epoch: string;
  observedAt: number;
  occurredAt?: number;
  kind: DiagnosticKind;
  phase: DiagnosticPhase;
  stopReason?: DiagnosticStopReason;
  executionSettled?: boolean;
  aborted?: boolean;
  yielded?: boolean;
  providerStarted?: boolean;
  errorCategory?: DiagnosticErrorCategory;
  userInitiated?: boolean;
  toolFailed?: boolean;
  operation?: DiagnosticOperation;
  toolValidationFailed?: boolean;
  errorCode?: DiagnosticErrorCode;
  statusCode?: number;
  durationMs?: number;
  exitCode?: number;
  timeoutPhase?: DiagnosticTimeoutPhase;
  responseIssue?: DiagnosticResponseIssue;
  replyDisposition?: 'visible' | 'silent' | 'empty';
  loopExit?: DiagnosticLoopExit;
  responseShape?: DiagnosticResponseShape;
}

export interface DiagnosticConclusion {
  reason: DiagnosticReason;
  confidence: 'confirmed' | 'unknown';
  evidenceIds: string[];
  toolFailures: number;
}
export interface DiagnosticRun {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
}
export interface DiagnosticCoverage {
  firstObservedAt?: number;
  dropped: number;
  /** Process-wide unassociated losses; cannot be attributed to this session. */
  collectorDropped?: number;
  storageFailed: boolean;
  /** Always partial: this recorder does not capture transcripts or every native event. */
  partial: true;
}
export interface DiagnosticReport {
  version: 1;
  snapshotId: string;
  sessionId: string;
  collectedAt: number;
  run?: DiagnosticRun;
  conclusion: DiagnosticConclusion;
  events: DiagnosticEvent[];
  coverage: DiagnosticCoverage;
  connection: 'connected' | 'offline';
  logs?: DiagnosticLogCollection;
  history?: DiagnosticHistoryEvidence;
  environment: {
    status: 'not_requested' | 'available' | 'unavailable';
    collectedAt?: number;
    /** Global context; never attributed as this run's cause. */
    stabilityCount?: number;
    stabilityDropped?: number;
    signals?: Partial<
      Record<'model' | 'tool' | 'blocked' | 'command' | 'stuck' | 'liveness', number>
    >;
    firstAt?: number;
    lastAt?: number;
  };
}
/** On-demand failure excerpts, never a persisted transcript cache. */
export interface DiagnosticHistoryEvidence {
  status: 'scanned' | 'partial' | 'unavailable' | 'changed';
  reason?:
    | 'offline'
    | 'no_run'
    | 'no_binding'
    | 'canceled'
    | 'timeout'
    | 'read_failed'
    | 'page_limit'
    | 'history_changed';
  messagesScanned: number;
  omitted: number;
  /** Content-free shape of the latest eligible assistant response, not its text. */
  lastResponse?: DiagnosticResponseObservation;
  failures: Array<{
    timestamp: number;
    kind: 'tool' | 'model' | 'runtime';
    tool?: string;
    excerpt: string;
    clipped: boolean;
    association: 'run' | 'run_window';
    basis?: 'activity' | 'result' | 'model' | 'failure_receipt';
    cause?: 'state_contention';
    outcome?: 'failed' | 'blocked' | 'aborted';
  }>;
}
export type DiagnosticLogSource = 'main' | 'cowork' | 'gateway' | 'native';
export type DiagnosticLogSignal =
  | 'auth'
  | 'rate_limit'
  | 'billing'
  | 'context'
  | 'timeout'
  | 'network'
  | 'tls'
  | 'provider'
  | 'tool'
  | 'retry'
  | 'disconnect'
  | 'reconnect'
  | 'process_exit'
  | 'queue'
  | 'storage'
  | 'permission'
  | 'unknown';
export interface DiagnosticLogRecord {
  id: string;
  source: DiagnosticLogSource;
  timestamp?: number;
  level: 'error' | 'warn' | 'info' | 'debug' | 'unknown';
  association: 'run' | 'session' | 'time_window';
  signal: DiagnosticLogSignal;
  /** Log-derived hints are never authoritative execution outcomes. */
  inferred: boolean;
  responseIssue?: DiagnosticResponseIssue;
  responseRecovery?: 'retrying' | 'exhausted';
  stage?: DiagnosticStage;
  errorCode?: DiagnosticErrorCode;
  /** Why the collector classified this record; never raw error text. */
  basis?:
    | 'error_category'
    | 'http_status'
    | 'tool_error'
    | 'tool_blocked'
    | 'model_error'
    | 'error_text'
    | 'keyword'
    | 'command_exit'
    | 'command_timeout'
    | 'command_error'
    | 'routine';
  metrics: Partial<
    Record<
      | 'statusCode'
      | 'attempt'
      | 'durationMs'
      | 'queueDepth'
      | 'exitCode'
      | 'waitMs'
      | 'timeToFirstByteMs'
      | 'requestPayloadBytes'
      | 'responseStreamBytes',
      number
    >
  >;
}

export const diagnosticLoopExits = [
  'abort_signal',
  'model_aborted',
  'tool_loop_guard',
  'model_error',
  'policy_stop',
  'handoff',
  'no_pending_work',
] as const;
export type DiagnosticLoopExit = (typeof diagnosticLoopExits)[number];
export const diagnosticResponseShapes = [
  'thinking_only',
  'empty',
  'text',
  'tool_call',
  'other',
] as const;
export type DiagnosticResponseShape = (typeof diagnosticResponseShapes)[number];

export const diagnosticResponseIssues = [
  'reasoning_only',
  'empty_response',
  'incomplete_response',
] as const;
export type DiagnosticResponseIssue = (typeof diagnosticResponseIssues)[number];
export const diagnosticTimeoutPhases = [
  'queue',
  'preflight',
  'provider',
  'post_turn',
  'gateway_draining',
] as const;
export type DiagnosticTimeoutPhase = (typeof diagnosticTimeoutPhases)[number];
export interface DiagnosticResponseObservation {
  endTurn?: boolean;
  timestamp: number;
  association: 'run' | 'run_window';
  thinking: boolean;
  text: boolean;
  toolCall: boolean;
  other: boolean;
  complete: boolean;
  stopReason:
    'stop' | 'end_turn' | 'length' | 'max_tokens' | 'toolUse' | 'error' | 'aborted' | 'unknown';
}
export interface DiagnosticScanProgress {
  snapshotId: string;
  source: DiagnosticLogSource;
  filesCompleted: number;
  bytesRead: number;
  fileBytesRead: number;
  fileBytesTotal: number;
}
export interface DiagnosticLogCoverage {
  /** Complete scan of discovered files at their captured sizes, not complete historical retention. */
  scanComplete?: boolean;
  filesDiscovered?: number;
  filesCompleted?: number;
  matched?: number;
  outputOmitted?: number;
  signalCounts?: Partial<Record<DiagnosticLogSignal, number>>;
  source: DiagnosticLogSource;
  status: 'available' | 'partial' | 'unavailable';
  filesRead: number;
  bytesRead: number;
  recordsRead: number;
  emitted: number;
  suppressed: number;
  parseFailures: number;
  truncated: boolean;
  reasons: Array<
    | 'missing'
    | 'unreadable'
    | 'unsafe_file'
    | 'limit'
    | 'malformed'
    | 'native_unavailable'
    | 'outside_window'
    | 'no_safe_fields'
    | 'output_limit'
    | 'source_changed'
    | 'read_timeout'
    | 'canceled'
  >;
}
export interface DiagnosticLogCollection {
  scanMode?: 'full_files' | 'tail';
  collectedAt: number;
  window: { from: number; to: number };
  /** Main's offset-less timestamps are interpreted in the collector's local timezone. */
  localTimezoneOffsetMinutes: number;
  partial: true;
  sources: DiagnosticLogCoverage[];
  records: DiagnosticLogRecord[];
}
export interface DiagnosticQuery {
  sessionId: string;
  sessionRunId?: string;
}
export type DiagnosticFailure = {
  success: false;
  reason: 'invalid' | 'missing' | 'unavailable' | 'expired' | 'export_failed' | 'busy';
};
export type DiagnosticReadResult = { success: true; report: DiagnosticReport } | DiagnosticFailure;
export type DiagnosticListResult =
  { success: true; runs: DiagnosticRun[]; nextCursor?: string } | DiagnosticFailure;
export type DiagnosticExportResult =
  { success: true; canceled: boolean; path?: string } | DiagnosticFailure;
