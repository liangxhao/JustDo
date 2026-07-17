import { ipcMain } from 'electron';

import {
  type DailyTokenUsage,
  type DailyTokenUsageResult,
  USAGE_STATS_DAY_OPTIONS,
  type UsageStatsCacheInfo,
  UsageStatsIpc,
} from '../../../shared/openclaw/usage';
import type { OpenClawRuntimeAdapter } from '../../engine';

interface UsageHandlerDependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

type GatewayUsageEntry = Record<string, unknown> & { date?: unknown };
type GatewayUsageSummary = {
  daily?: unknown;
  totals?: unknown;
  updatedAt?: unknown;
  cacheStatus?: unknown;
};

const readNonNegativeNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

export const normalizeDailyTokenUsage = (value: unknown): DailyTokenUsage[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as GatewayUsageEntry;
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return [];
    return [
      {
        date: entry.date,
        input: readNonNegativeNumber(entry.input),
        output: readNonNegativeNumber(entry.output),
        cacheRead: readNonNegativeNumber(entry.cacheRead),
        cacheWrite: readNonNegativeNumber(entry.cacheWrite),
        totalTokens: readNonNegativeNumber(entry.totalTokens),
      },
    ];
  });
};

export const normalizeUsageCacheInfo = (value: unknown): UsageStatsCacheInfo | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.status !== 'fresh' &&
    source.status !== 'partial' &&
    source.status !== 'stale' &&
    source.status !== 'refreshing'
  ) {
    return undefined;
  }
  const refreshedAt = readNonNegativeNumber(source.refreshedAt);
  return {
    status: source.status,
    cachedFiles: readNonNegativeNumber(source.cachedFiles),
    pendingFiles: readNonNegativeNumber(source.pendingFiles),
    staleFiles: readNonNegativeNumber(source.staleFiles),
    ...(refreshedAt > 0 ? { refreshedAt } : {}),
  };
};

const isSupportedDays = (value: unknown): value is number =>
  typeof value === 'number' && USAGE_STATS_DAY_OPTIONS.some(days => days === value);

export const registerOpenClawUsageHandlers = ({
  getRuntime,
}: UsageHandlerDependencies): void => {
  ipcMain.handle(
    UsageStatsIpc.GetDaily,
    async (_event, options?: { days?: number; utcOffset?: string }): Promise<DailyTokenUsageResult> => {
      try {
        const runtime = getRuntime();
        const client = runtime?.getGatewayClient();
        if (!client) {
          return { success: false, error: 'Gateway client not connected' };
        }

        const days = isSupportedDays(options?.days) ? options.days : USAGE_STATS_DAY_OPTIONS[0];
        const summary = await client.request<GatewayUsageSummary>('usage.cost', {
          days,
          agentScope: 'all',
          mode: 'specific',
          utcOffset: options?.utcOffset,
        });
        const daily = normalizeDailyTokenUsage(summary.daily);
        const totals =
          summary.totals && typeof summary.totals === 'object'
            ? (summary.totals as Record<string, unknown>)
            : undefined;

        return {
          success: true,
          daily,
          totalTokens: readNonNegativeNumber(totals?.totalTokens),
          updatedAt: readNonNegativeNumber(summary.updatedAt),
          cacheStatus: normalizeUsageCacheInfo(summary.cacheStatus),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load token usage',
        };
      }
    },
  );
};
