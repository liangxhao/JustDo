export const MulticaIntegrationIpc = {
  GetStatus: 'multica:integration:getStatus',
  Enable: 'multica:integration:enable',
  Disable: 'multica:integration:disable',
  Refresh: 'multica:integration:refresh',
} as const;

export type MulticaDaemonState = 'running' | 'stopped' | 'unavailable' | 'unknown';
export type MulticaBridgeState = 'running' | 'stopped' | 'error';
export interface MulticaIntegrationStatus {
  enabled: boolean;
  supported: boolean;
  networkPolicy: 'local-only';
  launcherPath: string;
  bridgeState: MulticaBridgeState;
  bridgeProtocolVersion: number;
  openclawVersion: string | null;
  gatewayPhase: 'ready' | 'starting' | 'running' | 'error';
  gatewayPort: number | null;
  multicaExecutable: string | null;
  multicaVersion: string | null;
  profileName: string | null;
  daemonState: MulticaDaemonState;
  activeTaskCount: number;
  launcherReady: boolean;
  manualSetup: {
    protocolFamily: string;
    displayName: string;
    commandName: string;
    description: string;
  };
  errorCode?: string;
  error?: string;
}

export interface MulticaIntegrationResult {
  success: boolean;
  status: MulticaIntegrationStatus;
  error?: string;
}

export type ExternalSessionOrigin = 'multica';
export type ExternalSessionStatus = 'running' | 'completed' | 'error' | 'timeout' | 'cancelled';

export interface ExternalSessionMetadata {
  origin: ExternalSessionOrigin;
  readOnly: true;
  sessionKey: string | null;
  status: ExternalSessionStatus;
}
