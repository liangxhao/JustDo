export const UsageStatsIpc = {
  GetDaily: 'openclaw:usage:getDaily',
} as const;

export const USAGE_STATS_DAY_OPTIONS = [7, 14, 30] as const;

export type UsageStatsDays = (typeof USAGE_STATS_DAY_OPTIONS)[number];

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
  updatedAt?: number;
  cacheStatus?: UsageStatsCacheInfo;
  error?: string;
}
