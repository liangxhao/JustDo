export const ExternalAgentId = {
  Claude: 'claude',
  Codex: 'codex',
  OpenCode: 'opencode',
} as const;

export type ExternalAgentId = (typeof ExternalAgentId)[keyof typeof ExternalAgentId];

export const EXTERNAL_AGENT_IDS = Object.values(ExternalAgentId);

export type ExternalAgentConnectionState =
  | 'not-tested'
  | 'connected'
  | 'failed'
  | 'unavailable';

export type ExternalAgentDiagnosticCode =
  | 'ok'
  | 'backend-missing'
  | 'adapter-missing'
  | 'authentication-required'
  | 'timeout'
  | 'connection-failed';

export interface ExternalAgentDiagnostic {
  id: ExternalAgentId;
  enabled: boolean;
  adapterAvailable: boolean;
  state: ExternalAgentConnectionState;
  code?: ExternalAgentDiagnosticCode;
  detail?: string;
  testedAt?: number;
  durationMs?: number;
}

export interface ExternalAgentDiagnosticsResult {
  success: boolean;
  backendAvailable: boolean;
  agents: ExternalAgentDiagnostic[];
  error?: string;
}

export interface ExternalAgentTestResult {
  success: boolean;
  diagnostic?: ExternalAgentDiagnostic;
  error?: string;
}

export const ExternalAgentIpc = {
  List: 'openclaw:externalAgents:list',
  Test: 'openclaw:externalAgents:test',
} as const;

export const isExternalAgentId = (value: unknown): value is ExternalAgentId =>
  typeof value === 'string' && EXTERNAL_AGENT_IDS.includes(value as ExternalAgentId);
