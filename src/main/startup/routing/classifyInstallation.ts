import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { StartupRoute, StartupStage } from '../../../shared/app/startup/routing';
import { DB_FILENAME } from '../../core/appConstants';
import { readStartupJournal, type StartupJournal, startupPathExists } from './startupState';

export type StartupDecision = { route: StartupRoute; journal: StartupJournal | null };

function inspectProductDatabase(file: string): 'absent' | 'legacy' | 'current' {
  if (!startupPathExists(file)) return 'absent';
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('The product database could not be verified.');
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map(row => row.name),
    );
    if (!tables.has('cowork_sessions') || !tables.has('kv'))
      throw new Error('Unrecognized product database. Existing data has been preserved.');
    if (tables.has('cowork_messages')) return 'legacy';
    if (tables.has('cowork_session_runs')) return 'current';
    throw new Error('Unrecognized product data generation. Existing data has been preserved.');
  } finally {
    db.close();
  }
}

/** Read-only admission, before SqliteStore, config projection or Gateway may touch a profile. */
export function classifyInstallation(userData: string, includeRecovery = true): StartupDecision {
  const journal = includeRecovery ? readStartupJournal(userData) : null;
  if (journal && journal.stage !== StartupStage.Complete) {
    if (journal.route === StartupRoute.Upgrade &&
        classifyInstallation(userData, false).route !== StartupRoute.Normal)
      throw new Error('The product data generation changed during database upgrade. Existing data has been preserved.');
    if (
      journal.stage === StartupStage.Backup &&
      classifyInstallation(userData, false).route !== StartupRoute.Migration
    )
      throw new Error('The active data generation changed before history backup was committed.');
    return { route: journal.route, journal };
  }
  const product = inspectProductDatabase(path.join(userData, DB_FILENAME));
  // The published product schema selects main-only history migration. Other
  // legacy execution identities are archived, never admitted as user profiles.
  if (product === 'legacy') return { route: StartupRoute.Migration, journal: null };
  const state = path.join(userData, 'openclaw', 'state');
  let jsonl = false;
  let sqlite = false;
  const agents = path.join(state, 'agents');
  if (startupPathExists(agents)) {
    for (const folder of [path.dirname(state), state, agents])
      if (fs.lstatSync(folder).isSymbolicLink())
        throw new Error('Linked native data requires manual recovery.');
    for (const entry of fs.readdirSync(agents, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Linked native data requires manual recovery.');
      if (!entry.isDirectory()) continue;
      const folder = path.join(agents, entry.name);
      const index = path.join(folder, 'sessions', 'sessions.json');
      if (startupPathExists(index)) {
        const rows: unknown = JSON.parse(fs.readFileSync(index, 'utf8'));
        if (!rows || typeof rows !== 'object' || Array.isArray(rows))
          throw new Error('Invalid legacy session index. Existing data has been preserved.');
        jsonl ||= Object.keys(rows).length > 0;
      }
      // Only the active canonical native database counts, never archives/backups.
      sqlite ||= startupPathExists(path.join(folder, 'agent', 'openclaw-agent.sqlite'));
    }
  }
  if (sqlite && jsonl)
    throw new Error(
      'Mixed native history formats require recovery. Existing data has been preserved.',
    );
  if (jsonl && product === 'absent')
    throw new Error(
      'The legacy conversation index is missing. Existing history has been preserved.',
    );
  if (jsonl) return { route: StartupRoute.Migration, journal: null };
  if (product === 'current') return { route: StartupRoute.Normal, journal };
  if (sqlite)
    throw new Error(
      'Native history exists without its product index. Existing data has been preserved.',
    );
  if (startupPathExists(path.join(state, 'openclaw.json')))
    return { route: StartupRoute.Migration, journal: null };
  if (journal?.stage === StartupStage.Complete)
    throw new Error(
      'The initialized product database is missing. Existing backups have been preserved.',
    );
  return { route: StartupRoute.Fresh, journal: null };
}
