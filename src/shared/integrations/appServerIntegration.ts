export const AppServerIntegrationIpc = {
  GetStatus: 'app-server:status',
  GetConnectionConfig: 'app-server:connection-config',
  SetPort: 'app-server:set-port',
  RegenerateToken: 'app-server:regenerate-token',
} as const;

export const AppServerIntegrationFailure = {
  PortInUse: 'port-in-use',
  Unavailable: 'unavailable',
} as const;

export const isAppServerPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535;

export interface AppServerIntegrationStatus {
  running: boolean;
  url: string;
  configuredPort: number;
  restartRequired: boolean;
  failure?: (typeof AppServerIntegrationFailure)[keyof typeof AppServerIntegrationFailure];
}

export interface AppServerConnectionConfig {
  url: string;
  headers: { Authorization: string };
}
