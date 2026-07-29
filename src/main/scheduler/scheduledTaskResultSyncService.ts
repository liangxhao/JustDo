import type {
  ScheduledTask,
  ScheduledTaskResult,
  ScheduledTaskRunWithName,
} from '../../shared/scheduledTask/types';
import type { ScheduledTaskResultStore } from '../data/scheduledTaskResultStore';
import type { ScheduledTaskResultCatchUp } from '../data/scheduledTaskResultStore';
import type { CronJobService } from './cronJobService';

export const RESULT_BASELINE_LIMIT = 200;
export const RESULT_BASELINE_PER_TASK_LIMIT = 20;
export const RESULT_RECONCILE_LIMIT = 100;
const RESULT_PAGE_SIZE = 50;

export interface ScheduledTaskResultSyncDeps {
  cronJobService: CronJobService;
  resultStore: ScheduledTaskResultStore;
  emitResultUpserted: (result: ScheduledTaskResult, isNewUnread: boolean) => void;
  emitUnreadCountChanged: (count: number) => void;
  emitResultsRefreshed?: () => void;
}

export class ScheduledTaskResultSyncService {
  private startupReconciled = false;
  private syncing: Promise<void> | null = null;
  private deleting: Promise<void> | null = null;
  private lastEmittedUnreadCount: number | null = null;
  private catchUps = new Map<string, ScheduledTaskResultCatchUp>();
  private suppressedRunIds = new Map<string, number>();

  constructor(private readonly deps: ScheduledTaskResultSyncDeps) {}

  reconcile(jobs: ScheduledTask[], forceGlobal = false): Promise<void> {
    if (this.deleting) {
      return this.deleting.then(() => this.reconcile(jobs, forceGlobal));
    }
    if (this.syncing) {
      if (!forceGlobal) return this.syncing;
      return this.syncing.then(() => this.reconcile(jobs, true));
    }
    this.syncing = this.reconcileInternal(jobs, forceGlobal).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async deleteResult(
    runId: string,
    cleanup: (result: ScheduledTaskResult) => Promise<void>,
  ): Promise<boolean> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return false;
    this.suppressedRunIds.set(
      normalizedRunId,
      (this.suppressedRunIds.get(normalizedRunId) ?? 0) + 1,
    );
    const previousDeletion = this.deleting;
    const operation = (async (): Promise<boolean> => {
      await previousDeletion;
      await this.syncing?.catch((): void => undefined);
      const result = this.deps.resultStore.getResult(normalizedRunId);
      if (!result) return false;
      if (result.status === 'running') {
        throw new Error('A running scheduled task result cannot be deleted');
      }
      await cleanup(result);
      return this.deps.resultStore.deleteResult(normalizedRunId);
    })();
    const barrier = operation.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.deleting = barrier;
    try {
      return await operation;
    } finally {
      await barrier;
      if (this.deleting === barrier) this.deleting = null;
      const suppressionCount = this.suppressedRunIds.get(normalizedRunId) ?? 1;
      if (suppressionCount <= 1) this.suppressedRunIds.delete(normalizedRunId);
      else this.suppressedRunIds.set(normalizedRunId, suppressionCount - 1);
    }
  }

