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

export type CoworkSubagentDetailsResult =
  { success: true; stats: SessionDetailStats } | { success: false; error: string };

export interface CoworkSubagentDescendant {
  sessionKey: string;
  sessionId: string;
  label: string;
}

export type CoworkSubagentDescendantsResult =
  { success: true; subagents: CoworkSubagentDescendant[] } | { success: false; error: string };
