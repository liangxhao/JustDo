export const EnginePhase = {
  Ready: 'ready',
  Starting: 'starting',
  Running: 'running',
  Error: 'error',
} as const;

export type OpenClawEnginePhase = (typeof EnginePhase)[keyof typeof EnginePhase];

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  message?: string;
  canRetry: boolean;
  /** Main-owned lifecycle evidence; only meaningful while starting. */
  restarting?: boolean;
  /** Identifies the Main-owned failure snapshot for on-demand diagnostics. */
  diagnosticId?: string;
}

export interface EngineCommandResult {
  success: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
}

export const EngineIpc = {
  StartGateway: 'openclaw:engine:startGateway',
} as const;