  private async reconcileInternal(jobs: ScheduledTask[], forceGlobal: boolean): Promise<void> {
    const taskNames = new Map(jobs.map(job => [job.id, job.name]));
    const activeJobIds = new Set(jobs.map(job => job.id));
    for (const taskId of this.catchUps.keys()) {
      if (!activeJobIds.has(taskId)) {
        this.catchUps.delete(taskId);
        this.persistCatchUp(taskId, null);
      }
    }

    if (!this.deps.resultStore.hasInitializedBaseline()) {
      const baselineAt = Date.now();
      const counts = new Map<string, number>();
      const baseline = (await this.fetchGlobal(RESULT_BASELINE_LIMIT, taskNames)).filter(run => {
        const count = counts.get(run.taskId) ?? 0;
        if (count >= RESULT_BASELINE_PER_TASK_LIMIT) return false;
        counts.set(run.taskId, count + 1);
        return true;
      });
      this.deps.resultStore.initializeBaseline(
        baseline.map(run => ({ run, taskName: run.taskName })),
        baselineAt,
        jobs.map(job => ({ taskId: job.id, lastRunAtMs: job.state.lastRunAtMs })),
      );
      this.startupReconciled = true;
      this.emitUnreadCountIfChanged();
      this.deps.emitResultsRefreshed?.();
      return;
    }

    if (!this.startupReconciled || forceGlobal) {
      const previousLatest = new Map(
        jobs.map(job => [job.id, this.getCompletedThrough(job.id)]),
      );
      // Re-upsert the bounded recent window so corrected mapping rules repair
      // durable projections without deleting read receipts.
      this.upsertChronologically(await this.fetchGlobal(RESULT_RECONCILE_LIMIT, taskNames));
      for (const job of jobs) {
        const stopAt = previousLatest.get(job.id) ?? null;
        if (
          !this.loadCatchUp(job.id) &&
          job.state.lastRunAtMs &&
          stopAt !== null &&
          job.state.lastRunAtMs <= stopAt
        ) {
          continue;
        }
        await this.reconcileJob(job, stopAt, true);
      }
      this.startupReconciled = true;
      this.emitUnreadCountIfChanged();
      return;
    }

    for (const job of jobs) {
      const localLatest = this.deps.resultStore.getLatestStartedAt(job.id);
      const completedThrough = localLatest ?? this.getCompletedThrough(job.id);
      const pending = this.loadCatchUp(job.id) !== null;
      if (
        !pending &&
        (!job.state.lastRunAtMs ||
          (completedThrough !== null && job.state.lastRunAtMs <= completedThrough))
      ) {
        continue;
      }
      await this.reconcileJob(job, completedThrough, false);
    }
    this.emitUnreadCountIfChanged();
  }

  private async reconcileJob(
    job: ScheduledTask,
    stopAt: number | null,
    restart: boolean,
  ): Promise<void> {
    let previousCatchUp = this.loadCatchUp(job.id);
    if (!previousCatchUp) {
      previousCatchUp = {
        boundaryRunId: '',
        boundaryStartedAt: Number.MAX_SAFE_INTEGER,
        stopAt,
        ignoreKnown: restart,
        resumeOffset: 0,
      };
      this.catchUps.set(job.id, previousCatchUp);
      this.persistCatchUp(job.id, previousCatchUp);
    }
    do {
      const batchBoundary = this.loadCatchUp(job.id);
      try {
        const runs = await this.fetchForJob(job, stopAt, restart);
        this.upsertChronologically(runs);
        this.persistCatchUp(job.id, this.catchUps.get(job.id) ?? null);
      } catch (error) {
        if (batchBoundary) {
          this.catchUps.set(job.id, batchBoundary);
          this.persistCatchUp(job.id, batchBoundary);
        }
        throw error;
      }
      restart = false;
    } while (this.catchUps.has(job.id));
  }

  private async fetchGlobal(
    limit: number,
    taskNames: ReadonlyMap<string, string>,
  ): Promise<ScheduledTaskRunWithName[]> {
    const collected: ScheduledTaskRunWithName[] = [];
    let offset = 0;
    while (collected.length < limit) {
      const page = await this.deps.cronJobService.listAllRuns(
        Math.min(RESULT_PAGE_SIZE, limit - collected.length),
        offset,
      );
      for (const run of page.runs) {
        collected.push({
          ...run,
          taskName: taskNames.get(run.taskId)?.trim() || run.taskName,
        });
        if (collected.length >= limit) break;
      }
      if (page.nextOffset === null || page.runs.length === 0) break;
      offset = page.nextOffset;
    }
    return collected;
  }

