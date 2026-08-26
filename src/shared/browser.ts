export const BrowserIpc = {
  GetStatus: 'browser:getStatus',
  CanSetMode: 'browser:canSetMode',
  SetMode: 'browser:setMode',
  OpenRemoteDebugging: 'browser:openRemoteDebugging',
  TestConnection: 'browser:testConnection',
  OpenExtensionManagement: 'browser:openExtensionManagement',
  RevealExtension: 'browser:revealExtension',
  CopyExtensionPairing: 'browser:copyExtensionPairing',
  TestExtensionConnection: 'browser:testExtensionConnection',
} as const;

export const BrowserMode = {
  Isolated: 'isolated',
  User: 'user',
  Extension: 'extension',
} as const;

export type BrowserMode = (typeof BrowserMode)[keyof typeof BrowserMode];

export const normalizeBrowserMode = (value: unknown): BrowserMode =>
  value === BrowserMode.User || value === BrowserMode.Extension ? value : BrowserMode.Isolated;

export type BrowserConnectionIssue =
  | 'unsupported-platform'
  | 'chrome-not-found'
  | 'remote-debugging-disabled'
  | 'port-occupied-by-other-process'
  | 'chrome-restart-required'
  | 'not-running';

export type BrowserPortOwner = {
  pid: number;
  processName: string | null;
  isChrome: boolean;
};

export type BrowserConnectionStatus = {
  supported: boolean;
  chromeFound: boolean;
  remoteDebuggingEnabled: boolean;
  activePort: number | null;
  activePortFileExists: boolean;
  activePortOwnerResolved: boolean;
  activePortOwner: BrowserPortOwner | null;
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
  errorCode?: 'invalid-mode' | 'active-session' | 'config-sync-failed';
};

export type BrowserModeSwitchAvailabilityResult = BrowserActionResult & {
  canSwitch: boolean;
  errorCode?: 'active-session';
};

export type BrowserConnectionTestResult = BrowserActionResult & {
  errorCode?:
    | 'gateway-unavailable'
    | 'permission-timeout'
    | 'extension-not-connected'
    | 'extension-relay-unavailable'
    | 'extension-pairing-mismatch'
    | 'extension-relay-port-conflict'
    | 'extension-browser-service-failed'
    | 'connection-failed';
  relayPort?: number;
  relayPortOwner?: BrowserPortOwner | null;
};

export const isBrowserExtensionConnected = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  return (value as { running?: unknown }).running === true;
};

export const parseDevToolsActivePort = (content: string): number | null => {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const port = Number(firstLine);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};
