import { BrowserWindow } from 'electron';

import type {
  DeliveryMode as DeliveryModeType,
  GatewayStatus as GatewayStatusType,
  WakeMode as WakeModeType,
} from '../../shared/scheduledTask/constants';
import {
  DeliveryMode,
  GatewayStatus,
  IpcChannel,
  PayloadKind,
  ScheduleKind,
  SessionTarget,
  TaskStatus,
} from '../../shared/scheduledTask/constants';
import {
  applyScheduledTaskPermission,
  ScheduledTaskPermission,
} from '../../shared/scheduledTask/permissions';
import {
  normalizeScheduledTaskDiagnostics,
  normalizeScheduledTaskRunMetadata,
} from '../../shared/scheduledTask/runMetadata';
import type {
  EditableScheduledTaskPayload,
  EditableScheduledTaskPayloadPatch,
  Schedule,
  ScheduledTask,
  ScheduledTaskAdvancedFeature,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskManualRunResult,
  ScheduledTaskPayload,
  ScheduledTaskResult,
  ScheduledTaskRun,
  ScheduledTaskRunPage,
  ScheduledTaskRunWithName,
  ScheduledTaskUpdateInput,
  SchedulerSettingsSnapshot,
  SchedulerSettingsUpdate,
  TaskState,
} from '../../shared/scheduledTask/types';
import { stringifyScheduledTaskLog } from './scheduledTaskLog';
import { buildSchedulerSettingsPatch, readSchedulerSettings } from './schedulerSettings';
import { buildSystemTaskSettingsPatch, readSystemTaskSettings } from './systemTaskSettings';

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

interface GatewayScheduleAt {
  kind: 'at';
  at: string;
}

interface GatewayScheduleEvery {
  kind: 'every';
  everyMs: number;
  anchorMs?: number;
}

interface GatewayScheduleCron {
  kind: 'cron';
  expr: string;
  tz?: string;
  staggerMs?: number;
}

interface GatewayScheduleOnExit {
  kind: 'on-exit';
  command: string;
  cwd?: string;
}

interface GatewayScheduleStream {
  kind: 'stream';
  command: string[];
  cwd?: string;
  mode?: 'line' | 'match';
  match?: string;
  batchMs?: number;
  maxBatchBytes?: number;
}

type GatewaySchedule =
  | GatewayScheduleAt
  | GatewayScheduleEvery
  | GatewayScheduleCron
  | GatewayScheduleOnExit
  | GatewayScheduleStream;

type GatewayPayload =
  | {
      kind: 'agentTurn';
      permissionMode?: 'read-only' | 'full';
      message: string;
      timeoutSeconds?: number;
      model?: string;
      fallbacks?: string[];
      thinking?: string;
      allowUnsafeExternalContent?: boolean;
      lightContext?: boolean;
      toolsAllow?: string[];
    }
  | {
      kind: 'systemEvent';
      text: string;
      toolsAllow?: string[];
    }
  | {
      kind: 'command';
      argv: string[];
      cwd?: string;
      timeoutSeconds?: number;
      noOutputTimeoutSeconds?: number;
      outputMaxBytes?: number;
      toolsAllow?: string[];
      env?: Record<string, string>;
      input?: unknown;
    }
  | {
      kind: 'script';
      script: string;
      timeoutSeconds?: number;
      toolBudget?: number;
      toolsAllow?: string[];
    }
  | { kind: 'heartbeat' };

interface GatewayDelivery {
  mode: DeliveryModeType;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
  threadId?: string | number;
  completionDestination?: unknown;
  failureDestination?: unknown;
}

interface GatewayJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: GatewayStatusType;
  lastStatus?: GatewayStatusType;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  consecutiveSkipped?: number;
  autoDisabled?: unknown;
  lastErrorReason?: string;
  lastDiagnostics?: unknown;
  lastDiagnosticSummary?: string;
  /** Delivery status from the last run. */
  lastDeliveryStatus?: string;
  /** Delivery error message from the last run. */
  lastDeliveryError?: string;
}

interface GatewayJob {
  id: string;
  declarationKey?: string | null;
  displayName?: string | null;
  owner?: { agentId?: string; sessionKey?: string; accountId?: string };
  scheduledToolPolicy?: { version: 1; mode: 'trusted' | 'account' };
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: GatewaySchedule;
  pacing?: unknown;
  trigger?: unknown;
  sessionTarget: 'main' | 'isolated' | 'current' | `session:${string}`;
  wakeMode: WakeModeType;
  payload: GatewayPayload;
  delivery?: GatewayDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
  failureAlert?: unknown;
  state: GatewayJobState;
  createdAtMs: number;
  updatedAtMs: number;
  configRevision?: string;
}

interface GatewayJobListResult {
  jobs?: GatewayJob[];
  snapshotRevision?: string;
  hasMore?: boolean;
  nextOffset?: number | null;
}

interface GatewayRunLogEntry {
  ts?: number;
  jobId: string;
  action?: 'added' | 'updated' | 'removed' | 'started' | 'finished' | 'scheduled';
  status?: GatewayStatusType;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  runAtMs?: number;
  durationMs?: number;
  jobName?: string;
  summary?: string;
  deliveryStatus?: string;
  deliveryError?: string;
  completionStatus?: unknown;
  errorReason?: unknown;
  diagnostics?: unknown;
  deliverySuppressionReason?: unknown;
  model?: unknown;
  provider?: unknown;
  usage?: unknown;
}

