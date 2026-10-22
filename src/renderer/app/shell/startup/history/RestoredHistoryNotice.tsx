import type { HistorySessionBinding } from '@shared/app/startup/history';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

export default function RestoredHistoryNotice({
  sessionId,
  binding,
  onWorkspaceChanged,
}: {
  sessionId: string;
  binding?: HistorySessionBinding;
  onWorkspaceChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!binding || (binding.availability !== 'missing' && !binding.workspaceUnavailable))
    return null;
  const select = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await window.electron.initialization.selectHistoryWorkspace({ sessionId });
      if (result.success) await onWorkspaceChanged();
      else if (!result.cancelled) setError(i18nService.t('startupHistoryWorkspaceFailed'));
    } catch {
      setError(i18nService.t('startupHistoryWorkspaceFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      className="mx-4 my-2 rounded-xl border border-border bg-surface-raised p-3 text-xs leading-5 text-secondary"
      role="status"
    >
      {binding.availability === 'missing' && <p>{i18nService.t('startupHistoryUnavailable')}</p>}
      {binding.workspaceUnavailable && (
        <div>
          <p>{i18nService.t('startupHistoryWorkspaceUnavailable')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void select()}
            className="mt-2 rounded-md bg-primary px-3 py-1.5 text-white disabled:opacity-50"
          >
            {i18nService.t('startupHistoryChooseWorkspace')}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-600 dark:text-red-300">
          {error}
        </p>
      )}
    </aside>
  );
}
