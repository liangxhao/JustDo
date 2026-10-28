import type { PermissionMode } from '../../runtime-services/contracts/permissions';

/** Live host capabilities. The plugin never imports or owns the application's controllers. */
export interface TeamHostSession {
  id: string;
  agentId: string;
  title: string;
  cwd: string;
  executionMode: 'local' | 'sandbox';
  permissionMode: PermissionMode;
  external?: unknown;
  nativeSessionKey?: string;
  nativeParentSessionId?: string;
  historyBinding?: { sessionKey: string; nativeSessionId: string };
}

export interface TeamHostAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  enabled: boolean;
}

export interface TeamHostRun {
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  acceptedAt?: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
}

export interface TeamHostStore {
  getSession(id: string): TeamHostSession | null;
  getSessionByNativeKey(key: string): TeamHostSession | null;
  getAgent(id: string): TeamHostAgent | null;
  listAgents(): TeamHostAgent[];
  getSessionRuns(sessionId: string): TeamHostRun[];
  getSessionRunByClientTurnId(clientTurnId: string): TeamHostRun | null;
  getGoalExecutionSnapshot(sessionId: string): unknown;
  listPlanHandoffs(sessionId: string): { artifact: { workspaceRoot?: string } }[];
  createSession(
    title: string,
    cwd: string,
    executionMode?: TeamHostSession['executionMode'],
    skillIds?: string[],
    agentId?: string,
    permissionMode?: PermissionMode,
    modelRef?: string,
  ): TeamHostSession;
  deleteSession(sessionId: string): void;
}

export interface TeamHostRouter {
  prepareSession(sessionId: string): Promise<{ sessionKey: string; gatewaySessionId: string }>;
  getSessionRuntimeStatus(
    sessionId: string,
    options?: {
      includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean;
      targeted?: boolean; expectedSessionId?: string; expectedLifecycleRevision?: string | null;
    },
  ): Promise<{ known: boolean; running: boolean; mainRunning: boolean; subagentRunning: boolean }>;
  stopSession(sessionId: string): Promise<void>;
  onSessionDeleted(
    sessionId: string,
    agentId?: string,
    sessionKeys?: string[],
    workspaceRoots?: string[],
  ): void;
}

export interface TeamHostRuntime {
  captureGatewayResponseContext(): { isCurrent(): boolean } | null;
  getPlanMode(sessionId: string): Promise<{ enabled: boolean }>;
  getGoalExecution(sessionId: string):
    | {
        goalId?: string;
        phase: string;
        identityPending?: boolean;
      }
    | null
    | undefined;
}
