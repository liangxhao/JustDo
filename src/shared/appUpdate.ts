export const AppUpdateIpc = {
  GetState: 'appUpdate:getState',
  Check: 'appUpdate:check',
  Download: 'appUpdate:download',
  QuitAndInstall: 'appUpdate:quitAndInstall',
  GetPreferences: 'appUpdate:getPreferences',
  SetCheckFrequency: 'appUpdate:setCheckFrequency',
  StateChanged: 'appUpdate:stateChanged',
} as const;

export const AppUpdateCheckFrequency = {
  Never: 'never',
  Daily: 'daily',
  Weekly: 'weekly',
} as const;

export type AppUpdateCheckFrequency =
  (typeof AppUpdateCheckFrequency)[keyof typeof AppUpdateCheckFrequency];

export const DEFAULT_APP_UPDATE_CHECK_FREQUENCY: AppUpdateCheckFrequency =
  AppUpdateCheckFrequency.Daily;

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported';

export type AppUpdateErrorCode = 'CHECK_FAILED' | 'DOWNLOAD_FAILED' | 'INSTALL_FAILED';

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

export interface AppUpdatePreferences {
  supported: boolean;
  checkFrequency: AppUpdateCheckFrequency;
  nextCheckAt?: number;
}
