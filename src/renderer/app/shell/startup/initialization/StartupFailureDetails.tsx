import { type StartupFailure, startupFailureText } from '@shared/app/startupFailure';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

import StartupLogButton from './StartupLogButton';
/** Shared diagnostic capability; each startup flow retains its own presentation. */
export default function StartupFailureDetails({ failure }: { failure: StartupFailure }) {
  const [notice, setNotice] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(startupFailureText(failure));
      setNotice('startupDiagnosticsCopied');
    } catch {
      setNotice('startupDiagnosticsCopyFailed');
    }
  };
  return (
    <div className="startup-failure-report">
      <StartupLogButton />
      <details className="startup-failure-details">
        <summary>
          {i18nService.t('startupDiagnosticsDetails')} ·{' '}
          {i18nService.t(`startupFailure_${failure.source}`)}
        </summary>
        <p>{i18nService.t('startupDiagnosticsEvidence')}</p>
        <pre>{startupFailureText(failure)}</pre>
        <button type="button" className="startup-action" onClick={() => void copy()}>
          {i18nService.t('startupDiagnosticsCopy')}
        </button>
        {notice && <p role="status">{i18nService.t(notice)}</p>}
      </details>
    </div>
  );
}
