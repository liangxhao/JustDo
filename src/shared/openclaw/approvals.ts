export const PermissionMode = {
  Ask: 'ask',
  Auto: 'auto',
  Full: 'full',
} as const;

export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const DEFAULT_PERMISSION_MODE: PermissionMode = PermissionMode.Full;

export const ExecApprovalDecision = {
  AllowOnce: 'allow-once',
  AllowAlways: 'allow-always',
  Deny: 'deny',
} as const;

export type ExecApprovalDecision =
  (typeof ExecApprovalDecision)[keyof typeof ExecApprovalDecision];

export const ApprovalDecision = {
  AllowOnce: ExecApprovalDecision.AllowOnce,
  AllowForSession: 'allow-session',
  Deny: ExecApprovalDecision.Deny,
} as const;

export type ApprovalDecision = (typeof ApprovalDecision)[keyof typeof ApprovalDecision];

export interface ExecApprovalCommandAnalysis {
  summary?: string;
  risk?: string;
  [key: string]: unknown;
}

export interface ExecApprovalRequestPayload {
  command?: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  envKeys?: string[];
  systemRunBinding?: Record<string, unknown> | null;
  systemRunPlan?: Record<string, unknown> | null;
  cwd?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  warningText?: string | null;
  commandAnalysis?: ExecApprovalCommandAnalysis | null;
  unavailableDecisions?: string[];
  allowedDecisions?: ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}

export interface ExecApprovalRequest {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ExecApprovalResolved {
  id: string;
  decision?: ExecApprovalDecision | null;
  resolvedAtMs?: number;
  [key: string]: unknown;
}

export const ApprovalKind = {
  Exec: 'exec',
  Plugin: 'plugin',
} as const;

export type ApprovalKind = (typeof ApprovalKind)[keyof typeof ApprovalKind];

export interface PluginApprovalRequestPayload {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: 'info' | 'warning' | 'critical' | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: ExecApprovalDecision[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
}

export interface PluginApprovalRequest {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface PluginApprovalResolved {
  id: string;
  decision?: ExecApprovalDecision | null;
  ts?: number;
  request?: PluginApprovalRequestPayload;
}

export type ApprovalRequest =
  | ({ kind: typeof ApprovalKind.Exec } & ExecApprovalRequest)
  | ({ kind: typeof ApprovalKind.Plugin } & PluginApprovalRequest);

export type ApprovalResolved =
  | ({ kind: typeof ApprovalKind.Exec } & ExecApprovalResolved)
  | ({ kind: typeof ApprovalKind.Plugin } & PluginApprovalResolved);

export const PERSISTENT_APPROVAL_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

export const OpenClawApprovalIpc = {
  List: 'openclaw:approvals:list',
  Resolve: 'openclaw:approvals:resolve',
  Requested: 'openclaw:approvals:requested',
  Resolved: 'openclaw:approvals:resolved',
  Snapshot: 'openclaw:approvals:snapshot',
} as const;

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  value === PermissionMode.Ask || value === PermissionMode.Auto || value === PermissionMode.Full;

export const resolvePermissionMode = (value: unknown): PermissionMode =>
  isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;

export const isExecApprovalDecision = (value: unknown): value is ExecApprovalDecision =>
  value === ExecApprovalDecision.AllowOnce ||
  value === ExecApprovalDecision.AllowAlways ||
  value === ExecApprovalDecision.Deny;

export const isApprovalDecision = (value: unknown): value is ApprovalDecision =>
  value === ApprovalDecision.AllowOnce ||
  value === ApprovalDecision.AllowForSession ||
  value === ApprovalDecision.Deny;

export const canGrantExecApprovalForSession = (request: ExecApprovalRequest): boolean => {
  const payload = request.request;
  const hasSession = typeof payload.sessionKey === 'string' && payload.sessionKey.trim().length > 0;
  const hasCommand =
    (typeof payload.command === 'string' && payload.command.length > 0) ||
    (Array.isArray(payload.commandArgv) &&
      payload.commandArgv.length > 0 &&
      payload.commandArgv.every(value => typeof value === 'string'));
  const hasUnboundEnvironment =
    Array.isArray(payload.envKeys) && payload.envKeys.length > 0 && !payload.systemRunBinding;
  return hasSession && hasCommand && !hasUnboundEnvironment;
};
