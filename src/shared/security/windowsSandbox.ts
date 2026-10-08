export const WINDOWS_SANDBOX_BACKEND_ID = 'mxc';

export const WindowsSandboxIpc = {
  GetStatus: 'windowsSandbox:getStatus',
  Initialize: 'windowsSandbox:initialize',
  Repair: 'windowsSandbox:repair',
  OpenDiagnostics: 'windowsSandbox:openDiagnostics',
} as const;

export const WindowsSandboxStatusCode = {
  UnsupportedPlatform: 'unsupported_platform',
  PluginMissing: 'plugin_missing',
  HostPreparationRecommended: 'host_preparation_recommended',
  Ready: 'ready',
  CheckFailed: 'check_failed',
} as const;

export type WindowsSandboxStatusCode =
  (typeof WindowsSandboxStatusCode)[keyof typeof WindowsSandboxStatusCode];

export type WindowsSandboxStatus = {
  code: WindowsSandboxStatusCode;
  supported: boolean;
  helperAvailable: boolean;
  initialized: boolean;
  ready: boolean;
  hostPreparationRecommended?: boolean;
  diagnosticsPath?: string;
  error?: string;
};

export type WindowsSandboxOperationResult =
  | { success: true; status: WindowsSandboxStatus }
  | { success: false; status: WindowsSandboxStatus; error: string };
