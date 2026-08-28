import { DocumentDuplicateIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

import { reconcileSubagentLabel, type SubagentLabelSource } from './subagentLabel';
import SubagentTokenUsage from './SubagentTokenUsage';
import { useDraggableModal } from './useDraggableModal';

export const SUBAGENT_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

export type Subagent = {
  id: string;
  sessionKey: string;
  sessionId?: string;
  label: string;
  labelSource: SubagentLabelSource;
  status: SubagentStatus;
  task?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
};

export const subagentStatusStyles: Record<SubagentStatus, string> = {
  pending: 'bg-amber-500 animate-pulse',
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  killed: 'bg-red-500',
  timeout: 'bg-red-500',
};

interface SubagentMenuProps {
  sessionId: string;
  onOpenSubagent?: (subagent: Subagent) => void;
  onSubagentsChange?: (subagents: Subagent[]) => void;
}

const SubagentMenu: React.FC<SubagentMenuProps> = ({
  sessionId,
  onOpenSubagent,
  onSubagentsChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [detailSubagent, setDetailSubagent] = useState<Subagent | null>(null);
  const [detailStats, setDetailStats] = useState<SessionDetailStats>();
  const [isDetailStatsLoading, setIsDetailStatsLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailDialogRef = useRef<HTMLDivElement>(null);
  const detailCloseButtonRef = useRef<HTMLButtonElement>(null);
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const subagentLabelsRef = useRef(
    new Map<string, { label: string; labelSource: SubagentLabelSource }>(),
  );
  const refreshInFlightRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const detailStatsSessionKeyRef = useRef<string>();
  const detailStatsRef = useRef<SessionDetailStats>();
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const {
    dialogStyle: detailDialogStyle,
    dragHandleProps: detailDragHandleProps,
    isDragging: isDetailDragging,
  } = useDraggableModal(detailDialogRef, detailSubagent?.sessionKey);
  const detailSessionKey = detailSubagent?.sessionKey;

  const closeDetails = useCallback(() => setDetailSubagent(null), []);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const result = await window.electron.cowork.getSubTaskStatus(sessionId);
      if (result.success && sessionIdRef.current === sessionId) {
        const nextSubagents = (result.subagents as Subagent[] | undefined) ?? [];
        const normalizedSubagents = nextSubagents.map(subagent => {
          const resolved = reconcileSubagentLabel(subagentLabelsRef.current.get(subagent.id), {
            label: subagent.label,
            labelSource: subagent.labelSource,
          });
          return { ...subagent, ...resolved };
        });
        subagentLabelsRef.current = new Map(
          normalizedSubagents.map(subagent => [
            subagent.id,
            { label: subagent.label, labelSource: subagent.labelSource },
          ]),
        );
        setSubagents(normalizedSubagents);
        setDetailSubagent(current => {
          if (!current) return null;
          return normalizedSubagents.find(subagent => subagent.id === current.id) ?? current;
        });
        onSubagentsChange?.(normalizedSubagents);
        hasLoadedRef.current = true;
        setIsLoading(false);
      }
    } catch {
      // Preserve the last successful snapshot and retry on the next interval.
    } finally {
      refreshInFlightRef.current = false;
      if (sessionIdRef.current === sessionId) setIsLoading(false);
    }
  }, [onSubagentsChange, sessionId]);

  useEffect(() => {
    hasLoadedRef.current = false;
    subagentLabelsRef.current = new Map();
    setSubagents([]);
    setDetailSubagent(null);
    onSubagentsChange?.([]);
  }, [onSubagentsChange, sessionId]);

  useEffect(() => {
    const sessionKey = detailSubagent?.sessionKey;
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
    const isActive =
      detailSubagent?.status === SUBAGENT_STATUSES.PENDING ||
      detailSubagent?.status === SUBAGENT_STATUSES.RUNNING;
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
        retryTimer = window.setTimeout(() => void refreshDetails(attempt + 1), 1000);
      }
    };
    void refreshDetails();
    const timer = isActive ? window.setInterval(() => void refreshDetails(), 5000) : undefined;
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [detailSubagent?.sessionKey, detailSubagent?.status]);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);

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

  const formatDateTime = (value?: number): string =>
    value ? new Date(value).toLocaleString() : i18nService.t('subagentInfoUnavailable');

  const formatRuntime = (value?: number): string => {
    if (value === undefined) return i18nService.t('subagentInfoUnavailable');
    const seconds = Math.max(0, Math.round(value / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`]
      .filter(Boolean)
      .join(' ');
  };

  const copySessionId = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('copySessionIdSuccess'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('copySessionIdFailed'),
        }),
      );
    }
  };

  const detailRows: Array<[string, React.ReactNode, boolean?]> = detailSubagent
    ? [
        [i18nService.t('subagentInfoStatus'), detailSubagent.status],
        [i18nService.t('subagentInfoTask'), detailSubagent.task],
        [i18nService.t('subagentInfoModel'), detailSubagent.model],
        [i18nService.t('subagentInfoRuntime'), formatRuntime(detailSubagent.runtimeMs)],
        [i18nService.t('subagentInfoStarted'), formatDateTime(detailSubagent.startedAt)],
        [i18nService.t('subagentInfoEnded'), formatDateTime(detailSubagent.endedAt)],
        [
          i18nService.t('subagentInfoTokens'),
          <SubagentTokenUsage
            key="token-usage"
            stats={detailStats}
            isLoading={isDetailStatsLoading}
          />,
        ],
        [i18nService.t('subagentInfoSession'), detailSubagent.sessionKey],
        [i18nService.t('subagentInfoSessionId'), detailSubagent.sessionId, true],
      ]
    : [];

  const activeCount = subagents.filter(
    subagent =>
      subagent.status === SUBAGENT_STATUSES.PENDING ||
      subagent.status === SUBAGENT_STATUSES.RUNNING,
  ).length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(value => !value)}
        className="relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        aria-label={i18nService.t('subagents')}
        title={i18nService.t('subagents')}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-[18px] w-[18px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="8" r="3" />
          <circle cx="5" cy="16" r="2.5" />
          <circle cx="19" cy="16" r="2.5" />
          <path d="M12 11v2M7.5 14.5 10 13m6.5 1.5L14 13" />
        </svg>
        {activeCount > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-background" />
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-10 z-[70] w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold text-foreground">
              {i18nService.t('subagents')}
            </span>
            <span className="text-xs text-secondary">{subagents.length}</span>
          </div>
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto p-1.5">
            {subagents.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-secondary">
                {isLoading ? i18nService.t('loading') : i18nService.t('subagentEmpty')}
              </div>
            ) : (
              subagents.map(subagent => (
                <div
                  key={subagent.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-raised"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${subagentStatusStyles[subagent.status]}`}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:text-primary"
                    onClick={() => {
                      onOpenSubagent?.(subagent);
                      setIsOpen(false);
                    }}
                  >
                    {subagent.label}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface hover:text-foreground"
                    onClick={event => {
                      detailReturnFocusRef.current = event.currentTarget;
                      setDetailSubagent(subagent);
                    }}
                    aria-label={i18nService.t('subagentShowInfo')}
                    title={i18nService.t('subagentShowInfo')}
                  >
                    <InformationCircleIcon className="h-4 w-4" />
                  </button>
                  <span className="shrink-0 text-xs text-secondary">{subagent.status}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <Modal
        isOpen={detailSubagent !== null}
        onClose={closeDetails}
        className="w-[min(36rem,calc(100vw-2rem))] max-h-[80vh] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
        style={detailDialogStyle}
      >
        {detailSubagent && (
          <div
            ref={detailDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subagent-details-title"
            tabIndex={-1}
          >
            <div
              {...detailDragHandleProps}
              className={`flex cursor-move select-none items-center justify-between border-b border-border px-5 py-4 ${
                isDetailDragging ? 'cursor-grabbing' : ''
              }`}
            >
              <h2
                id="subagent-details-title"
                className="min-w-0 truncate text-base font-semibold text-foreground"
              >
                {detailSubagent.label}
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
                      i18nService.t('subagentInfoUnavailable')
                    ) : typeof value === 'string' ? (
                      value || i18nService.t('subagentInfoUnavailable')
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
    </div>
  );
};

export default SubagentMenu;
