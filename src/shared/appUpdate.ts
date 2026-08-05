export const AppUpdateIpc = {
  GetState: 'appUpdate:getState',
  Check: 'appUpdate:check',
  QuitAndInstall: 'appUpdate:quitAndInstall',
  StateChanged: 'appUpdate:stateChanged',
} as const;

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported';

export type AppUpdateErrorCode = 'CHECK_FAILED' | 'INSTALL_FAILED';

export interface AppUpdateState {
  revision: number;
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadPercent?: number;
  releaseNotes?: string;
  errorCode?: AppUpdateErrorCode;
}

export interface AppUpdateActionResult {
  success: boolean;
  state: AppUpdateState;
  errorCode?: AppUpdateErrorCode;
}
