import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  APP_UPDATE_CONFIG,
  AUTO_UPDATE_CONFIG_MARKER,
  isNsisInstalledApp,
  NSIS_INSTALL_MARKER,
} from './installedApp';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function installedFixture(url = 'https://updates.corp.internal/desktop') {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-update-'));
  directories.push(resourcesPath);
  fs.writeFileSync(path.join(resourcesPath, NSIS_INSTALL_MARKER), 'installed');
  fs.writeFileSync(path.join(resourcesPath, AUTO_UPDATE_CONFIG_MARKER), `${url}\n`);
  fs.writeFileSync(
    path.join(resourcesPath, APP_UPDATE_CONFIG),
    `provider: generic\nurl: ${JSON.stringify(url)}\n`,
  );
  return { isPackaged: true, platform: 'win32' as NodeJS.Platform, resourcesPath };
}

describe('isNsisInstalledApp', () => {
  test('enables updates only for a Windows packaged install with matching explicit feed artifacts', () => {
    const fixture = installedFixture();
    expect(isNsisInstalledApp(fixture)).toBe(true);
    expect(isNsisInstalledApp({ ...fixture, isPackaged: false })).toBe(false);
    expect(isNsisInstalledApp({ ...fixture, platform: 'darwin' })).toBe(false);
  });

  test.each([NSIS_INSTALL_MARKER, AUTO_UPDATE_CONFIG_MARKER, APP_UPDATE_CONFIG])(
    'rejects an install missing %s',
    filename => {
      const fixture = installedFixture();
      fs.unlinkSync(path.join(fixture.resourcesPath, filename));
      expect(isNsisInstalledApp(fixture)).toBe(false);
    },
  );

  test.each([
    '',
    'https://xxx.com/electron-app-update',
    'https://sub.example.com/feed',
    'file:///updates',
    'invalid',
  ])('rejects inherited packaged placeholder config: %s', url => {
    expect(isNsisInstalledApp(installedFixture(url))).toBe(false);
  });

  test('rejects a marker that differs from the actual app-update.yml service', () => {
    const fixture = installedFixture();
    fs.writeFileSync(
      path.join(fixture.resourcesPath, AUTO_UPDATE_CONFIG_MARKER),
      'https://different.corp.internal/desktop',
    );
    expect(isNsisInstalledApp(fixture)).toBe(false);
  });

  test.each([
    'provider: github\nurl: https://updates.corp.internal/desktop',
    'url: [not-a-scalar]',
    '"unterminated',
  ])('rejects invalid or unsupported updater YAML', content => {
    const fixture = installedFixture();
    fs.writeFileSync(path.join(fixture.resourcesPath, APP_UPDATE_CONFIG), content);
    expect(isNsisInstalledApp(fixture)).toBe(false);
  });
});
