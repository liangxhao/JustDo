import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  Cog6ToothIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { isMissingExternalChannelError } from '@shared/scheduledTask/deliveryError';
import {
  getHeartbeatSkippedReason,
  isRoutineScheduledTaskResult,
  isSilentScheduledTaskResult,
} from '@shared/scheduledTask/resultPresentation';
import type { ScheduledTask, ScheduledTaskResult } from '@shared/scheduledTask/types';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import RunSessionModal from '@/features/scheduled-tasks/components/RunSessionModal';
import {
  resolveVisibleResultTaskId,
  scheduledTaskService,
} from '@/features/scheduled-tasks/scheduledTaskService';
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

export function isResultTaskDeleted(
  result: Pick<ScheduledTaskResult, 'taskId' | 'systemManaged'>,
  tasks: Pick<ScheduledTask, 'id'>[],
): boolean {
  return result.systemManaged !== true && !tasks.some(task => task.id === result.taskId);
}

const ResultInbox: React.FC = () => {
  const t = i18nService.t.bind(i18nService);
  const {
    results,
    resultsLoading,
    resultsNextCursor,
    unreadResultCount,
    resultFilter,
    tasks,
    loading: tasksLoading,
    error,
  } = useSelector((state: RootState) => state.scheduledTask);
  const [viewingResult, setViewingResult] = useState<ScheduledTaskResult | null>(null);
  const [resultToDelete, setResultToDelete] = useState<ScheduledTaskResult | null>(null);
  const [selectingResults, setSelectingResults] = useState(false);
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set());
  const [collapsedDateKeys, setCollapsedDateKeys] = useState<Set<string>>(new Set());
  const [confirmingBatchDelete, setConfirmingBatchDelete] = useState(false);
  const [deletingResult, setDeletingResult] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const resultGroups = groupResultsByDate(results);
  const selectableResultIds = results
    .filter(result => result.status !== 'running')
    .map(result => result.id);
  const allSelectableResultsSelected =
    selectableResultIds.length > 0 &&
    selectableResultIds.every(resultId => selectedResultIds.has(resultId));
  const getResultTitle = (result: ScheduledTaskResult): string => {
    const currentTaskName = tasks.find(task => task.id === result.taskId)?.name.trim();
    if (currentTaskName) return currentTaskName;
    const storedTaskName = result.taskName.trim();
    if (storedTaskName && storedTaskName !== result.taskId) return storedTaskName;
    return t('scheduledTasksResultsDeletedTaskTitle');
  };

  useEffect(() => {
    const visibleResultIds = new Set(results.map(result => result.id));
    setSelectedResultIds(current => {
      const retained = new Set([...current].filter(resultId => visibleResultIds.has(resultId)));
      if (retained.size === current.size) return current;
      return retained;
    });
  }, [results]);

  useEffect(() => {
    if (tasksLoading || !resultFilter.taskId) return;
    const taskId = resolveVisibleResultTaskId(tasks, resultFilter.taskId);
    if (taskId === resultFilter.taskId) return;
    void scheduledTaskService.setResultsFilter(
      taskId,
      resultFilter.unreadOnly,
      resultFilter.includeRoutine,
      resultFilter.includeSystem,
    );
  }, [
    resultFilter.includeRoutine,
    resultFilter.includeSystem,
    resultFilter.taskId,
    resultFilter.unreadOnly,
    tasks,
    tasksLoading,
  ]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [settingsOpen]);

  const updateVisibilitySetting = (setting: 'includeSystem' | 'includeRoutine', value: boolean) => {
    const includeSystem = setting === 'includeSystem' ? value : resultFilter.includeSystem;
    const includeRoutine = setting === 'includeRoutine' ? value : resultFilter.includeRoutine;
    const selectedTask = tasks.find(task => task.id === resultFilter.taskId);
    const taskId =
      !includeSystem && selectedTask?.management === 'managed' ? null : resultFilter.taskId;
    void scheduledTaskService.setResultsFilter(
      taskId,
      resultFilter.unreadOnly,
      includeRoutine,
      includeSystem,
    );
  };

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
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('scheduledTasksInboxTitle')}</h1>
          <p className="mt-1 text-sm text-secondary">{t('scheduledTasksInboxDescription')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void scheduledTaskService.markAllResultsRead()}
            disabled={unreadResultCount === 0}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-sm text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            <CheckIcon className="h-4 w-4" />
            {t('scheduledTasksResultsMarkAllRead')}
          </button>
          <button
            type="button"
            onClick={() => void scheduledTaskService.refreshResults()}
            disabled={resultsLoading}
            aria-label={t('cronRefresh')}
            title={t('cronRefresh')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-4 w-4 ${resultsLoading ? 'animate-spin' : ''}`} />
          </button>
          <div ref={settingsRef} className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen(open => !open)}
              aria-label={t('scheduledTasksResultsDisplaySettings')}
              title={t('scheduledTasksResultsDisplaySettings')}
              aria-expanded={settingsOpen}
              className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border transition-colors ${
                settingsOpen
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
            >
              <Cog6ToothIcon className="h-4 w-4" />
            </button>
            {settingsOpen && (
              <div
                role="dialog"
                aria-label={t('scheduledTasksResultsDisplaySettings')}
                className="absolute right-0 top-11 z-30 w-72 rounded-2xl border border-border bg-background p-4 shadow-xl"
              >
                <h2 className="text-sm font-semibold text-foreground">
                  {t('scheduledTasksResultsDisplaySettings')}
                </h2>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {t('scheduledTasksResultsDisplaySettingsDescription')}
                </p>
                <div className="mt-3 divide-y divide-border-subtle">
                  <label className="flex cursor-pointer items-start justify-between gap-4 py-3 first:pt-1">
                    <span>
                      <span className="block text-sm text-foreground">
                        {t('scheduledTasksResultsShowSystem')}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-secondary">
                        {t('scheduledTasksResultsShowSystemDescription')}
                      </span>
                    </span>
                    <span className="relative mt-1 inline-flex h-5 w-9 shrink-0">
                      <input
                        type="checkbox"
                        role="switch"
                        className="peer sr-only"
                        checked={resultFilter.includeSystem}
                        onChange={event =>
                          updateVisibilitySetting('includeSystem', event.target.checked)
                        }
                      />
                      <span className="absolute inset-0 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:ring-offset-2" />
                      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start justify-between gap-4 py-3 last:pb-1">
                    <span>
                      <span className="block text-sm text-foreground">
                        {t('scheduledTasksResultsShowRoutine')}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-secondary">
                        {t('scheduledTasksResultsShowRoutineDescription')}
                      </span>
                    </span>
                    <span className="relative mt-1 inline-flex h-5 w-9 shrink-0">
                      <input
                        type="checkbox"
                        role="switch"
                        className="peer sr-only"
                        checked={resultFilter.includeRoutine}
                        onChange={event =>
                          updateVisibilitySetting('includeRoutine', event.target.checked)
                        }
                      />
                      <span className="absolute inset-0 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 peer-focus-visible:ring-offset-2" />
                      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
                    </span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          className="flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
          role="alert"
        >
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle pb-4">
        <div className="flex rounded-xl bg-surface-raised p-1">
          {([false, true] as const).map(unreadOnly => (
            <button
              key={String(unreadOnly)}
              type="button"
              onClick={() =>
                void scheduledTaskService.setResultsFilter(
                  resultFilter.taskId,
                  unreadOnly,
                  resultFilter.includeRoutine,
                  resultFilter.includeSystem,
                )
              }
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
                resultFilter.unreadOnly === unreadOnly
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {t(unreadOnly ? 'scheduledTasksResultsUnreadOnly' : 'scheduledTasksResultsAll')}
              {unreadOnly && !resultFilter.taskId && unreadResultCount > 0 && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 tabular-nums text-primary">
                  {unreadResultCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <select
          className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
          value={resultFilter.taskId ?? ''}
          onChange={event =>
            void scheduledTaskService.setResultsFilter(
              event.target.value || null,
              resultFilter.unreadOnly,
              resultFilter.includeRoutine,
              resultFilter.includeSystem,
            )
          }
        >
          <option value="">{t('scheduledTasksResultsAllTasks')}</option>
          {tasks
            .filter(task => resultFilter.includeSystem || task.management !== 'managed')
            .map(task => (
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
        </div>
      </div>

      {!resultsLoading && results.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center text-sm text-secondary">
          {t(
            resultFilter.unreadOnly
              ? 'scheduledTasksResultsUnreadEmpty'
              : 'scheduledTasksResultsEmpty',
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
          {resultGroups.map(group => {
            const collapsed = collapsedDateKeys.has(group.dateKey);
            return (
              <section
                key={group.dateKey}
                className="border-b border-border-subtle last:border-b-0"
              >
                <h2>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 bg-surface-raised/60 px-4 py-2.5 text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                    aria-expanded={!collapsed}
                    aria-label={`${formatTimelineDate(group.dateKey)} · ${
                      collapsed ? t('expand') : t('collapse')
                    }`}
                    onClick={() => toggleDateGroup(group.dateKey)}
                  >
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
                  <div className="divide-y divide-border-subtle">
                    {group.results.map(result => (
                      <article
                        key={result.id}
                        className={`relative px-4 py-4 transition-colors ${
                          result.status !== 'skipped' && result.sessionKey
                            ? 'cursor-pointer hover:bg-surface-raised/60'
                            : ''
                        } ${
                          result.readAt === null &&
                          result.systemManaged !== true &&
                          !isRoutineScheduledTaskResult(result)
                            ? 'bg-primary/[0.025]'
                            : ''
                        }`}
                        onClick={() => {
                          if (
                            !selectingResults &&
                            result.status !== 'skipped' &&
                            result.sessionKey
                          ) {
                            openResult(result);
                          }
                        }}
                      >
                        <div className="flex items-start gap-3">
                          {selectingResults && (
                            <input
                              type="checkbox"
                              className="mt-1.5"
                              checked={selectedResultIds.has(result.id)}
                              disabled={result.status === 'running'}
                              aria-label={t('scheduledTasksResultsSelectResult').replace(
                                '{name}',
                                getResultTitle(result),
                              )}
                              onChange={() => toggleResultSelection(result.id)}
                            />
                          )}
                          <span
                            className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                              result.readAt === null &&
                              result.systemManaged !== true &&
                              !isRoutineScheduledTaskResult(result)
                                ? 'bg-primary'
                                : 'bg-transparent'
                            }`}
                            aria-label={
                              result.readAt === null &&
                              result.systemManaged !== true &&
                              !isRoutineScheduledTaskResult(result)
                                ? t('scheduledTasksResultsUnreadLabel')
                                : undefined
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-2">
                              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                <h3 className="font-medium text-foreground">
                                  {getResultTitle(result)}
                                </h3>
                                {isResultTaskDeleted(result, tasks) && (
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
                                {result.systemManaged === true && (
                                  <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-400">
                                    {t('scheduledTasksResultsSystem')}
                                  </span>
                                )}
                                {isRoutineScheduledTaskResult(result) && (
                                  <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-secondary">
                                    {t('scheduledTasksResultsRoutine')}
                                  </span>
                                )}
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
                                      event.stopPropagation();
                                      deleteTriggerRef.current = event.currentTarget;
                                      setResultToDelete(result);
                                    }}
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </button>
                                )}
                              </div>
                            </div>
                            {result.status === 'success' &&
                            isSilentScheduledTaskResult(result.summary) ? (
                              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-secondary">
                                {t('scheduledTasksResultsSilent')}
                              </p>
                            ) : result.summary ? (
                              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-secondary">
                                {result.summary}
                              </p>
                            ) : null}
                            {result.systemManaged === true &&
                            getHeartbeatSkippedReason(result.error) ? (
                              <p className="mt-2 line-clamp-2 text-sm text-secondary">
                                {t(
                                  getHeartbeatSkippedReason(result.error) === 'no-route'
                                    ? 'scheduledTasksResultsHeartbeatNoRoute'
                                    : 'scheduledTasksResultsHeartbeatSkipped',
                                )}
                              </p>
                            ) : (
                              result.error &&
                              !isDisabledResultError(result) && (
                                <p className="mt-2 line-clamp-2 text-sm text-red-600 dark:text-red-400">
                                  {result.error}
                                </p>
                              )
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
          run={viewingResult}
          title={getResultTitle(viewingResult)}
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
                className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deletingResult && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
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
                className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deletingResult && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
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
