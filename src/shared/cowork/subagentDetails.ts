import type { SessionDetailStats } from './sessionDetails';

export const CoworkSubagentDetailsIpc = {
  Get: 'cowork:subTask:details',
} as const;

export type CoworkSubagentDetailsResult =
  { success: true; stats: SessionDetailStats } | { success: false; error: string };
