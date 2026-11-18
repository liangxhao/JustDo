import { ArrowPathIcon, DocumentIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import { getBrowserLocalFilePath } from '@shared/browser/browserHistory';

import { i18nService } from '@/services/i18n';

import type { BrowserLoadError } from './browserLoadError';

export function BrowserLoadErrorPage({
  error,
  onRetry,
  disabled,
}: {
  error: BrowserLoadError;
  onRetry: () => void;
  disabled: boolean;
}) {
  const localFile = getBrowserLocalFilePath(error.url) !== null;
  const Icon = localFile ? DocumentIcon : GlobeAltIcon;

  return (
    <div role="alert" className="absolute inset-0 z-[5] overflow-auto bg-surface">
      <div className="flex min-h-full items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border border-border bg-surface-raised text-secondary">
            <Icon className="size-7" strokeWidth={1.5} aria-hidden="true" />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            {i18nService.t(localFile ? 'browserPanelFileErrorTitle' : 'browserPanelPageErrorTitle')}
          </h2>
          <p className="mt-2 text-sm leading-6 text-secondary [overflow-wrap:anywhere]">
            {error.message}
          </p>
          {error.code && (
            <p className="mt-3 font-mono text-[11px] text-muted [overflow-wrap:anywhere]">
              {error.code}
            </p>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={onRetry}
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowPathIcon className="size-4" aria-hidden="true" />
            {i18nService.t('browserPanelRetryLoad')}
          </button>
        </div>
      </div>
    </div>
  );
}
