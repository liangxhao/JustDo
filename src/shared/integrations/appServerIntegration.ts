export const AppServerIntegrationIpc = {
  GetStatus: 'app-server:status',
  GetConnectionConfig: 'app-server:connection-config',
} as const;

export interface AppServerIntegrationStatus {
  running: boolean;
  url: string;
}

export interface AppServerConnectionConfig {
  url: string;
  headers: { Authorization: string };
}
