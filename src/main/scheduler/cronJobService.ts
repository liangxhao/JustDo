import { BrowserWindow } from 'electron';

import type {
  DeliveryMode as DeliveryModeType,
  GatewayStatus as GatewayStatusType,
  SessionTarget as SessionTargetType,
  WakeMode as WakeModeType,
} from '../../shared/scheduledTask/constants';
import {
  DeliveryMode,
  GatewayStatus,
  IpcChannel,
  PayloadKind,
  ScheduleKind,
  TaskStatus,
} from '../../shared/scheduledTask/constants';
import { isMissingExternalChannelError } from '../../shared/scheduledTask/deliveryError';
import type {
  Schedule,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
  ScheduledTaskResult,
  ScheduledTaskRun,
  ScheduledTaskRunWithName,
  TaskState,
} from '../../shared/scheduledTask/types';
import { isCronSessionKey } from '../openclaw/sessions/openclawChannelSessionSync';

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

type GatewaySchedule = GatewayScheduleAt | GatewayScheduleEvery | GatewayScheduleCron;

type GatewayPayload =
  | {
      kind: 'agentTurn';
      message: string;
      timeoutSeconds?: number;
      model?: string;
      thinking?: string;
    }
  | {
      kind: 'systemEvent';
      text: string;
    };

interface GatewayDelivery {
  mode: DeliveryModeType;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
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
  /** Delivery status from the last run. */
  lastDeliveryStatus?: string;
  /** Delivery error message from the last run. */
  lastDeliveryError?: string;
}

interface GatewayJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: GatewaySchedule;
  sessionTarget: SessionTargetType;
  wakeMode: WakeModeType;
  payload: GatewayPayload;
  delivery?: GatewayDelivery;
  agentId?: string | null;
  sessionKey?: string | null;
  state: GatewayJobState;
  createdAtMs: number;
  updatedAtMs: number;
}

interface GatewayRunLogEntry {
  ts: number;
  jobId: string;
  action?: string;
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
}

interface CronJobServiceDeps {
  getGatewayClient: () => GatewayClientLike | null;
  ensureGatewayReady: () => Promise<void>;
  isCoworkBusy?: () => boolean;
  onJobsPolled?: (jobs: ScheduledTask[]) => Promise<void>;
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

/**
 * Returns true when a gateway error is exclusively a delivery failure —
 * the agent turn itself completed successfully but the gateway reports an
 * error because delivery was attempted and failed (or was not requested).
 *
 * The gateway currently conflates delivery failure with job failure for
 * `delivery.mode: "none"` jobs, setting `status: "error"` even though the
 * agent turn produced a valid summary.  This helper lets callers downgrade
 * such errors to success.
 */
function isDeliveryOnlyError(opts: {
  status?: GatewayStatusType;
  error?: string;
  deliveryError?: string;
  deliveryStatus?: string;
}): boolean {
  if (opts.status !== GatewayStatus.Error) return false;
  if (!opts.error) return false;
  if (opts.deliveryError && opts.error === opts.deliveryError) return true;

  // OpenClaw v2026.6.11 can finish the agent turn successfully, then fail while
  // resolving an announce target. In that path it records deliveryStatus=unknown
  // and puts the routing error only in `error`, leaving `deliveryError` absent.
  return (
    (opts.deliveryStatus === 'unknown' || opts.deliveryStatus === 'not-delivered') &&
    isMissingExternalChannelError(opts.error)
  );
}

export function shouldRepairInAppOnlyDeliveryBackoff(job: GatewayJob): boolean {
  const status = job.state.lastRunStatus ?? job.state.lastStatus;
  const deliveryOnlyError = isDeliveryOnlyError({
    status,
    error: job.state.lastError,
    deliveryError: job.state.lastDeliveryError,
    deliveryStatus: job.state.lastDeliveryStatus,
  });
  if (!deliveryOnlyError || !isMissingExternalChannelError(job.state.lastError)) return false;

  const delivery = job.delivery;
  if (delivery?.mode === DeliveryMode.None) return true;
  if (delivery?.mode === DeliveryMode.Webhook) return false;

  // Announce always represents external-delivery intent, even if its target
  // is incomplete. Only an omitted delivery object is treated as legacy
  // in-app intent.
  return delivery === undefined;
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
  }
}

