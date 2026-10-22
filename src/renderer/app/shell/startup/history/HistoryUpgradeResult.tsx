import { CheckCircleIcon } from '@heroicons/react/24/outline';
import { StartupSupportAction } from '@shared/app/startup/history';
import type { StartupHistorySummary } from '@shared/app/startup/routing';

import { i18nService } from '@/services/i18n';

import StartupSupportButton from './StartupSupportButton';

export default function HistoryUpgradeResult({
  summary,
  backupPath,
  onContinue,
}: {
  summary: StartupHistorySummary;
  backupPath?: string;
  onContinue: () => void;
}) {
  const items = [
    { label: 'initializationResultConversations', count: summary.conversations, warning: false },
    {
      label: 'initializationResultMissing',
      count: summary.unavailableConversations,
      warning: true,
    },
    {
      label: 'initializationResultWorkspaces',
      count: summary.unavailableWorkspaces ?? 0,
      warning: true,
    },
  ];
  return (
    <div
      data-history-result="true"
      role="region"
      aria-label={i18nService.t('initializationResultTitle')}
    >
      <CheckCircleIcon aria-hidden="true" className="mb-4 h-10 w-10 text-primary" />
      <h2 className="text-xl font-semibold">{i18nService.t('initializationResultTitle')}</h2>
      <p className="mt-3 text-sm leading-6 text-secondary">
        {i18nService.t('initializationResultDescription')}
      </p>
      <dl className="my-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map(item => (
          <div
            key={item.label}
            className={`rounded-xl border p-4 ${item.warning && item.count ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' : 'border-border-subtle bg-surface-raised/50'}`}
          >
            <dt className="text-xs leading-5 text-secondary">{i18nService.t(item.label)}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums">{item.count}</dd>
          </div>
        ))}
      </dl>
      {(summary.unavailableConversations > 0 || (summary.unavailableWorkspaces ?? 0) > 0) && (
        <p className="mb-5 text-xs leading-6 text-secondary">
          {i18nService.t('initializationResultIncomplete')}
        </p>
      )}
      {backupPath && (
        <div className="mb-6 rounded-xl border border-border-subtle p-4">
          <p className="text-xs font-medium text-secondary">
            {i18nService.t('initializationResultBackup')}
          </p>
          <p className="my-3 select-text break-all text-xs leading-5 text-secondary">
            {backupPath}
          </p>
          <StartupSupportButton
            action={StartupSupportAction.OpenBackup}
            label="initializationOpenBackup"
          />
        </div>
      )}
      <button
        type="button"
        onClick={onContinue}
        className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {i18nService.t('initializationResultContinue')}
      </button>
    </div>
  );
}
