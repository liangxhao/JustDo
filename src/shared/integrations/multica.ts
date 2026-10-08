export const MulticaIntegrationIpc = {
  GetStatus: 'multica:integration:getStatus',
  Enable: 'multica:integration:enable',
  Disable: 'multica:integration:disable',
  Refresh: 'multica:integration:refresh',
} as const;

export type MulticaBridgeState = 'running' | 'stopped' | 'error';

export interface MulticaManualSetup {
  protocolFamily: 'codex';
  displayName: string;
  command: string;
  description: string;
}

export interface MulticaIntegrationStatus {
  enabled: boolean;
  supported: boolean;
  networkPolicy: 'local-only';
  bridgeState: MulticaBridgeState;
  bridgeProtocolVersion: number;
  launcherPath: string;
  launcherReady: boolean;
  openclawVersion: string | null;
  multicaExecutable: string | null;
  multicaVersion: string | null;
  activeTaskCount: number;
  manualSetup: MulticaManualSetup;
  errorCode?: string;
  error?: string;
}

export interface MulticaIntegrationResult {
  success: boolean;
  status: MulticaIntegrationStatus;
  error?: string;
}

export type ExternalSessionStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface ExternalSessionMetadata {
  origin: 'multica';
  readOnly: true;
  status: ExternalSessionStatus;
  sessionKey: string;
}
