import type { StartupSupportAction } from '@shared/app/startup/history';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

export default function StartupSupportButton({
  action,
  label,
}: {
  action: StartupSupportAction;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.electron.initialization.openSupport(action);
      setFailed(!result.success);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-raised disabled:opacity-50"
      >
        {i18nService.t(label)}
      </button>
      {failed && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-300">
          {i18nService.t('initializationSupportFailed')}
        </p>
      )}
    </div>
  );
}
