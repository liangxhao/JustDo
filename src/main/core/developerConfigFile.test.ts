import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import packageJson from '../../../package.json';
import {
  defaultDeveloperConfig,
  DEVELOPER_CONFIG_DIRECTORY_NAME,
  DEVELOPER_CONFIG_FILE_NAME,
} from '../../shared/developerConfig';
import { USER_DATA_DIRECTORY_NAME } from '../../shared/productMetadata';
import { getDeveloperConfigPath, loadDeveloperConfig } from './developerConfigFile';

const tempDirectories: string[] = [];

const createUserDataDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-developer-config-'));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadDeveloperConfig', () => {
  it('resolves the config below the productName-derived userData directory', () => {
    const appDataPath = path.join('app-data');
    const userDataPath = path.join(appDataPath, USER_DATA_DIRECTORY_NAME);

    expect(USER_DATA_DIRECTORY_NAME).toBe(packageJson.productName);
    expect(getDeveloperConfigPath(userDataPath)).toBe(
      path.join(
        appDataPath,
        packageJson.productName,
        DEVELOPER_CONFIG_DIRECTORY_NAME,
        DEVELOPER_CONFIG_FILE_NAME,
      ),
    );
  });

  it('creates a disabled default config when the file is missing', () => {
    const userDataPath = createUserDataDirectory();

    expect(loadDeveloperConfig(userDataPath)).toEqual(defaultDeveloperConfig);
    expect(JSON.parse(fs.readFileSync(getDeveloperConfigPath(userDataPath), 'utf-8'))).toEqual(
      defaultDeveloperConfig,
    );
  });

  it('shows developer mode only for an explicit boolean true', () => {
    const userDataPath = createUserDataDirectory();
    const configPath = getDeveloperConfigPath(userDataPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    for (const value of [false, 'true', 1, null, undefined]) {
      fs.writeFileSync(configPath, JSON.stringify({ showDeveloperMode: value }), 'utf-8');
      expect(loadDeveloperConfig(userDataPath).showDeveloperMode).toBe(false);
    }

    fs.writeFileSync(configPath, JSON.stringify({ showDeveloperMode: true }), 'utf-8');
    expect(loadDeveloperConfig(userDataPath).showDeveloperMode).toBe(true);
  });

  it('falls back to hidden when the config is invalid JSON', () => {
    const userDataPath = createUserDataDirectory();
    const configPath = getDeveloperConfigPath(userDataPath);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{invalid', 'utf-8');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(loadDeveloperConfig(userDataPath)).toEqual(defaultDeveloperConfig);
  });
});
