import {
  type ExtensionEnablement,
  getExtensionEnabled,
} from '@/features/plugins/extensions/useExtensionEnablement';

import type { ComposerFeatureItem } from './ComposerFeatureMenu';

export interface ComposerFeatureRegistration extends ComposerFeatureItem {
  /** Omit for a built-in capability; each plugin may register multiple distinct entries. */
  extensionId?: string;
}

/** Adapters own their translated presentation and actions; only availability is shared. */
export function buildComposerFeatures(
  registrations: readonly ComposerFeatureRegistration[],
  settings: ExtensionEnablement,
): ComposerFeatureItem[] {
  return registrations
    .filter(item => !item.extensionId || getExtensionEnabled(settings, item.extensionId) === true)
    .map(({ extensionId: _extensionId, ...item }) => item);
}
