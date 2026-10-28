import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { AppInitializationTaskStatus } from '@shared/app/initialization';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import { selectIsOpenClawEngine } from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import EngineDiagnosticsModal from './EngineDiagnosticsModal';
import { refreshEngineReadiness, useEngineReadiness } from './startup/routing/useEngineReadiness';

const EngineStartupStatusBar: React.FC = () => {
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const readiness = useEngineReadiness();
  const status = readiness.status;
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showReason, setShowReason] = useState(false);

  useEffect(() => {
    setStartError(null);
    if (readiness.ready) setShowReason(false);
  }, [status, readiness.ready]);

  if (!isOpenClawEngine) return null;
  if (readiness.ready && !startError) {
    const servicesFailed = readiness.integrationsStatus === AppInitializationTaskStatus.Failed;
    const servicesPending = readiness.integrationsStatus === AppInitializationTaskStatus.Running ||
      readiness.integrationsStatus === AppInitializationTaskStatus.Waiting;
    return servicesFailed || servicesPending ? (
      <div role="status" aria-live="polite" className="non-draggable truncate text-xs text-secondary">
        {i18nService.t(servicesFailed ? 'localServicesFailed' : 'localServicesStarting')}
      </div>
    ) : null;
  }

  const handleStart = async () => {
    if (isStarting) return;
    setIsStarting(true);
    setStartError(null);
    try {
      await coworkService.startOpenClawGateway();
      await refreshEngineReadiness();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsStarting(false);
    }
  };

  const isError = !isStarting && (readiness.failed || startError !== null);
  const isBusy = !isError && (isStarting || readiness.pending);
  const statusText = isError
    ? i18nService.t('engineStartFailed')
    : i18nService.t(status?.restarting ? 'engineRestarting' : 'engineStarting');

  return (
    <div className="non-draggable min-w-0 max-w-full text-xs">
      <div
        role="status"
        aria-live="polite"
        className={`flex h-6 min-w-0 items-center gap-1.5 ${isError ? 'text-red-600 dark:text-red-300' : 'text-secondary'}`}
      >
        {isBusy ? (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-secondary/25 border-t-secondary will-change-transform"
          />
        ) : isError ? (
          <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
        ) : null}
        {(isBusy || isError) && <span className="min-w-0 truncate">{statusText}</span>}
        {isError ? (
          <button
            type="button"
            onClick={() => setShowReason(true)}
            className="shrink-0 rounded px-1 py-0.5 font-medium underline underline-offset-2 hover:bg-surface-raised"
          >
            {i18nService.t('engineViewReason')}
          </button>
        ) : !isBusy ? (
          <button
            type="button"
            onClick={() => void handleStart()}
            className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-surface-raised"
          >
            {i18nService.t('engineStart')}
          </button>
        ) : null}
      </div>
      {showReason &&
        isError &&
        createPortal(
          <EngineDiagnosticsModal
            key={status?.diagnosticId ?? readiness.failure?.occurredAt ?? 'engine-command'}
            status={status ? { ...status,
              canRetry: status.canRetry || Boolean(readiness.failure || startError),
            } : { phase: EnginePhase.Error, version: null, canRetry: true }}
            commandError={startError ?? readiness.failure?.error.message ?? null}
            onClose={() => setShowReason(false)}
            onStart={() => {
              setShowReason(false);
              void handleStart();
            }}
          />,
          document.body,
        )}
    </div>
  );
};

export default EngineStartupStatusBar;
