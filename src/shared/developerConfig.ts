export const DEVELOPER_CONFIG_DIRECTORY_NAME = 'developer';
export const DEVELOPER_CONFIG_FILE_NAME = 'config.json';

export const DeveloperConfigIpc = {
  Get: 'developer-config:get',
} as const;

export interface DeveloperConfig {
  showDeveloperMode: boolean;
}

export const defaultDeveloperConfig: DeveloperConfig = {
  showDeveloperMode: false,
};
