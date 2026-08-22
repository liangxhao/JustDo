export type SessionRunState = 'running' | 'completed' | 'failed' | 'aborted';

export interface SessionRunTiming {
  id: string;
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  modelRef?: string;
  startedAt: number;
  acceptedAt?: number;
  endedAt?: number;
  state: SessionRunState;
}

export interface SessionRuntimeSnapshot {
  revision: number;
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
  timing?: SessionRunTiming;
}

export interface BeginSessionRunInput {
  sessionId: string;
  clientTurnId: string;
  startedAt: number;
  modelRef?: string;
}
