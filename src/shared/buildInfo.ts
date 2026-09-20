export interface BuildInfo {
  schemaVersion: 1;
  productVersion: string;
  commit: string;
  shortCommit: string;
  branch: string;
  dirty: boolean;
  buildId: string;
  builtAt: string;
}

export const UNKNOWN_BUILD_INFO: BuildInfo = {
  schemaVersion: 1,
  productVersion: 'unknown',
  commit: 'unknown',
  shortCommit: 'unknown',
  branch: 'unknown',
  dirty: false,
  buildId: 'unknown',
  builtAt: '',
};