interface GatewayRunPage {
  entries?: GatewayRunLogEntry[];
  hasMore?: boolean;
  nextOffset?: number | null;
}

interface GatewayManualRunResult {
  ok?: boolean;
  enqueued?: boolean;
  ran?: boolean;
  runId?: string;
  reason?: string;
}

interface GatewayCronEvent extends GatewayRunLogEntry {
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished' | 'scheduled';
  job?: GatewayJob;
}

interface CronJobServiceDeps {
  getGatewayClient: () => GatewayClientLike | null;
  ensureGatewayReady: () => Promise<void>;
  isCoworkBusy?: () => boolean;
  onJobsPolled?: (jobs: ScheduledTask[]) => Promise<void>;
  onJobFinished?: (job: ScheduledTask) => Promise<void>;
  deleteRunArtifacts?: (result: ScheduledTaskResult) => Promise<void>;
}

/**
 * Coerce a value to a finite number, returning `fallback` when the value is
 * undefined, null, NaN, Infinity, or not a number at all.
 * Used to guard against malformed Gateway responses that could surface NaN in the UI.
 */
function safeFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/**
 * Same as {@link safeFiniteNumber} but returns `null` when the value is absent
 * instead of a numeric fallback.  Suitable for optional timestamp fields.
 */
function safeFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function mapGatewayResultStatus(
  status?: GatewayStatusType,
): 'success' | 'error' | 'skipped' | null {
  if (status === GatewayStatus.Ok) return TaskStatus.Success;
  if (status === GatewayStatus.Error) return TaskStatus.Error;
  if (status === GatewayStatus.Skipped) return TaskStatus.Skipped;
  return null;
}

export function mapGatewaySchedule(schedule: GatewaySchedule): Schedule {
  switch (schedule.kind) {
    case ScheduleKind.At:
      return { kind: ScheduleKind.At, at: schedule.at };
    case ScheduleKind.Every: {
      const everyMs = safeFiniteNumber(schedule.everyMs, 60_000);
      const anchorMs = safeFiniteNumberOrNull(schedule.anchorMs);
      return {
        kind: ScheduleKind.Every,
        everyMs,
        ...(anchorMs !== null ? { anchorMs } : {}),
      };
    }
    case ScheduleKind.Cron: {
      const staggerMs = safeFiniteNumberOrNull(schedule.staggerMs);
      return {
        kind: ScheduleKind.Cron,
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(staggerMs !== null ? { staggerMs } : {}),
      };
    }
    case 'on-exit':
      return {
        kind: 'on-exit',
        command: schedule.command,
        ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
      };
    case 'stream':
      return {
        kind: 'stream',
        command: [...schedule.command],
        ...(schedule.cwd ? { cwd: schedule.cwd } : {}),
        ...(schedule.mode ? { mode: schedule.mode } : {}),
        ...(schedule.match ? { match: schedule.match } : {}),
        ...(typeof schedule.batchMs === 'number' ? { batchMs: schedule.batchMs } : {}),
        ...(typeof schedule.maxBatchBytes === 'number'
          ? { maxBatchBytes: schedule.maxBatchBytes }
          : {}),
      };
  }
}

function toGatewaySchedule(schedule: ScheduledTaskInput['schedule']): GatewaySchedule {
  switch (schedule.kind) {
    case ScheduleKind.At:
      return { kind: ScheduleKind.At, at: schedule.at };
    case ScheduleKind.Every:
      return {
        kind: ScheduleKind.Every,
        everyMs: schedule.everyMs,
        ...(typeof schedule.anchorMs === 'number' ? { anchorMs: schedule.anchorMs } : {}),
      };
    case ScheduleKind.Cron:
      return {
        kind: ScheduleKind.Cron,
        expr: schedule.expr,
        ...(schedule.tz ? { tz: schedule.tz } : {}),
        ...(typeof schedule.staggerMs === 'number' ? { staggerMs: schedule.staggerMs } : {}),
      };
  }
}

function toGatewayPayload(payload: EditableScheduledTaskPayload): GatewayPayload {
  if (payload.kind === PayloadKind.SystemEvent) {
    return {
      kind: PayloadKind.SystemEvent,
      text: payload.text,
      ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
    };
  }

  return {
    kind: PayloadKind.AgentTurn,
    message: payload.message,
    ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
    ...(typeof payload.timeoutSeconds === 'number'
      ? { timeoutSeconds: payload.timeoutSeconds }
      : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.fallbacks ? { fallbacks: [...payload.fallbacks] } : {}),
    ...(payload.thinking ? { thinking: payload.thinking } : {}),
    ...(typeof payload.allowUnsafeExternalContent === 'boolean'
      ? { allowUnsafeExternalContent: payload.allowUnsafeExternalContent }
      : {}),
    ...(typeof payload.lightContext === 'boolean' ? { lightContext: payload.lightContext } : {}),
    ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
  };
}

function toGatewayPayloadPatch(
  payload: EditableScheduledTaskPayloadPatch,
): Record<string, unknown> {
  if (payload.kind === PayloadKind.SystemEvent) {
    return {
      kind: PayloadKind.SystemEvent,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.toolsAllow !== undefined ? { toolsAllow: [...payload.toolsAllow] } : {}),
    };
  }
  const patch: Record<string, unknown> = { kind: PayloadKind.AgentTurn };
  for (const field of [
    'message',
    'permissionMode',
    'timeoutSeconds',
    'model',
    'fallbacks',
    'thinking',
    'allowUnsafeExternalContent',
    'lightContext',
    'toolsAllow',
  ] as const) {
    const value = payload[field];
    if (value !== undefined) patch[field] = Array.isArray(value) ? [...value] : value;
  }
  if (payload.model === '') patch.model = null;
  return patch;
}

