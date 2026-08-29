import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { selectIsOpenClawEngine } from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';

const EngineStartupStatusBar: React.FC = () => {
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  useEffect(() => {
    if (!isOpenClawEngine) return;

    const unsubscribe = coworkService.onOpenClawEngineStatus(s => {
      setStatus(s);
    });
    void coworkService.getOpenClawEngineStatus();

    return unsubscribe;
  }, [isOpenClawEngine]);

  if (!isOpenClawEngine || !status || status.phase === 'running') {
    return null;
  }

  const handleRestartGateway = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await coworkService.restartOpenClawGateway();
    } catch (error) {
      console.error('[EngineStartupStatusBar] Failed to restart gateway:', error);
    } finally {
      setIsRestarting(false);
    }
  };

  const statusText = (() => {
    switch (status.phase) {
      case 'ready':
        return i18nService.t('coworkOpenClawReadyNotice');
      case 'error':
        return i18nService.t('coworkOpenClawError');
      case 'starting':
      default:
        return i18nService.t('coworkOpenClawStarting');
    }
  })();

  const isError = status.phase === 'error';
  const isStarting = status.phase === 'starting';
  const showRestartButton = status.canRetry || status.phase === 'ready';

  return (
    <div className="pointer-events-auto max-w-full">
      <div
        role="status"
        aria-live="polite"
        className={`flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs shadow-subtle ${
          isError
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300'
            : 'border-border/70 bg-surface text-secondary'
        }`}
      >
        {isStarting ? (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-secondary/25 border-t-secondary will-change-transform"
          />
        ) : isError ? (
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
        ) : (
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-secondary/60" />
        )}
        <span className="min-w-0 truncate">{statusText}</span>
        {showRestartButton && (
          <button
            type="button"
            onClick={handleRestartGateway}
            disabled={isRestarting}
            className={`ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isError
                ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
                : 'bg-primary text-white hover:bg-primary-hover'
            }`}
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${isRestarting ? 'animate-spin' : ''}`} />
            <span>{i18nService.t('coworkOpenClawRestartGateway')}</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default EngineStartupStatusBar;
