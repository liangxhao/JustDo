import {
  ArrowPathIcon,
  ChartBarIcon,
  DocumentDuplicateIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { SessionDetailTokenUsage } from '@shared/cowork/sessionDetails';
import { sumSessionDetailTokenUsage } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

type QueryPhase = 'discovering' | 'aggregating' | 'complete' | 'error';

interface SessionTotalTokenUsageModalProps {
  sessionId: string;
  gatewaySessionId?: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

interface AggregateResult {
  main: SessionDetailTokenUsage;
  subagents: SessionDetailTokenUsage;
  subagentCount: number;
  failedSessions: FailedSession[];
}

interface FailedSession {
  sessionId: string;
  label: string;
}

const EMPTY_USAGE: SessionDetailTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const addUsage = (
  left: SessionDetailTokenUsage,
  right: SessionDetailTokenUsage,
): SessionDetailTokenUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

const formatNumber = (value: number): string =>
  value.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');

const SessionTotalTokenUsageModal: React.FC<SessionTotalTokenUsageModalProps> = ({
  sessionId,
  gatewaySessionId,
  returnFocusRef,
  onClose,
}) => {
  const [phase, setPhase] = useState<QueryPhase>('discovering');
  const [completedCount, setCompletedCount] = useState(0);
  const [totalCount, setTotalCount] = useState<number>();
  const [currentSubagent, setCurrentSubagent] = useState('');
  const [isRetrying, setIsRetrying] = useState(false);
  const [result, setResult] = useState<AggregateResult>();
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusableElements.length) return;
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
      });
    };
  }, [returnFocusRef]);

  useEffect(() => {
    let cancelled = false;

    const query = async (): Promise<void> => {
      setPhase('discovering');
      setCompletedCount(0);
      setTotalCount(undefined);
      setCurrentSubagent('');
      setIsRetrying(false);
      setResult(undefined);

      try {
        const statusResult = await window.electron.cowork.listSubTaskDescendants(sessionId);
        if (!statusResult.success) throw new Error('Failed to list subagents');
        const subagents = [
          ...new Map(
            (statusResult.subagents ?? []).map(subagent => [subagent.sessionKey, subagent]),
          ).values(),
        ];
        if (cancelled) return;

        setTotalCount(subagents.length + 1);
        setPhase('aggregating');

        const failedSessions: FailedSession[] = [];
        let mainUsage = { ...EMPTY_USAGE };
        let mainDetails: Awaited<ReturnType<typeof coworkService.getSessionDetails>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (cancelled) return;
          setIsRetrying(attempt > 0);
          try {
            const details = await coworkService.getSessionDetails(sessionId);
            if (cancelled) return;
            if (details.stats) {
              mainDetails = details;
              break;
            }
          } catch {
            if (cancelled) return;
            // Retry once before recording this session as skipped.
          }
        }
        if (mainDetails?.stats) mainUsage = mainDetails.stats.tokenUsage;
        else {
          if (!gatewaySessionId) throw new Error('Main Gateway Session ID is unavailable');
          failedSessions.push({
            sessionId: gatewaySessionId,
            label: i18nService.t('sessionTotalTokensMain'),
          });
        }
        if (cancelled) return;
        setCompletedCount(1);
        setIsRetrying(false);

        let subagentUsage = { ...EMPTY_USAGE };
        for (let index = 0; index < subagents.length; index += 1) {
          const subagent = subagents[index];
          setCurrentSubagent(subagent.label || `Subagent ${index + 1}`);
          let detailStats: SessionDetailTokenUsage | undefined;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (cancelled) return;
            setIsRetrying(attempt > 0);
            try {
              const detailResult = await window.electron.cowork.getSubTaskDetails(
                subagent.sessionKey,
              );
              if (cancelled) return;
              if (detailResult.success) {
                detailStats = detailResult.stats.tokenUsage;
                break;
              }
            } catch {
              if (cancelled) return;
              // Retry once before recording this session as skipped.
            }
          }
          if (detailStats) subagentUsage = addUsage(subagentUsage, detailStats);
          else {
            failedSessions.push({
              sessionId: subagent.sessionId,
              label: subagent.label || `Subagent ${index + 1}`,
            });
          }
          if (cancelled) return;
          setCompletedCount(index + 2);
          setIsRetrying(false);
        }

        setResult({
          main: mainUsage,
          subagents: subagentUsage,
          subagentCount: subagents.length,
          failedSessions,
        });
        setCurrentSubagent('');
        setPhase('complete');
      } catch {
        if (!cancelled) setPhase('error');
      }
    };

    // Defer startup by one task so React StrictMode can complete its development-only
    // mount/cleanup probe without issuing a duplicate set of expensive Gateway queries.
    const queryTimer = window.setTimeout(() => void query(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(queryTimer);
    };
  }, [gatewaySessionId, reloadKey, sessionId]);

  const retry = useCallback(() => setReloadKey(value => value + 1), []);
  const progressPercent = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
  const combinedUsage = useMemo(
    () => (result ? addUsage(result.main, result.subagents) : undefined),
    [result],
  );
  const combinedTotal = combinedUsage ? sumSessionDetailTokenUsage(combinedUsage) : 0;

  const copySessionId = useCallback(async (value: string): Promise<void> => {
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
  }, []);

  const progressLabel =
    phase === 'discovering'
      ? i18nService.t('sessionTotalTokensDiscovering')
      : isRetrying
        ? i18nService
            .t('sessionTotalTokensRetrying')
            .replace('{name}', currentSubagent || i18nService.t('sessionTotalTokensMainSession'))
        : currentSubagent
          ? i18nService
              .t('sessionTotalTokensProcessingSubagent')
              .replace('{current}', String(Math.max(1, completedCount)))
              .replace('{total}', String(Math.max(0, (totalCount ?? 1) - 1)))
              .replace('{name}', currentSubagent)
          : i18nService.t('sessionTotalTokensProcessingMain');

  return (
    <Modal
      onClose={onClose}
      closeOnBackdrop={phase === 'complete' || phase === 'error'}
      overlayClassName="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-5"
      className="max-h-[86vh] w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-total-tokens-title"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="rounded-xl bg-primary/10 p-2 text-primary">
            <ChartBarIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="session-total-tokens-title" className="text-base font-semibold text-foreground">
              {i18nService.t('sessionTotalTokensTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-secondary">
              {i18nService.t('sessionTotalTokensDescription')}
            </p>
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

        <div className="max-h-[calc(86vh-73px)] overflow-y-auto px-5 py-6">
          {(phase === 'discovering' || phase === 'aggregating') && (
            <div className="flex min-h-56 flex-col items-center justify-center" role="status">
              <div className="inline-flex items-center text-xl font-semibold" aria-hidden="true">
                <ArrowPathIcon className="mr-2.5 h-6 w-6 animate-spin text-primary motion-reduce:animate-none" />
                <span className="querying-indicator-text tracking-wider">
                  {i18nService.t('sessionTotalTokensAggregating')}
                </span>
                <span className="ml-0.5 inline-flex">
                  {[0, 1, 2].map(index => (
                    <span
                      key={index}
                      className="querying-indicator-dot"
                      style={{ animationDelay: `${index * 160}ms` }}
                    >
                      .
                    </span>
                  ))}
                </span>
              </div>
              <p className="querying-indicator-stage mt-2 max-w-full truncate text-xs text-secondary">
                {progressLabel}
              </p>

              <div className="mt-6 w-full max-w-sm">
                <div
                  className="h-2 overflow-hidden rounded-full bg-border"
                  role="progressbar"
                  aria-label={i18nService.t('sessionTotalTokensProgress')}
                  aria-valuemin={0}
                  aria-valuemax={totalCount ?? undefined}
                  aria-valuenow={totalCount === undefined ? undefined : completedCount}
                >
                  {totalCount === undefined ? (
                    <div
                      key="indeterminate"
                      className="session-token-progress-indeterminate h-full w-1/3 rounded-full bg-primary"
                    />
                  ) : (
                    <div
                      key="determinate"
                      className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                      style={{
                        width: `${progressPercent}%`,
                        transform: 'none',
                        animation: 'none',
                      }}
                    />
                  )}
                </div>
                <div className="mt-2 flex justify-between text-[11px] tabular-nums text-secondary">
                  <span>
                    {totalCount === undefined
                      ? i18nService.t('sessionTotalTokensCountingSubagents')
                      : i18nService
                          .t('sessionTotalTokensCompletedCount')
                          .replace('{completed}', String(completedCount))
                          .replace('{total}', String(totalCount))}
                  </span>
                  {totalCount !== undefined && <span>{progressPercent}%</span>}
                </div>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <p className="text-sm text-secondary">
                {i18nService.t('sessionTotalTokensLoadFailed')}
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                <ArrowPathIcon className="h-4 w-4" />
                {i18nService.t('sessionDetailsRetry')}
              </button>
            </div>
          )}

          {phase === 'complete' && result && combinedUsage && (
            <div>
              <div className="rounded-2xl border border-primary/25 bg-primary/5 px-5 py-5 text-center">
                <p className="text-xs font-medium text-secondary">
                  {i18nService.t('sessionTotalTokensOverall')}
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-foreground">
                  {formatNumber(combinedTotal)}
                </p>
              </div>

              {result.failedSessions.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                  <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                    {i18nService
                      .t('sessionTotalTokensPartialResult')
                      .replace('{count}', String(result.failedSessions.length))}
                  </p>
                  <p className="mt-3 text-[11px] font-semibold text-secondary">
                    {i18nService.t('sessionTotalTokensFailedSessionIds')}
                  </p>
                  <div className="mt-1.5 max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface">
                    {result.failedSessions.map((failedSession, index) => (
                      <div
                        key={`${failedSession.sessionId ?? failedSession.label}-${index}`}
                        className="flex items-center gap-2 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 break-all text-xs text-foreground">
                          {failedSession.sessionId}
                        </span>
                        <button
                          type="button"
                          onClick={() => void copySessionId(failedSession.sessionId)}
                          className="shrink-0 rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          title={i18nService.t('copySessionId')}
                          aria-label={i18nService.t('copySessionId')}
                        >
                          <DocumentDuplicateIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  [
                    i18nService.t('sessionTotalTokensMain'),
                    sumSessionDetailTokenUsage(result.main),
                  ],
                  [
                    i18nService.t('sessionTotalTokensSubagents'),
                    sumSessionDetailTokenUsage(result.subagents),
                  ],
                  [i18nService.t('sessionTotalTokensSubagentCount'), result.subagentCount],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-border px-3 py-2.5">
                    <div className="text-base font-semibold tabular-nums text-foreground">
                      {formatNumber(Number(value))}
                    </div>
                    <div className="mt-0.5 text-[11px] text-secondary">{label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 rounded-xl border border-border px-4 py-3 text-xs">
                {[
                  [i18nService.t('sessionDetailsInputTokens'), combinedUsage.input],
                  [i18nService.t('sessionDetailsOutputTokens'), combinedUsage.output],
                  [i18nService.t('sessionDetailsCacheRead'), combinedUsage.cacheRead],
                  [i18nService.t('sessionDetailsCacheWrite'), combinedUsage.cacheWrite],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex items-center justify-between gap-3">
                    <span className="text-secondary">{label}</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {formatNumber(Number(value))}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-center text-[10px] leading-4 text-secondary">
                {i18nService.t('sessionDetailsTokenUsageScopeNote')}
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default SessionTotalTokenUsageModal;
