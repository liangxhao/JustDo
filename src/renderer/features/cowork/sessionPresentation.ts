import type { SessionDirectoryEntry } from '@shared/cowork/sessionDirectory';
import { CoworkSessionSource } from '@shared/cowork/sessionSource';
import { ExternalSessionSource } from '@shared/integrations/externalSession';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
export type { SessionDetailStats } from '@shared/cowork/sessionDetails';
export { sumSessionDetailTokenUsage } from '@shared/cowork/sessionDetails';
export const SessionHistoryGrouping = {
  Time: 'time',
  Workspace: 'workspace',
} as const;
export type SessionHistoryGrouping =
  (typeof SessionHistoryGrouping)[keyof typeof SessionHistoryGrouping];

export interface SessionWorkspaceGroup {
  key: string;
  path: string;
  label: string;
  sessions: SessionDirectoryEntry[];
  visibleCount: number;
}

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
  chromeExtension: T[];
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
  const chromeExtension: T[] = [];
  const regular: T[] = [];

  for (const session of sessions) {
    if (session.external?.origin === ExternalSessionSource.Cli) {
      cli.push(session);
    } else if (session.source === CoworkSessionSource.ChromeExtension) {
      chromeExtension.push(session);
    } else {
      regular.push(session);
    }
  }

  return {
    cli: cli.sort(sortByRecentActivity),
    chromeExtension: chromeExtension.sort(sortByRecentActivity),
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

function sessionWorkspacePath(cwd: string) {
  const windowsPath = /^[a-z]:[\\/]|^(?:\\\\|\/\/)/i.test(cwd);
  const normalized = windowsPath ? cwd.replace(/\\/g, '/') : cwd;
  const path = normalized.replace(/\/+$/, '') || normalized;
  return {
    key: windowsPath ? path.toLowerCase() : path,
    label: path.slice(path.lastIndexOf('/') + 1) || path,
  };
}

export const getSessionWorkspaceKey = (cwd?: string): string => sessionWorkspacePath(cwd ?? '').key;

export function groupSessionsByWorkspace(
  sessions: SessionDirectoryEntry[],
  visibleIds: Pick<ReadonlySet<string>, 'has'>,
): SessionWorkspaceGroup[] {
  const grouped = new Map<string, SessionWorkspaceGroup>();
  for (const session of [...sessions].sort(sortByRecentActivity)) {
    const cwd = session.cwd ?? '';
    const { key, label } = sessionWorkspacePath(cwd);
    let group = grouped.get(key);
    if (!group) {
      group = {
        key,
        path: cwd,
        label,
        sessions: [],
        visibleCount: 0,
      };
      grouped.set(key, group);
    }
    group.sessions.push(session);
    if (visibleIds.has(session.id)) group.visibleCount += 1;
  }

  const groups = [...grouped.values()].filter(group => group.visibleCount > 0);
  return [...groups.filter(group => group.key), ...groups.filter(group => !group.key)];
}
