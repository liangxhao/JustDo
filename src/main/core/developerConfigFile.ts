import fs from 'fs';
import path from 'path';

import {
  defaultDeveloperConfig,
  DEVELOPER_CONFIG_DIRECTORY_NAME,
  DEVELOPER_CONFIG_FILE_NAME,
  type DeveloperConfig,
} from '../../shared/developerConfig';

export const getDeveloperConfigPath = (userDataPath: string): string =>
  path.join(userDataPath, DEVELOPER_CONFIG_DIRECTORY_NAME, DEVELOPER_CONFIG_FILE_NAME);

export const loadDeveloperConfig = (userDataPath: string): DeveloperConfig => {
  const configPath = getDeveloperConfigPath(userDataPath);

  try {
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(defaultDeveloperConfig, null, 2)}\n`, 'utf-8');
      return { ...defaultDeveloperConfig };
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    const showDeveloperMode =
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).showDeveloperMode === true;

    return { showDeveloperMode };
  } catch (error) {
    console.warn(
      '[DeveloperConfig] Failed to load developer config; developer mode is hidden:',
      error,
    );
    return { ...defaultDeveloperConfig };
  }
};
