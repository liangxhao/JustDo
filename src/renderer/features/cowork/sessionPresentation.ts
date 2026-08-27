import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
export type { SessionDetailStats } from '@shared/cowork/sessionDetails';
export {
  buildLocalSessionDetailStats as buildSessionDetailStats,
  sumSessionDetailTokenUsage,
} from '@shared/cowork/sessionDetails';
export type SessionDateGroupKey =
  'pinned' | 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'earlier';

export interface SessionDateGroup {
  key: SessionDateGroupKey;
  sessions: CoworkSessionSummary[];
}

const DATE_GROUP_ORDER: SessionDateGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'previous7Days',
  'previous30Days',
  'earlier',
];

const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary): number => {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt;
};

const localCalendarDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
};

export const getSessionDateGroupKey = (
  session: CoworkSessionSummary,
  now: number = Date.now(),
): SessionDateGroupKey => {
  if (session.pinned) return 'pinned';

  const dayDifference = localCalendarDay(now) - localCalendarDay(session.updatedAt);
  if (dayDifference <= 0) return 'today';
  if (dayDifference === 1) return 'yesterday';
  if (dayDifference <= 7) return 'previous7Days';
  if (dayDifference <= 30) return 'previous30Days';
  return 'earlier';
};

export const groupSessionsByDate = (
  sessions: CoworkSessionSummary[],
  now: number = Date.now(),
): SessionDateGroup[] => {
  const grouped = new Map<SessionDateGroupKey, CoworkSessionSummary[]>();
  for (const session of sessions) {
    const key = getSessionDateGroupKey(session, now);
    const values = grouped.get(key) ?? [];
    values.push(session);
    grouped.set(key, values);
  }

  return DATE_GROUP_ORDER.flatMap(key => {
    const values = grouped.get(key);
    return values?.length ? [{ key, sessions: values.sort(sortByRecentActivity) }] : [];
  });
};
