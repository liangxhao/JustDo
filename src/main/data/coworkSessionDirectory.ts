import type Database from 'better-sqlite3';

import type { HistorySessionBinding } from '../../shared/app/startup/history';
import type { SessionDirectoryEntry } from '../../shared/cowork/sessionDirectory';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import {
  type ExternalSessionMetadata,
  ExternalSessionSource,
  type ExternalSessionStatus,
} from '../../shared/integrations/externalSession';
import { isCustodySessionKey } from '../openclaw/sessions/openclawSessionKeys';
import type { CoworkSessionSummary } from './coworkStore';

interface SessionProjectionRow {
  id: string;
  title?: string;
  status: SessionDirectoryEntry['status'];
  pinned: number;
  agent_id: string | null;
  group_id: string | null;
  source: string | null;
  native_session_key: string | null;
  created_at: number;
  updated_at: number;
  external_source: ExternalSessionMetadata['origin'] | null;
  external_status: ExternalSessionStatus | null;
  external_session_key: string | null;
  history_session_key: string | null;
  history_native_session_id?: string;
  history_availability?: HistorySessionBinding['availability'];
  branch_pending?: number;
}

interface ProjectionOptions {
  agentId?: string;
  sessionIds?: string[];
  summaries?: boolean;
}

/** A bounded number of SQL queries, independent of the number of sessions returned. */
const readProjection = (
  db: Database.Database,
  { agentId, sessionIds, summaries = false }: ProjectionOptions,
): SessionProjectionRow[] => {
  if (sessionIds?.length === 0) return [];
  // The production schema owns both tables. Small store fixtures may omit them.
  const tables = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('cowork_external_sessions', 'history_session_bindings')`,
        )
        .all() as { name: string }[]
    ).map(row => row.name),
  );
  const external = tables.has('cowork_external_sessions');
  const history = tables.has('history_session_bindings');
  const predicates: string[] = [];
  const parameters: string[] = [];
  if (agentId) {
    predicates.push('session.agent_id = ?');
    parameters.push(agentId);
  }
  if (sessionIds) {
    predicates.push(`session.id IN (${sessionIds.map(() => '?').join(',')})`);
    parameters.push(...sessionIds);
  }
  return db
    .prepare(
      `SELECT session.id, session.status, session.pinned, session.agent_id,
      session.group_id, session.source, session.native_session_key,
      session.created_at, session.updated_at,
      ${external ? 'external.source' : 'NULL'} AS external_source,
      ${external ? 'external.status' : 'NULL'} AS external_status,
      ${external ? 'external.openclaw_session_key' : 'NULL'} AS external_session_key,
      ${history ? 'history.session_key' : 'NULL'} AS history_session_key
      ${
        summaries
          ? `, session.title,
        ${history ? 'history.native_session_id' : 'NULL'} AS history_native_session_id,
        ${history ? 'history.availability' : 'NULL'} AS history_availability,
        EXISTS (SELECT 1 FROM cowork_config AS config
          WHERE config.key = 'sessionBranchPending:' || session.id) AS branch_pending`
          : ''
      }
    FROM cowork_sessions AS session
    ${
      external
        ? `LEFT JOIN cowork_external_sessions AS external
      ON external.cowork_session_id = session.id
      AND external.source IN ('${ExternalSessionSource.Cli}', '${ExternalSessionSource.HistoricalAppServer}')`
        : ''
    }
    ${history ? 'LEFT JOIN history_session_bindings AS history ON history.session_id = session.id' : ''}
    ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
    ORDER BY session.pinned DESC, session.updated_at DESC, session.id ASC`,
    )
    .all(...parameters) as SessionProjectionRow[];
};

const isVisible = (row: SessionProjectionRow): boolean =>
  ![row.native_session_key, row.history_session_key, row.external_session_key].some(
    isCustodySessionKey,
  );

const mapDirectoryEntry = (row: SessionProjectionRow): SessionDirectoryEntry => {
  const nativeSessionKey = row.native_session_key || row.history_session_key;
  return {
    id: row.id,
    status: row.status,
    pinned: Boolean(row.pinned),
    agentId: row.agent_id || 'main',
    groupId: row.group_id,
    ...(row.source === CoworkSessionSource.BrowserExtension ? { source: row.source } : {}),
    ...(nativeSessionKey ? { nativeSessionKey } : {}),
    ...(row.external_source && row.external_status
      ? {
          external: {
            origin: row.external_source,
            readOnly: true as const,
            status: row.external_status,
            sessionKey: row.external_session_key ?? '',
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const readSessionDirectory = (
  db: Database.Database,
  agentId?: string,
): SessionDirectoryEntry[] =>
  readProjection(db, { agentId }).filter(isVisible).map(mapDirectoryEntry);

export const readSessionSummaryProjection = (
  db: Database.Database,
  options: Omit<ProjectionOptions, 'summaries'> = {},
): CoworkSessionSummary[] =>
  readProjection(db, { ...options, summaries: true })
    .filter(isVisible)
    .map(row => ({
      ...mapDirectoryEntry(row),
      agentId: row.agent_id || 'main',
      groupId: row.group_id,
      title: row.title ?? '',
      ...(row.branch_pending ? { branchCreationPending: true } : {}),
      ...(row.history_session_key
        ? {
            historyBinding: {
              sessionKey: row.history_session_key,
              nativeSessionId: row.history_native_session_id!,
              availability: row.history_availability!,
            },
          }
        : {}),
    }));
