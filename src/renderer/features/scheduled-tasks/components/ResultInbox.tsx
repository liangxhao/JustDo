import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { isMissingExternalChannelError } from '@shared/scheduledTask/deliveryError';
import type { ScheduledTaskResult } from '@shared/scheduledTask/types';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import RunSessionModal from '@/features/scheduled-tasks/components/RunSessionModal';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10} s`;
  return `${Math.round(durationMs / 6000) / 10} min`;
}

const statusClass: Record<ScheduledTaskResult['status'], string> = {
  success: 'bg-green-500/10 text-green-600 dark:text-green-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
  skipped: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  running: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
};

function localDateKey(value: string): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function groupResultsByDate(
  results: ScheduledTaskResult[],
): Array<{ dateKey: string; results: ScheduledTaskResult[] }> {
  const groups = new Map<string, ScheduledTaskResult[]>();
  for (const result of results) {
    const dateKey = localDateKey(result.startedAt);
    const group = groups.get(dateKey);
    if (group) group.push(result);
    else groups.set(dateKey, [result]);
  }
  return [...groups].map(([dateKey, groupedResults]) => ({
    dateKey,
    results: groupedResults,
  }));
}

function formatTimelineDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  yesterday.setDate(yesterday.getDate() - 1);
  const dayStart = date.getTime();
  const relative =
    dayStart === todayStart
      ? i18nService.t('scheduledTasksResultsToday')
      : dayStart === yesterday.getTime()
        ? i18nService.t('scheduledTasksResultsYesterday')
        : null;
  const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
  const formatted = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
  return relative ? `${relative} · ${formatted}` : formatted;
}

function formatResultTime(value: string): string {
  return new Intl.DateTimeFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function isDisabledResultError(result: ScheduledTaskResult): boolean {
  return result.status === 'skipped' && result.error?.trim().toLowerCase() === 'disabled';
}

const ResultInbox: React.FC = () => {
  const t = i18nService.t.bind(i18nService);
  const { results, resultsLoading, resultsNextCursor, unreadResultCount, resultFilter, tasks } =
    useSelector((state: RootState) => state.scheduledTask);
  const [viewingResult, setViewingResult] = useState<ScheduledTaskResult | null>(null);
  const [resultToDelete, setResultToDelete] = useState<ScheduledTaskResult | null>(null);
  const [selectingResults, setSelectingResults] = useState(false);
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set());
  const [collapsedDateKeys, setCollapsedDateKeys] = useState<Set<string>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deletingResult, setDeletingResult] = useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const resultGroups = groupResultsByDate(results);
  const selectableResultIds = results
    .filter(result => result.status !== 'running')
    .map(result => result.id);
  const allSelectableResultsSelected =
    selectableResultIds.length > 0 &&
    selectableResultIds.every(resultId => selectedResultIds.has(resultId));

  useEffect(() => {
    const visibleResultIds = new Set(results.map(result => result.id));
    setSelectedResultIds(current => {
      const retained = new Set([...current].filter(resultId => visibleResultIds.has(resultId)));
      if (retained.size === current.size) return current;
      return retained;
    });
  }, [results]);

  const openResult = (result: ScheduledTaskResult) => {
    void scheduledTaskService.markResultRead(result.id);
    if (result.status !== 'skipped' && result.sessionKey) setViewingResult(result);
  };

  const shouldShowDeliveryError = (result: ScheduledTaskResult): boolean => {
    if (!result.deliveryError) return false;
    // OpenClaw can retain this routing error on otherwise successful runs,
    // including runs created before in-app delivery became the default. It is
    // not actionable in the result inbox and must not depend on task-list
    // refresh timing or the task's current delivery configuration.
    return !isMissingExternalChannelError(result.deliveryError);
  };

  const confirmDeleteResult = async () => {
    if (!resultToDelete || deletingResult) return;
    setDeletingResult(true);
    const deleted = await scheduledTaskService.deleteResult(resultToDelete.id);
    setDeletingResult(false);
    if (deleted) closeDeleteDialog();
  };

  const confirmDeleteResults = async () => {
    if (selectedResultIds.size === 0 || deletingResult) return;
    setDeletingResult(true);
    const { failedIds } = await scheduledTaskService.deleteResults([...selectedResultIds]);
    setDeletingResult(false);
    setConfirmingBatchDelete(false);
    setSelectedResultIds(new Set(failedIds));
    if (failedIds.length === 0) setSelectingResults(false);
  };

  const closeDeleteDialog = () => {
    setResultToDelete(null);
    window.requestAnimationFrame(() => deleteTriggerRef.current?.focus());
  };

  const exitSelectionMode = () => {
    setSelectingResults(false);
    setSelectedResultIds(new Set());
  };

  const toggleResultSelection = (resultId: string) => {
    setSelectedResultIds(current => {
      const next = new Set(current);
      if (next.has(resultId)) next.delete(resultId);
      else next.add(resultId);
      return next;
    });
  };

  const toggleDateGroup = (dateKey: string) => {
    setCollapsedDateKeys(current => {
      const next = new Set(current);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-3">
        <span className="text-sm text-secondary">
          {t('scheduledTasksResultsUnread').replace('{count}', String(unreadResultCount))}
        </span>
        <label className="inline-flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            checked={resultFilter.unreadOnly}
            onChange={event =>
              void scheduledTaskService.setResultsFilter(resultFilter.taskId, event.target.checked)
            }
          />
          {t('scheduledTasksResultsUnreadOnly')}
        </label>
        <select
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          value={resultFilter.taskId ?? ''}
          onChange={event =>
            void scheduledTaskService.setResultsFilter(
              event.target.value || null,
              resultFilter.unreadOnly,
            )
          }
        >
          <option value="">{t('scheduledTasksResultsAllTasks')}</option>
          {tasks.map(task => (
            <option key={task.id} value={task.id}>
              {task.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {selectingResults ? (
            <>
              <label className="inline-flex h-9 items-center gap-2 px-1 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={allSelectableResultsSelected}
                  onChange={() =>
                    setSelectedResultIds(
                      allSelectableResultsSelected ? new Set() : new Set(selectableResultIds),
                    )
                  }
                />
                {t('scheduledTasksResultsSelectAll')}
              </label>
              <span className="inline-flex h-9 items-center text-sm text-secondary">
                {t('scheduledTasksResultsSelected').replace(
                  '{count}',
                  String(selectedResultIds.size),
                )}
              </span>
              <button
                type="button"
                disabled={selectedResultIds.size === 0}
                onClick={() => setConfirmingBatchDelete(true)}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-500/30 px-3 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
              >
                <TrashIcon className="h-4 w-4" />
                {t('delete')}
              </button>
              <button
                type="button"
                onClick={exitSelectionMode}
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-secondary hover:bg-surface-raised"
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSelectingResults(true)}
              disabled={selectableResultIds.length === 0}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
            >
              <TrashIcon className="h-4 w-4" />
              {t('scheduledTasksResultsBatchDelete')}
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void scheduledTaskService.markAllResultsRead(resultFilter.taskId ?? undefined)
            }
            disabled={unreadResultCount === 0}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            {t('scheduledTasksResultsMarkAllRead')}
          </button>
          <button
            type="button"
            onClick={() => void scheduledTaskService.refreshResults()}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-secondary hover:bg-surface-raised"
          >
            <ArrowPathIcon className="h-4 w-4" />
            {t('cronRefresh')}
          </button>
        </div>
      </div>

      {!resultsLoading && results.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-secondary">
          {t('scheduledTasksResultsEmpty')}
        </div>
      ) : (
        <div>
          {resultGroups.map(group => {
            const collapsed = collapsedDateKeys.has(group.dateKey);
            return (
              <section key={group.dateKey} className="relative pb-5 last:pb-0">
                <h2 className={collapsed ? 'relative' : 'relative mb-3'}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    aria-expanded={!collapsed}
                    aria-label={`${formatTimelineDate(group.dateKey)} · ${
                      collapsed ? t('expand') : t('collapse')
                    }`}
                    onClick={() => toggleDateGroup(group.dateKey)}
                  >
                    <span className="z-10 h-[15px] w-[15px] shrink-0 rounded-full border-[3px] border-background bg-primary shadow-sm" />
                    <span className="text-sm font-semibold text-foreground">
                      {formatTimelineDate(group.dateKey)}
                    </span>
                    <span className="text-xs text-secondary">
                      {t('scheduledTasksResultsDayCount').replace(
                        '{count}',
                        String(group.results.length),
                      )}
                    </span>
                    <ChevronDownIcon
                      className={`h-4 w-4 text-secondary transition-transform ${
                        collapsed ? '-rotate-90' : ''
                      }`}
                    />
                  </button>
                </h2>
                {!collapsed && (
                  <div className="ml-[7px] space-y-3 border-l border-border pl-5">
                    {group.results.map(result => (
                      <article
                        key={result.id}
                        className="relative rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm"
                      >
                        <span className="absolute -left-[25px] top-6 h-2 w-2 rounded-full border-2 border-background bg-border" />
                        <div className="flex items-start gap-3">
                          {selectingResults && (
                            <input
                              type="checkbox"
                              className="mt-1.5"
                              checked={selectedResultIds.has(result.id)}
                              disabled={result.status === 'running'}
                              aria-label={t('scheduledTasksResultsDelete')}
                              onChange={() => toggleResultSelection(result.id)}
                            />
                          )}
                          <span
                            className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                              result.readAt === null ? 'bg-primary' : 'bg-transparent'
                            }`}
                            aria-label={
                              result.readAt === null
                                ? t('scheduledTasksResultsUnreadLabel')
                                : undefined
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-2">
                              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                <h3 className="font-medium text-foreground">{result.taskName}</h3>
                                {!tasks.some(task => task.id === result.taskId) && (
                                  <span className="text-xs text-secondary">
                                    {t('scheduledTasksResultsDeletedTask')}
                                  </span>
                                )}
                                <span
                                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass[result.status]}`}
                                >
                                  {t(
                                    result.status === 'success'
                                      ? 'scheduledTasksStatusSuccess'
                                      : result.status === 'error'
                                        ? 'scheduledTasksStatusError'
                                        : result.status === 'skipped'
                                          ? 'scheduledTasksStatusSkipped'
                                          : 'scheduledTasksStatusRunning',
                                  )}
                                </span>
                                {isDisabledResultError(result) && (
                                  <span className="text-xs font-medium text-red-600 dark:text-red-400">
                                    {result.error}
                                  </span>
                                )}
                                <span className="text-xs text-secondary">
                                  {formatResultTime(result.startedAt)} ·{' '}
                                  {formatDuration(result.durationMs)}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                {result.status !== 'skipped' && result.sessionKey ? (
                                  <button
                                    type="button"
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-primary"
                                    aria-label={t('scheduledTasksResultsViewFull')}
                                    title={t('scheduledTasksResultsViewFull')}
                                    onClick={event => {
                                      event.stopPropagation();
                                      openResult(result);
                                    }}
                                  >
                                    <EyeIcon className="h-4 w-4" />
                                  </button>
                                ) : (
                                  <span
                                    className="inline-flex h-7 w-7 items-center justify-center text-secondary/50"
                                    aria-label={t('scheduledTasksResultsSessionUnavailable')}
                                    title={t('scheduledTasksResultsSessionUnavailable')}
                                  >
                                    <EyeSlashIcon className="h-4 w-4" />
                                  </span>
                                )}
                                {!selectingResults && result.status !== 'running' && (
                                  <button
                                    type="button"
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                                    aria-label={t('scheduledTasksResultsDelete')}
                                    title={t('scheduledTasksResultsDelete')}
                                    onClick={event => {
                                      deleteTriggerRef.current = event.currentTarget;
                                      setResultToDelete(result);
                                    }}
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </button>
                                )}
                              </div>
                            </div>
                            {result.summary && (
                              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-secondary">
                                {result.summary}
                              </p>
                            )}
                            {result.error && !isDisabledResultError(result) && (
                              <p className="mt-2 line-clamp-2 text-sm text-red-600 dark:text-red-400">
                                {result.error}
                              </p>
                            )}
                            {shouldShowDeliveryError(result) && (
                              <div className="mt-2 flex items-start gap-2 text-sm text-yellow-700 dark:text-yellow-400">
                                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                                <span>
                                  {t('scheduledTasksResultsDeliveryWarning')}:{' '}
                                  {result.deliveryError}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {resultsLoading && (
        <div className="py-4 text-center text-sm text-secondary">{t('loading')}</div>
      )}
      {resultsNextCursor && !resultsLoading && (
        <button
          type="button"
          onClick={() => void scheduledTaskService.loadResults(true)}
          className="w-full rounded-xl border border-border py-2.5 text-sm text-secondary hover:bg-surface-raised"
        >
          {t('scheduledTasksLoadMore')}
        </button>
      )}

      {viewingResult?.status !== 'skipped' && viewingResult?.sessionKey && (
        <RunSessionModal
          sessionKey={viewingResult.sessionKey}
          onClose={() => setViewingResult(null)}
        />
      )}

      {resultToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => !deletingResult && closeDeleteDialog()}
          onKeyDown={event => {
            if (event.key === 'Escape' && !deletingResult) closeDeleteDialog();
          }}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative mx-4 w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-2xl"
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="scheduled-result-delete-title"
            aria-describedby="scheduled-result-delete-description"
          >
            <h3
              id="scheduled-result-delete-title"
              className="mb-2 text-lg font-semibold text-foreground"
            >
              {t('scheduledTasksResultsDeleteTitle')}
            </h3>
            <p id="scheduled-result-delete-description" className="mb-6 text-sm text-secondary">
              {t('scheduledTasksResultsDeleteConfirm').replace('{name}', resultToDelete.taskName)}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                autoFocus
                disabled={deletingResult}
                onClick={closeDeleteDialog}
                className="rounded-xl px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={deletingResult}
                onClick={() => void confirmDeleteResult()}
                className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingBatchDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => !deletingResult && setConfirmingBatchDelete(false)}
          onKeyDown={event => {
            if (event.key === 'Escape' && !deletingResult) setConfirmingBatchDelete(false);
          }}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative mx-4 w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-2xl"
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="scheduled-results-batch-delete-title"
            aria-describedby="scheduled-results-batch-delete-description"
          >
            <h3
              id="scheduled-results-batch-delete-title"
              className="mb-2 text-lg font-semibold text-foreground"
            >
              {t('scheduledTasksResultsBatchDeleteTitle')}
            </h3>
            <p
              id="scheduled-results-batch-delete-description"
              className="mb-6 text-sm text-secondary"
            >
              {t('scheduledTasksResultsBatchDeleteConfirm').replace(
                '{count}',
                String(selectedResultIds.size),
              )}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                autoFocus
                disabled={deletingResult}
                onClick={() => setConfirmingBatchDelete(false)}
                className="rounded-xl px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                disabled={deletingResult}
                onClick={() => void confirmDeleteResults()}
                className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultInbox;
