import fs from 'fs';
import path from 'path';

import { t } from '../../core/i18n';

/** Shared format boundary for local imports and downloaded marketplace extensions. */
export const assertNativeExtensionDirectory = (pluginDirectory: string): void => {
  // Detect only the native manifest marker. OpenClaw owns schema and runtime entry
  // validation; malformed native manifests must keep their native error.
  if (fs.existsSync(path.join(pluginDirectory, 'openclaw.plugin.json'))) return;
  throw new Error(t('extensionConversionNotImplemented'));
};
