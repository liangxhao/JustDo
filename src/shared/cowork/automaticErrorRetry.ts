/** Application-owned retry presentation; native history and terminals remain authoritative. */
export const AutomaticErrorRetryPhase = {
  Eligible: 'eligible',
  Checking: 'checking',
  Preparing: 'preparing',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Unknown: 'unknown',
} as const;

export type AutomaticErrorRetryPhase =
  (typeof AutomaticErrorRetryPhase)[keyof typeof AutomaticErrorRetryPhase];

export function isAutomaticErrorRetryActive(phase: AutomaticErrorRetryPhase): boolean {
  return phase === AutomaticErrorRetryPhase.Checking ||
    phase === AutomaticErrorRetryPhase.Preparing || phase === AutomaticErrorRetryPhase.Running;
}

export const AutomaticErrorRetryDisposition = {
  Candidate: 'candidate',
  Pending: 'pending',
  Superseded: 'superseded',
  Final: 'final',
} as const;

export type AutomaticErrorRetryDisposition =
  (typeof AutomaticErrorRetryDisposition)[keyof typeof AutomaticErrorRetryDisposition];

/** Content-free association persisted with the existing session-run receipt. */
export interface AutomaticErrorRetryRunMetadata {
  chainId: string;
  attempt: number;
  maxContinuations: number;
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
  disposition: AutomaticErrorRetryDisposition;
  predecessorRunId?: string;
  ruleId?: string;
  chainPhase?: typeof AutomaticErrorRetryPhase.Cancelled;
}

export interface AutomaticErrorRetryPresentedRun extends AutomaticErrorRetryRunMetadata {
  runId: string;
  clientTurnId: string;
}

export interface AutomaticErrorRetryPresentation {
  sessionId: string;
  chainId: string;
  revision: number;
  phase: AutomaticErrorRetryPhase;
  attempt: number;
  maxContinuations: number;
  runs: AutomaticErrorRetryPresentedRun[];
}

export interface AutomaticErrorRetryActivitySnapshot {
  revision: number;
  sessionIds: string[];
}

export const AutomaticErrorRetryIpc = {
  Get: 'execution:error-retry:get',
  GetActivity: 'execution:error-retry:get-activity',
  Changed: 'execution:error-retry:changed',
} as const;

export const AUTOMATIC_ERROR_RETRY_DEFAULT_MAX_CONTINUATIONS = 3;
export const AUTOMATIC_ERROR_RETRY_MAX_CONTINUATIONS = 3;
