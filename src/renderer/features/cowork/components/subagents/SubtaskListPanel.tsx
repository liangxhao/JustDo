import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import { useDraggableModal } from '../shared/useDraggableModal';
import { reconcileSubagentLabel, type SubagentLabelSource } from './subagentLabel';
import { resolveSubagentPollInterval } from './subagentPolling';
import SubagentTokenUsage from './SubagentTokenUsage';
import SubtaskChildren from './SubtaskChildren';
import SubtaskControls from './SubtaskControls';
import SubtaskGroups from './SubtaskGroups';
import {
  isActiveSubtask,
  mergeSubtaskSnapshots,
  partitionSubtasks,
  resolveExternalAgentLabel,
  resolveSubtaskElapsedMs,
  resolveSubtaskExecutionKey,
  type Subtask,
  SUBTASK_DELIVERY_I18N_KEYS,
  SUBTASK_STATUS_I18N_KEYS,
  subtaskStatusStyles,
} from './subtaskPresentation';

interface SubtaskListPanelProps {
  sessionId: string;
  panelId?: string;
  isOpen: boolean;
  parentRunning?: boolean;
  anchorRef?: React.RefObject<HTMLElement>;
  onClose: (restoreFocus?: boolean) => void;
  onOpenSubtask?: (subtask: Subtask) => void;
  onSubtasksChange?: (subtasks: Subtask[]) => void;
}

