import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
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
    <div className="pointer-events-auto max-w-full">
      <div
        className={`flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs shadow-subtle ${
          installError
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300'
            : 'border-border/70 bg-surface text-secondary'
        }`}
        role="status"
        aria-live="polite"
        aria-busy={installing}
      >
        {installError ? (
          <ExclamationTriangleIcon
            className="h-4 w-4 shrink-0 text-red-600 dark:text-red-300"
            aria-hidden="true"
          />
        ) : (
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {installError
            ? i18nService.t('appUpdateStatusInstallError')
            : i18nService.t('appUpdateToastTitle')}
          {availableVersion ? ` (${availableVersion})` : ''}
        </span>
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          className={`ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            installError
              ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
              : 'bg-primary text-white hover:bg-primary-hover'
          }`}
        >
          {installing && (
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          {i18nService.t('appUpdateRestartAndInstall')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={installing}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={i18nService.t('appUpdateLater')}
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default AppUpdateToast;
