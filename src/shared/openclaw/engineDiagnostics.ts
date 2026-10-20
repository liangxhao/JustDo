import type { OpenClawEngineStatus } from './engineStatus';

export const EngineDiagnosticsIpc = {
  Collect: 'engine:diagnostics:collect',
  Cancel: 'engine:diagnostics:cancel',
} as const;

export interface EngineDiagnosticsQuery {
  requestId: string;
  diagnosticId?: string;
}

export interface EngineFailureContext {
  id: string;
  startedAt: number;
  failedAt: number;
  processGeneration: number;
  status: OpenClawEngineStatus;
}

export type EngineLogSource = 'main' | 'gateway' | 'native';
export type EngineFailureCategory =
  | 'port'
  | 'runtime'
  | 'config'
  | 'credentials'
  | 'permission'
  | 'storage'
  | 'network'
  | 'certificate'
  | 'memory'
  | 'timeout'
  | 'exit'
  | 'unknown';
export type EngineLogIssue =
  | 'missing'
  | 'unavailable'
  | 'unsafe'
  | 'changed'
  | 'timeout'
  | 'invalid_record'
  | 'oversized'
  | 'offline';

export interface EngineDiagnosticEvidence {
  id: string;
  source: EngineLogSource | 'engine';
  timestamp: number;
  level: 'error' | 'warning' | 'info';
  text: string;
  category: EngineFailureCategory;
  truncated: boolean;
}

export interface EngineLogCoverage {
  source: EngineLogSource;
  files: number;
  scannedFiles: number;
  matched: number;
  omitted: number;
  issues: EngineLogIssue[];
}

export interface EngineDiagnosticReport {
  context: EngineFailureContext;
  collectedAt: number;
  window: { from: number; to: number };
  engineChanged: boolean;
  evidence: EngineDiagnosticEvidence[];
  /** Evidence references in descending specificity; time correlation is not causal proof. */
  findings: string[];
  coverage: EngineLogCoverage[];
}

export type EngineDiagnosticResult =
  | { success: true; report: EngineDiagnosticReport }
  | { success: false; reason: 'invalid' | 'busy' | 'stale' | 'canceled' | 'unavailable' };
