import fs from 'fs';
import path from 'path';

import { t } from '../../core/i18n';

export type ExtensionConversionInput = {
  sourcePath: string;
  pluginDirectory: string;
};

/** Shared format boundary for local imports and downloaded marketplace extensions. */
export const prepareExtensionForInstall = async (
  input: ExtensionConversionInput,
): Promise<ExtensionConversionInput> => {
  // Detect only the native manifest marker. OpenClaw owns schema and runtime entry
  // validation; malformed native manifests must keep their native error.
  if (fs.existsSync(path.join(input.pluginDirectory, 'openclaw.plugin.json'))) {
    return input;
  }
  throw new Error(t('extensionConversionNotImplemented'));
};
