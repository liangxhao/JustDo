import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DB_FILENAME } from '../core/appConstants';
import type { RelocationCleanupProtectedPaths } from './relocationCleanup';
import { relocateOpenClawPath } from './relocationPaths';

const workspaceColumns = [
  ['cowork_sessions', 'cwd'],
  ['cowork_external_sessions', 'cwd'],
  ['cowork_plan_handoffs', 'artifact_workspace_root'],
  ['cowork_config', 'value'],
] as const;
const downloadColumns = [['browser_downloads', 'save_path']] as const;

type PathColumns = readonly (readonly [table: string, column: string])[];

function openProfileDatabase(file: string, readOnly: boolean): Database.Database | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('The copied profile database is not a regular file.');
  return new Database(file, { fileMustExist: true, readonly: readOnly });
}

function* queryStoredPaths(db: Database.Database, columns: PathColumns) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const [table, column] of columns) {
    if (!hasTable.get(table)) continue;
    const scope = table === 'cowork_config' ? " AND key = 'workingDirectory'" : '';
    const rows = db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL${scope}`)
      .all() as Array<{ value: unknown }>;
    const paths = rows.flatMap(({ value }) => typeof value === 'string' && value ? [value] : []);
    yield { table, column, scope, paths };
  }
}

function projectDatabasePaths(
  file: string,
  columns: PathColumns,
  sourceRoot: string,
  targetRoot: string,
): void {
  const db = openProfileDatabase(file, false);
  if (!db) return;
  try {
    db.pragma('synchronous = FULL');
    db.transaction(() => {
      for (const { table, column, scope, paths } of queryStoredPaths(db, columns)) {
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?${scope}`);
        for (const value of paths) {
          const next = relocateOpenClawPath(value, sourceRoot, targetRoot);
          if (next !== value) update.run(next, value);
        }
      }
    })();
  } finally {
    db.close();
  }
}

function readDatabasePaths(file: string, columns: PathColumns): string[] {
  const db = openProfileDatabase(file, true);
  if (!db) return [];
  try {
    return [...new Set([...queryStoredPaths(db, columns)].flatMap(({ paths }) => paths))];
  } finally {
    db.close();
  }
}

/** Update structured paths in the inactive target, leaving the source databases untouched. */
export function projectRelocatedProfilePaths(sourceRoot: string, targetRoot: string): void {
  projectDatabasePaths(path.join(targetRoot, DB_FILENAME), workspaceColumns, sourceRoot, targetRoot);
  projectDatabasePaths(path.join(targetRoot, 'browser-import.sqlite'), downloadColumns, sourceRoot, targetRoot);
}

/** Read recorded working directories and downloads without starting the application stores. */
export function readRelocatedProfilePaths(targetRoot: string): RelocationCleanupProtectedPaths {
  return {
    directories: readDatabasePaths(path.join(targetRoot, DB_FILENAME), workspaceColumns),
    files: readDatabasePaths(path.join(targetRoot, 'browser-import.sqlite'), downloadColumns),
  };
}
