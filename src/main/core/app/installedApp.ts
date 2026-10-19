import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

import { resolveAppUpdateFeedUrl } from '../../../config/appUpdate';

export const NSIS_INSTALL_MARKER = '.justdo-nsis-installed';
export const APP_UPDATE_CONFIG = 'app-update.yml';
export const AUTO_UPDATE_CONFIG_MARKER = '.justdo-auto-update-configured';

export const isNsisInstalledApp = ({
  isPackaged,
  platform,
  resourcesPath,
}: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}): boolean => {
  if (
    !isPackaged ||
    platform !== 'win32' ||
    !fs.existsSync(path.join(resourcesPath, NSIS_INSTALL_MARKER))
  )
    return false;
  try {
    const markerUrl = resolveAppUpdateFeedUrl(
      fs.readFileSync(path.join(resourcesPath, AUTO_UPDATE_CONFIG_MARKER), 'utf8'),
    );
    const config = yaml.load(fs.readFileSync(path.join(resourcesPath, APP_UPDATE_CONFIG), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
    const record = config as Record<string, unknown>;
    const feedUrl = resolveAppUpdateFeedUrl(record.url);
    return record.provider === 'generic' && feedUrl !== undefined && feedUrl === markerUrl;
  } catch {
    return false;
  }
};
