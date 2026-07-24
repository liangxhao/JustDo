import type Database from 'better-sqlite3';
import { BrowserWindow } from 'electron';

import { IpcChannel } from '../../../shared/scheduledTask/constants';
import { ScheduledTaskResultStore } from '../../data/scheduledTaskResultStore';
import { CronJobService } from '../../scheduler/cronJobService';
import { OpenClawCronRunCleanupService } from '../../scheduler/openClawCronRunCleanupService';
import { ScheduledTaskResultSyncService } from '../../scheduler/scheduledTaskResultSyncService';

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

export interface CronJobServiceDeps {
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => GatewayClientLike | null;
    ensureReady: () => Promise<void>;
    hasActiveSessions?: () => boolean;
    clearSessionExecApprovalGrants?: (sessionKey: string) => void;
  } | null;
  getDatabase: () => Database.Database;
  getOpenClawStateDir: () => string;
}

let cronJobService: CronJobService | null = null;
let resultStore: ScheduledTaskResultStore | null = null;
let resultSyncService: ScheduledTaskResultSyncService | null = null;
let deps: CronJobServiceDeps | null = null;

export function initCronJobServiceManager(d: CronJobServiceDeps): void {
  deps = d;
}

export function getCronJobService(): CronJobService {
  if (!cronJobService) {
    if (!deps) {
      throw new Error(
        'CronJobServiceManager not initialized. Call initCronJobServiceManager() first.',
      );
    }
    const adapter = deps.getOpenClawRuntimeAdapter();
    if (!adapter) {
      throw new Error(
        'OpenClaw runtime adapter not initialized. CronJobService requires OpenClaw.',
      );
    }
    const emit = (channel: string, payload?: unknown) => {
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      });
    };
    resultStore = new ScheduledTaskResultStore(deps.getDatabase());
    const cleanupService = new OpenClawCronRunCleanupService({
      getGatewayClient: () => adapter.getGatewayClient(),
      ensureGatewayReady: () => adapter.ensureReady(),
      getStateDir: deps.getOpenClawStateDir,
      getDatabase: deps.getDatabase,
      clearSessionApprovalGrants: sessionKey =>
        adapter.clearSessionExecApprovalGrants?.(sessionKey),
    });
    let createdCronService: CronJobService;
    createdCronService = new CronJobService({
      getGatewayClient: () => adapter.getGatewayClient(),
      ensureGatewayReady: () => adapter.ensureReady(),
      isCoworkBusy: () => adapter.hasActiveSessions?.() ?? false,
      onJobsPolled: jobs => resultSyncService?.reconcile(jobs) ?? Promise.resolve(),
      deleteRunArtifacts: result => cleanupService.deleteResultArtifacts(result),
    });
    resultSyncService = new ScheduledTaskResultSyncService({
      cronJobService: createdCronService,
      resultStore,
      emitResultUpserted: (result, isNewUnread) => {
        emit(IpcChannel.ResultUpserted, { result, isNewUnread });
        emit(IpcChannel.RunUpdate, { run: { ...result, taskName: result.taskName } });
      },
      emitUnreadCountChanged: unreadCount => {
        emit(IpcChannel.UnreadCountChanged, { unreadCount });
      },
      emitResultsRefreshed: () => emit(IpcChannel.Refresh),
    });
    cronJobService = createdCronService;
  }
  return cronJobService;
}

export function getScheduledTaskResultStore(): ScheduledTaskResultStore {
  getCronJobService();
  if (!resultStore) throw new Error('Scheduled task result store is unavailable.');
  return resultStore;
}

export function getScheduledTaskResultSyncService(): ScheduledTaskResultSyncService {
  getCronJobService();
  if (!resultSyncService) throw new Error('Scheduled task result sync service is unavailable.');
  return resultSyncService;
}
