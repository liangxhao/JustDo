import type { PermissionMode } from '../security/approvals';
import type { AutomaticErrorRetryRunMetadata } from './automaticErrorRetry';

export type SessionRunState = 'running' | 'completed' | 'failed' | 'aborted';

export interface RunExecutionTiming {
  startedAt: number;
  endedAt: number;
}

export function readRunExecutionTiming(startedAt: unknown, endedAt: unknown): RunExecutionTiming | undefined {
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt <= 0 ||
      typeof endedAt !== 'number' || !Number.isSafeInteger(endedAt) || endedAt < startedAt) return;
  return { startedAt, endedAt };
}

export const SessionRunBeginErrorCode = {
  FollowupAvailable: 'followup_available',
  RuntimeActive: 'runtime_active',
  RuntimeUnknown: 'runtime_unknown',
} as const;

export type SessionRunBeginErrorCode =
  (typeof SessionRunBeginErrorCode)[keyof typeof SessionRunBeginErrorCode];

export interface SessionRunTiming {
  id: string;
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  /** Legacy selection snapshot; actual reply models belong to Gateway messages/events. */
  modelRef?: string;
  startedAt: number;
  acceptedAt?: number;
  endedAt?: number;
  state: SessionRunState;
  /** Measured whole-run timestamps. For main chat they come from the native terminal. */
  executionTiming?: RunExecutionTiming;
  /** Content-free presentation association; never used to resume execution. */
  automaticErrorRetry?: AutomaticErrorRetryRunMetadata;
}

/** Optional presentation fact from a row with this exact native key. */
export interface SessionWorktreeBinding {
  nativeSessionKey: string;
  isWorktree: boolean;
}

export interface SessionRuntimeActivity {
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
  rootRunId?: string;
  worktreeBinding?: SessionWorktreeBinding;
}

export interface SessionRuntimeSnapshot extends SessionRuntimeActivity {
  revision: number;
  timing?: SessionRunTiming;
}

export interface BeginSessionRunInput {
  sessionId: string;
  clientTurnId: string;
  startedAt: number;
  modelRef?: string;
  /** Transient explicit Team input; Main persists only its hash and execution receipt. */
  pluginPrompt?: string;
  /** Workspace captured before native permission preparation; never persisted. */
  expectedWorkspaceRoot?: string;
}

export const SessionRunIpc = {
  Unknown: 'cowork:session:run:unknown',
  AuthorizeUnknownFollowup: 'cowork:session:run:authorize-unknown-followup',
  PluginSubmissionStarted: 'cowork:session:run:plugin-submission-started',
  PluginSubmissionAbortedBeforeSend: 'cowork:session:run:plugin-submission-aborted-before-send',
} as const;

export interface SessionRunUnknownInput {
  sessionId: string;
  id: string;
  cancelled?: boolean;
  requireRunning?: true;
}

export interface UnknownSessionFollowupInput {
  sessionId: string;
  id: string;
  runId: string;
  sessionKey: string;
  workspaceRoot: string;
}

export type UnknownSessionFollowupResult =
  | { success: true; permissionMode: PermissionMode }
  | { success: false; error?: string };