const formatDuration = (value?: number): string => {
  if (value === undefined) return i18nService.t('subtaskInfoUnavailable');
  const seconds = Math.max(0, Math.round(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`]
    .filter(Boolean)
    .join(' ');
};

const SubtaskListPanel: React.FC<SubtaskListPanelProps> = ({
  sessionId,
  panelId = 'cowork-subtask-list',
  isOpen,
  parentRunning = false,
  anchorRef,
  onClose,
  onOpenSubtask,
  onSubtasksChange,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [finishedExpanded, setFinishedExpanded] = useState(true);
  const [finishedLimit, setFinishedLimit] = useState(50);
  const [detailAncestors, setDetailAncestors] = useState<Subtask[]>([]);
  const detailAncestorsRef = useRef(detailAncestors);
  detailAncestorsRef.current = detailAncestors;
  const [detailSubtask, setDetailSubtask] = useState<Subtask | null>(null);
  const [detailStats, setDetailStats] = useState<SessionDetailStats>();
  const [isDetailStatsLoading, setIsDetailStatsLoading] = useState(false);
  const [detailStatsFailed, setDetailStatsFailed] = useState(false);
  const [detailUsageUnavailable, setDetailUsageUnavailable] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const panelRef = useRef<HTMLElement>(null);
  const detailDialogRef = useRef<HTMLDivElement>(null);
  const detailCloseButtonRef = useRef<HTMLButtonElement>(null);
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const subtaskLabelsRef = useRef(
    new Map<string, { label: string; labelSource: SubagentLabelSource }>(),
  );
  const refreshInFlightRef = useRef<{ sessionId: string; generation: number } | null>(null);
  const refreshPendingRef = useRef(false);
  const refreshRef = useRef<(force?: boolean) => void>(() => undefined);
  const refreshGenerationRef = useRef(0);
  const lifecycleRequestSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const detailStatsSessionKeyRef = useRef<string>();
  const detailStatsRef = useRef<SessionDetailStats>();
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const {
    dialogStyle: detailDialogStyle,
    dragHandleProps: detailDragHandleProps,
    isDragging: isDetailDragging,
  } = useDraggableModal(detailDialogRef, detailSubtask?.sessionKey);
  const detailSessionKey = detailSubtask?.sessionKey;
  const statusPollInterval = resolveSubagentPollInterval(
    parentRunning,
    subtasks.map(subtask => subtask.status),
  );

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      onClose(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || detailSubtask) return;
      event.preventDefault();
      onClose(true);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorRef, detailSubtask, isOpen, onClose]);
  const { active, finished } = useMemo(() => partitionSubtasks(subtasks), [subtasks]);

  const closeDetails = useCallback(() => setDetailSubtask(null), []);

  const refresh = useCallback(
    async (force = false) => {
      if (refreshInFlightRef.current?.sessionId === sessionId) {
        if (force) {
          refreshPendingRef.current = true;
          // The in-flight response predates the event that requested a forced
          // refresh. Let it settle only to start the queued authoritative read;
          // it must not close the current detail dialog or replace the list.
          refreshGenerationRef.current += 1;
        }
        return;
      }
      refreshPendingRef.current = false;
      const refreshToken = { sessionId, generation: ++refreshGenerationRef.current };
      const lifecycleRequestSequence = ++lifecycleRequestSequenceRef.current;
      refreshInFlightRef.current = refreshToken;
      setIsLoading(true);
      try {
        const result = force
          ? await window.electron.cowork.getSubTaskStatus(sessionId, true)
          : await window.electron.cowork.getSubTaskStatus(sessionId);
        if (
          result.success &&
          mountedRef.current &&
          sessionIdRef.current === sessionId &&
          refreshInFlightRef.current === refreshToken &&
          refreshGenerationRef.current === refreshToken.generation
        ) {
          const nextSubtasks = (result.subagents as Subtask[] | undefined) ?? [];
          const normalizedSubtasks = nextSubtasks.map(subtask => {
            const resolved = reconcileSubagentLabel(subtaskLabelsRef.current.get(subtask.id), {
              label: subtask.label,
              labelSource: subtask.labelSource,
            });
            return { ...subtask, ...resolved, lifecycleRequestSequence };
          });
          subtaskLabelsRef.current = new Map(
            normalizedSubtasks.map(subtask => [
              subtask.id,
              { label: subtask.label, labelSource: subtask.labelSource },
            ]),
          );
          setSubtasks(normalizedSubtasks);
          setDetailSubtask(current =>
            current
              ? (() => {
                  const latest = normalizedSubtasks.find(subtask => subtask.id === current.id);
                  return latest
                    ? mergeSubtaskSnapshots(current, latest, { preserveCurrentTask: true })
                    : normalizedSubtasks.some(
                          subtask => subtask.id === detailAncestorsRef.current[0]?.id,
                        )
                      ? current
                      : null;
                })()
              : null,
          );
          onSubtasksChange?.(normalizedSubtasks);
          setHasLoaded(true);
          setHasLoadError(false);
        } else if (
          !result.success &&
          mountedRef.current &&
          refreshInFlightRef.current === refreshToken &&
          refreshGenerationRef.current === refreshToken.generation
        ) {
          setHasLoadError(true);
        }
      } catch {
        if (
          mountedRef.current &&
          refreshInFlightRef.current === refreshToken &&
          refreshGenerationRef.current === refreshToken.generation
        ) {
          setHasLoadError(true);
        }
      } finally {
        if (refreshInFlightRef.current === refreshToken) {
          refreshInFlightRef.current = null;
          if (mountedRef.current && sessionIdRef.current === sessionId) setIsLoading(false);
          if (
            mountedRef.current &&
            refreshPendingRef.current &&
            sessionIdRef.current === sessionId
          ) {
            refreshPendingRef.current = false;
            queueMicrotask(() => {
              if (mountedRef.current && sessionIdRef.current === sessionId)
                refreshRef.current(true);
            });
          }
        }
      }
    },
    [onSubtasksChange, sessionId],
  );
  refreshRef.current = force => void refresh(force);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshPendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    setHasLoaded(false);
    subtaskLabelsRef.current = new Map();
    setSubtasks([]);
    setDetailSubtask(null);
    setFinishedExpanded(true);
    setFinishedLimit(50);
    setDetailAncestors([]);
    setHasLoadError(false);
    refreshPendingRef.current = false;
    onSubtasksChange?.([]);
  }, [onSubtasksChange, sessionId]);

  useEffect(() => {
    void refresh();
    const handleVisibilityChange = () => {
      if (!document.hidden) void refresh(true);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), statusPollInterval);
    return () => window.clearInterval(timer);
  }, [refresh, statusPollInterval]);

  useEffect(() => {
    const subscribe = window.electron.cowork.onSubtasksChanged;
    if (!subscribe) return;
    return subscribe(event => {
      if (!event.sessionId || event.sessionId === sessionId) void refresh(true);
    });
  }, [refresh, sessionId]);

  useEffect(() => {
    if (!isOpen || active.length === 0) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active.length, isOpen]);

  useEffect(() => {
    const sessionKey = detailSubtask?.sessionKey;
    const taskId = detailSubtask?.id;
    if (!sessionKey) {
      detailStatsSessionKeyRef.current = undefined;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(false);
      setDetailStatsFailed(false);
      setDetailUsageUnavailable(false);
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    let retryTimer: number | undefined;
    const detailIdentity = `${taskId ?? ''}:${sessionKey}`;
    const isNewTask = detailStatsSessionKeyRef.current !== detailIdentity;
    detailStatsSessionKeyRef.current = detailIdentity;
    if (isNewTask) {
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(true);
      setDetailStatsFailed(false);
      setDetailUsageUnavailable(false);
    }
    const isActive = isActiveSubtask(detailSubtask.status);
    const refreshDetails = async (attempt = 0): Promise<void> => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const lifecycleRequestSequence = ++lifecycleRequestSequenceRef.current;
      let succeeded = false;
      try {
        const result = await window.electron.cowork.getSubTaskDetails(sessionKey, taskId);
        if (!cancelled && result.success) {
          succeeded = true;
          if (result.stats) {
            detailStatsRef.current = result.stats;
            setDetailStats(result.stats);
          }
          setDetailUsageUnavailable(!result.stats);
          setDetailStatsFailed(false);
          if (result.subagent) {
            setDetailSubtask(current => {
              if (!current || current.id !== result.subagent?.id) return current;
              return mergeSubtaskSnapshots(current, {
                ...result.subagent,
                lifecycleRequestSequence,
                ...reconcileSubagentLabel(
                  { label: current.label, labelSource: current.labelSource },
                  {
                    label: result.subagent.label,
                    labelSource: result.subagent.labelSource,
                  },
                ),
              });
            });
          }
        }
      } catch {
        // Preserve the last complete lifetime total until the next refresh.
      } finally {
        refreshInFlight = false;
        const willRetry = !succeeded && !isActive && attempt < 2;
        if (!cancelled && !willRetry) {
          setIsDetailStatsLoading(false);
          if (!succeeded) setDetailStatsFailed(true);
        }
      }
      if (!cancelled && !succeeded && !isActive && attempt < 2) {
        retryTimer = window.setTimeout(() => void refreshDetails(attempt + 1), 1_000);
      }
    };
    void refreshDetails();
    const timer = isActive ? window.setInterval(() => void refreshDetails(), 5_000) : undefined;
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [detailReloadKey, detailSubtask?.id, detailSubtask?.sessionKey, detailSubtask?.status]);

  useEffect(() => {
    if (!detailSessionKey) return;
    detailCloseButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDetails();
        return;
      }
      if (event.key !== 'Tab' || !detailDialogRef.current) return;
      const focusableElements = Array.from(
        detailDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(element => !element.hasAttribute('hidden'));
      if (!focusableElements.length) {
        event.preventDefault();
        detailDialogRef.current.focus();
        return;
      }
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === firstElement || !detailDialogRef.current.contains(activeElement))
      ) {
        event.preventDefault();
        lastElement.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === lastElement || !detailDialogRef.current.contains(activeElement))
      ) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const returnFocusTarget = detailReturnFocusRef.current;
      requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
      });
    };
  }, [closeDetails, detailSessionKey]);

  const copySessionId = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: { message: i18nService.t('copySessionIdSuccess'), tone: 'success' },
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: { message: i18nService.t('copySessionIdFailed'), tone: 'error' },
        }),
      );
    }
  };

  const detailRows: Array<[string, React.ReactNode, boolean?]> = detailSubtask
    ? [
        [
          i18nService.t('subtaskInfoStatus'),
          i18nService.t(SUBTASK_STATUS_I18N_KEYS[detailSubtask.status]),
        ],
        ...(detailSubtask.execution
          ? [
              [
                i18nService.t('subtaskInfoExecution'),
                i18nService.t(resolveSubtaskExecutionKey(detailSubtask, true)),
              ] as [string, React.ReactNode],
            ]
          : []),
        ...(detailSubtask.deliveryStatus
          ? [
              [
                i18nService.t('subtaskInfoDelivery'),
                i18nService.t(SUBTASK_DELIVERY_I18N_KEYS[detailSubtask.deliveryStatus]),
              ] as [string, React.ReactNode],
            ]
          : []),
        ...(
          [
            ['subtaskInfoProgress', detailSubtask.progressSummary],
            ['subtaskInfoSwarmGroup', detailSubtask.swarmGroupId],
            ['subtaskInfoResult', detailSubtask.terminalSummary],
            ['subtaskInfoError', detailSubtask.error],
            ['subtaskInfoActivity', detailSubtask.lastActivity],
            [
              detailSubtask.execution?.currentTool ? 'subtaskInfoTool' : 'subtaskInfoLastTool',
              detailSubtask.execution?.currentTool?.name ?? detailSubtask.lastToolName,
            ],
            [
              'subtaskInfoDiff',
              detailSubtask.diffStat
                ? i18nService
                    .t('subtaskInfoDiffValue')
                    .replace('{files}', String(detailSubtask.diffStat.files))
                    .replace('{added}', String(detailSubtask.diffStat.added))
                    .replace('{removed}', String(detailSubtask.diffStat.removed))
                : undefined,
            ],
          ] as Array<[string, string | undefined]>
        )
          .filter(([, value]) => value)
          .map(([key, value]): [string, React.ReactNode] => [i18nService.t(key), value]),
        [i18nService.t('subtaskInfoAgentId'), detailSubtask.agentId],
        [i18nService.t('subtaskInfoTask'), detailSubtask.task],
        [i18nService.t('subtaskInfoModel'), detailSubtask.model],
        [
          i18nService.t('subtaskInfoRequestedModels'),
          detailStats?.models.length ? detailStats.models.join('\n') : undefined,
        ],
        [
          i18nService.t('subtaskInfoDuration'),
          formatDuration(resolveSubtaskElapsedMs(detailSubtask, clock)),
        ],
        [
          i18nService.t('subtaskInfoStarted'),
          detailSubtask.startedAt
            ? new Date(detailSubtask.startedAt).toLocaleString()
            : i18nService.t('subtaskInfoUnavailable'),
        ],
        [
          i18nService.t('subtaskInfoEnded'),
          detailSubtask.endedAt
            ? new Date(detailSubtask.endedAt).toLocaleString()
            : i18nService.t('subtaskInfoUnavailable'),
        ],
        [
          i18nService.t('subtaskInfoTokens'),
          <div key="token-usage" className="space-y-2">
            <SubagentTokenUsage stats={detailStats} isLoading={isDetailStatsLoading} />
            {detailUsageUnavailable && (
              <div className="text-xs text-secondary" role="status">
                <p>
                  {i18nService.t(detailStats ? 'subtaskUsageStale' : 'subtaskUsageUnavailable')}
                </p>
                <button
                  type="button"
                  disabled={isDetailStatsLoading}
                  className="mt-1 text-primary hover:underline disabled:opacity-50"
                  onClick={() => {
                    setIsDetailStatsLoading(true);
                    setDetailReloadKey(value => value + 1);
                  }}
                >
                  {i18nService.t('subtaskUsageRetry')}
                </button>
              </div>
            )}
          </div>,
        ],
        [i18nService.t('subtaskInfoSession'), detailSubtask.sessionKey],
        [i18nService.t('subtaskInfoSessionId'), detailSubtask.sessionId, true],
      ]
    : [];

  const renderSubtask = (subtask: Subtask) => {
    const externalAgentLabel = resolveExternalAgentLabel(subtask);
    return (
      <div
        key={subtask.id}
        role="listitem"
        className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-surface focus-within:bg-surface"
      >
        {subtask.status === 'done' ? (
          <CheckCircleIcon
            className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        ) : (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${subtaskStatusStyles[subtask.status]}`}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:text-primary"
          onClick={() => onOpenSubtask?.(subtask)}
          title={subtask.label}
        >
          {subtask.label}
        </button>
        {externalAgentLabel && (
          <span
            className="shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-300"
            title={externalAgentLabel}
          >
            {externalAgentLabel}
          </span>
        )}
        <span className="shrink-0 text-xs text-secondary">
          <span className={subtask.status === 'done' && !subtask.execution ? 'sr-only' : undefined}>
            {i18nService.t(resolveSubtaskExecutionKey(subtask))}
          </span>
          {(subtask.deliveryStatus === 'failed' || subtask.deliveryStatus === 'parent_missing') && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-300">
              {i18nService.t(SUBTASK_DELIVERY_I18N_KEYS[subtask.deliveryStatus])}
            </span>
          )}
        </span>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-70 transition-colors hover:bg-surface hover:text-foreground group-hover:opacity-100"
          onClick={event => {
            detailReturnFocusRef.current = event.currentTarget;
            setDetailAncestors([]);
            setDetailSubtask(subtask);
          }}
          aria-label={i18nService.t('subtaskShowInfo')}
          title={i18nService.t('subtaskShowInfo')}
        >
          <InformationCircleIcon className="h-4 w-4" />
        </button>
      </div>
    );
  };

  return (
    <>
      {isOpen && (
        <aside
          ref={panelRef}
          id={panelId}
          className="absolute right-0 top-full z-[90] mt-2 flex max-h-[min(32rem,calc(100vh-4.5rem))] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-popover backdrop-blur-xl"
          aria-label={i18nService.t('subtasks')}
        >
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {i18nService.t('subtasks')}
              </h2>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={isLoading}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                aria-label={i18nService.t('subtaskRefresh')}
                title={i18nService.t('subtaskRefresh')}
              >
                <ArrowPathIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => onClose(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                aria-label={i18nService.t('subtaskHide')}
                title={i18nService.t('subtaskHide')}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {hasLoadError && (
            <div
              className="border-b border-border bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400"
              role="alert"
            >
              {i18nService.t('subtaskLoadFailed')}
            </div>
          )}

          {!hasLoaded && isLoading ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-secondary">
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
              {i18nService.t('loading')}
            </div>
          ) : subtasks.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center px-6 py-6 text-center">
              <svg
                viewBox="0 0 24 24"
                className="mb-3 h-8 w-8 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 6h11M9 12h11M9 18h11" />
                <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
              </svg>
              <p className="text-sm font-medium text-foreground">{i18nService.t('subtasks')}</p>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('subtaskEmpty')}
              </p>
            </div>
          ) : (
            <div className="min-h-0 overflow-y-auto pb-1">
              {active.length > 0 && (
                <section className="pt-3">
                  <h3 className="shrink-0 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    {i18nService.t('subtaskActive').replace('{count}', String(active.length))}
                  </h3>
                  <div className="space-y-1 px-2 pb-2" role="list">
                    <SubtaskGroups tasks={active} renderTask={renderSubtask} />
                  </div>
                </section>
              )}
              {finished.length > 0 && (
                <section className={`pt-3 ${active.length > 0 ? 'border-t border-border/60' : ''}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 pb-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted hover:text-secondary"
                    onClick={() => setFinishedExpanded(value => !value)}
                    aria-expanded={finishedExpanded}
                  >
                    <span>
                      {i18nService.t('subtaskFinished').replace('{count}', String(finished.length))}
                    </span>
                    {finishedExpanded ? (
                      <ChevronDownIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRightIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {finishedExpanded && (
                    <div className="space-y-1 px-2 pb-2" role="list">
                      <SubtaskGroups
                        tasks={finished.slice(0, finishedLimit)}
                        renderTask={renderSubtask}
                      />
                      {finished.length > finishedLimit && (
                        <button
                          type="button"
                          className="w-full rounded-md py-2 text-xs text-primary hover:bg-surface-raised"
                          onClick={() => setFinishedLimit(value => value + 50)}
                        >
                          {i18nService.t('subtaskLoadMore')}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </aside>
      )}

      <Modal
        isOpen={detailSubtask !== null}
        onClose={closeDetails}
        className="max-h-[80vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
        style={detailDialogStyle}
      >
        {detailSubtask && (
          <div
            ref={detailDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subtask-details-title"
            tabIndex={-1}
          >
            <div
              {...detailDragHandleProps}
              className={`flex cursor-move select-none items-center justify-between border-b border-border px-5 py-4 ${
                isDetailDragging ? 'cursor-grabbing' : ''
              }`}
            >
              <h2
                id="subtask-details-title"
                className="min-w-0 truncate text-base font-semibold text-foreground"
              >
                {detailSubtask.label}
              </h2>
              <button
                ref={detailCloseButtonRef}
                type="button"
                onClick={closeDetails}
                className="ml-4 rounded-lg px-2 py-1 text-secondary hover:bg-surface-raised"
                aria-label={i18nService.t('close')}
              >
                ×
              </button>
            </div>
            {detailStatsFailed && (
              <div
                className="border-b border-amber-500/30 bg-amber-500/5 px-5 py-2 text-xs text-amber-700 dark:text-amber-300"
                role="status"
              >
                <span>{i18nService.t('subtaskDetailsRefreshFailed')}</span>{' '}
                <button
                  type="button"
                  onClick={() => {
                    setIsDetailStatsLoading(true);
                    setDetailReloadKey(value => value + 1);
                  }}
                  disabled={isDetailStatsLoading}
                  className="font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
                >
                  {i18nService.t('sessionDetailsRetry')}
                </button>
              </div>
            )}
            <div className="max-h-[calc(80vh-4rem)] overflow-y-auto">
              {onOpenSubtask && (
                <button
                  type="button"
                  className="mx-5 mt-3 text-xs text-primary"
                  onClick={() => {
                    closeDetails();
                    onOpenSubtask(detailSubtask);
                  }}
                >
                  {i18nService.t('subtaskOpenHistory')}
                </button>
              )}
              {detailAncestors.length > 0 && (
                <button
                  type="button"
                  className="mx-5 mt-3 text-xs text-primary"
                  onClick={() => {
                    setDetailSubtask(detailAncestors[detailAncestors.length - 1]);
                    setDetailAncestors(current => current.slice(0, -1));
                  }}
                >
                  {i18nService.t('subtaskParent')}:{' '}
                  {detailAncestors[detailAncestors.length - 1].label}
                </button>
              )}
              <SubtaskControls
                key={`controls:${detailSubtask.id}`}
                sessionId={sessionId}
                task={detailSubtask}
                onRefresh={verified => {
                  if (verified)
                    setDetailSubtask(current =>
                      current?.id === verified.id
                        ? mergeSubtaskSnapshots(current, {
                            ...verified,
                            lifecycleRequestSequence: ++lifecycleRequestSequenceRef.current,
                          })
                        : current,
                    );
                  setDetailReloadKey(value => value + 1);
                  void refresh(true);
                }}
              />
              <SubtaskChildren
                key={`children:${detailSubtask.id}`}
                sessionId={sessionId}
                task={detailSubtask}
                ancestors={detailAncestors.map(task => task.id)}
                onOpen={child => {
                  setDetailAncestors(current => [...current, detailSubtask]);
                  setDetailSubtask(child);
                }}
              />
              <dl className="px-5 py-3">
                {detailRows.map(([label, value, copyable]) => (
                  <div
                    key={label}
                    className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-2.5 last:border-0"
                  >
                    <dt className="text-sm text-secondary">{label}</dt>
                    <dd className="min-w-0 break-words whitespace-pre-wrap text-sm text-foreground">
                      {copyable && typeof value === 'string' ? (
                        <button
                          type="button"
                          className="inline-flex max-w-full items-start gap-1.5 text-left hover:text-primary"
                          onClick={() => void copySessionId(value)}
                          aria-label={i18nService.t('copySessionId')}
                          title={i18nService.t('copySessionId')}
                        >
                          <span className="min-w-0 break-all">{value}</span>
                          <DocumentDuplicateIcon className="mt-0.5 h-4 w-4 shrink-0" />
                        </button>
                      ) : value == null ? (
                        i18nService.t('subtaskInfoUnavailable')
                      ) : typeof value === 'string' ? (
                        value || i18nService.t('subtaskInfoUnavailable')
                      ) : (
                        value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
};

export default SubtaskListPanel;
