import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type {
  OpenClawSessionMigrationPlan,
  OpenClawSessionMigrationProgress,
} from '@shared/openclaw/sessionMigration';
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { selectIsOpenClawEngine } from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

const EngineStartupStatusBar: React.FC = () => {
  const isOpenClawEngine = useSelector(selectIsOpenClawEngine);
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [migrationPlan, setMigrationPlan] = useState<OpenClawSessionMigrationPlan | null>(null);
  const [migrationProgress, setMigrationProgress] =
    useState<OpenClawSessionMigrationProgress | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);

  useEffect(() => {
    if (!isOpenClawEngine) return;

    const migrationApi = window.electron?.openclaw?.engine?.migration;
    const refreshMigrationPlan = () => {
      void migrationApi?.plan().then(result => {
        setMigrationPlan(result.success ? (result.plan ?? null) : null);
      });
    };
    const unsubscribe = coworkService.onOpenClawEngineStatus(s => {
      setStatus(s);
      if (s.phase === 'error') refreshMigrationPlan();
    });
    const unsubscribeMigration = migrationApi?.onProgress(progress => {
      setMigrationProgress(progress);
      if (progress.phase === 'completed') setShowMigration(false);
    });
    void coworkService.getOpenClawEngineStatus();
    refreshMigrationPlan();

    return () => {
      unsubscribe();
      unsubscribeMigration?.();
    };
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
  const migrationRequired = migrationPlan?.required === true;
  const showRestartButton = !migrationRequired && (status.canRetry || status.phase === 'ready');

  const handleMigrationDecision = async (approved: boolean) => {
    if (!migrationPlan?.planId || isMigrating) return;
    if (!approved) {
      await window.electron.openclaw.engine.migration.confirm({
        planId: migrationPlan.planId,
        approved: false,
      });
      setShowMigration(false);
      return;
    }
    setIsMigrating(true);
    try {
      const result = await window.electron.openclaw.engine.migration.confirm({
        planId: migrationPlan.planId,
        approved: true,
      });
      if (!result.success && result.error) {
        setMigrationPlan(current =>
          current ? { ...current, phase: 'failed', error: result.error } : current,
        );
      }
    } finally {
      setIsMigrating(false);
    }
  };

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
        <span className="min-w-0 truncate">
          {migrationRequired ? i18nService.t('coworkOpenClawMigrationRequired') : statusText}
        </span>
        {migrationRequired && (
          <button
            type="button"
            onClick={() => setShowMigration(true)}
            className="ml-1 inline-flex h-6 shrink-0 items-center rounded-md bg-red-600 px-2 font-medium text-white transition-colors hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
          >
            {i18nService.t('coworkOpenClawReviewMigration')}
          </button>
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
      {showMigration && migrationPlan && (
        <Modal
          onClose={() => {
            if (!isMigrating) setShowMigration(false);
          }}
          className="mx-4 w-full max-w-lg overflow-hidden rounded-2xl bg-surface shadow-xl"
        >
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="rounded-full bg-amber-100 p-2 dark:bg-amber-900/30">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-700 dark:text-amber-300" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('coworkOpenClawMigrationTitle')}
            </h2>
          </div>
          <div className="space-y-3 px-5 pb-5 text-sm text-secondary">
            <p>{i18nService.t('coworkOpenClawMigrationDescription')}</p>
            <p>
              {i18nService.t('coworkOpenClawMigrationSources')}: {migrationPlan.sourceCount} ·{' '}
              {migrationPlan.agents.join(', ')}
            </p>
            {migrationPlan.dryRun?.sessionCount !== undefined && (
              <p>
                {i18nService.t('coworkOpenClawMigrationSessions')}:{' '}
                {migrationPlan.dryRun.sessionCount}
              </p>
            )}
            {migrationProgress && (
              <p role="status">
                {i18nService.t('coworkOpenClawMigrationProgress')}:{' '}
                {migrationProgress.completedSteps}/{migrationProgress.totalSteps} ·{' '}
                {migrationProgress.phase}
              </p>
            )}
            {migrationPlan.error && <p className="text-red-600">{migrationPlan.error}</p>}
          </div>
          <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
            <button
              type="button"
              disabled={isMigrating}
              onClick={() => void handleMigrationDecision(false)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              disabled={isMigrating || migrationPlan.phase === 'failed'}
              onClick={() => void handleMigrationDecision(true)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {isMigrating
                ? i18nService.t('coworkOpenClawMigrationRunning')
                : i18nService.t('coworkOpenClawMigrationConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default EngineStartupStatusBar;
