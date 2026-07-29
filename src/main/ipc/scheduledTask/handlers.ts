import { createHash } from 'node:crypto';

import { ipcMain } from 'electron';

import { IpcChannel as ScheduledTaskIpc } from '../../../shared/scheduledTask/constants';
import type {
  ScheduledTaskInput,
  ScheduledTaskResultQuery,
  ScheduledTaskSessionResolveContext,
} from '../../../shared/scheduledTask/types';
import type { ScheduledTaskResultStore } from '../../data/scheduledTaskResultStore';
import type { CronJobService } from '../../scheduler/cronJobService';
import type { ScheduledTaskResultSyncService } from '../../scheduler/scheduledTaskResultSyncService';
import { listScheduledTaskChannels } from './helpers';

export interface ScheduledTaskHandlerDeps {
  getCronJobService: () => CronJobService;
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => unknown;
    fetchSessionHistoryByKey: (
      sessionKey: string,
      sessionId?: string | null,
    ) => Promise<unknown>;
  } | null;
  getResultStore?: () => ScheduledTaskResultStore;
  getResultSyncService?: () => ScheduledTaskResultSyncService;
}

function sessionKeyKind(sessionKey: string): string {
  if (/^(?:agent:[^:]+:)?cron:[^:]+:run:[^:]+/i.test(sessionKey)) return 'cron-run';
  if (/^(?:agent:[^:]+:)?cron:[^:]+/i.test(sessionKey)) return 'cron';
  if (sessionKey.startsWith('managed:') || sessionKey.includes(':justdo:')) return 'managed';
  return 'other';
}

function sessionKeyFingerprint(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 12);
}

function normalizeDiagnosticRunId(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().replace(/\s+/g, '_');
  return normalized ? normalized.slice(0, 128) : 'unknown';
}

function normalizeDiagnosticStatus(value: unknown): string {
  return value === 'success' || value === 'error' || value === 'skipped' || value === 'running'
    ? value
    : 'unknown';
}

function historyHasMessages(history: unknown): boolean {
  if (!history || typeof history !== 'object') return false;
  const messages = Reflect.get(history, 'messages');
  return Array.isArray(messages) && messages.length > 0;
}

