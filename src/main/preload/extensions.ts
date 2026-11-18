import {
  type ExtensionChangedEvent,
  ExtensionIpc,
  type ExtensionRemovalConfirmedEvent,
} from '../../shared/plugins/extensions';
import { createIpcSubscription } from './ipcSubscription';

/** Each window shares one IPC listener, regardless of how many extension cards are mounted. */
export function createExtensionChangedSubscription() {
  return createIpcSubscription(
    ExtensionIpc.Changed,
    (event: ExtensionChangedEvent) => event,
    error => console.error('[ExtensionsPreload] Change listener failed:', error),
  );
}

export function createExtensionRemovalConfirmedSubscription() {
  return createIpcSubscription(
    ExtensionIpc.RemovalConfirmed,
    (event: ExtensionRemovalConfirmedEvent) => event,
    error => console.error('[ExtensionsPreload] Removal listener failed:', error),
  );
}
