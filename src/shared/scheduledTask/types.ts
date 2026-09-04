import type { DeliveryMode, SessionTarget, TaskStatus, WakeMode } from './constants';

export interface ScheduleAt {
  kind: 'at';
  at: string;
}

export interface ScheduleEvery {
  kind: 'every';
  everyMs: number;
  anchorMs?: number;
}

export interface ScheduleCron {
  kind: 'cron';
  expr: string;
  tz?: string;
  staggerMs?: number;
}

export interface ScheduleOnExit {
  kind: 'on-exit';
  command: string;
  cwd?: string;
}

export interface ScheduleStream {
  kind: 'stream';
  command: string[];
  cwd?: string;
  mode?: 'line' | 'match';
  match?: string;
  batchMs?: number;
  maxBatchBytes?: number;
}

export type EditableSchedule = ScheduleAt | ScheduleEvery | ScheduleCron;
export type Schedule = EditableSchedule | ScheduleOnExit | ScheduleStream;

export interface AgentTurnPayload {
  kind: 'agentTurn';
  message: string;
  timeoutSeconds?: number;
  model?: string;
  fallbacks?: string[];
  thinking?: string;
  allowUnsafeExternalContent?: boolean;
  lightContext?: boolean;
  toolsAllow?: string[];
}

export interface SystemEventPayload {
  kind: 'systemEvent';
  text: string;
  toolsAllow?: string[];
}

export interface CommandPayload {
  kind: 'command';
  argv: string[];
  cwd?: string;
  timeoutSeconds?: number;
  noOutputTimeoutSeconds?: number;
  outputMaxBytes?: number;
  toolsAllow?: string[];
}

export interface ScriptPayload {
  kind: 'script';
  script: string;
  timeoutSeconds?: number;
  toolBudget?: number;
  toolsAllow?: string[];
}

export interface GatewayManagedPayload {
  kind: 'heartbeat' | 'skillCollectionReview';
}

export type EditableScheduledTaskPayload = AgentTurnPayload | SystemEventPayload;
export type ScheduledTaskPayload =
  EditableScheduledTaskPayload | CommandPayload | ScriptPayload | GatewayManagedPayload;

export type ScheduledTaskSessionTarget = SessionTarget | 'current' | `session:${string}`;

export type ScheduledTaskManagement = 'editable' | 'advanced' | 'managed';
export type ScheduledTaskAdvancedFeature =
  | 'owner'
  | 'account-tool-policy'
  | 'pacing'
  | 'trigger'
  | 'failure-alert'
  | 'delete-after-run'
  | 'advanced-delivery'
  | 'command-environment'
  | 'command-input';

export interface ScheduledTaskDelivery {
  mode: DeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

export type TaskLastStatus = TaskStatus | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  sessionTarget: ScheduledTaskSessionTarget;
  wakeMode: WakeMode;
  payload: ScheduledTaskPayload;
  delivery: ScheduledTaskDelivery;
  agentId: string | null;
  sessionKey: string | null;
  /** Whether JustDo can safely round-trip edits for this native OpenClaw job. */
  management: ScheduledTaskManagement;
  /** Native features intentionally preserved outside JustDo's basic editor. */
  advancedFeatures?: ScheduledTaskAdvancedFeature[];
  /** Opaque OpenClaw revision used to reject stale destructive confirmations. */
  configRevision?: string | null;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  sessionKey: string | null;
  status: TaskStatus;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}

export interface ScheduledTaskRunWithName extends ScheduledTaskRun {
  taskName: string;
  systemManaged?: boolean;
}

export interface ScheduledTaskResult extends ScheduledTaskRun {
  taskName: string;
  systemManaged?: boolean;
  observedAt: string;
  readAt: string | null;
}

export interface ScheduledTaskSessionResolveContext {
  runId: string;
  status: TaskStatus;
  sessionId?: string | null;
  reason?: 'retry-exhausted';
}

export interface ScheduledTaskSessionHistory {
  sessionKey: string;
  messages: unknown[];
}

export interface ScheduledTaskResultQuery {
  taskId?: string;
  unreadOnly?: boolean;
  includeRoutine?: boolean;
  includeSystem?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ScheduledTaskResultPage {
  results: ScheduledTaskResult[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface ScheduledTaskInput {
  name: string;
  description: string;
  enabled: boolean;
  schedule: EditableSchedule;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  payload: EditableScheduledTaskPayload;
  delivery?: ScheduledTaskDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
}

export interface ScheduledTaskManualRunResult {
  enqueued: boolean;
  runId: string | null;
}

export interface ScheduledTaskRunPage {
  runs: ScheduledTaskRun[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface ScheduledTaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface ScheduledTaskRunEvent {
  run: ScheduledTaskRunWithName;
}

export interface ScheduledTaskResultUpsertedEvent {
  result: ScheduledTaskResult;
  isNewUnread: boolean;
}

export interface ScheduledTaskUnreadCountEvent {
  unreadCount: number;
}

export interface ScheduledTaskChannelOption {
  value: string;
  label: string;
  /** Whether the channel is displayed as unavailable and cannot be selected. */
  disabled?: boolean;
  /** For multi-instance platforms, the account ID that
   *  identifies a specific bot instance.  Passed as `delivery.accountId` so the
   *  channel plugin can use the correct account instead of
   *  falling back to the `default` account. */
  accountId?: string;
}
