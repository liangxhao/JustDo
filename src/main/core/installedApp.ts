import fs from 'fs';
import path from 'path';

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
}): boolean =>
  isPackaged &&
  platform === 'win32' &&
  fs.existsSync(path.join(resourcesPath, NSIS_INSTALL_MARKER)) &&
  fs.existsSync(path.join(resourcesPath, AUTO_UPDATE_CONFIG_MARKER)) &&
  fs.existsSync(path.join(resourcesPath, APP_UPDATE_CONFIG));
