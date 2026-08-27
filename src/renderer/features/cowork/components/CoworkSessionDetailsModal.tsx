import {
  ArrowPathIcon,
  DocumentDuplicateIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import type {
  CoworkExecutionMode,
  CoworkSession,
  CoworkSessionStatus,
  CoworkSessionSummary,
  SessionGroup,
} from '@/features/cowork/coworkTypes';
import {
  buildSessionDetailStats,
  type SessionDetailStats,
} from '@/features/cowork/sessionPresentation';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

interface CoworkSessionDetailsModalProps {
  sessionSummary: CoworkSessionSummary;
  groups: SessionGroup[];
  isRuntimeRunning: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const statusLabels: Record<CoworkSessionStatus, string> = {
  idle: 'coworkStatusIdle',
  running: 'coworkStatusRunning',
  completed: 'coworkStatusCompleted',
  error: 'coworkStatusError',
};

const executionModeLabels: Record<CoworkExecutionMode, string> = {
  auto: 'sessionDetailsExecutionAuto',
  local: 'sessionDetailsExecutionLocal',
  sandbox: 'sessionDetailsExecutionSandbox',
};

const formatDateTime = (timestamp: number): string =>
  new Intl.DateTimeFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));

const formatNumber = (value: number): string =>
  value.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');

