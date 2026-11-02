import { useEffect, useState } from 'react';

import PluginActivityStatus, {
  PluginActivityTone,
} from '@/features/plugins/shared/PluginActivityStatus';
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
    <PluginActivityStatus
      message={i18nService.t('appPluginRestartRequired')}
      tone={PluginActivityTone.WARNING}
    />
  ) : null;
}
