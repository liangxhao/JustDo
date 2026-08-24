import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskInput,
  ScheduledTaskResultQuery,
  ScheduledTaskResultUpsertedEvent,
  ScheduledTaskRunEvent,
  ScheduledTaskStatusEvent,
  ScheduledTaskUnreadCountEvent,
} from '@shared/scheduledTask/types';

import {
  addOrUpdateRun,
  addTask,
  appendResults,
  appendRuns,
  markAllResultsReadLocal,
  markResultReadLocal,
  removeResultLocal,
  removeTask,
  replaceResults,
  setError,
  setLoading,
  setResultFilter,
  setResultsLoading,
  setRuns,
  setTasks,
  setUnreadResultCount,
  updateTask,
  updateTaskState,
  upsertResult,
} from '@/features/scheduled-tasks/scheduledTaskSlice';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
}

function hasTaskDataAnomaly(task: ScheduledTask): boolean {
  if (task.schedule.kind === 'every') {
    const ms = task.schedule.everyMs;
    if (!Number.isFinite(ms) || ms <= 0) return true;
  }
  if (task.schedule.kind === 'at') {
    const d = new Date(task.schedule.at);
    if (!Number.isFinite(d.getTime())) return true;
  }
  const ts = task.state;
  const nums = [ts.nextRunAtMs, ts.lastRunAtMs, ts.lastDurationMs, ts.runningAtMs];
  for (const v of nums) {
    if (v !== null && !Number.isFinite(v)) return true;
  }
  return false;
}

function checkTasksForAnomalies(tasks: ScheduledTask[]): void {
  const anomalous = tasks.filter(hasTaskDataAnomaly);
  if (anomalous.length === 0) return;

  const name = anomalous[0].name;
  const msg = i18nService.t('scheduledTasksDataAnomalyWarning').replace('{name}', name);
  showToast(msg);
}

