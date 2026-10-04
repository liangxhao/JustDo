import type { SessionDetailStats } from './sessionDetails';

export const CoworkSubagentDetailsIpc = {
  Status: 'cowork:subTask:status',
  Get: 'cowork:subTask:details',
  ListDescendants: 'cowork:subTask:listDescendants',
  Changed: 'cowork:subTask:changed',
  ListChildren: 'cowork:subTask:listChildren',
  Control: 'cowork:subTask:control',
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
  status: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout' | 'blocked' | 'unknown';
  runtime?: 'subagent' | 'acp';
  parentTaskId?: string;
  execution?: CoworkSubagentExecution;
  deliveryStatus?: CoworkSubagentDeliveryStatus;
  diffStat?: { files: number; added: number; removed: number };
  agentId?: string;
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
  | { success: true; stats?: SessionDetailStats; subagent?: CoworkSubagentDetailTask }
  | { success: false; error: string };

export interface CoworkSubagentDescendant {
  sessionKey: string;
  sessionId: string;
  label: string;
}

export type CoworkSubagentDescendantsResult =
  { success: true; subagents: CoworkSubagentDescendant[] } | { success: false; error: string };

export type CoworkSubagentDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'session_queued'
  | 'failed'
  | 'dismissed'
  | 'parent_missing'
  | 'not_applicable';

export interface CoworkSubagentExecution {
  state: 'queued' | 'running' | 'waiting' | 'finished' | 'unknown';
  currentTool?: { name: string; startedAt: string | number };
  lastActivityAt?: string | number;
  wait?: {
    kind: 'children' | 'external' | 'agent_messages' | 'approval' | 'user_input';
    dependencies?: Array<{ runId: string; sessionKey?: string; taskId?: string; label?: string }>;
    pendingCount?: number;
  };
}

export type CoworkSubagentChildrenResult =
  | { success: true; subagents: CoworkSubagentDetailTask[]; nextCursor?: string }
  | { success: false; error: string };

export const CoworkSubagentActions = {
  Cancel: 'cancel',
} as const;
export type CoworkSubagentAction =
  (typeof CoworkSubagentActions)[keyof typeof CoworkSubagentActions];
export type CoworkSubagentControlResult =
  { success: true; duplicateRisk?: boolean } | { success: false; error: string };
