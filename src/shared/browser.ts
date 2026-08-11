export const BrowserIpc = {
  GetStatus: 'browser:getStatus',
  SetMode: 'browser:setMode',
  OpenRemoteDebugging: 'browser:openRemoteDebugging',
  TestConnection: 'browser:testConnection',
} as const;

export const BrowserMode = {
  Isolated: 'isolated',
  User: 'user',
} as const;

export type BrowserMode = (typeof BrowserMode)[keyof typeof BrowserMode];

export const normalizeBrowserMode = (value: unknown): BrowserMode =>
  value === BrowserMode.User ? BrowserMode.User : BrowserMode.Isolated;

export type BrowserConnectionIssue =
  | 'unsupported-platform'
  | 'chrome-not-found'
  | 'remote-debugging-disabled'
  | 'chrome-restart-required'
  | 'not-running';

export type BrowserConnectionStatus = {
  supported: boolean;
  chromeFound: boolean;
  remoteDebuggingEnabled: boolean;
  activePort: number | null;
  activePortFileExists: boolean;
  endpointReachable: boolean;
  issue: BrowserConnectionIssue | null;
};

export type BrowserStatusResult = {
  success: boolean;
  status?: BrowserConnectionStatus;
  error?: string;
};

export type BrowserActionResult = {
  success: boolean;
  error?: string;
};

export type BrowserModeUpdateResult = BrowserActionResult & {
  mode?: BrowserMode;
  errorCode?: 'invalid-mode' | 'config-sync-failed';
};

export type BrowserConnectionTestResult = BrowserActionResult & {
  errorCode?: 'gateway-unavailable' | 'permission-timeout' | 'connection-failed';
};

export const parseDevToolsActivePort = (content: string): number | null => {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const port = Number(firstLine);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};
