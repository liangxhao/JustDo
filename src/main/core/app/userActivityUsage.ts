import type { GatewayClientLike } from '../../engine/gateway/types';

export const USER_ACTIVITY_TIME_ZONE = 'Asia/Shanghai';
export const USER_ACTIVITY_UTC_OFFSET = 'UTC+8';
export const USER_ACTIVITY_USAGE_DAYS = 7;
export const USER_ACTIVITY_USAGE_TIMEOUT_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_SOURCE_CREATORS = 1024;
const MAX_SOURCE_COHORTS = 4096;
const MAX_SOURCE_DATES = 31;
const CACHE_STATUSES = ['fresh', 'partial', 'stale', 'refreshing'] as const;

type UsageCacheStatus = (typeof CACHE_STATUSES)[number];

export type UserActivityDailyUsage = {
  date: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type UserActivityUsageSnapshot = {
  daily: UserActivityDailyUsage[];
  cacheStatus?: UsageCacheStatus;
  updatedAt?: number;
};

type CollectOptions = { now?: number; signal?: AbortSignal };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const activityDates = (now: number): string[] | null => {
  if (!Number.isFinite(now)) return null;
  const shifted = new Date(now + UTC_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  shifted.setUTCHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (let index = 0; index < USER_ACTIVITY_USAGE_DAYS; index += 1) {
    const date = new Date(shifted.getTime() - (USER_ACTIVITY_USAGE_DAYS - index - 1) * DAY_MS);
    if (!Number.isFinite(date.getTime())) return null;
    const key = date.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    dates.push(key);
  }
  return dates;
};

const normalizeUsage = (value: unknown, dates: string[]): UserActivityUsageSnapshot | null => {
  if (!record(value) || !record(value.aggregates)) return null;
  const { costDaily, byCreator } = value.aggregates;
  if (!Array.isArray(costDaily) || costDaily.length > MAX_SOURCE_DATES ||
      !Array.isArray(byCreator) || byCreator.length > MAX_SOURCE_CREATORS) return null;

  const daily = dates.map(date => ({
    date, sessionCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  }));
  const days = new Map(daily.map(day => [day.date, day]));
  const tokenDates = new Set<string>();
  for (const item of costDaily) {
    if (!record(item) || typeof item.date !== 'string') return null;
    const day = days.get(item.date);
    if (!day) continue;
    if (tokenDates.has(item.date) || !count(item.input) || !count(item.output) ||
        !count(item.totalTokens)) return null;
    tokenDates.add(item.date);
    day.inputTokens = item.input;
    day.outputTokens = item.output;
    day.totalTokens = item.totalTokens;
  }

  let cohortCount = 0;
  for (const creator of byCreator) {
    if (!record(creator) || !Array.isArray(creator.sessionActivity)) return null;
    cohortCount += creator.sessionActivity.length;
    if (cohortCount > MAX_SOURCE_COHORTS) return null;
    for (const item of creator.sessionActivity) {
      if (!record(item) || !Array.isArray(item.dates) ||
          item.dates.length > MAX_SOURCE_DATES || !count(item.sessionCount)) return null;
      const countedDates = new Set<string>();
      for (const date of item.dates) {
        if (typeof date !== 'string') return null;
        const day = days.get(date);
        if (!day || countedDates.has(date)) continue;
        const next = day.sessionCount + item.sessionCount;
        if (!count(next)) return null;
        day.sessionCount = next;
        countedDates.add(date);
      }
    }
  }

  const snapshot: UserActivityUsageSnapshot = { daily };
  if (record(value.cacheStatus)) {
    const status = value.cacheStatus.status;
    if (CACHE_STATUSES.some(candidate => candidate === status)) {
      snapshot.cacheStatus = status as UsageCacheStatus;
    }
  }
  if (count(value.updatedAt)) snapshot.updatedAt = value.updatedAt;
  return snapshot;
};

/** Read one native aggregate; never fetch histories or poll for cache completion. */
export const collectUserActivityUsage = async (
  client: Pick<GatewayClientLike, 'request'> | null,
  options: CollectOptions = {},
): Promise<UserActivityUsageSnapshot | null> => {
  if (!client || options.signal?.aborted) return null;
  const dates = activityDates(options.now ?? Date.now());
  if (!dates) return null;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let resolveAbort = (): void => {};
  const aborted = new Promise<null>(resolve => {
    resolveAbort = (): void => resolve(null);
    controller.signal.addEventListener('abort', resolveAbort, { once: true });
  });
  const timer = setTimeout(abort, USER_ACTIVITY_USAGE_TIMEOUT_MS);
  timer.unref();
  try {
    const value = await Promise.race([
      client.request<unknown>('sessions.usage', {
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        agentScope: 'all',
        mode: 'specific',
        utcOffset: USER_ACTIVITY_UTC_OFFSET,
        timeZone: USER_ACTIVITY_TIME_ZONE,
        groupBy: 'instance',
        limit: 1,
        includeContextWeight: false,
      }, { timeoutMs: USER_ACTIVITY_USAGE_TIMEOUT_MS, signal: controller.signal }),
      aborted,
    ]);
    return controller.signal.aborted ? null : normalizeUsage(value, dates);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', resolveAbort);
  }
};
