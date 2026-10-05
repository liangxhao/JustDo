import { useEffect, useState } from 'react';

export interface ExtensionEnablement {
  loaded: boolean;
  enabled: ReadonlyMap<string, boolean>;
  disabledRevisions: ReadonlyMap<string, number>;
}

export function getExtensionEnabled(
  settings: ExtensionEnablement,
  extensionId: string,
): boolean | undefined {
  return settings.enabled.get(extensionId) ?? (settings.loaded ? false : undefined);
}

/** One catalog read/subscription for all entries; newer toggles override in-flight reads by ID. */
export function useExtensionEnablement(): ExtensionEnablement {
  const [settings, setSettings] = useState<ExtensionEnablement>(() => ({
    loaded: false,
    enabled: new Map(),
    disabledRevisions: new Map(),
  }));
  useEffect(() => {
    let active = true;
    let requestRevision = 0;
    let changeRevision = 0;
    const changes = new Map<string, { revision: number; enabled: boolean }>();
    const refresh = async () => {
      const request = ++requestRevision;
      const observedChange = changeRevision;
      try {
        const result = await window.electron.extensions.list();
        if (!active || request !== requestRevision || !result.success) return;
        const enabled = new Map(result.extensions.map(item => [item.id, item.enabled]));
        for (const [id, change] of changes) {
          if (change.revision > observedChange) enabled.set(id, change.enabled);
        }
        setSettings(current => {
          const disabledRevisions = new Map(current.disabledRevisions);
          for (const [id, wasEnabled] of current.enabled) {
            if (wasEnabled && enabled.get(id) !== true) {
              disabledRevisions.set(id, (disabledRevisions.get(id) ?? 0) + 1);
            }
          }
          return { loaded: true, enabled, disabledRevisions };
        });
      } catch {
        // Keep observed settings while the runtime is temporarily unavailable.
      }
    };
    const stop = window.electron.extensions.onChanged(event => {
      if (!active) return;
      changes.set(event.extensionId, { revision: ++changeRevision, enabled: event.enabled });
      setSettings(current => ({
        loaded: current.loaded,
        enabled: new Map(current.enabled).set(event.extensionId, event.enabled),
        disabledRevisions: event.enabled
          ? current.disabledRevisions
          : new Map(current.disabledRevisions).set(
              event.extensionId,
              (current.disabledRevisions.get(event.extensionId) ?? 0) + 1,
            ),
      }));
    });
    window.addEventListener('focus', refresh);
    void refresh();
    return () => {
      active = false;
      stop();
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return settings;
}
