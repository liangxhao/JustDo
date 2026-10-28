import './HistoryUpgradeResult.css';

import {
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  FolderIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { StartupSupportAction } from '@shared/app/startup/history';
import type { StartupHistorySummary } from '@shared/app/startup/routing';

import { i18nService } from '@/services/i18n';

import StartupSupportButton from './StartupSupportButton';

const LEGACY_PROJECT_RULE_FILES = [
  'AGENTS.md',
  'BOOT.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
] as const;

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
    <div data-history-result="true" className="history-upgrade-result">
      <section
        className="history-result-summary"
        aria-label={i18nService.t('initializationResultTitle')}
      >
        <h2 className="history-result-heading">
          <CheckCircleIcon aria-hidden="true" />
          {i18nService.t('initializationResultTitle')}
        </h2>
        <dl className="history-result-counts">
          {items.map(item => (
            <div key={item.label} data-warning={item.warning && item.count > 0}>
              <dt>{i18nService.t(item.label)}</dt>
              <dd>{item.count}</dd>
            </div>
          ))}
        </dl>
        <details className="history-result-details">
          <summary>
            {i18nService.t('initializationResultDetails')}
            <ChevronDownIcon aria-hidden="true" />
          </summary>
          <div className="history-result-detail-content">
            <p>{i18nService.t('initializationResultDescription')}</p>
            {(summary.unavailableConversations > 0 || (summary.unavailableWorkspaces ?? 0) > 0) && (
              <p>{i18nService.t('initializationResultIncomplete')}</p>
            )}
            {backupPath && (
              <div className="history-result-backup">
                <p>{i18nService.t('initializationResultBackup')}</p>
                <p className="history-result-backup-path">{backupPath}</p>
                <StartupSupportButton
                  action={StartupSupportAction.OpenBackup}
                  label="initializationOpenBackup"
                />
              </div>
            )}
          </div>
        </details>
      </section>
      <section
        className="history-project-reminder"
        aria-label={i18nService.t('initializationProjectRulesTitle')}
      >
        <header className="history-project-heading">
          <FolderIcon aria-hidden="true" />
          <h2>{i18nService.t('initializationProjectRulesTitle')}</h2>
          <span>{i18nService.t('initializationProjectRulesWhen')}</span>
        </header>
        <p className="history-project-intro">
          {i18nService.t('initializationProjectRulesDescription')}
        </p>
        <ol className="history-project-steps">
          <li>
            <h3>{i18nService.t('initializationProjectRulesRemoveTitle')}</h3>
            <p>{i18nService.t('initializationProjectRulesRemoveDescription')}</p>
            <ul
              className="history-project-files"
              aria-label={i18nService.t('initializationProjectRulesFiles')}
            >
              {LEGACY_PROJECT_RULE_FILES.map(file => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </li>
          <li>
            <h3>
              {i18nService.t('initializationProjectRulesAddTitle')}
              <span className="history-project-optional">
                {i18nService.t('initializationProjectRulesOptional')}
              </span>
            </h3>
            <ul className="history-project-guidance">
              <li>{i18nService.t('initializationProjectRulesAddDescription')}</li>
              <li>{i18nService.t('initializationProjectRulesReuseDescription')}</li>
              <li className="history-project-context">
                {i18nService.t('initializationProjectRulesContext')}
              </li>
              <li>{i18nService.t('initializationProjectRulesLegacyWarning')}</li>
            </ul>
          </li>
        </ol>
      </section>
      <footer className="history-result-footer">
        <p>
          <InformationCircleIcon aria-hidden="true" />
          {i18nService.t('initializationProjectRulesManual')}
        </p>
        <button
          type="button"
          onClick={onContinue}
          className="history-result-continue rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {i18nService.t('initializationResultContinue')}
          <ArrowRightIcon aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}