function toGatewaySchedule(schedule: Schedule): GatewaySchedule {
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

function toGatewayPayload(payload: ScheduledTaskPayload): GatewayPayload {
  if (payload.kind === PayloadKind.SystemEvent) {
    return {
      kind: PayloadKind.SystemEvent,
      text: payload.text,
    };
  }

  return {
    kind: PayloadKind.AgentTurn,
    message: payload.message,
    ...(typeof payload.timeoutSeconds === 'number'
      ? { timeoutSeconds: payload.timeoutSeconds }
      : {}),
    ...(payload.model ? { model: payload.model } : {}),
  };
}

function toGatewayDelivery(delivery?: ScheduledTaskDelivery): GatewayDelivery | undefined {
  console.log(
    '[CronJobService][toGatewayDelivery] input delivery:',
    JSON.stringify(delivery, null, 2),
  );
  if (!delivery) {
    console.log('[CronJobService][toGatewayDelivery] no delivery, returning undefined');
    return undefined;
  }
  if (delivery.mode === DeliveryMode.None) {
    // Preserve channel/to even with mode='none' so IM notification target round-trips
    // through the gateway for the edit form to display.
    const result: GatewayDelivery = {
      mode: DeliveryMode.None,
      ...(delivery.channel ? { channel: delivery.channel } : {}),
      ...(delivery.to ? { to: delivery.to } : {}),
    } as GatewayDelivery;
    console.log(
      '[CronJobService][toGatewayDelivery] mode=none with preserved channel/to:',
      JSON.stringify(result),
    );
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
  console.log(
    '[CronJobService][toGatewayDelivery] output gatewayDelivery:',
    JSON.stringify(result, null, 2),
  );
  return result;
}

export function mapGatewayTaskState(
  state: GatewayJobState,
  _deliveryMode?: DeliveryModeType,
): TaskState {
  let lastStatus = state.runningAtMs
    ? TaskStatus.Running
    : mapGatewayResultStatus(state.lastRunStatus ?? state.lastStatus);

  // Keep execution and external delivery outcomes separate.
  if (
    lastStatus === TaskStatus.Error &&
    isDeliveryOnlyError({
      status: state.lastRunStatus ?? state.lastStatus,
      error: state.lastError,
      deliveryError: state.lastDeliveryError,
      deliveryStatus: state.lastDeliveryStatus,
    })
  ) {
    lastStatus = TaskStatus.Success;
  }

  return {
    nextRunAtMs: safeFiniteNumberOrNull(state.nextRunAtMs),
    lastRunAtMs: safeFiniteNumberOrNull(state.lastRunAtMs),
    lastStatus,
    lastError: lastStatus === TaskStatus.Success ? null : (state.lastError ?? null),
    lastDurationMs: safeFiniteNumberOrNull(state.lastDurationMs),
    runningAtMs: safeFiniteNumberOrNull(state.runningAtMs),
    consecutiveErrors: safeFiniteNumber(state.consecutiveErrors ?? 0, 0),
  };
}

export function mapGatewayJob(job: GatewayJob): ScheduledTask {
  const delivery = job.delivery ?? { mode: DeliveryMode.None };

  // Infer delivery channel/to from sessionKey when the gateway job has no
  // explicit delivery target. IM channel inference removed — only cron sessions remain.
  let inferredChannel: string | undefined;
  let inferredTo: string | undefined;
  if (!delivery.channel && job.sessionKey && isCronSessionKey(job.sessionKey)) {
    // Cron sessions don't have channel/to targets
    inferredChannel = undefined;
    inferredTo = undefined;
  }

  return {
    id: job.id,
    name: job.name,
    description: job.description ?? '',
    enabled: job.enabled,
    schedule: mapGatewaySchedule(job.schedule),
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload:
      job.payload.kind === PayloadKind.SystemEvent
        ? { kind: PayloadKind.SystemEvent, text: job.payload.text }
        : {
            kind: PayloadKind.AgentTurn,
            message: job.payload.message,
            ...(typeof job.payload.timeoutSeconds === 'number'
              ? { timeoutSeconds: job.payload.timeoutSeconds }
              : {}),
            ...(job.payload.model ? { model: job.payload.model } : {}),
          },
    delivery: {
      mode: delivery.mode,
      ...(delivery.channel || inferredChannel
        ? { channel: delivery.channel ?? inferredChannel }
        : {}),
      ...(delivery.to || inferredTo ? { to: delivery.to ?? inferredTo } : {}),
      ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
      ...(typeof delivery.bestEffort === 'boolean' ? { bestEffort: delivery.bestEffort } : {}),
    },
    agentId: job.agentId ?? null,
    sessionKey: job.sessionKey ?? null,
    state: mapGatewayTaskState(job.state, delivery.mode),
    createdAt: new Date(safeFiniteNumber(job.createdAtMs, Date.now())).toISOString(),
    updatedAt: new Date(safeFiniteNumber(job.updatedAtMs, Date.now())).toISOString(),
  };
}

export function mapGatewayRun(entry: GatewayRunLogEntry): ScheduledTaskRun {
  let status =
    entry.action && entry.action !== 'finished'
      ? TaskStatus.Running
      : (mapGatewayResultStatus(entry.status) ?? TaskStatus.Error);

  // Suppress delivery-only errors: the agent turn succeeded but the
  // gateway conflated a delivery failure with the job status.
  const deliveryOnlyError = isDeliveryOnlyError({
    status: entry.status,
    error: entry.error,
    deliveryError: entry.deliveryError,
    deliveryStatus: entry.deliveryStatus,
  });
  if (status === TaskStatus.Error && deliveryOnlyError) {
    status = TaskStatus.Success;
  }

  const completionMs = safeFiniteNumber(entry.ts, Date.now());
  const tsMs = safeFiniteNumber(entry.runAtMs, completionMs);
  const stableId =
    entry.runId?.trim() ||
    (Number.isFinite(entry.runAtMs)
      ? `${entry.jobId}:${entry.runAtMs}`
      : `${entry.jobId}:${completionMs}`);

  return {
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
    deliveryError: entry.deliveryError ?? (deliveryOnlyError ? (entry.error ?? null) : null),
  };
}

export class CronJobService {
  private readonly getGatewayClient: () => GatewayClientLike | null;
  private readonly ensureGatewayReady: () => Promise<void>;
  private readonly isCoworkBusy: () => boolean;
  private readonly onJobsPolled: (jobs: ScheduledTask[]) => Promise<void>;
  private readonly deleteRunArtifactsImpl: (result: ScheduledTaskResult) => Promise<void>;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownStates: Map<string, string> = new Map();
  private lastKnownRunAtMs: Map<string, number> = new Map();
  private polling = false;
  private pollOnceInProgress = false;
  private firstPollDone = false;
  private runningJobIds: Set<string> = new Set();
  private inAppDeliveryBackoffRepairs: Map<
    string,
    { signature: string; promise: Promise<GatewayJob> }
  > = new Map();
  private repairedInAppDeliveryBackoffs: Map<string, string> = new Map();
  private taskMutationTails = new Map<string, Promise<void>>();

  private static readonly POLL_INTERVAL_MS = 60_000;

  constructor(deps: CronJobServiceDeps) {
    this.getGatewayClient = deps.getGatewayClient;
    this.ensureGatewayReady = deps.ensureGatewayReady;
    this.isCoworkBusy = deps.isCoworkBusy ?? (() => false);
    this.onJobsPolled = deps.onJobsPolled ?? (async () => undefined);
    this.deleteRunArtifactsImpl =
      deps.deleteRunArtifacts ??
      (async () => {
        throw new Error('OpenClaw cron run cleanup is unavailable');
      });
  }

  hasRunningJobs(): boolean {
    return this.runningJobIds.size > 0;
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
    this.lastKnownRunAtMs.clear();
    this.runningJobIds.clear();
    this.inAppDeliveryBackoffRepairs.clear();
    this.repairedInAppDeliveryBackoffs.clear();
    this.taskMutationTails.clear();
    this.pollOnceInProgress = false;
    this.firstPollDone = false;
  }

  private async pollOnce(): Promise<void> {
    if (!this.polling || this.pollOnceInProgress) return;
    if (this.isCoworkBusy()) return;
    this.pollOnceInProgress = true;

    try {
      const client = this.getGatewayClient();
      if (!client) return;

      const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
        includeDisabled: true,
        limit: 200,
      });
      const jobs = await this.repairInAppOnlyDeliveryBackoffs(
        client,
        Array.isArray(result.jobs) ? result.jobs : [],
      );

      this.runningJobIds.clear();
      const mappedJobs = jobs.map(mapGatewayJob);
      for (const job of jobs) {
        if (job.state.runningAtMs) {
          this.runningJobIds.add(job.id);
        }
      }

      for (const job of jobs) {
        const stateHash = JSON.stringify(job.state);
        const previousHash = this.lastKnownStates.get(job.id);
        if (previousHash !== stateHash) {
          this.lastKnownStates.set(job.id, stateHash);
          if (previousHash !== undefined) {
            const task = mapGatewayJob(job);
            this.emitStatusUpdate(task.id, task.state);
          }
        }

        this.lastKnownRunAtMs.set(job.id, job.state.lastRunAtMs ?? 0);
      }

      await this.onJobsPolled(mappedJobs);

      const currentIds = new Set(jobs.map(job => job.id));
      for (const knownId of this.lastKnownStates.keys()) {
        if (!currentIds.has(knownId)) {
          this.lastKnownStates.delete(knownId);
          this.lastKnownRunAtMs.delete(knownId);
        }
      }

      if (!this.firstPollDone) {
        this.firstPollDone = true;
        this.emitFullRefresh();
      }
    } catch (error) {
      console.warn('[CronJobService] Polling error:', error);
    } finally {
      this.pollOnceInProgress = false;
    }
  }

  private emitStatusUpdate(taskId: string, state: TaskState): void {
    BrowserWindow.getAllWindows().forEach(window => {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcChannel.StatusUpdate, { taskId, state });
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

  private async repairInAppOnlyDeliveryBackoffs(
    client: GatewayClientLike,
    jobs: GatewayJob[],
  ): Promise<GatewayJob[]> {
    const repairedJobs = [...jobs];
    await Promise.all(
      jobs.map(async (job, index) => {
        if (!shouldRepairInAppOnlyDeliveryBackoff(job)) {
          this.inAppDeliveryBackoffRepairs.delete(job.id);
          this.repairedInAppDeliveryBackoffs.delete(job.id);
          return;
        }

        const signature = `${job.state.lastRunAtMs ?? ''}\n${job.state.lastError ?? ''}`;
        if (this.repairedInAppDeliveryBackoffs.get(job.id) === signature) return;

        let repairEntry = this.inAppDeliveryBackoffRepairs.get(job.id);
        if (!repairEntry || repairEntry.signature !== signature) {
          const promise = this.withTaskMutation(job.id, async () => {
            const latestResult = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
              includeDisabled: true,
              query: job.id,
              limit: 20,
            });
            const latest = latestResult.jobs?.find(item => item.id === job.id) ?? job;
            if (!shouldRepairInAppOnlyDeliveryBackoff(latest)) return latest;
            return client.request<GatewayJob>('cron.update', {
              id: latest.id,
              patch: {
                delivery: { mode: DeliveryMode.None },
                // Reapplying the current schedule forces OpenClaw to discard
                // the stale error-backoff timestamp.
                schedule: latest.schedule,
              },
            });
          });
          repairEntry = { signature, promise };
          this.inAppDeliveryBackoffRepairs.set(job.id, repairEntry);
        }

        try {
          const repaired = await repairEntry.promise;
          // The repair runs under the same per-task mutation lock as user
          // updates and re-reads the task inside that lock, so this is the
          // newest complete snapshot.
          repairedJobs[index] = repaired;
          this.repairedInAppDeliveryBackoffs.set(job.id, signature);
          console.info(
            `[CronJobService] Cleared external-delivery backoff for in-app task ${job.id}`,
          );
        } catch (error) {
          console.warn(
            `[CronJobService] Failed to clear external-delivery backoff for task ${job.id}:`,
            error,
          );
        } finally {
          if (this.inAppDeliveryBackoffRepairs.get(job.id) === repairEntry) {
            this.inAppDeliveryBackoffRepairs.delete(job.id);
          }
        }
      }),
    );
    return repairedJobs;
  }

  async addJob(input: ScheduledTaskInput): Promise<ScheduledTask> {
    return this.addJobLocked(input);
  }

  private async addJobLocked(input: ScheduledTaskInput): Promise<ScheduledTask> {
    console.log('[CronJobService][addJob] full input:', JSON.stringify(input, null, 2));
    console.log(
      '[CronJobService][addJob] delivery details:',
      JSON.stringify(
        {
          deliveryMode: input.delivery?.mode,
          deliveryChannel: input.delivery?.channel,
          deliveryTo: input.delivery?.to,
          deliveryAccountId: input.delivery?.accountId,
          sessionTarget: input.sessionTarget,
          sessionKey: input.sessionKey,
        },
        null,
        2,
      ),
    );
    const client = await this.client();
    const gatewayDelivery = toGatewayDelivery(input.delivery);
    console.log(
      '[CronJobService][addJob] resolved gatewayDelivery:',
      JSON.stringify(gatewayDelivery),
    );
    const job = await client.request<GatewayJob>('cron.add', {
      name: input.name,
      description: input.description || undefined,
      enabled: input.enabled,
      schedule: toGatewaySchedule(input.schedule),
      sessionTarget: input.sessionTarget,
      wakeMode: input.wakeMode,
      payload: toGatewayPayload(input.payload),
      ...(gatewayDelivery ? { delivery: gatewayDelivery } : {}),
      ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
      ...(input.sessionKey?.trim() ? { sessionKey: input.sessionKey.trim() } : {}),
    });
    const mapped = mapGatewayJob(job);
    console.log('[CronJobService][addJob] created job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async updateJob(id: string, input: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
    return this.updateJobLocked(id, input);
  }

  private async updateJobLocked(
    id: string,
    input: Partial<ScheduledTaskInput>,
  ): Promise<ScheduledTask> {
    console.log('[CronJobService][updateJob] id:', id, 'input:', JSON.stringify(input, null, 2));
    console.log(
      '[CronJobService][updateJob] delivery details:',
      JSON.stringify(
        {
          deliveryMode: input.delivery?.mode,
          deliveryChannel: input.delivery?.channel,
          deliveryTo: input.delivery?.to,
          deliveryAccountId: input.delivery?.accountId,
          sessionTarget: input.sessionTarget,
          sessionKey: input.sessionKey,
        },
        null,
        2,
      ),
    );
    const client = await this.client();
    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) {
      patch.description = input.description || undefined;
    }
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.schedule !== undefined) patch.schedule = toGatewaySchedule(input.schedule);
    if (input.sessionTarget !== undefined) patch.sessionTarget = input.sessionTarget;
    if (input.wakeMode !== undefined) patch.wakeMode = input.wakeMode;
    if (input.payload !== undefined) patch.payload = toGatewayPayload(input.payload);
    if (input.delivery !== undefined)
      patch.delivery = toGatewayDelivery(input.delivery) ?? { mode: DeliveryMode.None };
    if (input.agentId !== undefined) patch.agentId = input.agentId?.trim() || null;
    if (input.sessionKey !== undefined) patch.sessionKey = input.sessionKey?.trim() || null;

    console.log('[CronJobService][updateJob] final patch:', JSON.stringify(patch, null, 2));
    const job = await this.withTaskMutation(id, () =>
      client.request<GatewayJob>('cron.update', { id, patch }),
    );
    const mapped = mapGatewayJob(job);
    console.log('[CronJobService][updateJob] updated job id:', mapped.id, 'name:', mapped.name);
    return mapped;
  }

  async removeJob(id: string): Promise<void> {
    const client = await this.client();
    await client.request('cron.remove', { id });
    this.lastKnownStates.delete(id);
    this.lastKnownRunAtMs.delete(id);
  }

  async listJobs(): Promise<ScheduledTask[]> {
    const client = await this.client();
    const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
      includeDisabled: true,
      limit: 200,
    });
    const jobs = await this.repairInAppOnlyDeliveryBackoffs(
      client,
      Array.isArray(result.jobs) ? result.jobs : [],
    );
    return jobs.map(mapGatewayJob);
  }

  async getJob(id: string): Promise<ScheduledTask | null> {
    const raw = await this.getJobRaw(id);
    return raw ? mapGatewayJob(raw) : null;
  }

  private async getJobRaw(id: string): Promise<GatewayJob | null> {
    const client = await this.client();
    try {
      const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
        includeDisabled: true,
        query: id,
        limit: 20,
      });
      return result.jobs?.find(job => job.id === id) ?? null;
    } catch {
      return null;
    }
  }

  async toggleJob(id: string, enabled: boolean): Promise<ScheduledTask> {
    return this.toggleJobLocked(id, enabled);
  }

  private async toggleJobLocked(id: string, enabled: boolean): Promise<ScheduledTask> {
    const client = await this.client();
    const job = await this.withTaskMutation(id, () =>
      client.request<GatewayJob>('cron.update', { id, patch: { enabled } }),
    );
    return mapGatewayJob(job);
  }

  async runJob(id: string): Promise<void> {
    return this.runJobLocked(id);
  }

  private async runJobLocked(id: string): Promise<void> {
    const client = await this.client();
    await client.request('cron.run', { id });
  }

  async deleteRunArtifacts(result: ScheduledTaskResult): Promise<void> {
    await this.deleteRunArtifactsImpl(result);
  }

  async listRuns(jobId: string, limit = 20, offset = 0): Promise<ScheduledTaskRun[]> {
    const client = await this.client();
    const result = await client.request<{ entries?: GatewayRunLogEntry[] }>('cron.runs', {
      scope: 'job',
      id: jobId,
      limit,
      offset,
      sortDir: 'desc',
    });
    return Array.isArray(result.entries) ? result.entries.map(mapGatewayRun) : [];
  }

  async listAllRuns(
    limit = 50,
    offset = 0,
  ): Promise<{ runs: ScheduledTaskRunWithName[]; nextOffset: number | null }> {
    const client = await this.client();
    const result = await client.request<{
      entries?: GatewayRunLogEntry[];
      nextOffset?: number | null;
    }>('cron.runs', {
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
