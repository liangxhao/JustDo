import { ArrowPathIcon, CheckCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';

type AppUpdateToastProps = {
  availableVersion?: string;
  installError: boolean;
  installing: boolean;
  onDismiss: () => void;
  onInstall: () => void;
};

const AppUpdateToast: React.FC<AppUpdateToastProps> = ({
  availableVersion,
  installError,
  installing,
  onDismiss,
  onInstall,
}) => {
  return (
    <div
      className="fixed bottom-4 right-4 z-[80] w-[min(340px,calc(100vw-2rem))] rounded-xl border border-border bg-surface/95 p-3.5 text-foreground shadow-xl backdrop-blur-md"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-green-500/10 p-1.5 text-green-600 dark:text-green-400">
          <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{i18nService.t('appUpdateToastTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('appUpdateToastDescription')}
            {availableVersion ? ` (${availableVersion})` : ''}
          </p>
          {installError && (
            <p className="mt-1 text-xs text-danger" role="alert">
              {i18nService.t('appUpdateStatusInstallError')}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={onInstall}
              disabled={installing}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing && (
                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {i18nService.t('appUpdateRestartAndInstall')}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="h-7 rounded-md px-2.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              {i18nService.t('appUpdateLater')}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default AppUpdateToast;
