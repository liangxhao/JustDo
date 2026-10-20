import type Database from 'better-sqlite3';

import type { AppPluginManifest, AppSubmission } from './contracts';

export interface AppSession {
  id: string;
  agentId: string;
  title: string;
  cwd: string;
  executionMode: 'local' | 'sandbox';
  permissionMode: 'ask' | 'auto' | 'full';
  external?: unknown;
  nativeSessionKey?: string;
  nativeParentSessionId?: string;
  historyBinding?: { sessionKey: string; nativeSessionId: string };
}
export interface AppAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  enabled: boolean;
  deletedAt?: number | null;
}
export interface AppRun {
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  acceptedAt?: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
}
export interface AppSessionStore {
  getSession(id: string): AppSession | null;
  getSessionByNativeKey(key: string): AppSession | null;
  getAgent(id: string): AppAgent | null;
  listAgents(): AppAgent[];
  getSessionRuns(sessionId: string): AppRun[];
  getSessionRunByClientTurnId(clientTurnId: string): AppRun | null;
  getGoalExecutionSnapshot(sessionId: string): unknown;
  listPlanHandoffs(sessionId: string): { artifact: { workspaceRoot?: string } }[];
  createSession(
    title: string,
    cwd: string,
    executionMode?: AppSession['executionMode'],
    skillIds?: string[],
    agentId?: string,
    permissionMode?: AppSession['permissionMode'],
    modelRef?: string,
  ): AppSession;
  deleteSession(sessionId: string): void;
}
export interface AppSessionExecution {
  prepareSession(sessionId: string): Promise<{ sessionKey: string; gatewaySessionId: string }>;
  getSessionRuntimeStatus(
    sessionId: string,
    options?: {
      includeSubagents?: boolean;
      forceRefresh?: boolean;
      fullScan?: boolean;
      targeted?: boolean;
      expectedSessionId?: string;
      expectedLifecycleRevision?: string | null;
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
export interface AppNativeRuntime {
  /** Read lifetime only; this is not execution or mutation authority. */
  captureGatewayResponseContext(): { isCurrent(): boolean } | null;
  getPlanMode(sessionId: string): Promise<{ enabled: boolean }>;
  getGoalExecution(
    sessionId: string,
  ): { goalId?: string; phase: string; identityPending?: boolean } | null | undefined;
  getSessionKeysForSession(sessionId: string): string[];
  getGatewayClient(): {
    request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  } | null;
}
export interface AppMainHost {
  readonly manifest: AppPluginManifest;
  readonly epoch: string;
  readonly signal: AbortSignal;
  isEnabled(): boolean;
  assertActive(): void;
  getDatabase(): Database.Database;
  getNativeStateDirectory(): string;
  getSessions(): AppSessionStore;
  getExecution(): AppSessionExecution;
  getRuntime(): AppNativeRuntime | null;
  ensureReady(): Promise<unknown>;
  requestGateway<T = unknown>(method: string, params?: unknown): Promise<T>;
  requestConnectedGateway<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNativeEvent(listener: (event: { event: string; payload: unknown }) => void): () => void;
  publishEvent(name: string, payload: unknown): void;
  onExecutionReceipt(
    listener: (payload: {
      stream: 'lifecycle';
      sessionKey: string;
      runId: string;
      sessionId?: string;
      data: { phase: 'end' | 'error'; executionSettled: true; aborted?: boolean };
    }) => void,
  ): () => void;
  onSessionStopped(listener: (sessionId: string) => void): () => void;
  sessionsChanged(): void;
  createAssistant(input: unknown, identity: string, assertActive: () => void): Promise<unknown>;
}
export interface AppCommand {
  id: string;
  invoke(...args: unknown[]): unknown | Promise<unknown>;
}
export interface AppSubmissionParticipant {
  matches(prompt: string, submission?: AppSubmission): boolean;
  register(input: {
    sessionId: string;
    clientTurnId: string;
    prompt: string;
    submission?: AppSubmission;
    assertActive?: () => void;
  }): Promise<unknown>;
  markSubmissionStarted(sessionId: string, clientTurnId: string): Promise<unknown>;
  abortBeforeSend(sessionId: string, clientTurnId: string): Promise<boolean>;
  cancel(sessionId: string, clientTurnId?: string): Promise<unknown>;
  releaseIfSettled(sessionId: string): Promise<boolean>;
}
export interface AppResourceParticipant {
  protectedResources?(): string[];
  adoptResources?(previous: { artifactHash: string; resourceIds: readonly string[] }): boolean;
  expandResources(sessionIds: readonly string[]): string[];
  acquireDeletion(sessionIds: string[]): () => void;
  isDeleting(sessionId: string): boolean;
  isManaged(sessionId: string): boolean;
  prepareDelete(sessionIds: readonly string[]): Promise<void>;
  deleteManaged(sessionId: string): Promise<boolean>;
}
export interface AppMainRegistration {
  commands: AppCommand[];
  schemas?: { id: string; initialize(database: Database.Database): void }[];
  projectNativeConfig?: (agents: AppAgent[]) => Record<string, unknown>;
  nativePolicy?: { skills?: string[]; sandboxTools?: string[]; surfaces?: Record<string, unknown> };
  submission?: AppSubmissionParticipant;
  resources?: AppResourceParticipant;
  activate?: () => void;
  onEnable?: () => void | (() => void);
  /** Periodic receipt reconciliation with a fresh cleanup-only lease, including while disabled. */
  maintenance?: () => void | Promise<void>;
  /** Explicit cleanup-only RPCs; this never grants native authorization or enables business commands. */
  cleanupGatewayMethods?: readonly string[];
  allowCleanupGatewayRequest?: (method: string, params: unknown) => boolean;
  beforeDisable?: () => Promise<() => void>;
  /** Refuse native package removal/replacement until all owned executions and custody are settled. */
  beforePackageMutation?: () => Promise<void>;
  dispose?: () => void;
}
export interface AppMainModule {
  register(host: AppMainHost): AppMainRegistration;
}