export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const { getCronJobService, getOpenClawRuntimeAdapter } = deps;

  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    try {
      // listJobs() waits for the Gateway when it is not connected yet. Returning
      // an empty successful result here creates a startup race: the one-shot
      // refresh event can fire before the renderer subscribes, leaving persisted
      // OpenClaw jobs hidden until another refresh happens.
      const tasks = await getCronJobService().listJobs();
      return { success: true, tasks };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tasks',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Get, async (_event, id: string) => {
    try {
      const task = await getCronJobService().getJob(id);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Create, async (_event, input: ScheduledTaskInput) => {
    try {
      const normalizedInput = { ...input };
      console.debug('[ScheduledTask] create input:', JSON.stringify(normalizedInput, null, 2));

      const task = await getCronJobService().addJob(normalizedInput);
      console.log('[IPC][scheduledTask:create] result task id:', task?.id, 'name:', task?.name);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Update, async (_event, id: string, input: Partial<ScheduledTaskInput>) => {
    try {
      const normalizedInput = { ...input };
      console.debug(
        '[ScheduledTask] update input id:',
        id,
        JSON.stringify(normalizedInput, null, 2),
      );

      const task = await getCronJobService().updateJob(id, normalizedInput);
      console.log('[IPC][scheduledTask:update] result task id:', task?.id, 'name:', task?.name);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Delete, async (_event, id: string) => {
    try {
      await getCronJobService().removeJob(id);
      return { success: true, result: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Toggle, async (_event, id: string, enabled: boolean) => {
    try {
      const task = await getCronJobService().toggleJob(id, enabled);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to toggle task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.RunManually, async (_event, id: string) => {
    try {
      await getCronJobService().runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListRuns,
    async (_event, taskId: string, limit?: number, offset?: number) => {
      try {
        const runs = await getCronJobService().listRuns(taskId, limit, offset);
        return { success: true, runs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list runs',
        };
      }
    },
  );

  ipcMain.handle(
    ScheduledTaskIpc.ResolveSession,
    async (_event, rawSessionKey: string, context?: ScheduledTaskSessionResolveContext) => {
      const sessionKey = typeof rawSessionKey === 'string' ? rawSessionKey.trim() : '';
      try {
        if (!sessionKey) return { success: true, history: null };
        // Fetch raw OpenClaw history so the renderer uses the canonical chat projection.
        const sessionId =
          typeof context?.sessionId === 'string' && context.sessionId.trim()
            ? context.sessionId.trim()
            : null;
        const history = await getOpenClawRuntimeAdapter()?.fetchSessionHistoryByKey(
          sessionKey,
          sessionId,
        );
        if (!historyHasMessages(history) && context?.reason === 'retry-exhausted') {
          console.warn('[ScheduledTask] Full result unavailable after retries', {
            runId: normalizeDiagnosticRunId(context.runId),
            status: normalizeDiagnosticStatus(context.status),
            sessionKind: sessionKeyKind(sessionKey),
            sessionFingerprint: sessionKeyFingerprint(sessionKey),
            hasSessionId: Boolean(sessionId),
          });
        }
        return { success: true, history: history ?? null };
      } catch (error) {
        if (context?.reason === 'retry-exhausted') {
          console.warn('[ScheduledTask] Full result lookup failed after retries', {
            runId: normalizeDiagnosticRunId(context.runId),
            status: normalizeDiagnosticStatus(context.status),
            sessionKind: sessionKeyKind(sessionKey),
            sessionFingerprint: sessionKeyFingerprint(sessionKey),
            hasSessionId: Boolean(context.sessionId),
            errorType: error instanceof Error ? error.name : 'unknown',
          });
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to resolve session',
        };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.ListChannels, async () => {
    try {
      return { success: true, channels: listScheduledTaskChannels() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list channels',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListResults,
    async (_event, rawQuery?: ScheduledTaskResultQuery) => {
      try {
        if (!deps.getResultStore) throw new Error('Result store is unavailable');
        const taskId =
          typeof rawQuery?.taskId === 'string' ? rawQuery.taskId.trim() : '';
        const cursor = typeof rawQuery?.cursor === 'string' ? rawQuery.cursor : '';
        const rawLimit =
          typeof rawQuery?.limit === 'number' && Number.isFinite(rawQuery.limit)
            ? rawQuery.limit
            : 30;
        const query: ScheduledTaskResultQuery = {
          ...(taskId ? { taskId } : {}),
          ...(rawQuery?.unreadOnly === true ? { unreadOnly: true } : {}),
          ...(cursor ? { cursor } : {}),
          limit: Math.min(100, Math.max(1, Math.floor(rawLimit))),
        };
        return { success: true, page: deps.getResultStore().listResults(query) };
      } catch {
        return { success: false, error: 'Failed to list scheduled task results' };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.MarkResultRead, async (_event, rawRunId: string) => {
    try {
      if (!deps.getResultStore) throw new Error('Result store is unavailable');
      const runId = typeof rawRunId === 'string' ? rawRunId.trim() : '';
      if (!runId) return { success: false, error: 'A non-empty run ID is required' };
      const store = deps.getResultStore();
      const result = store.markRead(runId);
      if (!result) return { success: false, error: 'Scheduled task result was not found' };
      const unreadCount = store.countUnread();
      deps.getResultSyncService?.().updateUnreadCount(unreadCount);
      return { success: true, result, unreadCount };
    } catch {
      return { success: false, error: 'Failed to mark scheduled task result read' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.MarkAllResultsRead, async (_event, rawTaskId?: string) => {
    try {
      if (!deps.getResultStore) throw new Error('Result store is unavailable');
      const taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() || undefined : undefined;
      const store = deps.getResultStore();
      store.markAllRead(Date.now(), taskId);
      const unreadCount = store.countUnread();
      deps.getResultSyncService?.().updateUnreadCount(unreadCount);
      return { success: true, unreadCount };
    } catch {
      return { success: false, error: 'Failed to mark scheduled task results read' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.DeleteResult, async (_event, rawRunId: string) => {
    try {
      const runId = typeof rawRunId === 'string' ? rawRunId.trim() : '';
      if (!runId) return { success: false, error: 'A non-empty run ID is required' };
      if (!deps.getResultStore) throw new Error('Result store is unavailable');
      if (!deps.getResultSyncService) throw new Error('Result sync is unavailable');
      const store = deps.getResultStore();
      const deleted = await deps
        .getResultSyncService()
        .deleteResult(runId, result => getCronJobService().deleteRunArtifacts(result));
      if (!deleted) {
        return { success: false, error: 'Scheduled task result was not found' };
      }
      const unreadCount = store.countUnread();
      deps.getResultSyncService?.().updateUnreadCount(unreadCount);
      return { success: true, unreadCount };
    } catch (error) {
      console.error(
        '[ScheduledTask] Failed to delete result and OpenClaw artifacts:',
        error instanceof Error ? error.message : String(error),
      );
      return { success: false, error: 'Failed to delete scheduled task result' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ReconcileResults, async () => {
    try {
      if (!deps.getResultSyncService) throw new Error('Result sync is unavailable');
      const jobs = await getCronJobService().listJobs();
      await deps.getResultSyncService().reconcile(jobs, true);
      return { success: true };
    } catch {
      return { success: false, error: 'Failed to refresh scheduled task results' };
    }
  });
}
