import type { ScheduledTaskRun } from '@shared/scheduledTask/types';
import React, { useState } from 'react';
import { useSelector } from 'react-redux';

import RunSessionModal from '@/features/scheduled-tasks/components/RunSessionModal';
import {
  formatDateTime,
  formatDuration,
  getStatusLabelKey,
} from '@/features/scheduled-tasks/components/utils';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';
import { RootState } from '@/store';

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
  const hasMore = useSelector(
    (state: RootState) => state.scheduledTask.runsHasMore[taskId] ?? false,
  );
  const nextOffset = useSelector(
    (state: RootState) => state.scheduledTask.runsNextOffset[taskId] ?? null,
  );
  const [viewingRun, setViewingRun] = useState<ScheduledTaskRun | null>(null);
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

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-secondary">
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          aria-hidden="true"
        />
        {i18nService.t('loading')}
      </div>
    );
  }

  if (runs.length === 0) {
    if (loadError) {
      return (
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
      );
    }
    return (
      <div className="text-center py-6 text-sm text-secondary">
        {i18nService.t('scheduledTasksNoRuns')}
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-border/50">
        {runs.map(run => {
          const statusInfo = statusIcons[run.status] || { icon: '?', color: '' };
          return (
            <div key={run.id} className="flex items-center justify-between py-2.5 px-1">
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
                {run.status === 'error' && run.error && (
                  <span className="text-xs text-red-500 max-w-[150px] truncate" title={run.error}>
                    {run.error}
                  </span>
                )}
                {run.status !== 'skipped' && run.sessionKey && (
                  <button
                    type="button"
                    onClick={() => setViewingRun(run)}
                    className="text-xs text-primary hover:text-primary-hover transition-colors"
                  >
                    {i18nService.t('scheduledTasksViewSession')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
      {viewingRun && (
        <RunSessionModal run={viewingRun} title={taskName} onClose={() => setViewingRun(null)} />
      )}
    </div>
  );
};

export default TaskRunHistory;
