import type { StartupDowngradeConfirmation } from '@shared/app/initialization';
import { useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

/** Human continuation resumes Main's existing startup; it cannot mark any check complete. */
export default function DowngradeConfirmation({
  confirmation,
}: {
  confirmation: StartupDowngradeConfirmation;
}) {
  const pending = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const proceed = async () => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = await window.electron.initialization.confirmDowngrade({
        requestId: confirmation.requestId,
      });
      if (!result.confirmed) throw new Error('The startup confirmation is no longer current.');
    } catch {
      pending.current = false;
      setSubmitting(false);
      setError(i18nService.t('startupDowngradeContinueFailed'));
    }
  };
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-surface-raised p-5"
      aria-label={i18nService.t('startupDowngradeTitle')}
    >
      <h2 className="text-lg font-semibold text-foreground">
        {i18nService.t('startupDowngradeTitle')}
      </h2>
      <p className="text-sm leading-6 text-secondary">
        {i18nService.t('startupDowngradeDescription')}
      </p>
      <dl className="space-y-2 text-sm text-secondary">
        <div>
          <dt className="font-medium">{i18nService.t('startupDowngradePrevious')}</dt>
          <dd>
            {confirmation.source.appVersion} · OpenClaw {confirmation.source.runtimeVersion}
          </dd>
        </div>
        <div>
          <dt className="font-medium">{i18nService.t('startupDowngradeInstalled')}</dt>
          <dd>
            {confirmation.target.appVersion} · OpenClaw {confirmation.target.runtimeVersion}
          </dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={submitting}
        onClick={() => void proceed()}
        className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {i18nService.t(submitting ? 'startupDowngradeContinuing' : 'startupDowngradeContinue')}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
