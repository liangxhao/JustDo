import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  APP_UPDATE_CONFIG,
  AUTO_UPDATE_CONFIG_MARKER,
  isNsisInstalledApp,
  NSIS_INSTALL_MARKER,
} from './installedApp';

afterEach(() => vi.restoreAllMocks());

describe('isNsisInstalledApp', () => {
  test('requires Windows, a packaged app, the NSIS marker, and updater config', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    expect(
      isNsisInstalledApp({ isPackaged: true, platform: 'win32', resourcesPath: 'C:\\app' }),
    ).toBe(true);
    expect(existsSpy).toHaveBeenCalledWith(path.join('C:\\app', NSIS_INSTALL_MARKER));
    expect(existsSpy).toHaveBeenCalledWith(path.join('C:\\app', AUTO_UPDATE_CONFIG_MARKER));
    expect(existsSpy).toHaveBeenCalledWith(path.join('C:\\app', APP_UPDATE_CONFIG));
    expect(
      isNsisInstalledApp({ isPackaged: false, platform: 'win32', resourcesPath: 'C:\\app' }),
    ).toBe(false);
    expect(
      isNsisInstalledApp({ isPackaged: true, platform: 'darwin', resourcesPath: '/app' }),
    ).toBe(false);
  });

  test('rejects win-unpacked directories without the marker', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(
      isNsisInstalledApp({ isPackaged: true, platform: 'win32', resourcesPath: 'C:\\unpacked' }),
    ).toBe(false);
  });

  test('rejects local validation installs without packaged updater config', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(filePath =>
      [NSIS_INSTALL_MARKER, AUTO_UPDATE_CONFIG_MARKER].some(fileName =>
        String(filePath).endsWith(fileName),
      ),
    );

    expect(
      isNsisInstalledApp({ isPackaged: true, platform: 'win32', resourcesPath: 'C:\\app' }),
    ).toBe(false);
  });
});
