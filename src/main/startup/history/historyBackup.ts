import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DB_FILENAME } from '../../core/appConstants';
import { startupPathExists, writeStartupJson } from '../routing/startupState';
import { historySourceChanged } from './historyFailure';

type BackupFile = { path: string; size: number; sha256: string };
export type HistoryBackupManifest = { version: 1; files: BackupFile[] };

export function ownedPath(root: string, relative: string, allowLeafLink = false): string {
  const resolved = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), resolved);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside))
    throw new Error('History path escaped its owned directory.');
  const parts = inside.split(path.sep);
  for (let index = 1; index <= parts.length; index++) {
    if (index === parts.length && allowLeafLink) continue;
    const parent = path.join(root, ...parts.slice(0, index));
    try {
      if (fs.lstatSync(parent).isSymbolicLink())
        throw new Error('History path crosses a linked directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

export function digestFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes: number;
    while ((bytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, bytes));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function assertRegular(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('History backup contains a linked or non-regular file.');
  return stat;
}

/** Recovery originals only: never open old native databases or stage them for import. */
function nativeHistoryOriginals(source: string): string[] {
  const files: string[] = [];
  const visit = (relative: string, accept: (entry: fs.Dirent) => boolean, recursive = false) => {
    const folder = ownedPath(source, relative);
    if (!startupPathExists(folder)) return;
    if (!fs.lstatSync(folder).isDirectory()) throw new Error('Invalid native history directory.');
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!recursive && !accept(entry)) continue;
      const child = path.join(relative, entry.name);
      const file = ownedPath(source, child);
      if (recursive && entry.isDirectory()) visit(child, accept, true);
      else {
        assertRegular(file);
        files.push(child);
      }
    }
  };
  // Include journal-mode sidecars, orphan sidecars and native recovery copies.
  // Other agent files can contain credentials/configuration and are not history.
  const sqlite = (entry: fs.Dirent) => /\.sqlite(?:$|[-.])/u.test(entry.name);
  visit(path.join('openclaw', 'state', 'state'), sqlite);
  visit(path.join('openclaw', 'state', 'session-sqlite-migration-runs'), () => true, true);
  const agentsRelative = path.join('openclaw', 'state', 'agents');
  const agents = ownedPath(source, agentsRelative);
  if (startupPathExists(agents)) {
    for (const agent of fs.readdirSync(agents, { withFileTypes: true })) {
      if (agent.isSymbolicLink()) throw new Error('Linked agent directories cannot be backed up.');
      if (!agent.isDirectory()) continue;
      const relative = path.join(agentsRelative, agent.name);
      visit(path.join(relative, 'agent'), sqlite);
      visit(path.join(relative, 'session-sqlite-import-archive'), () => true, true);
      const sessions = path.join(relative, 'sessions');
      visit(
        sessions,
        entry =>
          (/\.jsonl\./u.test(entry.name) &&
            !entry.name.endsWith('.jsonl') &&
            !entry.name.includes('.trajectory.')) ||
          entry.name.startsWith('sessions.json.bak'),
      );
      visit(path.join(sessions, 'cold'), () => true, true);
    }
  }
  return files.sort();
}

/** Fence the opaque originals again after planning, immediately before isolation. */
export function verifyNativeHistoryOriginals(source: string, backup: string): void {
  const originals = nativeHistoryOriginals(source);
  if (
    JSON.stringify(originals) !== JSON.stringify(nativeHistoryOriginals(backup)) ||
    originals.some(
      relative =>
        digestFile(ownedPath(source, relative)) !== digestFile(ownedPath(backup, relative)),
    ) ||
    JSON.stringify(originals) !== JSON.stringify(nativeHistoryOriginals(source))
  )
    throw historySourceChanged(
      'Native history files changed after backup. Close the previous application and retry.',
    );
}

/** Published JSONL installations only. The snapshot includes committed product WAL. */
export async function createHistoryBackup(source: string, destination: string): Promise<void> {
  if (fs.existsSync(path.join(destination, 'manifest.json'))) {
    verifyHistoryBackup(destination);
    return;
  }
  fs.mkdirSync(destination, { recursive: true });
  const files: BackupFile[] = [];
  const sourceFiles: { file: string; digest: string; size: number; mtime: number }[] = [];
  const nativeOriginals = nativeHistoryOriginals(source);
  const product = path.join(source, DB_FILENAME);
  const db = fs.existsSync(product)
    ? new Database(product, { readonly: true, fileMustExist: true })
    : null;
  const dataVersion = db?.pragma('data_version', { simple: true });
  try {
    const copy = async (file: string) => {
      ownedPath(source, path.relative(source, file));
      const before = assertRegular(file);
      const relative = path.relative(source, file);
      const target = ownedPath(destination, relative);
      const digest = digestFile(file);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(file, target);
      const after = assertRegular(file);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        digestFile(target) !== digest ||
        digestFile(file) !== digest
      )
        throw historySourceChanged(
          'History changed during backup. Close the previous application and retry.',
        );
      files.push({ path: relative, size: before.size, sha256: digest });
      sourceFiles.push({ file, digest, size: before.size, mtime: before.mtimeMs });
    };
    if (db) {
      assertRegular(product);
      const target = path.join(destination, DB_FILENAME);
      // An incomplete snapshot is never considered a committed backup.
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
      await db.backup(target);
      const snapshot = new Database(target, { readonly: true, fileMustExist: true });
      try {
        if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error('The history metadata snapshot failed integrity verification.');
      } finally {
        snapshot.close();
      }
      files.push({ path: DB_FILENAME, size: fs.statSync(target).size, sha256: digestFile(target) });
    }
    for (const relative of nativeOriginals) await copy(ownedPath(source, relative));
    const agents = path.join(source, 'openclaw', 'state', 'agents');
    if (fs.existsSync(agents)) {
      for (const agent of fs.readdirSync(agents, { withFileTypes: true })) {
        if (agent.isSymbolicLink())
          throw new Error('Linked agent directories cannot be backed up.');
        if (!agent.isDirectory()) continue;
        if (!/^[a-zA-Z0-9_-]+$/.test(agent.name))
          throw new Error('Invalid historical agent identity.');
        const folder = path.join(agents, agent.name, 'sessions');
        if (!fs.existsSync(folder)) continue;
        if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Linked session directory.');
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (
            entry.name === 'sessions.json' ||
            (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.trajectory.jsonl'))
          )
            await copy(path.join(folder, entry.name));
        }
      }
    }
    const media = path.join(source, 'openclaw', 'state', 'media');
    const copyMedia = async (folder: string): Promise<void> => {
      if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Linked media directory.');
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Linked historical attachment.');
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await copyMedia(file);
        else await copy(file);
      }
    };
    if (fs.existsSync(media)) await copyMedia(media);
    // Detect writes to files copied early, and committed database writes across the snapshot.
    for (const entry of sourceFiles) {
      const stat = assertRegular(entry.file);
      if (
        stat.size !== entry.size ||
        stat.mtimeMs !== entry.mtime ||
        digestFile(entry.file) !== entry.digest
      )
        throw historySourceChanged(
          'The previous application is still writing history. Backup was not committed.',
        );
    }
    if (db && db.pragma('data_version', { simple: true }) !== dataVersion)
      throw historySourceChanged('The previous application changed metadata during backup.');
    if (JSON.stringify(nativeHistoryOriginals(source)) !== JSON.stringify(nativeOriginals))
      throw historySourceChanged(
        'Native history files changed during backup. Close the previous application and retry.',
      );
    writeStartupJson(path.join(destination, 'manifest.json'), { version: 1, files });
    verifyHistoryBackup(destination);
  } finally {
    db?.close();
  }
}

export function verifyHistoryBackup(folder: string): HistoryBackupManifest {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'),
  ) as HistoryBackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('Invalid history backup manifest.');
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || paths.has(entry.path))
      throw new Error('Invalid backup file identity.');
    paths.add(entry.path);
    const file = ownedPath(folder, entry.path);
    if (assertRegular(file).size !== entry.size || digestFile(file) !== entry.sha256)
      throw new Error('History backup verification failed. Source data has been preserved.');
  }
  return manifest;
}