function validateAdvancedInput(
  input: ScheduledTaskInput | ScheduledTaskUpdateInput,
  update: boolean,
): void {
  if (input.deleteAfterRun !== undefined && typeof input.deleteAfterRun !== 'boolean') {
    throw new Error('Invalid scheduled task retention policy');
  }
  if (input.schedule?.kind === ScheduleKind.Cron) {
    const { tz, staggerMs } = input.schedule;
    if (tz !== undefined) {
      if (typeof tz !== 'string' || tz.length > 128)
        throw new Error('Invalid scheduled task timezone');
      if (tz) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
        } catch {
          throw new Error('Invalid scheduled task timezone');
        }
      }
    }
    if (
      staggerMs !== undefined &&
      (!Number.isSafeInteger(staggerMs) || staggerMs < 0 || staggerMs > 8_640_000_000_000_000)
    ) {
      throw new Error('Invalid scheduled task stagger window');
    }
  }
  const payload = input.payload;
  if (payload?.kind !== PayloadKind.AgentTurn) return;
  if (
    payload.timeoutSeconds !== undefined &&
    !(update && payload.timeoutSeconds === null) &&
    (typeof payload.timeoutSeconds !== 'number' ||
      !Number.isFinite(payload.timeoutSeconds) ||
      payload.timeoutSeconds < 0)
  ) {
    throw new Error('Invalid scheduled task timeout');
  }
  for (const field of ['model', 'thinking'] as const) {
    const value = payload[field];
    if (
      value !== undefined &&
      !(update && value === null) &&
      (typeof value !== 'string' || value.length > 1024 || (field === 'thinking' && !value.trim()))
    ) {
      throw new Error(`Invalid scheduled task ${field}`);
    }
  }
  if (
    payload.fallbacks !== undefined &&
    !(update && payload.fallbacks === null) &&
    (!Array.isArray(payload.fallbacks) ||
      payload.fallbacks.length > 128 ||
      payload.fallbacks.some(
        value => typeof value !== 'string' || !value.trim() || value.length > 1024,
      ))
  ) {
    throw new Error('Invalid scheduled task fallback models');
  }
  if (payload.lightContext !== undefined && typeof payload.lightContext !== 'boolean') {
    throw new Error('Invalid scheduled task light context option');
  }
}

function mapGatewayPayload(payload: GatewayPayload): ScheduledTaskPayload {
  switch (payload.kind) {
    case 'systemEvent':
      return {
        kind: 'systemEvent',
        text: payload.text,
        ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
      };
    case 'agentTurn':
      return {
        kind: 'agentTurn',
        message: payload.message,
        ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
        ...(typeof payload.timeoutSeconds === 'number'
          ? { timeoutSeconds: payload.timeoutSeconds }
          : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.fallbacks ? { fallbacks: [...payload.fallbacks] } : {}),
        ...(payload.thinking ? { thinking: payload.thinking } : {}),
        ...(typeof payload.allowUnsafeExternalContent === 'boolean'
          ? { allowUnsafeExternalContent: payload.allowUnsafeExternalContent }
          : {}),
        ...(typeof payload.lightContext === 'boolean'
          ? { lightContext: payload.lightContext }
          : {}),
        ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
      };
    case 'command':
      return {
        kind: 'command',
        argv: [...payload.argv],
        ...(payload.cwd ? { cwd: payload.cwd } : {}),
        ...(typeof payload.timeoutSeconds === 'number'
          ? { timeoutSeconds: payload.timeoutSeconds }
          : {}),
        ...(typeof payload.noOutputTimeoutSeconds === 'number'
          ? { noOutputTimeoutSeconds: payload.noOutputTimeoutSeconds }
          : {}),
        ...(typeof payload.outputMaxBytes === 'number'
          ? { outputMaxBytes: payload.outputMaxBytes }
          : {}),
        ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
      };
    case 'script':
      return {
        kind: 'script',
        script: payload.script,
        ...(typeof payload.timeoutSeconds === 'number'
          ? { timeoutSeconds: payload.timeoutSeconds }
          : {}),
        ...(typeof payload.toolBudget === 'number' ? { toolBudget: payload.toolBudget } : {}),
        ...(payload.toolsAllow ? { toolsAllow: [...payload.toolsAllow] } : {}),
      };
    case 'heartbeat':
      return { kind: payload.kind };
  }
}

function resolveGatewayJobManagement(job: GatewayJob): ScheduledTask['management'] {
  if (job.declarationKey || job.payload.kind === 'heartbeat') {
    return 'managed';
  }
  if (
    job.owner !== undefined ||
    job.scheduledToolPolicy?.mode === 'account' ||
    job.pacing !== undefined ||
    job.trigger !== undefined ||
    job.failureAlert !== undefined ||
    (job.schedule.kind !== 'at' && job.deleteAfterRun === true) ||
    job.schedule.kind === 'on-exit' ||
    job.schedule.kind === 'stream' ||
    job.payload.kind === 'command' ||
    job.payload.kind === 'script' ||
    job.sessionTarget === 'current' ||
    job.sessionTarget.startsWith('session:') ||
    job.delivery?.threadId !== undefined ||
    job.delivery?.completionDestination !== undefined ||
    job.delivery?.failureDestination !== undefined
  ) {
    return 'advanced';
  }
  return 'editable';
}

