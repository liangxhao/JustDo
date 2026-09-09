import { ipcMain } from 'electron';

import {
  type DailyTokenUsage,
  type DailyTokenUsageResult,
  USAGE_STATS_DAY_OPTIONS,
  type UsageActivity,
  type UsageStatsCacheInfo,
  UsageStatsIpc,
  type UsageStatsOptions,
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

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];

export const normalizeUsageActivity = (value: unknown): UsageActivity => {
  const source = record(value);
  const messages = record(source.messages);
  const tools = record(source.tools);
  const latency = record(source.latency);
  const breakdown = (value: unknown, fields: string[]) =>
    rows(value)
      .map(row => {
        const totals = record(row.totals);
        return {
          name: fields
            .map(field => (typeof row[field] === 'string' ? row[field] : ''))
            .filter(Boolean)
            .join(' / '),
          totalTokens: readNonNegativeNumber(totals.totalTokens),
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    sessionCount:
      typeof source.sessionCount === 'number'
        ? readNonNegativeNumber(source.sessionCount)
        : undefined,
    userMessages: readNonNegativeNumber(messages.user),
    assistantMessages: readNonNegativeNumber(messages.assistant),
    errors: readNonNegativeNumber(messages.errors),
    toolCalls: readNonNegativeNumber(tools.totalCalls),
    averageLatencyMs:
      readNonNegativeNumber(latency.count) > 0 ? readNonNegativeNumber(latency.avgMs) : undefined,
    byModel: breakdown(source.byModel, ['provider', 'model']),
    byProvider: breakdown(source.byProvider, ['provider']),
    byAgent: breakdown(source.byAgent, ['agentId']),
    tools: rows(tools.tools)
      .filter(row => typeof row.name === 'string')
      .map(row => ({ name: row.name as string, count: readNonNegativeNumber(row.count) }))
      .sort((a, b) => b.count - a.count),
  };
};

export const registerOpenClawUsageHandlers = ({ getRuntime }: UsageHandlerDependencies): void => {
  ipcMain.handle(
    UsageStatsIpc.GetDaily,
    async (_event, options?: UsageStatsOptions): Promise<DailyTokenUsageResult> => {
      try {
        const runtime = getRuntime();
        const client = runtime?.getGatewayClient();
        if (!client) {
          return { success: false, error: 'Gateway client not connected' };
        }

        const days = isSupportedDays(options?.days) ? options.days : USAGE_STATS_DAY_OPTIONS[0];
        const timeZone = options?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date());
        const part = (type: string) => parts.find(item => item.type === type)!.value;
        const endDate = `${part('year')}-${part('month')}-${part('day')}`;
        const start = new Date(`${endDate}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - days + 1);
        const params = {
          startDate: start.toISOString().slice(0, 10),
          endDate,
          agentScope: 'all',
          mode: 'specific',
          utcOffset: options?.utcOffset,
          timeZone,
        };
        const [tokenResult, activityResult] = await Promise.allSettled([
          client.request<GatewayUsageSummary>('usage.cost', params),
          client.request<{ aggregates: unknown; cacheStatus?: unknown }>('sessions.usage', {
            ...params,
            groupBy: 'instance',
            limit: 1,
            includeContextWeight: false,
          }),
        ]);
        if (tokenResult.status === 'rejected') throw tokenResult.reason;
        const summary = tokenResult.value;
        const daily = normalizeDailyTokenUsage(summary.daily);
        const totals =
          summary.totals && typeof summary.totals === 'object'
            ? (summary.totals as Record<string, unknown>)
            : undefined;

        return {
          success: true,
          daily,
          totalTokens: readNonNegativeNumber(totals?.totalTokens),
          ...(activityResult.status === 'fulfilled'
            ? {
                activity: normalizeUsageActivity(activityResult.value.aggregates),
              }
            : { activityError: 'Usage activity is unavailable' }),
          updatedAt: readNonNegativeNumber(summary.updatedAt),
          cacheStatus:
            [
              normalizeUsageCacheInfo(summary.cacheStatus),
              activityResult.status === 'fulfilled'
                ? normalizeUsageCacheInfo(activityResult.value.cacheStatus)
                : undefined,
            ].find(status => status && status.status !== 'fresh') ??
            normalizeUsageCacheInfo(summary.cacheStatus),
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
