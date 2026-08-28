import type { SessionDetailStats } from './sessionDetails';

export const CoworkSubagentDetailsIpc = {
  Get: 'cowork:subTask:details',
  ListDescendants: 'cowork:subTask:listDescendants',
} as const;

export type CoworkSubagentDetailsResult =
  { success: true; stats: SessionDetailStats } | { success: false; error: string };

export interface CoworkSubagentDescendant {
  sessionKey: string;
  sessionId: string;
  label: string;
}

export type CoworkSubagentDescendantsResult =
  { success: true; subagents: CoworkSubagentDescendant[] } | { success: false; error: string };