function collectGatewayAdvancedFeatures(job: GatewayJob): ScheduledTaskAdvancedFeature[] {
  const features: ScheduledTaskAdvancedFeature[] = [];
  if (job.owner !== undefined) features.push('owner');
  if (job.scheduledToolPolicy?.mode === 'account') features.push('account-tool-policy');
  if (job.pacing !== undefined) features.push('pacing');
  if (job.trigger !== undefined) features.push('trigger');
  if (job.failureAlert !== undefined) features.push('failure-alert');
  if (job.schedule.kind !== 'at' && job.deleteAfterRun === true) features.push('delete-after-run');
  if (job.payload.kind === 'command' && job.payload.env !== undefined) {
    features.push('command-environment');
  }
  if (job.payload.kind === 'command' && job.payload.input !== undefined) {
    features.push('command-input');
  }
  if (
    job.delivery?.threadId !== undefined ||
    job.delivery?.completionDestination !== undefined ||
    job.delivery?.failureDestination !== undefined
  ) {
    features.push('advanced-delivery');
  }
  return features;
}

function toGatewayDelivery(delivery?: ScheduledTaskDelivery): GatewayDelivery {
  if (!delivery) return { mode: DeliveryMode.None };
  if (delivery.mode === DeliveryMode.None) {
    // Preserve channel/to even with mode='none' so IM notification target round-trips
    // through the gateway for the edit form to display.
    const result: GatewayDelivery = {
      mode: DeliveryMode.None,
      ...(delivery.channel ? { channel: delivery.channel } : {}),
      ...(delivery.to ? { to: delivery.to } : {}),
    } as GatewayDelivery;
    return result;
  }

  // IM channel translation removed — channels disabled pending future adaptation.
  // Pass the channel through directly without platform-specific mapping.
  const openclawChannel = delivery.channel ?? undefined;

  const result: GatewayDelivery = {
    mode: delivery.mode,
    ...(openclawChannel ? { channel: openclawChannel } : {}),
    ...(delivery.to ? { to: delivery.to } : {}),
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
    ...(typeof delivery.bestEffort === 'boolean' ? { bestEffort: delivery.bestEffort } : {}),
  };
  return result;
}

export function mapGatewayTaskState(state: GatewayJobState): TaskState {
  const lastStatus = state.runningAtMs
    ? TaskStatus.Running
    : mapGatewayResultStatus(state.lastRunStatus ?? state.lastStatus);

  const diagnostics = normalizeScheduledTaskDiagnostics(state.lastDiagnostics);
  const disabled =
    state.autoDisabled && typeof state.autoDisabled === 'object'
      ? (state.autoDisabled as Record<string, unknown>)
      : {};
  const autoDisabled =
    (disabled.reason === 'consecutive-failures' || disabled.reason === 'schedule-errors') &&
    typeof disabled.atMs === 'number' &&
    Number.isSafeInteger(disabled.atMs) &&
    disabled.atMs >= 0 &&
    typeof disabled.consecutiveErrors === 'number' &&
    Number.isSafeInteger(disabled.consecutiveErrors) &&
    disabled.consecutiveErrors >= 0
      ? ({
          reason: disabled.reason,
          atMs: disabled.atMs,
          consecutiveErrors: disabled.consecutiveErrors,
        } as NonNullable<TaskState['autoDisabled']>)
      : undefined;
  return {
    nextRunAtMs: safeFiniteNumberOrNull(state.nextRunAtMs),
    lastRunAtMs: safeFiniteNumberOrNull(state.lastRunAtMs),
    lastStatus,
    lastError: lastStatus === TaskStatus.Success ? null : (state.lastError ?? null),
    lastDurationMs: safeFiniteNumberOrNull(state.lastDurationMs),
    runningAtMs: safeFiniteNumberOrNull(state.runningAtMs),
    consecutiveErrors: safeFiniteNumber(state.consecutiveErrors ?? 0, 0),
    ...(autoDisabled ? { autoDisabled } : {}),
    ...(typeof state.lastErrorReason === 'string'
      ? { lastErrorReason: state.lastErrorReason.slice(0, 512) }
      : {}),
    ...(diagnostics ? { lastDiagnostics: diagnostics } : {}),
    ...(typeof state.lastDiagnosticSummary === 'string'
      ? { lastDiagnosticSummary: state.lastDiagnosticSummary.slice(0, 4096) }
      : {}),
    ...(typeof state.consecutiveSkipped === 'number' &&
    Number.isSafeInteger(state.consecutiveSkipped) &&
    state.consecutiveSkipped >= 0
      ? { consecutiveSkipped: state.consecutiveSkipped }
      : {}),
    ...(typeof state.lastDeliveryStatus === 'string'
      ? { lastDeliveryStatus: state.lastDeliveryStatus.slice(0, 128) }
      : {}),
    ...(typeof state.lastDeliveryError === 'string'
      ? { lastDeliveryError: state.lastDeliveryError.slice(0, 2048) }
      : {}),
  };
}

