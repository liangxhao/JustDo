import { ArrowPathIcon } from '@heroicons/react/24/outline';
import {
  type DailyTokenUsage,
  type DailyTokenUsageResult,
  USAGE_STATS_DAY_OPTIONS,
  type UsageStatsCacheInfo,
  type UsageStatsDays,
} from '@shared/openclaw/usage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

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
  const [dimension, setDimension] = useState<'byModel' | 'byProvider' | 'byAgent'>('byModel');
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

  const maxTokens = useMemo(() => Math.max(1, ...daily.map(entry => entry.totalTokens)), [daily]);
  const totalTokens = useMemo(
    () => snapshot?.totalTokens ?? daily.reduce((total, entry) => total + entry.totalTokens, 0),
    [daily, snapshot],
  );
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US'),
    [],
  );
  const compactFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }),
    [],
  );
  const totalCompactFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
        notation: 'compact',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      }),
    [],
  );
  const labelInterval = days === 30 ? 5 : days === 14 ? 2 : 1;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
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

      {snapshot && (
        <div className="space-y-4" aria-live="polite">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['usageStatsSessions', snapshot.activity?.sessionCount],
              ['usageStatsToolCalls', snapshot.activity?.toolCalls],
              ['usageStatsErrors', snapshot.activity?.errors],
              ['usageStatsInput', daily.reduce((sum, row) => sum + row.input, 0)],
              ['usageStatsOutput', daily.reduce((sum, row) => sum + row.output, 0)],
              ['usageStatsCacheRead', daily.reduce((sum, row) => sum + row.cacheRead, 0)],
              ['usageStatsCacheWrite', daily.reduce((sum, row) => sum + row.cacheWrite, 0)],
              ['usageStatsUserMessages', snapshot.activity?.userMessages],
              ['usageStatsAssistantMessages', snapshot.activity?.assistantMessages],
              [
                'usageStatsLatency',
                snapshot.activity?.averageLatencyMs === undefined
                  ? undefined
                  : (snapshot.activity.averageLatencyMs / 1000).toFixed(2) + ' s',
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className={`rounded-xl border border-border bg-surface p-3 ${label === 'usageStatsAssistantMessages' ? 'sm:col-start-2' : ''}`}
              >
                <p className="text-xs text-secondary">{i18nService.t(String(label))}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {value === undefined
                    ? '—'
                    : typeof value === 'number'
                      ? numberFormatter.format(value)
                      : value}
                </p>
              </div>
            ))}
          </div>
          {snapshot.activityError && (
            <p role="status" className="text-xs text-amber-600">
              {i18nService.t('usageStatsActivityUnavailable')}
            </p>
          )}
          {snapshot.updatedAt ? (
            <p className="text-xs text-secondary">
              {i18nService.t('usageStatsUpdatedAt')} {new Date(snapshot.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="text-xs text-secondary">{i18nService.t('usageStatsTotalTokens')}</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
              <span className="text-2xl font-semibold text-foreground">
                {snapshot ? numberFormatter.format(totalTokens) : '—'}
              </span>
              {snapshot && totalTokens >= (i18nService.getLanguage() === 'zh' ? 10000 : 1000) && (
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-secondary">
                  ≈{' '}
                  {totalCompactFormatter
                    .formatToParts(totalTokens)
                    .map(part => (part.type === 'compact' ? ` ${part.value}` : part.value))
                    .join('')}
                </span>
              )}
            </div>
          </div>
          <div className="text-xs text-secondary">{i18nService.t('usageStatsUnit')}</div>
        </div>

        {error ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg bg-surface-raised px-6 text-center">
            <p className="text-sm font-medium text-foreground">
              {i18nService.t('usageStatsUnavailable')}
            </p>
            <p className="max-w-md text-xs text-secondary">{error}</p>
            <button
              type="button"
              onClick={() => void loadUsage()}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
            >
              {i18nService.t('usageStatsRetry')}
            </button>
          </div>
        ) : (
          <div
            className={`relative h-64 transition-opacity ${isLoading ? 'opacity-50' : ''}`}
            role="img"
            aria-label={i18nService.t('usageStatsChartLabel')}
          >
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-border" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
            <div className="absolute inset-x-0 bottom-7 border-t border-border" />
            <div className="absolute inset-0 flex items-end gap-1 pb-7 pt-1">
              {daily.map((entry, index) => {
                const height =
                  entry.totalTokens === 0 ? 0 : Math.max(3, (entry.totalTokens / maxTokens) * 100);
                const date = new Date(`${entry.date}T00:00:00`);
                const showLabel = index % labelInterval === 0 || index === daily.length - 1;
                const tooltip = `${entry.date}: ${numberFormatter.format(entry.totalTokens)} ${i18nService.t('usageStatsUnit')}`;
                return (
                  <div key={entry.date} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                    <div className="group relative flex min-h-0 flex-1 items-end justify-center">
                      <div
                        className="w-full max-w-10 rounded-t bg-primary transition-[height,opacity] duration-300 hover:opacity-80"
                        style={{ height: `${height}%` }}
                        title={tooltip}
                        aria-label={tooltip}
                      />
                      {entry.totalTokens > 0 && (
                        <div className="pointer-events-none absolute bottom-[calc(100%+6px)] z-10 hidden whitespace-nowrap rounded bg-foreground px-2 py-1 text-[10px] text-background shadow group-hover:block">
                          {compactFormatter.format(entry.totalTokens)}
                        </div>
                      )}
                    </div>
                    <div className="h-7 pt-2 text-center text-[10px] text-secondary">
                      {showLabel ? `${date.getMonth() + 1}/${date.getDate()}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {snapshot?.activity && (
        <div className="space-y-4 rounded-xl border border-border bg-surface p-4">
          <ThemedSelect
            id="usage-dimension"
            value={dimension}
            onChange={value => setDimension(value as typeof dimension)}
            options={(['byModel', 'byProvider', 'byAgent'] as const).map(value => ({
              value,
              label: i18nService.t('usageStats' + value),
            }))}
          />
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-secondary">
                  <th className="py-2">{i18nService.t('usageStatsName')}</th>
                  <th className="text-right">{i18nService.t('usageStatsTotalTokens')}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.activity[dimension].map((row, index) => (
                  <tr key={index} className="border-t border-border">
                    <td className="max-w-64 break-words py-2">
                      {row.name || i18nService.t('usageStatsUnknown')}
                    </td>
                    <td className="text-right tabular-nums">
                      {numberFormatter.format(row.totalTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {snapshot.activity[dimension].length === 0 && (
              <p className="py-3 text-secondary">{i18nService.t('usageStatsEmpty')}</p>
            )}
          </div>
          <p className="text-xs font-medium">{i18nService.t('usageStatsTools')}</p>
          <div className="max-h-40 space-y-2 overflow-auto text-xs">
            {snapshot.activity.tools.map(tool => (
              <div key={tool.name} className="flex justify-between gap-3">
                <span className="break-all">{tool.name}</span>
                <span>{numberFormatter.format(tool.count)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default UsageStatsTab;
