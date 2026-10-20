import { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

/** A pending Gateway reload never requires closing the application. */
export default function AppPluginRestartNotice() {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    if (!window.electron?.appPlugins) return;
    let live = true;
    let changed = false;
    const update = (snapshots: Awaited<ReturnType<typeof window.electron.appPlugins.snapshot>>) => {
      if (live) setRequired(snapshots.some(snapshot => snapshot.restartRequired));
    };
    const release = window.electron.appPlugins.onChanged(snapshots => {
      changed = true;
      update(snapshots);
    });
    void window.electron.appPlugins
      .snapshot()
      .then(snapshots => {
        if (!changed) update(snapshots);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      release();
    };
  }, []);
  return required ? (
    <p
      role="status"
      className="mb-3 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm text-secondary"
    >
      {i18nService.t('appPluginRestartRequired')}
    </p>
  ) : null;
}
