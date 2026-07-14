import {
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
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

    coworkService.getOpenClawEngineStatus().then(s => {
      if (s) setStatus(s);
    });

    const unsubscribe = coworkService.onOpenClawEngineStatus(s => {
      setStatus(s);
    });

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

  const progressPercent =
    typeof status.progressPercent === 'number'
      ? Math.max(0, Math.min(100, Math.round(status.progressPercent)))
      : null;
  const isError = status.phase === 'error';
  const showRestartButton = status.canRetry || status.phase === 'ready';
  const Icon = isError ? ExclamationTriangleIcon : ChatBubbleLeftRightIcon;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-[min(520px,calc(100vw-2rem))]">
      <div
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-xs shadow-card backdrop-blur ${
          isError
            ? 'border-red-200 bg-red-50/95 text-red-700 dark:border-red-900/60 dark:bg-red-950/80 dark:text-red-300'
            : 'border-border bg-surface/95 text-foreground'
        }`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${status.phase === 'starting' ? 'animate-pulse' : ''} ${
            isError ? 'text-red-600 dark:text-red-300' : 'text-primary'
          }`}
        />
        <span className="min-w-0 truncate">{statusText}</span>
        {progressPercent !== null && (
          <>
            <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-primary/15">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-secondary">{progressPercent}%</span>
          </>
        )}
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
