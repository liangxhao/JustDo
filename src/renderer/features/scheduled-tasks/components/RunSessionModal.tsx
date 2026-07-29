import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type {
  ScheduledTaskRun,
  ScheduledTaskSessionHistory,
} from '@shared/scheduledTask/types';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import ChatMessageDisplay from '@/features/cowork/components/ChatMessageDisplay';
import { normalizeGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

interface RunSessionModalProps {
  run: ScheduledTaskRun;
  title?: string;
  onClose: () => void;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 3000;

const RunSessionModal: React.FC<RunSessionModalProps> = ({ run, title, onClose }) => {
  const [history, setHistory] = useState<ScheduledTaskSessionHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGenerationRef = useRef(0);

  const loadSession = useCallback(
    async (requestGeneration: number, reportUnavailable = false): Promise<boolean> => {
      const sessionKey = run.sessionKey?.trim();
      if (!sessionKey) return false;

      try {
        const result = await window.electron?.scheduledTasks?.resolveSession(
          sessionKey,
          {
            runId: run.id,
            status: run.status,
            sessionId: run.sessionId,
            ...(reportUnavailable ? { reason: 'retry-exhausted' as const } : {}),
          },
        );
        if (requestGenerationRef.current !== requestGeneration) return false;
        if (result?.success && result.history?.messages.length) {
          const messages = await normalizeGatewayHistoryForDisplay(result.history.messages, {
            sessionKey: result.history.sessionKey,
          });
          if (requestGenerationRef.current !== requestGeneration) return false;
          if (messages.length === 0) return false;
          setHistory({ ...result.history, messages });
          setLoading(false);
          setUnavailable(false);
          return true;
        }
      } catch {
        // The final failed attempt is logged once in Main through resolveSession.
      }
      return false;
    },
    [run.id, run.sessionId, run.sessionKey, run.status],
  );

  useEffect(() => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    setHistory(null);
    setLoading(true);
    setUnavailable(false);
    setRetryCount(0);

    void loadSession(requestGeneration).then(success => {
      if (!success && requestGenerationRef.current === requestGeneration) setRetryCount(1);
    });

    return () => {
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [loadSession]);

  useEffect(() => {
    if (retryCount === 0 || retryCount > MAX_RETRIES || history) return;
    const requestGeneration = requestGenerationRef.current;

    retryTimerRef.current = setTimeout(async () => {
      if (requestGenerationRef.current !== requestGeneration) return;
      const finalAttempt = retryCount >= MAX_RETRIES;
      const success = await loadSession(requestGeneration, finalAttempt);
      if (requestGenerationRef.current !== requestGeneration || success) return;

      if (finalAttempt) {
        setLoading(false);
        setUnavailable(true);
      } else {
        setRetryCount(current => current + 1);
      }
    }, RETRY_INTERVAL_MS);

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [history, loadSession, retryCount]);

  const handleManualRetry = () => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    setHistory(null);
    setLoading(true);
    setUnavailable(false);
    setRetryCount(0);
    void loadSession(requestGeneration).then(success => {
      if (!success && requestGenerationRef.current === requestGeneration) setRetryCount(1);
    });
  };

  const hasSavedResult = Boolean(run.summary?.trim() || run.error?.trim());

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        className="relative mx-4 flex h-[80vh] max-h-[800px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-surface/50 px-5 py-3">
          <h3
            className="truncate text-sm font-semibold text-foreground"
            title={title?.trim() || undefined}
          >
            {title?.trim() || i18nService.t('scheduledTasksViewSession')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading && (
            <div className="flex shrink-0 flex-col items-center justify-center gap-3 px-6 py-8">
              <svg className="h-5 w-5 animate-spin text-secondary" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  className="opacity-25"
                />
                <path
                  d="M4 12a8 8 0 018-8"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  className="opacity-75"
                />
              </svg>
              <span className="text-sm text-secondary">
                {retryCount > 0
                  ? `${i18nService.t('scheduledTasksSessionSyncing')} (${retryCount}/${MAX_RETRIES})`
                  : i18nService.t('loading')}
              </span>
            </div>
          )}

          {unavailable && (
            <div className="flex shrink-0 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
              <p className="text-sm font-medium text-foreground">
                {i18nService.t('scheduledTasksFullResultUnavailableTitle')}
              </p>
              <p className="max-w-lg text-sm text-secondary">
                {i18nService.t('scheduledTasksFullResultUnavailableDescription')}
              </p>
              <button
                type="button"
                onClick={handleManualRetry}
                className="mt-1 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-primary transition-colors hover:bg-surface-raised"
              >
                <ArrowPathIcon className="h-3.5 w-3.5" />
                {i18nService.t('scheduledTasksSessionRetry')}
              </button>
            </div>
          )}

          {!history && hasSavedResult && (
            <div className="mx-5 mb-5 overflow-y-auto rounded-xl border border-border bg-surface p-4">
              <p className="mb-2 text-xs font-medium text-secondary">
                {i18nService.t('scheduledTasksSavedResultFallback')}
              </p>
              {run.summary?.trim() && (
                <p className="whitespace-pre-wrap text-sm text-foreground">{run.summary}</p>
              )}
              {run.error?.trim() && (
                <p className="mt-2 whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">
                  {run.error}
                </p>
              )}
            </div>
          )}

          {!history && !loading && !hasSavedResult && (
            <div className="px-6 pb-8 text-center text-sm text-secondary">
              {i18nService.t('scheduledTasksFullResultEmpty')}
            </div>
          )}

          {history && (
            <ChatMessageDisplay
              gatewayMessages={history.messages as GatewayMessage[]}
              fullWidth
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default RunSessionModal;
