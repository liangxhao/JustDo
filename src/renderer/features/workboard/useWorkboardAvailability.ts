import { OpenClawExtensionId } from '@shared/openclaw/extensions';
import { useEffect, useState } from 'react';

export function useWorkboardAvailability(initialized: boolean): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!initialized) return;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const requestedRevision = ++revision;
      try {
        const result = await window.electron.extensions.list();
        if (active && requestedRevision === revision && result.success) {
          setEnabled(
            result.extensions.some(
              extension => extension.id === OpenClawExtensionId.WORKBOARD && extension.enabled,
            ),
          );
        }
      } catch {
        // Preserve the last known setting while the Gateway is unavailable.
      }
    };
    const stopExtensions = window.electron.extensions.onChanged(event => {
      if (event.extensionId !== OpenClawExtensionId.WORKBOARD) return;
      revision += 1;
      if (active) setEnabled(event.enabled);
    });
    const stopWorkboard = window.electron.workboard.onChanged(() => void refresh());
    void refresh();
    return () => {
      active = false;
      stopExtensions();
      stopWorkboard();
    };
  }, [initialized]);
  return enabled;
}
