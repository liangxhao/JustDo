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

export const AutomaticErrorRetryIpc = {
  Get: 'execution:error-retry:get',
  Changed: 'execution:error-retry:changed',
} as const;

export const AUTOMATIC_ERROR_RETRY_DEFAULT_MAX_CONTINUATIONS = 1;
export const AUTOMATIC_ERROR_RETRY_MAX_CONTINUATIONS = 3;
