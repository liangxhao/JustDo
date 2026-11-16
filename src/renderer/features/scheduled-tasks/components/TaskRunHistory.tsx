import type { ScheduledTaskRun } from '@shared/scheduledTask/types';
import React, { useState } from 'react';
import { useSelector } from 'react-redux';

import {
  formatDateTime,
  formatDuration,
  getStatusLabelKey,
  isMemoryDreamingTask,
} from '@/features/scheduled-tasks/components/utils';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';
import { RootState } from '@/store';

import RunDetailsModal from './RunDetailsModal';
import RunSessionModal from './RunSessionModal';

interface TaskRunHistoryProps {
  taskId: string;
  taskName?: string;
  runs: ScheduledTaskRun[];
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
}

const statusIcons: Record<string, { icon: string; color: string }> = {
  success: { icon: '✓', color: 'text-green-500' },
  error: { icon: '✗', color: 'text-red-500' },
  skipped: { icon: '↷', color: 'text-yellow-500' },
  running: { icon: '●', color: 'text-blue-500' },
};

const TaskRunHistory: React.FC<TaskRunHistoryProps> = ({
  taskId,
  taskName,
  runs,
  loading,
  loadError,
  onRetry,
}) => {
  const task = useSelector((state: RootState) =>
    state.scheduledTask.tasks.find(candidate => candidate.id === taskId),
  );
  const runningAtMs = task?.state.runningAtMs ?? null;
  const showRunDetails = Boolean(task && isMemoryDreamingTask(task));
  const isRunning = runningAtMs !== null && Number.isFinite(runningAtMs);
  const hasMore = useSelector(
    (state: RootState) => state.scheduledTask.runsHasMore[taskId] ?? false,
  );
  const nextOffset = useSelector(
    (state: RootState) => state.scheduledTask.runsNextOffset[taskId] ?? null,
  );
  const [viewing, setViewing] = useState<{ run: ScheduledTaskRun; details: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await scheduledTaskService.loadRuns(taskId, 50, nextOffset ?? runs.length);
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('scheduledTasksLoadRunsFailed'),
        }),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <div className="divide-y divide-border/50">
        {isRunning && (
          <div className="flex items-center justify-between gap-3 py-2.5 px-1">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm font-bold text-blue-500" aria-hidden="true">
                {statusIcons.running.icon}
              </span>
              <time
                className="text-sm text-foreground"
                dateTime={new Date(runningAtMs).toISOString()}
              >
                {formatDateTime(new Date(runningAtMs))}
              </time>
            </div>
            <span className="shrink-0 text-xs text-blue-500">
              {i18nService.t('scheduledTasksStatusRunning')}
            </span>
          </div>
        )}
        {runs.map(run => {
          const statusInfo = statusIcons[run.status] || { icon: '?', color: '' };
          return (
            <div key={run.id} className="py-2.5 px-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`text-sm font-bold ${statusInfo.color}`}
                    role="img"
                    aria-label={i18nService.t(getStatusLabelKey(run.status))}
                  >
                    {statusInfo.icon}
                  </span>
                  <div className="min-w-0">
                    <span className="text-sm text-foreground">
                      {formatDateTime(new Date(run.startedAt))}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-2">
                  {run.durationMs !== null && (
                    <span className="text-xs text-secondary">{formatDuration(run.durationMs)}</span>
                  )}
                  {(showRunDetails || (run.status !== 'skipped' && run.sessionKey)) && (
                    <button
                      type="button"
                      onClick={() => setViewing({ run, details: showRunDetails })}
                      className="text-xs text-primary hover:text-primary-hover transition-colors"
                    >
                      {i18nService.t(
                        showRunDetails
                          ? 'scheduledTasksResultsRunDetails'
                          : 'scheduledTasksViewSession',
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {runs.length === 0 &&
        (loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-secondary">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
              aria-hidden="true"
            />
            {i18nService.t('loading')}
          </div>
        ) : loadError ? (
          <div className="py-6 text-center text-sm text-secondary" role="alert">
            <p>{i18nService.t('scheduledTasksLoadRunsFailed')}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 text-primary hover:text-primary-hover"
            >
              {i18nService.t('scheduledTasksRetry')}
            </button>
          </div>
        ) : !isRunning ? (
          <div className="text-center py-6 text-sm text-secondary">
            {i18nService.t('scheduledTasksNoRuns')}
          </div>
        ) : null)}
      {hasMore && (
        <button
          type="button"
          onClick={() => void handleLoadMore()}
          disabled={loadingMore}
          className="mt-2 w-full py-2 text-sm text-primary transition-colors hover:text-primary-hover disabled:cursor-wait disabled:opacity-60"
        >
          {i18nService.t(loadingMore ? 'loading' : 'scheduledTasksLoadMore')}
        </button>
      )}
      {viewing &&
        (viewing.details ? (
          <RunDetailsModal
            run={viewing.run}
            title={taskName ?? i18nService.t('scheduledTasksMemoryDreamingName')}
            memoryDreaming
            onClose={() => setViewing(null)}
          />
        ) : (
          <RunSessionModal run={viewing.run} title={taskName} onClose={() => setViewing(null)} />
        ))}
    </div>
  );
};

export default TaskRunHistory;
