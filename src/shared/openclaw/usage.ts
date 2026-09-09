export const UsageStatsIpc = {
  GetDaily: 'openclaw:usage:getDaily',
} as const;

export const USAGE_STATS_DAY_OPTIONS = [7, 14, 30] as const;

export type UsageStatsDays = (typeof USAGE_STATS_DAY_OPTIONS)[number];

export interface UsageStatsOptions {
  days: number;
  utcOffset: string;
  timeZone: string;
}

export interface UsageBreakdown {
  name: string;
  totalTokens: number;
}

export interface UsageActivity {
  sessionCount?: number;
  userMessages: number;
  assistantMessages: number;
  errors: number;
  toolCalls: number;
  averageLatencyMs?: number;
  byModel: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  byAgent: UsageBreakdown[];
  tools: Array<{ name: string; count: number }>;
}

export interface DailyTokenUsage {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type UsageStatsCacheStatus = 'fresh' | 'partial' | 'stale' | 'refreshing';

export interface UsageStatsCacheInfo {
  status: UsageStatsCacheStatus;
  cachedFiles: number;
  pendingFiles: number;
  staleFiles: number;
  refreshedAt?: number;
}

export interface DailyTokenUsageResult {
  success: boolean;
  daily?: DailyTokenUsage[];
  totalTokens?: number;
  activity?: UsageActivity;
  activityError?: string;
  updatedAt?: number;
  cacheStatus?: UsageStatsCacheInfo;
  error?: string;
}
