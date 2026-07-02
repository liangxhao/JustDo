import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useState } from 'react';

import { ChatController } from '../../libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '../../services/i18n';
import ChatMessageDisplay from '../cowork/ChatMessageDisplay';
import { connectToGateway } from '../cowork/JustDoChatWrapper';

interface RunSessionModalProps {
  sessionId?: string | null;
  sessionKey?: string | null;
  onClose: () => void;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 3000;

const RunSessionModal: React.FC<RunSessionModalProps> = ({ sessionKey, onClose }) => {
  const [controller, setController] = useState<ChatController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    if (!sessionKey) {
      setLoading(false);
      setError(i18nService.t('scheduledTasksSessionNotSynced'));
      return;
    }

    const nextController = new ChatController();
    nextController.state.sessionKey = sessionKey;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setController(nextController);
    setLoading(true);
    setError(null);
    setRetryCount(0);

    const connect = async (attempt: number): Promise<void> => {
      try {
        const success = await connectToGateway(nextController);
        if (cancelled) return;
        if (success) {
          setLoading(false);
          setError(null);
          return;
        }
      } catch {
        // Retry below while the scheduled session is still being registered.
      }
      if (cancelled) return;
      if (attempt >= MAX_RETRIES) {
        setLoading(false);
        setError(i18nService.t('scheduledTasksSessionNotSynced'));
        return;
      }
      setRetryCount(attempt + 1);
      retryTimer = setTimeout(() => void connect(attempt + 1), RETRY_INTERVAL_MS);
    };

    void connect(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      nextController.disconnect();
      setController(current => (current === nextController ? null : current));
    };
  }, [connectionAttempt, sessionKey]);

  const handleManualRetry = useCallback(() => {
    setConnectionAttempt(attempt => attempt + 1);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col rounded-2xl shadow-2xl bg-background border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle bg-surface/50 shrink-0">
          <h3 className="text-sm font-semibold text-foreground truncate">
            {i18nService.t('scheduledTasksViewSession')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="w-5 h-5 animate-spin text-secondary" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="text-sm text-secondary">
                {retryCount > 0
                  ? `${i18nService.t('scheduledTasksSessionSyncing')} (${retryCount}/${MAX_RETRIES})`
                  : i18nService.t('loading')}
              </span>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-sm text-secondary">{error}</span>
              <button
                type="button"
                onClick={handleManualRetry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-primary hover:bg-surface-raised transition-colors"
              >
                <ArrowPathIcon className="w-3.5 h-3.5" />
                {i18nService.t('scheduledTasksSessionRetry')}
              </button>
            </div>
          )}

          {!loading && !error && (
            <ChatMessageDisplay controller={controller} fullWidth />
          )}
        </div>
      </div>
    </div>
  );
};

export default RunSessionModal;
