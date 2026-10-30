import { useSyncExternalStore } from 'react';

let availability: { loaded: boolean; enabled: boolean | null; disabledRevision: number } = { loaded: true, enabled: true, disabledRevision: 0 };
const listeners = new Set<() => void>();
export function setTestExtensionAvailability(enabled: boolean | null) {
  availability = { loaded: enabled !== null, enabled, disabledRevision: availability.disabledRevision + (enabled === false ? 1 : 0) };
  listeners.forEach(listener => listener());
}
export const useExtensionAvailability = (_id: string) => useSyncExternalStore(
  listener => { listeners.add(listener); return () => listeners.delete(listener); },
  () => availability,
);
export const useExtensionEnabled = (id: string) => useExtensionAvailability(id).enabled === true;
