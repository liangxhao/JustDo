import { useSyncExternalStore } from 'react';

import {
  getEngineReadinessSnapshot,
  subscribeEngineReadiness,
} from '@/app/shell/startup/routing/useEngineReadiness';

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

/** Feature entrances require positively observed enablement. */
export function useExtensionEnabled(extensionId: string): boolean {
  return useExtensionAvailability(extensionId).enabled;
}

/** Disable revisions also retire open UI across batched disable/enable changes. */
export function useExtensionAvailability(extensionId: string) {
  const settings = useExtensionEnablement();
  const enabled = getExtensionEnabled(settings, extensionId);
  return {
    loaded: enabled !== undefined,
    enabled: enabled === true,
    disabledRevision: settings.disabledRevisions.get(extensionId) ?? 0,
  };
}

const EMPTY_SETTINGS: ExtensionEnablement = {
  loaded: false,
  enabled: new Map(),
  disabledRevisions: new Map(),
};
let settingsSnapshot = EMPTY_SETTINGS;
let stopObserving: (() => void) | undefined;
const subscribers = new Set<() => void>();

function publishSettings(settings: ExtensionEnablement): void {
  settingsSnapshot = settings;
  for (const subscriber of subscribers) subscriber();
}

function startObserving(): void {
  if (stopObserving) return;
  let active = true;
  let requestRevision = 0;
  let changeRevision = 0;
  const changes = new Map<string, { revision: number; enabled: boolean }>();
  const refresh = async () => {
    if (!getEngineReadinessSnapshot().ready) return;
    const request = ++requestRevision;
    const observedChange = changeRevision;
    try {
      const result = await window.electron.extensions.list();
      if (!active || request !== requestRevision || !result.success) return;
      const enabled = new Map(result.extensions.map(item => [item.id, item.enabled]));
      for (const [id, change] of changes) {
        if (change.revision > observedChange) enabled.set(id, change.enabled);
      }
      const disabledRevisions = new Map(settingsSnapshot.disabledRevisions);
      for (const [id, wasEnabled] of settingsSnapshot.enabled) {
        if (wasEnabled && enabled.get(id) !== true) {
          disabledRevisions.set(id, (disabledRevisions.get(id) ?? 0) + 1);
        }
      }
      publishSettings({ loaded: true, enabled, disabledRevisions });
    } catch {
      // Keep observed settings while the runtime is temporarily unavailable.
    }
  };
  const stop = window.electron.extensions.onChanged(event => {
    if (!active) return;
    changes.set(event.extensionId, { revision: ++changeRevision, enabled: event.enabled });
    publishSettings({
      loaded: settingsSnapshot.loaded,
      enabled: new Map(settingsSnapshot.enabled).set(event.extensionId, event.enabled),
      disabledRevisions: event.enabled
        ? settingsSnapshot.disabledRevisions
        : new Map(settingsSnapshot.disabledRevisions).set(
            event.extensionId,
            (settingsSnapshot.disabledRevisions.get(event.extensionId) ?? 0) + 1,
          ),
    });
  });
  let wasReady = getEngineReadinessSnapshot().ready;
  const stopEngine = subscribeEngineReadiness(() => {
    const ready = getEngineReadinessSnapshot().ready;
    if (!ready) requestRevision += 1;
    if (ready && !wasReady) void refresh();
    wasReady = ready;
  });
  window.addEventListener('focus', refresh);
  stopObserving = () => {
    active = false;
    stop();
    stopEngine();
    window.removeEventListener('focus', refresh);
  };
  void refresh();
}

function subscribeSettings(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  startObserving();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size) return;
    stopObserving?.();
    stopObserving = undefined;
    settingsSnapshot = EMPTY_SETTINGS;
  };
}

/** Share one observed catalog across entrances and mounted panels; newer toggles win by ID. */
export function useExtensionEnablement(): ExtensionEnablement {
  return useSyncExternalStore(
    subscribeSettings,
    () => settingsSnapshot,
    () => EMPTY_SETTINGS,
  );
}
