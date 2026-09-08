import type { SessionDetailStats } from './sessionDetails';

export const CoworkSubagentDetailsIpc = {
  Status: 'cowork:subTask:status',
  Get: 'cowork:subTask:details',
  ListDescendants: 'cowork:subTask:listDescendants',
  Changed: 'cowork:subTask:changed',
} as const;

export interface CoworkSubtaskChangedEvent {
  sessionId?: string;
}

export interface CoworkSubagentDetailTask {
  id: string;
  taskName: string;
  sessionKey: string;
  sessionId?: string;
  label: string;
  labelSource: 'taskName' | 'label' | 'task';
  status: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout' | 'blocked';
  task?: string;
  runId?: string;
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  runtimeSampledAt?: number;
  totalTokens?: number;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  lastActivity?: string;
  lastToolName?: string;
  toolUseCount?: number;
}

export type CoworkSubagentDetailsResult =
  | { success: true; stats: SessionDetailStats; subagent?: CoworkSubagentDetailTask }
  | { success: false; error: string };

export interface CoworkSubagentDescendant {
  sessionKey: string;
  sessionId: string;
  label: string;
}

export type CoworkSubagentDescendantsResult =
  { success: true; subagents: CoworkSubagentDescendant[] } | { success: false; error: string };