  private async fetchForJob(
    job: ScheduledTask,
    stopAt: number | null,
    ignoreKnown: boolean,
  ): Promise<ScheduledTaskRunWithName[]> {
    const collected: ScheduledTaskRunWithName[] = [];
    const pending = this.catchUps.get(job.id);
    const effectiveStopAt = pending?.stopAt ?? stopAt;
    const effectiveIgnoreKnown = pending?.ignoreKnown ?? ignoreKnown;
    let boundaryPassed = !pending;
    let offset = pending?.resumeOffset ?? 0;
    while (true) {
      const runs = await this.deps.cronJobService.listRuns(
        job.id,
        RESULT_PAGE_SIZE,
        offset,
      );
      if (!runs.length) {
        this.catchUps.delete(job.id);
        break;
      }
      for (const run of runs) {
        const startedAt = Date.parse(run.startedAt);
        if (!boundaryPassed && pending) {
          if (run.id === pending.boundaryRunId) {
            boundaryPassed = true;
            continue;
          }
          if (startedAt >= pending.boundaryStartedAt) continue;
          boundaryPassed = true;
        }
        if (!boundaryPassed) continue;
        if (
          (effectiveStopAt !== null && startedAt <= effectiveStopAt) ||
          (!effectiveIgnoreKnown && this.deps.resultStore.getResult(run.id))
        ) {
          this.catchUps.delete(job.id);
          return collected;
        }
        collected.push({ ...run, taskName: job.name });
        if (collected.length >= RESULT_RECONCILE_LIMIT) {
          this.catchUps.set(job.id, {
            boundaryRunId: run.id,
            boundaryStartedAt: startedAt,
            stopAt: effectiveStopAt,
            ignoreKnown: effectiveIgnoreKnown,
            resumeOffset: offset,
          });
          return collected;
        }
      }
      offset += runs.length;
      if (runs.length < RESULT_PAGE_SIZE) {
        this.catchUps.delete(job.id);
        break;
      }
    }
    return collected;
  }

  private loadCatchUp(taskId: string): ScheduledTaskResultCatchUp | null {
    const memory = this.catchUps.get(taskId);
    if (memory) return memory;
    const persisted = this.deps.resultStore.getCatchUp?.(taskId) ?? null;
    if (persisted) this.catchUps.set(taskId, persisted);
    return persisted;
  }

  private persistCatchUp(taskId: string, catchUp: ScheduledTaskResultCatchUp | null): void {
    this.deps.resultStore.setCatchUp?.(taskId, catchUp);
  }

  private getBaselineAt(): number | null {
    return this.deps.resultStore.getBaselineAt?.() ?? null;
  }

  private getCompletedThrough(taskId: string): number | null {
    const localLatest = this.deps.resultStore.getLatestStartedAt(taskId);
    if (localLatest !== null) return localLatest;
    const watermark = this.deps.resultStore.getBaselineWatermark?.(taskId);
    if (watermark) return watermark.lastRunAtMs;
    return this.getBaselineAt();
  }

  private upsertChronologically(runs: ScheduledTaskRunWithName[]): void {
    const deduplicated = [...new Map(runs.map(run => [run.id, run])).values()].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    const validRuns = deduplicated.filter(run => {
      if (this.suppressedRunIds.has(run.id)) return false;
      const valid =
        !!run.id.trim() &&
        !!run.taskId.trim() &&
        Number.isFinite(Date.parse(run.startedAt)) &&
        (run.finishedAt === null || Number.isFinite(Date.parse(run.finishedAt)));
      if (!valid) {
        console.warn(
          `[ScheduledTaskResultSync] Skipped malformed run task=${run.taskId} run=${run.id}`,
        );
      }
      return valid;
    });
    const outcomes = this.deps.resultStore.upsertResults(
      validRuns.map(run => ({ run, taskName: run.taskName })),
    );
    for (const outcome of outcomes) {
      if (outcome.changed) {
        this.deps.emitResultUpserted(outcome.result, outcome.isNewUnread);
      }
    }
  }

  updateUnreadCount(count: number): void {
    this.lastEmittedUnreadCount = count;
    this.deps.emitUnreadCountChanged(count);
  }

  private emitUnreadCountIfChanged(): void {
    const count = this.deps.resultStore.countUnread();
    if (count === this.lastEmittedUnreadCount) return;
    this.lastEmittedUnreadCount = count;
    this.deps.emitUnreadCountChanged(count);
  }
}
