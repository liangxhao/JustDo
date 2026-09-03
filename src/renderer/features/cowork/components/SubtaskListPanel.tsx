import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

import { reconcileSubagentLabel, type SubagentLabelSource } from './subagentLabel';
import { resolveSubagentPollInterval } from './subagentPolling';
import SubagentTokenUsage from './SubagentTokenUsage';
import {
  isActiveSubtask,
  partitionSubtasks,
  resolveSubtaskElapsedMs,
  type Subtask,
  SUBTASK_STATUS_I18N_KEYS,
  subtaskStatusStyles,
} from './subtaskPresentation';
import { useDraggableModal } from './useDraggableModal';

interface SubtaskListPanelProps {
  sessionId: string;
  isOpen: boolean;
  parentRunning?: boolean;
  onClose: () => void;
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
  isOpen,
  parentRunning = false,
  onClose,
  onOpenSubtask,
  onSubtasksChange,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [finishedExpanded, setFinishedExpanded] = useState(true);
  const [detailSubtask, setDetailSubtask] = useState<Subtask | null>(null);
  const [detailStats, setDetailStats] = useState<SessionDetailStats>();
  const [isDetailStatsLoading, setIsDetailStatsLoading] = useState(false);
  const [clock, setClock] = useState(Date.now());
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
  const { active, finished } = useMemo(() => partitionSubtasks(subtasks), [subtasks]);

  const closeDetails = useCallback(() => setDetailSubtask(null), []);

  const refresh = useCallback(
    async (force = false) => {
      if (refreshInFlightRef.current?.sessionId === sessionId) {
        if (force) refreshPendingRef.current = true;
        return;
      }
      refreshPendingRef.current = false;
      const refreshToken = { sessionId, generation: ++refreshGenerationRef.current };
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
          refreshInFlightRef.current === refreshToken
        ) {
          const nextSubtasks = (result.subagents as Subtask[] | undefined) ?? [];
          const normalizedSubtasks = nextSubtasks.map(subtask => {
            const resolved = reconcileSubagentLabel(subtaskLabelsRef.current.get(subtask.id), {
              label: subtask.label,
              labelSource: subtask.labelSource,
            });
            return { ...subtask, ...resolved };
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
              ? (normalizedSubtasks.find(subtask => subtask.id === current.id) ?? null)
              : null,
          );
          onSubtasksChange?.(normalizedSubtasks);
          setHasLoaded(true);
          setHasLoadError(false);
        } else if (
          !result.success &&
          mountedRef.current &&
          refreshInFlightRef.current === refreshToken
        ) {
          setHasLoadError(true);
        }
      } catch {
        if (mountedRef.current && refreshInFlightRef.current === refreshToken) {
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
    if (!sessionKey) {
      detailStatsSessionKeyRef.current = undefined;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(false);
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    let retryTimer: number | undefined;
    const isNewSession = detailStatsSessionKeyRef.current !== sessionKey;
    detailStatsSessionKeyRef.current = sessionKey;
    if (isNewSession) {
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(true);
    }
    let hasCompleteStats = detailStatsRef.current !== undefined;
    const isActive = isActiveSubtask(detailSubtask.status);
    const refreshDetails = async (attempt = 0): Promise<void> => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      let succeeded = false;
      try {
        const result = await window.electron.cowork.getSubTaskDetails(sessionKey);
        if (!cancelled && result.success) {
          succeeded = true;
          hasCompleteStats = true;
          detailStatsRef.current = result.stats;
          setDetailStats(result.stats);
        }
      } catch {
        // Preserve the last complete lifetime total until the next refresh.
      } finally {
        refreshInFlight = false;
        const willRetry = !succeeded && !isActive && attempt < 2;
        const waitingForActiveRefresh = !succeeded && isActive && !hasCompleteStats;
        if (!cancelled && !willRetry && !waitingForActiveRefresh) {
          setIsDetailStatsLoading(false);
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
  }, [detailSubtask?.sessionKey, detailSubtask?.status]);

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
        new CustomEvent('app:showToast', { detail: i18nService.t('copySessionIdSuccess') }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('copySessionIdFailed') }),
      );
    }
  };

  const detailRows: Array<[string, React.ReactNode, boolean?]> = detailSubtask
    ? [
        [
          i18nService.t('subtaskInfoStatus'),
          i18nService.t(SUBTASK_STATUS_I18N_KEYS[detailSubtask.status]),
        ],
        [i18nService.t('subtaskInfoTask'), detailSubtask.task],
        [i18nService.t('subtaskInfoModel'), detailSubtask.model],
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
          <SubagentTokenUsage
            key="token-usage"
            stats={detailStats}
            isLoading={isDetailStatsLoading}
          />,
        ],
        [i18nService.t('subtaskInfoSession'), detailSubtask.sessionKey],
        [i18nService.t('subtaskInfoSessionId'), detailSubtask.sessionId, true],
      ]
    : [];

  const renderSubtask = (subtask: Subtask) => {
    return (
      <div
        key={subtask.id}
        role="listitem"
        className="group flex min-w-0 items-center gap-2 rounded-lg border border-transparent bg-surface-raised/55 px-2.5 py-2 transition-colors hover:border-border"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${subtaskStatusStyles[subtask.status]}`}
          aria-hidden="true"
        />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:text-primary"
          onClick={() => onOpenSubtask?.(subtask)}
          title={subtask.label}
        >
          {subtask.label}
        </button>
        <span className="shrink-0 text-xs text-secondary">{subtask.status}</span>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-70 transition-colors hover:bg-surface hover:text-foreground group-hover:opacity-100"
          onClick={event => {
            detailReturnFocusRef.current = event.currentTarget;
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
          id="cowork-subtask-list"
          className="absolute inset-y-0 right-0 z-50 flex h-full w-80 max-w-[calc(100%-2rem)] shrink-0 flex-col border-l border-border bg-surface/95 shadow-xl min-[1100px]:relative min-[1100px]:inset-auto min-[1100px]:z-auto min-[1100px]:max-w-none min-[1100px]:shadow-none"
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
                onClick={onClose}
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
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-secondary">
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
              {i18nService.t('loading')}
            </div>
          ) : subtasks.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {active.length > 0 && (
                <section className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2">
                  <h3 className="shrink-0 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    {i18nService.t('subtaskActive').replace('{count}', String(active.length))}
                  </h3>
                  <div className="space-y-1 px-2 pb-2" role="list">
                    {active.map(renderSubtask)}
                  </div>
                </section>
              )}
              {finished.length > 0 && (
                <section
                  className={`shrink overflow-y-auto border-t border-border pt-2 ${
                    active.length > 0 ? 'max-h-[50%]' : 'flex-1'
                  }`}
                >
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
                      {finished.map(renderSubtask)}
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
            <dl className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-3">
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
        )}
      </Modal>
    </>
  );
};

export default SubtaskListPanel;