const CoworkSessionDetailsModal: React.FC<CoworkSessionDetailsModalProps> = ({
  sessionSummary,
  groups,
  isRuntimeRunning,
  returnFocusRef,
  onClose,
}) => {
  const [session, setSession] = useState<CoworkSession | null>(null);
  const [stats, setStats] = useState<SessionDetailStats | null>(null);
  const [gatewaySessionId, setGatewaySessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const hasLoadedRef = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const isInitialLoad = !hasLoadedRef.current;
    if (isInitialLoad) {
      setIsLoading(true);
      setLoadFailed(false);
    }

    const refreshTimer = setTimeout(
      () => {
        void coworkService
          .getSessionDetails(sessionSummary.id)
          .then(result => {
            if (cancelled) return;
            if (result.session) {
              hasLoadedRef.current = true;
              setSession(result.session);
              setStats(result.stats ?? buildSessionDetailStats(result.session));
              setGatewaySessionId(result.gatewaySessionId ?? null);
              setLoadFailed(false);
            } else if (isInitialLoad) {
              setLoadFailed(true);
            }
          })
          .catch(() => {
            if (!cancelled && isInitialLoad) setLoadFailed(true);
          })
          .finally(() => {
            if (!cancelled && isInitialLoad) setIsLoading(false);
          });
      },
      isInitialLoad ? 0 : 250,
    );

    return () => {
      cancelled = true;
      clearTimeout(refreshTimer);
    };
  }, [isRuntimeRunning, reloadKey, sessionSummary.id, sessionSummary.updatedAt]);

  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(element => !element.hasAttribute('hidden'));
      if (!focusableElements.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === firstElement || !dialogRef.current.contains(activeElement))
      ) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const focusTarget = returnFocusTarget ?? previouslyFocusedRef.current;
      requestAnimationFrame(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
      });
    };
  }, [returnFocusRef]);

  const retry = useCallback(() => setReloadKey(value => value + 1), []);
  const copySessionId = useCallback(async () => {
    if (!gatewaySessionId) return;
    try {
      await navigator.clipboard.writeText(gatewaySessionId);
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
  }, [gatewaySessionId]);
  const displayedModels = stats?.models ?? [];
  const currentStatus: CoworkSessionStatus = isRuntimeRunning
    ? 'running'
    : (session?.status ?? sessionSummary.status);
  const groupName = groups.find(group => group.id === sessionSummary.groupId)?.name;
  const unavailable = i18nService.t('sessionDetailsUnavailable');

  const messageStats = stats
    ? [
        [i18nService.t('sessionDetailsMessages'), stats.messageCount],
        [i18nService.t('sessionDetailsUserMessages'), stats.userMessageCount],
        [i18nService.t('sessionDetailsAssistantMessages'), stats.assistantMessageCount],
        [i18nService.t('sessionDetailsToolCalls'), stats.toolCallCount],
      ]
    : [];
  const detailRows: Array<[string, string, boolean?]> = session
    ? [
        [i18nService.t('sessionDetailsCreatedAt'), formatDateTime(session.createdAt)],
        [i18nService.t('sessionDetailsUpdatedAt'), formatDateTime(session.updatedAt)],
        [i18nService.t('sessionDetailsGroup'), groupName ?? i18nService.t('ungrouped')],
        [i18nService.t('sessionDetailsWorkingDirectory'), session.cwd || unavailable],
        [
          i18nService.t('sessionDetailsExecutionMode'),
          i18nService.t(executionModeLabels[session.executionMode]),
        ],
        [i18nService.t('sessionDetailsAgent'), session.agentId || unavailable],
        [i18nService.t('sessionDetailsSessionId'), gatewaySessionId ?? unavailable, true],
      ]
    : [];

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-5"
      className="w-full max-w-2xl max-h-[84vh] overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-details-title"
        tabIndex={-1}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">
            <InformationCircleIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2
                id="session-details-title"
                className="truncate text-base font-semibold text-foreground"
              >
                {sessionSummary.title}
              </h2>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  currentStatus === 'running'
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : currentStatus === 'error'
                      ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                      : 'bg-surface-raised text-secondary'
                }`}
              >
                {i18nService.t(statusLabels[currentStatus])}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-secondary">{i18nService.t('sessionDetailsTitle')}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(84vh-73px)] overflow-y-auto px-5 py-5">
          {isLoading && (
            <div
              className="flex min-h-52 items-center justify-center gap-2.5 text-sm text-secondary"
              role="status"
              aria-live="polite"
            >
              <ArrowPathIcon className="h-5 w-5 animate-spin" aria-hidden="true" />
              {i18nService.t('sessionDetailsLoading')}
            </div>
          )}

          {!isLoading && loadFailed && (
            <div className="flex min-h-52 flex-col items-center justify-center text-center">
              <p className="text-sm text-secondary">{i18nService.t('sessionDetailsLoadFailed')}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                <ArrowPathIcon className="h-4 w-4" />
                {i18nService.t('sessionDetailsRetry')}
              </button>
            </div>
          )}

          {!isLoading && session && stats && (
            <div className="space-y-5">
              <section>
                <h3 className="mb-2 text-xs font-semibold text-secondary">
                  {i18nService.t('sessionDetailsSummary')}
                </h3>
                <div className="rounded-xl border border-border bg-surface-raised/50 px-4 py-3">
                  <p className="text-sm leading-6 text-foreground">
                    {stats.summary ?? i18nService.t('sessionDetailsNoSummary')}
                  </p>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold text-secondary">
                  {i18nService.t('sessionDetailsActivity')}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {messageStats.map(([label, value]) => (
                    <div
                      key={String(label)}
                      className="rounded-xl border border-border px-3 py-2.5"
                    >
                      <div className="text-lg font-semibold tabular-nums text-foreground">
                        {formatNumber(Number(value))}
                      </div>
                      <div className="mt-0.5 text-[11px] text-secondary">{label}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="shrink-0 text-xs font-semibold text-secondary">
                    {i18nService.t('sessionDetailsTokenUsage')}
                  </h3>
                  <p className="whitespace-nowrap text-right text-[10px] leading-4 text-secondary">
                    {i18nService.t('sessionDetailsTokenUsageScopeNote')}
                  </p>
                </div>
                {stats.hasTokenUsage ? (
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-xl border border-border px-4 py-3 text-xs">
                    <div className="col-span-2 flex items-center justify-between gap-3 border-b border-border pb-2">
                      <span className="font-medium text-secondary">
                        {i18nService.t('sessionDetailsTotalTokens')}
                      </span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatNumber(stats.totalTokens)}
                      </span>
                    </div>
                    {[
                      [i18nService.t('sessionDetailsInputTokens'), stats.tokenUsage.input],
                      [i18nService.t('sessionDetailsOutputTokens'), stats.tokenUsage.output],
                      [i18nService.t('sessionDetailsCacheRead'), stats.tokenUsage.cacheRead],
                      [i18nService.t('sessionDetailsCacheWrite'), stats.tokenUsage.cacheWrite],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="flex items-center justify-between gap-3">
                        <span className="text-secondary">{label}</span>
                        <span className="font-medium tabular-nums text-foreground">
                          {formatNumber(Number(value))}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-border px-4 py-3 text-xs text-secondary">
                    {i18nService.t('sessionDetailsNoTokenUsage')}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold text-secondary">
                  {i18nService.t('sessionDetailsEnvironment')}
                </h3>
                <dl className="overflow-hidden rounded-xl border border-border">
                  {detailRows.map(([label, value, copyable], index) => (
                    <div
                      key={label}
                      className={`grid grid-cols-[132px_minmax(0,1fr)] gap-3 px-4 py-2.5 text-xs ${
                        index > 0 ? 'border-t border-border' : ''
                      }`}
                    >
                      <dt className="text-secondary">{label}</dt>
                      <dd className="flex min-w-0 items-start gap-2 text-foreground">
                        <span className="min-w-0 flex-1 break-all">{value}</span>
                        {copyable && (
                          <button
                            type="button"
                            onClick={() => void copySessionId()}
                            disabled={!gatewaySessionId}
                            className="shrink-0 rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                            title={i18nService.t('copySessionId')}
                            aria-label={i18nService.t('copySessionId')}
                          >
                            <DocumentDuplicateIcon className="h-4 w-4" />
                          </button>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold text-secondary">
                  {i18nService.t('sessionDetailsModels')}
                </h3>
                <div className="flex min-h-10 flex-wrap gap-1.5 rounded-xl border border-border px-3 py-2.5">
                  {displayedModels.length ? (
                    displayedModels.map(model => (
                      <span
                        key={model}
                        className="rounded-md bg-surface-raised px-2 py-1 text-xs text-foreground"
                      >
                        {model}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-secondary">{unavailable}</span>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default CoworkSessionDetailsModal;