export class ScheduledTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  private tasksRequestId = 0;
  private resultsRequestId = 0;
  private resultsRevision = 0;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.setupListeners();
    await Promise.all([this.loadTasks(), this.loadResults()]);
  }

  destroy(): void {
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
    this.initialized = false;
  }

  private setupListeners(): void {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const cleanupStatus = api.onStatusUpdate((event: ScheduledTaskStatusEvent) => {
      store.dispatch(
        updateTaskState({
          taskId: event.taskId,
          taskState: event.state,
        }),
      );
    });
    this.cleanupFns.push(cleanupStatus);

    const cleanupRun = api.onRunUpdate((event: ScheduledTaskRunEvent) => {
      store.dispatch(addOrUpdateRun(event.run));
    });
    this.cleanupFns.push(cleanupRun);

    const cleanupResult = api.onResultUpserted((event: ScheduledTaskResultUpsertedEvent) => {
      this.resultsRevision += 1;
      const filter = store.getState().scheduledTask.resultFilter;
      if (
        (!filter.taskId || filter.taskId === event.result.taskId) &&
        (!filter.unreadOnly || event.result.readAt === null)
      ) {
        store.dispatch(upsertResult(event.result));
      }
    });
    this.cleanupFns.push(cleanupResult);

    const cleanupUnread = api.onUnreadCountChanged((event: ScheduledTaskUnreadCountEvent) => {
      store.dispatch(setUnreadResultCount(event.unreadCount));
    });
    this.cleanupFns.push(cleanupUnread);

    const cleanupRefresh = api.onRefresh(() => {
      this.loadTasks();
      this.loadResults();
    });
    this.cleanupFns.push(cleanupRefresh);
  }

  async loadTasks(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    const requestId = ++this.tasksRequestId;
    store.dispatch(setLoading(true));
    try {
      const result = await api.list();
      if (requestId !== this.tasksRequestId) return;
      if (result.success && result.tasks) {
        checkTasksForAnomalies(result.tasks);
        store.dispatch(setTasks(result.tasks));
        store.dispatch(setError(null));
      }
    } catch (err: unknown) {
      if (requestId !== this.tasksRequestId) return;
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    } finally {
      if (requestId === this.tasksRequestId) store.dispatch(setLoading(false));
    }
  }

  async createTask(input: ScheduledTaskInput): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.create(input);
      if (result.success && result.task) {
        if (hasTaskDataAnomaly(result.task)) {
          const msg = i18nService
            .t('scheduledTasksDataAnomalyWarning')
            .replace('{name}', result.task.name);
          showToast(msg);
        }
        store.dispatch(addTask(result.task));
      } else {
        throw new Error(result.error || 'Failed to create task');
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async updateTaskById(id: string, input: Partial<ScheduledTaskInput>): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.update(id, input);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      } else if (!result.success) {
        const errorMsg = result.error || 'Failed to update task';
        store.dispatch(setError(errorMsg));
        throw new Error(errorMsg);
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      await this.loadTasks();
      throw err;
    }
  }

  async deleteTask(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.delete(id);
      if (result.success) {
        store.dispatch(removeTask(id));
      } else {
        throw new Error(result.error || 'Failed to delete task');
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      await this.loadTasks();
      throw err;
    }
  }

  async toggleTask(id: string, enabled: boolean): Promise<string | null> {
    const api = window.electron?.scheduledTasks;
    if (!api) return null;

    try {
      const result = await api.toggle(id, enabled);
      if (result.success && result.task) {
        store.dispatch(updateTask(result.task));
      }
      return result.warning ?? null;
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async runManually(id: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      await api.runManually(id);
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  async loadRuns(taskId: string, limit = 20, offset?: number): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;

    try {
      const result = await api.listRuns(taskId, limit, offset);
      if (result.success && result.runs) {
        const hasMore = result.runs.length >= limit;
        if (offset && offset > 0) {
          store.dispatch(appendRuns({ taskId, runs: result.runs, hasMore }));
        } else {
          store.dispatch(setRuns({ taskId, runs: result.runs, hasMore }));
        }
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async listChannels(): Promise<ScheduledTaskChannelOption[]> {
    const api = window.electron?.scheduledTasks;
    if (!api?.listChannels) return [];

    try {
      const result = await api.listChannels();
      return result.success && result.channels ? result.channels : [];
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      return [];
    }
  }

  async loadResults(append = false): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;
    const state = store.getState().scheduledTask;
    const query: ScheduledTaskResultQuery = {
      taskId: state.resultFilter.taskId ?? undefined,
      unreadOnly: state.resultFilter.unreadOnly,
      limit: 30,
      cursor: append ? (state.resultsNextCursor ?? undefined) : undefined,
    };
    if (append && !query.cursor) return;
    const requestId = ++this.resultsRequestId;
    const resultsRevision = this.resultsRevision;
    store.dispatch(setResultsLoading(true));
    try {
      const response = await api.listResults(query);
      if (requestId !== this.resultsRequestId) return;
      if (!append && resultsRevision !== this.resultsRevision) {
        await this.loadResults();
        return;
      }
      if (!response.success || !response.page) throw new Error(response.error);
      const payload = {
        results: response.page.results,
        nextCursor: response.page.nextCursor,
      };
      store.dispatch(append ? appendResults(payload) : replaceResults(payload));
      store.dispatch(setUnreadResultCount(response.page.unreadCount));
    } catch (err: unknown) {
      if (requestId !== this.resultsRequestId) return;
      store.dispatch(setResultsLoading(false));
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async setResultsFilter(taskId: string | null, unreadOnly: boolean): Promise<void> {
    this.resultsRequestId += 1;
    store.dispatch(setResultFilter({ taskId, unreadOnly }));
    await this.loadResults();
  }

  async markResultRead(runId: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;
    this.resultsRequestId += 1;
    store.dispatch(markResultReadLocal(runId));
    const response = await api.markResultRead(runId);
    if (!response.success) {
      await this.loadResults();
      return;
    }
    if (response.result) store.dispatch(upsertResult(response.result));
    if (typeof response.unreadCount === 'number') {
      store.dispatch(setUnreadResultCount(response.unreadCount));
    }
  }

  async markAllResultsRead(taskId?: string): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;
    this.resultsRequestId += 1;
    store.dispatch(markAllResultsReadLocal(taskId));
    const response = await api.markAllResultsRead(taskId);
    if (!response.success) {
      await this.loadResults();
      return;
    }
    if (typeof response.unreadCount === 'number') {
      store.dispatch(setUnreadResultCount(response.unreadCount));
    }
    if (store.getState().scheduledTask.resultFilter.unreadOnly) await this.loadResults();
  }

  async deleteResult(runId: string): Promise<boolean> {
    const api = window.electron?.scheduledTasks;
    if (!api?.deleteResult) return false;
    this.resultsRequestId += 1;
    try {
      const response = await api.deleteResult(runId);
      if (!response.success) {
        store.dispatch(setError(response.error || 'Failed to delete scheduled task result'));
        await this.loadResults();
        return false;
      }
      store.dispatch(removeResultLocal(runId));
      if (typeof response.unreadCount === 'number') {
        store.dispatch(setUnreadResultCount(response.unreadCount));
      }
      await this.loadResults();
      return true;
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
      await this.loadResults();
      return false;
    }
  }

  async deleteResults(runIds: string[]): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const api = window.electron?.scheduledTasks;
    const normalizedRunIds = [...new Set(runIds.map(id => id.trim()).filter(Boolean))];
    if (!api?.deleteResult || normalizedRunIds.length === 0) {
      return { deletedIds: [], failedIds: normalizedRunIds };
    }

    this.resultsRequestId += 1;
    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    let unreadCount: number | undefined;

    for (const runId of normalizedRunIds) {
      try {
        const response = await api.deleteResult(runId);
        if (!response.success) {
          failedIds.push(runId);
          continue;
        }
        deletedIds.push(runId);
        store.dispatch(removeResultLocal(runId));
        if (typeof response.unreadCount === 'number') unreadCount = response.unreadCount;
      } catch {
        failedIds.push(runId);
      }
    }

    if (typeof unreadCount === 'number') {
      store.dispatch(setUnreadResultCount(unreadCount));
    }
    if (failedIds.length > 0) {
      store.dispatch(
        setError(
          i18nService
            .t('scheduledTasksResultsBatchDeleteFailed')
            .replace('{count}', String(failedIds.length)),
        ),
      );
    }
    await this.loadResults();
    return { deletedIds, failedIds };
  }

  async refreshResults(): Promise<void> {
    const api = window.electron?.scheduledTasks;
    if (!api) return;
    await api.reconcileResults();
    await this.loadResults();
  }
}

export const scheduledTaskService = new ScheduledTaskService();
