import { ArrowPathIcon } from '@heroicons/react/24/outline';
import {
  type DailyTokenUsage,
  type DailyTokenUsageResult,
  USAGE_STATS_DAY_OPTIONS,
  type UsageStatsCacheInfo,
  type UsageStatsDays,
} from '@shared/openclaw/usage';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

import UsageDashboard from './UsageDashboard';

const dateKey = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

export const fillDailyTokenUsage = (
  daily: DailyTokenUsage[],
  days: number,
  today = new Date(),
): DailyTokenUsage[] => {
  const usageByDate = new Map(daily.map(entry => [entry.date, entry]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    date.setDate(date.getDate() - (days - index - 1));
    const key = dateKey(date);
    return (
      usageByDate.get(key) ?? {
        date: key,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      }
    );
  });
};

const formatUtcOffset = (): string => {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
};

const USAGE_REFRESH_POLL_INTERVAL_MS = 1500;
const USAGE_REFRESH_MAX_ATTEMPTS = 12;

export const shouldPollUsageStats = (cacheStatus?: UsageStatsCacheInfo): boolean =>
  cacheStatus !== undefined && cacheStatus.status !== 'fresh';

const UsageStatsTab: React.FC = () => {
  const [days, setDays] = useState<UsageStatsDays>(7);
  const [snapshot, setSnapshot] = useState<DailyTokenUsageResult | null>(null);
  const [daily, setDaily] = useState<DailyTokenUsage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<UsageStatsCacheInfo | undefined>();
  const requestGenerationRef = useRef(0);

  const loadUsage = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);
    setCacheStatus(undefined);
    setSnapshot(null);
    setDaily([]);
    try {
      for (let attempt = 0; attempt < USAGE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
        if (requestGeneration !== requestGenerationRef.current) return;
        const result = await window.electron.openclaw.usage.getDaily({
          days,
          utcOffset: formatUtcOffset(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (requestGeneration !== requestGenerationRef.current) return;
        if (!result.success) {
          throw new Error(result.error || i18nService.t('usageStatsLoadFailed'));
        }

        setSnapshot(result);
        setDaily(fillDailyTokenUsage(result.daily ?? [], days));
        setCacheStatus(result.cacheStatus);
        if (!shouldPollUsageStats(result.cacheStatus)) return;

        if (attempt < USAGE_REFRESH_MAX_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, USAGE_REFRESH_POLL_INTERVAL_MS));
        }
      }
    } catch (loadError) {
      if (requestGeneration !== requestGenerationRef.current) return;

      setError(
        loadError instanceof Error ? loadError.message : i18nService.t('usageStatsLoadFailed'),
      );
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [days]);

  useEffect(() => {
    void loadUsage();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [loadUsage]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-secondary">{i18nService.t('usageStatsDescription')}</p>
          <p className="mt-1 text-xs text-secondary">{i18nService.t('usageStatsScopeHint')}</p>
          {isLoading && shouldPollUsageStats(cacheStatus) && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-primary">
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
              <span>
                {i18nService
                  .t('usageStatsCalculating')
                  .replace('{count}', String(cacheStatus?.pendingFiles ?? 0))}
              </span>
            </p>
          )}
          {!isLoading && shouldPollUsageStats(cacheStatus) && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-300">
              {i18nService.t('usageStatsStillRefreshing')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="w-[112px]">
            <ThemedSelect
              id="usage-stats-days"
              value={String(days)}
              onChange={value => setDays(Number(value) as UsageStatsDays)}
              options={USAGE_STATS_DAY_OPTIONS.map(option => ({
                value: String(option),
                label: i18nService.t('usageStatsRecentDays').replace('{days}', String(option)),
              }))}
            />
          </div>
          <button
            type="button"
            onClick={() => void loadUsage()}
            disabled={isLoading}
            className="rounded-lg border border-border p-2 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={i18nService.t('usageStatsRefresh')}
            title={i18nService.t('usageStatsRefresh')}
          >
            <ArrowPathIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <div
          className="usage-panel flex min-h-64 flex-col items-center justify-center gap-3 text-center"
          role="alert"
        >
          <p className="font-medium">{i18nService.t('usageStatsUnavailable')}</p>
          <p className="text-xs text-secondary">{error}</p>
          <span className="text-2xl">—</span>
          <button
            type="button"
            onClick={() => void loadUsage()}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white"
          >
            {i18nService.t('usageStatsRetry')}
          </button>
        </div>
      ) : snapshot ? (
        <UsageDashboard daily={daily} snapshot={snapshot} />
      ) : (
        <div
          className="usage-panel animate-pulse space-y-4"
          role="status"
          aria-label={i18nService.t('usageStatsRefresh')}
        >
          <div className="h-16 rounded-xl bg-surface-raised" />
          <div className="h-64 rounded-xl bg-surface-raised" />
        </div>
      )}
    </div>
  );
};

export default UsageStatsTab;
