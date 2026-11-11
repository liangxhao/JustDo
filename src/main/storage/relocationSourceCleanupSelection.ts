import fs, { type BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DB_FILENAME } from '../core/appConstants';
import { isManagedBrowserPartitionDirectory } from './browserCachePaths';
import {
  normalizeRelocationRelativePath,
  type RelocationManifest,
  type RelocationManifestEntry,
  relocationPhysicalIdentity,
} from './relocationFiles';
import { RELOCATION_ROOT_SCOPE } from './relocationScope';
import { assertCanonicalDirectory, pathsOverlap } from './relocationState';

export type SourceCleanupEntry = Pick<RelocationManifestEntry, 'relativePath' | 'kind' | 'physical'>;

const copiedDirectories = new Set(RELOCATION_ROOT_SCOPE.cleanableDirectories.map(name => name.toLowerCase()));
const copiedRootFiles = new Set(RELOCATION_ROOT_SCOPE.cleanableFiles.map(name => name.toLowerCase()));
const productDatabases = new Set([DB_FILENAME.toLowerCase(), 'browser-import.sqlite']);

function scopePath(value: string): string | undefined {
  try { return normalizeRelocationRelativePath(value).toLowerCase(); }
  catch { return undefined; }
}

const sqliteBase = (relative: string) => relative.replace(/-(?:wal|shm|journal)$/u, '');

/** Recognize the product SQLite families cleaned individually. */
export function sourceCleanupSqliteFamily(relativePath: string): string | undefined {
  const relative = scopePath(relativePath);
  if (!relative) return undefined;
  const base = sqliteBase(relative);
  return productDatabases.has(base) ? base : undefined;
}

export function isCopiedSourceCleanupCandidate(relativePath: string): boolean {
  const relative = scopePath(relativePath);
  if (!relative) return false;
  const [root, next] = relative.split('/');
  return copiedDirectories.has(root) ||
    (!next && (productDatabases.has(sqliteBase(root)) || copiedRootFiles.has(root))) ||
    (root === 'partitions' && isManagedBrowserPartitionDirectory(next ?? ''));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Preserve explicit native locations that the existing config projection kept in the source. */
export function retainedSourceConfigPaths(config: Record<string, unknown>, sourceRoot: string): string[] {
  const paths = new Set<string>();
  const addInsideSource = (absolute: string) => {
    const relative = path.relative(sourceRoot, absolute);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
      paths.add(absolute);
  };
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const absolute = path.resolve(value);
    addInsideSource(absolute);
    try { addInsideSource(fs.realpathSync.native(absolute)); }
    catch { /* A missing or inaccessible reference still retains its lexical path. */ }
  };
  const addWorkspace = (value: unknown) => {
    if (!isRecord(value)) return;
    add(value.cwd);
    add(value.workspace);
    if (isRecord(value.sandbox)) add(value.sandbox.workspaceRoot);
  };
  add(config.worktreeRoot);
  if (isRecord(config.session)) {
    const store = config.session.store;
    if (typeof store === 'string' && store.includes('{agentId}')) {
      const prefix = store.slice(0, store.indexOf('{agentId}'));
      add(/[\\/]$/u.test(prefix) ? prefix : path.dirname(prefix));
    } else add(store);
  }
  if (isRecord(config.agents)) {
    addWorkspace(config.agents.defaults);
    if (isRecord(config.agents.entries)) Object.values(config.agents.entries).forEach(addWorkspace);
  }
  if (isRecord(config.plugins)) {
    if (isRecord(config.plugins.load) && Array.isArray(config.plugins.load.paths))
      config.plugins.load.paths.forEach(add);
    if (isRecord(config.plugins.installs)) {
      for (const install of Object.values(config.plugins.installs)) {
        if (!isRecord(install)) continue;
        add(install.installPath);
        add(install.sourcePath);
      }
    }
  }
  if (isRecord(config.skills) && isRecord(config.skills.load) && Array.isArray(config.skills.load.extraDirs))
    config.skills.load.extraDirs.forEach(add);
  if (isRecord(config.secrets) && isRecord(config.secrets.providers)) {
    for (const provider of Object.values(config.secrets.providers)) {
      if (!isRecord(provider)) continue;
      if (provider.source === 'file') add(provider.path);
      if (provider.source === 'exec') {
        add(provider.command);
        if (Array.isArray(provider.args)) provider.args.forEach(add);
      }
    }
  }
  return [...paths];
}

const isProtected = (sourceRoot: string, relative: string, protectedPaths: readonly string[]) =>
  protectedPaths.some(protectedPath => pathsOverlap(path.join(sourceRoot, relative), protectedPath));

export function selectCopiedSourceCleanupEntries(
  manifest: RelocationManifest,
  protectedPaths: readonly string[],
): SourceCleanupEntry[] {
  return manifest.entries.flatMap(({ relativePath, kind, physical, provenance }) => {
    if (provenance || !isCopiedSourceCleanupCandidate(relativePath) ||
        isProtected(manifest.sourceRoot, relativePath, protectedPaths)) return [];
    return [{ relativePath, kind, physical }];
  });
}

async function statIfPresent(filename: string): Promise<BigIntStats | undefined> {
  try {
    return await fsp.lstat(filename, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function fromMetadata(relativePath: string, stat: BigIntStats): SourceCleanupEntry | undefined {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return undefined;
  return {
    relativePath: normalizeRelocationRelativePath(relativePath),
    kind: stat.isDirectory() ? 'directory' : 'file',
    physical: relocationPhysicalIdentity(stat),
  };
}

/** A separate metadata inventory for the regenerated top-level caches omitted by the copy. */
export async function captureExcludedBrowserCaches(
  sourceRoot: string,
  protectedPaths: readonly string[],
  signal: AbortSignal,
): Promise<SourceCleanupEntry[]> {
  const entries: SourceCleanupEntry[] = [];
  const pending = [...RELOCATION_ROOT_SCOPE.cleanSkippedCaches];
  while (pending.length) {
    signal.throwIfAborted();
    const relative = pending.pop()!;
    if (!isCopiedSourceCleanupCandidate(relative) || isProtected(sourceRoot, relative, protectedPaths)) continue;
    const filename = path.join(sourceRoot, relative);
    const stat = await statIfPresent(filename);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const directory = assertCanonicalDirectory(filename);
    const stream = await fsp.opendir(directory);
    for await (const item of stream) {
      signal.throwIfAborted();
      const child = path.join(relative, item.name);
      if (!isCopiedSourceCleanupCandidate(child) || isProtected(sourceRoot, child, protectedPaths)) continue;
      const childStat = await statIfPresent(path.join(directory, item.name));
      const entry = childStat && fromMetadata(child, childStat);
      if (entry?.kind === 'directory') pending.push(child);
      else if (entry) entries.push(entry);
    }
    assertCanonicalDirectory(directory);
    const after = await statIfPresent(directory);
    if (!after?.isDirectory() || after.isSymbolicLink() || stat.dev !== after.dev ||
        stat.ino !== after.ino || stat.birthtimeNs !== after.birthtimeNs)
      throw new Error('The old browser cache directory changed during cleanup inventory.');
    const entry = fromMetadata(relative, stat);
    if (entry) entries.push(entry);
  }
  return entries;
}
