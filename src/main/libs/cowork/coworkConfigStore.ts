import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export type CoworkApiType = 'openai';

export type CoworkApiConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: CoworkApiType;
};

const CONFIG_FILE_NAME = 'api-config.json';

function getConfigPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, CONFIG_FILE_NAME);
}

export function loadCoworkApiConfig(): CoworkApiConfig | null {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
      return null;
    }

    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as CoworkApiConfig;
    if (config.apiKey && config.baseURL && config.model) {
      config.apiType = 'openai';
      return config;
    }

    return null;
  } catch (error) {
    console.error('[cowork-config] Failed to load API config:', error);
    return null;
  }
}

export function saveCoworkApiConfig(config: CoworkApiConfig): void {
  const configPath = getConfigPath();
  const userDataPath = app.getPath('userData');

  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, { recursive: true });
  }

  if (!config.apiKey || !config.baseURL || !config.model) {
    throw new Error('Invalid config: apiKey, baseURL, and model are required');
  }

  const normalized: CoworkApiConfig = {
    apiKey: config.apiKey.trim(),
    baseURL: config.baseURL.trim(),
    model: config.model.trim(),
    apiType: 'openai',
  };

  writeFileSync(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  console.info('[cowork-config] API config saved successfully');
}

export function deleteCoworkApiConfig(): void {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      console.info('[cowork-config] API config deleted');
    }
  } catch (error) {
    console.error('[cowork-config] Failed to delete API config:', error);
  }
}