export function mapGatewayJob(job: GatewayJob): ScheduledTask {
  const delivery = job.delivery ?? { mode: DeliveryMode.None };
  const advancedFeatures = collectGatewayAdvancedFeatures(job);

  return {
    id: job.id,
    name: job.displayName?.trim() || job.name,
    description: job.description ?? '',
    enabled: job.enabled,
    ...(typeof job.deleteAfterRun === 'boolean' ? { deleteAfterRun: job.deleteAfterRun } : {}),
    schedule: mapGatewaySchedule(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: mapGatewayPayload(job.payload),
    delivery: {
      mode: delivery.mode,
      ...(delivery.channel ? { channel: delivery.channel } : {}),
      ...(delivery.to ? { to: delivery.to } : {}),
      ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
      ...(typeof delivery.bestEffort === 'boolean' ? { bestEffort: delivery.bestEffort } : {}),
    },
    agentId: job.agentId ?? null,
    sessionKey: job.sessionKey ?? null,
    management: resolveGatewayJobManagement(job),
    declarationKey: job.declarationKey ?? null,
    ...(advancedFeatures.length > 0 ? { advancedFeatures } : {}),
    configRevision: job.configRevision ?? null,
    state: mapGatewayTaskState(job.state),
    createdAt: new Date(safeFiniteNumber(job.createdAtMs, Date.now())).toISOString(),
    updatedAt: new Date(safeFiniteNumber(job.updatedAtMs, Date.now())).toISOString(),
  };
}

export function mapGatewayRun(entry: GatewayRunLogEntry): ScheduledTaskRun {
  const status =
    entry.action && entry.action !== 'finished'
      ? TaskStatus.Running
      : (mapGatewayResultStatus(entry.status) ?? TaskStatus.Error);

  const completionMs = safeFiniteNumber(entry.ts, Date.now());
  const tsMs = safeFiniteNumber(entry.runAtMs, completionMs);
  const stableId =
    entry.runId?.trim() ||
    (Number.isFinite(entry.runAtMs)
      ? `${entry.jobId}:${entry.runAtMs}`
      : `${entry.jobId}:${completionMs}`);

  return {
    ...normalizeScheduledTaskRunMetadata(entry),
    id: stableId,
    taskId: entry.jobId,
    sessionId: entry.sessionId ?? null,
    sessionKey: entry.sessionKey ?? null,
    status,
    summary: entry.summary ?? null,
    startedAt: new Date(tsMs).toISOString(),
    finishedAt:
      status === TaskStatus.Running
        ? null
        : new Date(safeFiniteNumber(entry.ts, tsMs)).toISOString(),
    durationMs: safeFiniteNumberOrNull(entry.durationMs),
    error: status === TaskStatus.Success ? null : (entry.error ?? null),
    deliveryStatus: entry.deliveryStatus ?? null,
    deliveryError: entry.deliveryError ?? null,
  };
}

export class CronJobService {
  private readonly getGatewayClient: () => GatewayClientLike | null;
  private readonly ensureGatewayReady: () => Promise<void>;
  private readonly isCoworkBusy: () => boolean;
  private readonly onJobsPolled: (jobs: ScheduledTask[]) => Promise<void>;
  private readonly onJobFinished: (job: ScheduledTask) => Promise<void>;
  private readonly deleteRunArtifactsImpl: (result: ScheduledTaskResult) => Promise<void>;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownStates: Map<string, string> = new Map();
  private polling = false;
  private pollOnceInProgress = false;
  private firstPollDone = false;
  private taskMutationTails = new Map<string, Promise<void>>();

  private static readonly POLL_INTERVAL_MS = 60_000;

  constructor(deps: CronJobServiceDeps) {
    this.getGatewayClient = deps.getGatewayClient;
    this.ensureGatewayReady = deps.ensureGatewayReady;
    this.isCoworkBusy = deps.isCoworkBusy ?? (() => false);
    this.onJobsPolled = deps.onJobsPolled ?? (async () => undefined);
    this.onJobFinished = deps.onJobFinished ?? (async () => undefined);
    this.deleteRunArtifactsImpl =
      deps.deleteRunArtifacts ??
      (async () => {
        throw new Error('OpenClaw cron run cleanup is unavailable');
      });
  }

  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollOnce();
    this.pollingTimer = setInterval(() => {
      void this.pollOnce();
    }, CronJobService.POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.lastKnownStates.clear();
    this.taskMutationTails.clear();
    this.pollOnceInProgress = false;
    this.firstPollDone = false;
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling || this.pollOnceInProgress) return;
    this.pollOnceInProgress = true;

    try {
      const client = this.getGatewayClient();
      if (!client) return;

      const jobs = await this.listAllGatewayJobs(client);
      if (this.isCoworkBusy()) return;
      const mappedJobs = jobs.map(mapGatewayJob);

      const knownIdsBeforePoll = new Set(this.lastKnownStates.keys());
      for (const job of jobs) {
        const stateHash = JSON.stringify(mapGatewayJob(job));
        const previousHash = this.lastKnownStates.get(job.id);
        if (previousHash !== stateHash) {
          this.lastKnownStates.set(job.id, stateHash);
          if (previousHash !== undefined) {
            const task = mapGatewayJob(job);
            this.emitStatusUpdate(task);
          }
        }
      }

      await this.onJobsPolled(mappedJobs);

      const currentIds = new Set(jobs.map(job => job.id));
      const taskSetChanged =
        currentIds.size !== knownIdsBeforePoll.size ||
        [...currentIds].some(id => !knownIdsBeforePoll.has(id));
      for (const knownId of this.lastKnownStates.keys()) {
        if (!currentIds.has(knownId)) {
          this.lastKnownStates.delete(knownId);
        }
      }

      if (!this.firstPollDone || taskSetChanged) {
        this.firstPollDone = true;
        this.emitFullRefresh();
      }
    } catch (error) {
      console.warn('[CronJobService] Polling error:', error);
    } finally {
      this.pollOnceInProgress = false;
    }
  }

  private emitStatusUpdate(task: ScheduledTask): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.StatusUpdate, {
          taskId: task.id,
          state: task.state,
          task,
        });
      }
    });
  }

  private emitRunUpdate(run: ScheduledTaskRunWithName): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.RunUpdate, { run });
      }
    });
  }

  private emitFullRefresh(): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.Refresh);
      }
    });
  }

  async reconcileGatewayChange(payload?: unknown): Promise<void> {
    const event = this.parseGatewayCronEvent(payload);
    if (event?.job) {
      const task = mapGatewayJob(event.job);
      this.emitStatusUpdate(task);
    }
    if (event?.action === 'finished') {
      this.emitRunUpdate({
        ...mapGatewayRun(event),
        taskName: event.job?.displayName?.trim() || event.job?.name || event.jobId,
      });
    }
    if (event) {
      if (event.action === 'finished' && event.job) {
        await this.onJobFinished(mapGatewayJob(event.job));
      } else if (
        event.action === 'added' ||
        event.action === 'updated' ||
        event.action === 'removed'
      ) {
        this.emitFullRefresh();
      }
      return;
    }
    try {
      const jobs = await this.listJobs();
      await this.onJobsPolled(jobs);
    } finally {
      this.emitFullRefresh();
    }
  }

  private parseGatewayCronEvent(payload: unknown): GatewayCronEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const event = payload as Partial<GatewayCronEvent>;
    if (typeof event.jobId !== 'string' || !event.jobId.trim()) return null;
    if (
      event.action !== 'added' &&
      event.action !== 'updated' &&
      event.action !== 'removed' &&
      event.action !== 'started' &&
      event.action !== 'finished' &&
      event.action !== 'scheduled'
    ) {
      return null;
    }
    return event as GatewayCronEvent;
  }

  private async client(): Promise<GatewayClientLike> {
    let client = this.getGatewayClient();
    if (!client) {
      await this.ensureGatewayReady();
      client = this.getGatewayClient();
    }
    if (!client) {
      throw new Error('OpenClaw gateway client is unavailable for cron operations.');
    }
    return client;
  }

  private async withTaskMutation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskMutationTails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const settledPrevious: Promise<void> = previous.catch((): void => {});
    const tail: Promise<void> = settledPrevious.then((): Promise<void> => gate);
    this.taskMutationTails.set(taskId, tail);
    await settledPrevious;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskMutationTails.get(taskId) === tail) {
        this.taskMutationTails.delete(taskId);
      }
    }
  }

  private async listAllGatewayJobs(client: GatewayClientLike): Promise<GatewayJob[]> {
    const jobs: GatewayJob[] = [];
    const seenIds = new Set<string>();
    let offset = 0;
    let snapshotRevision: string | undefined;
    let snapshotRestarts = 0;

    while (true) {
      const result = await client.request<GatewayJobListResult>('cron.list', {
        includeDisabled: true,
        limit: 200,
        offset,
        includeDeliveryPreviews: false,
      });
      if (
        snapshotRevision !== undefined &&
        result.snapshotRevision !== undefined &&
        result.snapshotRevision !== snapshotRevision
      ) {
        if (snapshotRestarts >= 2) {
          throw new Error('OpenClaw cron.list changed while pagination was in progress.');
        }
        snapshotRestarts += 1;
        jobs.length = 0;
        seenIds.clear();
        offset = 0;
        snapshotRevision = undefined;
        continue;
      }
      snapshotRevision ??= result.snapshotRevision;
      for (const job of Array.isArray(result.jobs) ? result.jobs : []) {
        if (seenIds.has(job.id)) continue;
        seenIds.add(job.id);
        jobs.push(job);
      }
      if (result.hasMore !== true) return jobs;
      const nextOffset = result.nextOffset;
      if (!Number.isFinite(nextOffset) || (nextOffset as number) <= offset) {
        throw new Error('OpenClaw returned an invalid cron.list pagination cursor.');
      }
      offset = Math.floor(nextOffset as number);
    }
  }

  private async findGatewayJob(
    client: GatewayClientLike,
    jobId: string,
  ): Promise<GatewayJob | null> {
    try {
      return await client.request<GatewayJob>('cron.get', { id: jobId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown cron job id|cron job not found|automation not found/i.test(message)) return null;
      throw error;
    }
  }

  private assertJobIsMutable(job: GatewayJob): void {
    if (resolveGatewayJobManagement(job) === 'managed') {
      throw new Error('This automation is system-managed and cannot be changed here.');
    }
  }

  private assertJobIsEditable(job: GatewayJob): void {
    if (resolveGatewayJobManagement(job) !== 'editable') {
      throw new Error('This automation uses advanced or system-managed settings and is read-only.');
    }
  }

  async getSystemSettings() {
    const client = await this.client();
    const snapshot = await client.request<{ config: unknown }>('config.get');
    return readSystemTaskSettings(snapshot.config);
  }

  async getSchedulerSettings(): Promise<SchedulerSettingsSnapshot> {
    const client = await this.client();
    const snapshot = await client.request<{ config: unknown; hash: string }>('config.get');
    if (!snapshot.hash) throw new Error('Gateway configuration revision is unavailable');
    return { settings: readSchedulerSettings(snapshot.config), revision: snapshot.hash };
  }

  async updateSchedulerSettings(input: SchedulerSettingsUpdate): Promise<void> {
    const patch = buildSchedulerSettingsPatch(input);
    if (!Object.keys(patch.cron).length) return;
    const client = await this.client();
    // Use the revision displayed to the user; concurrent config edits must not be overwritten.
    await client.request('config.patch', { raw: JSON.stringify(patch), baseHash: input.revision });
  }

  async updateSystemSettings(
    input: import('../../shared/scheduledTask/types').SystemTaskSettingsPatch,
  ): Promise<void> {
    const client = await this.client();
    const snapshot = await client.request<{ config: unknown; hash: string }>('config.get');
    if (!snapshot.hash) throw new Error('Gateway configuration revision is unavailable');
    const patch = buildSystemTaskSettingsPatch(input, snapshot.config);
    if (!Object.keys(patch).length) return;
    await client.request('config.patch', { raw: JSON.stringify(patch), baseHash: snapshot.hash });
  }

  async addJob(input: ScheduledTaskInput): Promise<ScheduledTask> {
    return this.addJobLocked(input);
  }

  private async addJobLocked(input: ScheduledTaskInput): Promise<ScheduledTask> {
    validateAdvancedInput(input, false);
    console.log('[CronJobService][addJob] input:', stringifyScheduledTaskLog(input));
    const client = await this.client();
    const gatewayDelivery = toGatewayDelivery(input.delivery);
    const job = await client.request<GatewayJob>('cron.add', {
      name: input.name,
      description: input.description || undefined,
      enabled: input.enabled,
      ...(input.deleteAfterRun !== undefined ? { deleteAfterRun: input.deleteAfterRun } : {}),
      schedule: toGatewaySchedule(input.schedule),
      sessionTarget: input.sessionTarget,
      wakeMode: input.wakeMode,
      payload: toGatewayPayload(
        input.payload.kind === PayloadKind.AgentTurn || input.permissionMode !== undefined
          ? applyScheduledTaskPermission(
              input.payload,
              input.permissionMode ?? ScheduledTaskPermission.ReadOnly,
            )
          : input.payload,
      ),
      delivery: gatewayDelivery,
      ...(input.payload.kind === PayloadKind.AgentTurn
        ? { agentId: input.agentId?.trim() || 'main' }
        : input.agentId?.trim()
          ? { agentId: input.agentId.trim() }
          : {}),
      ...(input.sessionKey?.trim() ? { sessionKey: input.sessionKey.trim() } : {}),
    });
    const mapped = mapGatewayJob(job);
    console.log('[CronJobService][addJob] created job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async updateJob(id: string, input: ScheduledTaskUpdateInput): Promise<ScheduledTask> {
    return this.updateJobLocked(id, input);
  }

  private async updateJobLocked(
    id: string,
    input: ScheduledTaskUpdateInput,
  ): Promise<ScheduledTask> {
    validateAdvancedInput(input, true);
    console.log('[CronJobService][updateJob] id:', id, 'input:', stringifyScheduledTaskLog(input));
    const client = await this.client();
    const job = await this.withTaskMutation(id, async () => {
      const current = await this.findGatewayJob(client, id);
      if (!current) throw new Error(`Scheduled task not found: ${id}`);
      this.assertJobIsEditable(current);

      const patch: Record<string, unknown> = {};
      const nextPayloadKind = input.payload?.kind ?? current.payload.kind;
      const payloadKindChanged = nextPayloadKind !== current.payload.kind;
      const payloadPatch = input.payload ? toGatewayPayloadPatch(input.payload) : undefined;
      if (input.permissionMode !== undefined) {
        if (nextPayloadKind !== PayloadKind.AgentTurn) {
          throw new Error('Permission presets require an agent-turn task payload');
        }
        const permitted = applyScheduledTaskPermission(
          { kind: PayloadKind.AgentTurn, message: '' },
          input.permissionMode,
        );
        if (
          permitted.kind === PayloadKind.AgentTurn &&
          input.permissionMode !== ScheduledTaskPermission.Custom
        ) {
          patch.payload = {
            kind: PayloadKind.AgentTurn,
            ...payloadPatch,
            permissionMode: permitted.permissionMode,
            toolsAllow: permitted.toolsAllow,
          };
        }
      }
      if (payloadPatch && patch.payload === undefined) patch.payload = payloadPatch;

      if (input.name !== undefined) {
        if (current.displayName?.trim()) {
          patch.displayName = input.name;
        } else {
          patch.name = input.name;
        }
      }
      if (input.description !== undefined) patch.description = input.description || undefined;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.deleteAfterRun !== undefined) patch.deleteAfterRun = input.deleteAfterRun;
      if (input.schedule !== undefined) patch.schedule = toGatewaySchedule(input.schedule);
      if (input.sessionTarget !== undefined) {
        patch.sessionTarget = input.sessionTarget;
      } else if (payloadKindChanged) {
        patch.sessionTarget =
          nextPayloadKind === PayloadKind.AgentTurn ? SessionTarget.Isolated : SessionTarget.Main;
      }
      if (input.wakeMode !== undefined) patch.wakeMode = input.wakeMode;
      if (input.delivery !== undefined) {
        patch.delivery = toGatewayDelivery(input.delivery);
      }
      if (nextPayloadKind === PayloadKind.AgentTurn) {
        if (payloadKindChanged) {
          patch.agentId = input.agentId?.trim() || 'main';
        } else if (input.agentId !== undefined) {
          patch.agentId = input.agentId?.trim() || null;
        }
      } else if (input.agentId !== undefined) {
        patch.agentId = input.agentId?.trim() || null;
      } else if (payloadKindChanged) {
        patch.agentId = null;
      }
      if (input.sessionKey !== undefined) {
        patch.sessionKey = input.sessionKey?.trim() || null;
      } else if (payloadKindChanged) {
        patch.sessionKey = null;
      }

      console.log('[CronJobService][updateJob] final patch:', stringifyScheduledTaskLog(patch));
      try {
        return await client.request<GatewayJob>('cron.update', {
          id,
          patch,
          ...(current.configRevision ? { expectedConfigRevision: current.configRevision } : {}),
        });
      } catch (error) {
        let currentAfterFailure: GatewayJob | null | undefined;
        try {
          currentAfterFailure = await this.findGatewayJob(client, id);
        } catch {
          currentAfterFailure = undefined;
        }
        if (currentAfterFailure === null) {
          throw new Error(`Scheduled task not found: ${id}`);
        }
        throw error;
      }
    });
    const mapped = mapGatewayJob(job);
    console.log('[CronJobService][updateJob] updated job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async removeJob(id: string): Promise<void> {
    const client = await this.client();
    await this.withTaskMutation(id, async () => {
      const current = await this.findGatewayJob(client, id);
      if (current) {
        this.assertJobIsMutable(current);
        try {
          await client.request('cron.remove', { id });
        } catch (error) {
          let currentAfterFailure: GatewayJob | null | undefined;
          try {
            currentAfterFailure = await this.findGatewayJob(client, id);
          } catch {
            currentAfterFailure = undefined;
          }
          if (currentAfterFailure !== null) throw error;
        }
      }
      this.lastKnownStates.delete(id);
    });
  }

  async listJobs(): Promise<ScheduledTask[]> {
    const client = await this.client();
    return (await this.listAllGatewayJobs(client)).map(mapGatewayJob);
  }

  async getJob(id: string): Promise<ScheduledTask | null> {
    const raw = await this.getJobRaw(id);
    return raw ? mapGatewayJob(raw) : null;
  }

  private async getJobRaw(id: string): Promise<GatewayJob | null> {
    const client = await this.client();
    return this.findGatewayJob(client, id);
  }

  async toggleJob(id: string, enabled: boolean): Promise<ScheduledTask> {
    return this.toggleJobLocked(id, enabled);
  }

  private async toggleJobLocked(id: string, enabled: boolean): Promise<ScheduledTask> {
    const client = await this.client();
    const job = await this.withTaskMutation(id, async () => {
      const current = await this.findGatewayJob(client, id);
      if (!current) throw new Error(`Scheduled task not found: ${id}`);
      this.assertJobIsMutable(current);
      const patch: Record<string, unknown> = { enabled };
      return await client.request<GatewayJob>('cron.update', {
        id,
        patch,
        ...(current.configRevision ? { expectedConfigRevision: current.configRevision } : {}),
      });
    });
    return mapGatewayJob(job);
  }

  async runJob(id: string, expectedConfigRevision?: string): Promise<ScheduledTaskManualRunResult> {
    return this.runJobLocked(id, expectedConfigRevision);
  }

  private async runJobLocked(
    id: string,
    expectedConfigRevision?: string,
  ): Promise<ScheduledTaskManualRunResult> {
    const client = await this.client();
    return this.withTaskMutation(id, async () => {
      const current = await this.findGatewayJob(client, id);
      if (!current) throw new Error(`Scheduled task not found: ${id}`);
      this.assertJobIsMutable(current);
      if (
        expectedConfigRevision !== undefined &&
        current.configRevision !== expectedConfigRevision
      ) {
        throw new Error('The automation changed. Review the latest configuration before running.');
      }
      const result = await client.request<GatewayManualRunResult>('cron.run', {
        id,
        mode: 'force',
      });
      const runId = result.runId?.trim() || null;
      if (result.enqueued !== true || !runId) {
        throw new Error(
          result.reason
            ? `The scheduler did not enqueue the automation: ${result.reason}`
            : 'The scheduler did not return a run ID for the automation.',
        );
      }
      return { enqueued: true, runId };
    });
  }

  async deleteRunArtifacts(result: ScheduledTaskResult): Promise<void> {
    await this.deleteRunArtifactsImpl(result);
  }

  async listRunsPage(jobId: string, limit = 20, offset = 0): Promise<ScheduledTaskRunPage> {
    const client = await this.client();
    const result = await client.request<GatewayRunPage>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit,
      offset,
      sortDir: 'desc',
    });
    return {
      runs: Array.isArray(result.entries) ? result.entries.map(mapGatewayRun) : [],
      hasMore: result.hasMore === true,
      nextOffset:
        typeof result.nextOffset === 'number' && Number.isFinite(result.nextOffset)
          ? result.nextOffset
          : null,
    };
  }

  async listRuns(jobId: string, limit = 20, offset = 0): Promise<ScheduledTaskRun[]> {
    return (await this.listRunsPage(jobId, limit, offset)).runs;
  }

  async listAllRuns(
    limit = 50,
    offset = 0,
  ): Promise<{ runs: ScheduledTaskRunWithName[]; nextOffset: number | null }> {
    const client = await this.client();
    const result = await client.request<GatewayRunPage>('cron.runs', {
      scope: 'all',
      limit,
      offset,
      sortDir: 'desc',
    });
    return {
      runs: Array.isArray(result.entries)
        ? result.entries.map(entry => ({
            ...mapGatewayRun(entry),
            taskName: entry.jobName?.trim() || entry.jobId,
          }))
        : [],
      nextOffset:
        typeof result.nextOffset === 'number' && Number.isFinite(result.nextOffset)
          ? result.nextOffset
          : null,
    };
  }
}
