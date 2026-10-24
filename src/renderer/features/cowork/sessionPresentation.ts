import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { ExternalSessionSource } from '@shared/integrations/externalSession';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
export type { SessionDetailStats } from '@shared/cowork/sessionDetails';
export { sumSessionDetailTokenUsage } from '@shared/cowork/sessionDetails';
export type SessionDateGroupKey =
  'pinned' | 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'earlier';

type SidebarSession = Pick<CoworkSessionSummary,
  'id' | 'updatedAt' | 'createdAt' | 'pinned' | 'external' | 'source'>;

export interface SessionDateGroup<T extends SidebarSession = CoworkSessionSummary> {
  key: SessionDateGroupKey;
  sessions: T[];
}

export interface SidebarSessionBuckets<T extends SidebarSession = CoworkSessionSummary> {
  cli: T[];
  browserExtension: T[];
  regular: T[];
}

export const DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS: readonly SessionDateGroupKey[] = [
  'previous7Days',
  'previous30Days',
  'earlier',
];

const DATE_GROUP_ORDER: SessionDateGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'previous7Days',
  'previous30Days',
  'earlier',
];

const sortByRecentActivity = (a: SidebarSession, b: SidebarSession): number => {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
};

export const partitionSidebarSessions = <T extends SidebarSession>(
  sessions: T[],
): SidebarSessionBuckets<T> => {
  const cli: T[] = [];
  const browserExtension: T[] = [];
  const regular: T[] = [];

  for (const session of sessions) {
    if (session.external?.origin === ExternalSessionSource.Cli) {
      cli.push(session);
    } else if (session.source === CoworkSessionSource.BrowserExtension) {
      browserExtension.push(session);
    } else {
      regular.push(session);
    }
  }

  return {
    cli: cli.sort(sortByRecentActivity),
    browserExtension: browserExtension.sort(sortByRecentActivity),
    regular,
  };
};

const localCalendarDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
};

export const getSessionDateGroupKey = (
  session: Pick<SidebarSession, 'pinned' | 'updatedAt'>,
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

export const groupSessionsByDate = <T extends SidebarSession>(
  sessions: T[],
  now: number = Date.now(),
): SessionDateGroup<T>[] => {
  const grouped = new Map<SessionDateGroupKey, T[]>();
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
