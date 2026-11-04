import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import {
  assertPluginDataId,
  parsePluginDataOwner,
  PLUGIN_DATA_DIRECTORY,
  PLUGIN_DATA_OWNER_FILE,
  resolvePluginDataDirectory,
} from '../../../../plugins/sdk/app-plugin-sdk/data';

interface Entry {
  file: string;
  directory: boolean;
  identity: string;
  stamp: string;
}
interface Inventory {
  directory: string;
  owner: string;
  entries: Entry[];
  bytes: number;
  retained?: true;
}
interface Removal {
  state: string;
  root: string;
  stateIdentity: string;
  rootIdentity?: string;
  pluginIds: string[];
  inventories: Inventory[];
}
export interface PluginDataRemovalSnapshot { readonly token: string }
export interface PluginDataInfo {
  exists: boolean;
  bytes: number;
  canDelete: boolean;
  reason?: string;
  retained?: true;
}
const removals = new WeakMap<PluginDataRemovalSnapshot, Removal>();
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 128;
const LEGACY_RESERVED = new Set([
  'agents', 'agent-workspaces', 'auth', 'backups', 'browser', 'cache', 'canvas', 'completions',
  'credentials', 'cron', 'delivery-queue', 'devices', 'extensions', 'hooks', 'identity', 'logs',
  'media', 'memory', 'nodes', 'pairing', 'plugin-data', 'plugins', 'runtime-services', 'sessions',
  'skills', 'subagents', 'tmp', 'workspace', 'workspaces',
]);
const id = (info: BigIntStats) => [info.dev, info.ino, info.birthtimeNs].join(':');
const stamp = (info: BigIntStats) => [id(info), info.size, info.mtimeNs, info.ctimeNs].join(':');
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const message = (error: unknown) => error instanceof Error ? error.message : 'Plugin data is unavailable';

async function stat(file: string): Promise<BigIntStats | undefined> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
async function regularDirectory(directory: string): Promise<BigIntStats> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory)
    throw new Error('Plugin data contains a linked or invalid directory');
  return info;
}
async function roots(stateDirectory: string) {
  if (!path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')) throw new Error('Invalid plugin data state root');
  const state = path.resolve(stateDirectory);
  const stateInfo = await regularDirectory(state);
  const root = path.join(state, PLUGIN_DATA_DIRECTORY);
  const rootInfo = await stat(root);
  if (rootInfo) await regularDirectory(root);
  return { state, root, stateInfo, rootInfo };
}
function ids(pluginIds: readonly string[]) {
  if (!Array.isArray(pluginIds) || !pluginIds.length || pluginIds.length > 4096)
    throw new Error('Invalid plugin data owners');
  const result = [...new Set(pluginIds)];
  result.forEach(assertPluginDataId);
  return result;
}

async function tree(directory: string): Promise<{ entries: Entry[]; bytes: number }> {
  const entries: Entry[] = [];
  let bytes = 0;
  async function visit(file: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) throw new Error('Plugin data inventory exceeds the safety limit');
    const info = await lstat(file, { bigint: true });
    if (info.isSymbolicLink() || await realpath(file) !== file ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)))
      throw new Error('Plugin data contains linked or unsupported files');
    entries.push({ file, directory: info.isDirectory(), identity: id(info), stamp: stamp(info) });
    if (info.isDirectory()) {
      const children = (await readdir(file)).sort();
      for (const child of children) await visit(path.join(file, child), depth + 1);
    } else {
      bytes += Number(info.size);
      if (!Number.isSafeInteger(bytes)) throw new Error('Plugin data size exceeds the safety limit');
    }
    if (stamp(await lstat(file, { bigint: true })) !== stamp(info)) throw new Error('Plugin data changed during inspection');
  }
  await visit(directory, 0);
  return { entries, bytes };
}
async function inventory(state: string, pluginId: string): Promise<Inventory> {
  const directory = resolvePluginDataDirectory(state, pluginId);
  const owner = await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8');
  const inspected = await tree(directory);
  if (resolvePluginDataDirectory(state, pluginId) !== directory ||
      await readFile(path.join(directory, PLUGIN_DATA_OWNER_FILE), 'utf8') !== owner)
    throw new Error('Plugin data owner changed during inspection');
  const retained = parsePluginDataOwner(JSON.parse(owner)).retention === 'retain';
  return { directory, owner, ...inspected, ...(retained ? { retained: true as const } : {}) };
}

/** A stopped preparation may strengthen retention, but never remove a durable policy. */
async function retainOwner(directory: string, pluginId: string): Promise<void> {
  const directoryIdentity = id(await regularDirectory(directory));
  const marker = path.join(directory, PLUGIN_DATA_OWNER_FILE);
  const before = await lstat(marker, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n ||
      await realpath(marker) !== marker) throw new Error('Plugin data owner is unavailable');
  const previous = parsePluginDataOwner(JSON.parse(await readFile(marker, 'utf8')));
  if (previous.pluginId !== pluginId || stamp(await lstat(marker, { bigint: true })) !== stamp(before))
    throw new Error('Plugin data owner changed during preparation');
  if (previous.retention === 'retain') return;
  const temporary = path.join(directory, `.owner-${randomUUID()}.tmp`);
  let temporaryIdentity: string | undefined;
  try {
    await writeFile(temporary, JSON.stringify({ ...previous, retention: 'retain' }) + '\n', { flag: 'wx' });
    temporaryIdentity = id(await lstat(temporary, { bigint: true }));
    if (id(await regularDirectory(directory)) !== directoryIdentity ||
        stamp(await lstat(marker, { bigint: true })) !== stamp(before))
      throw new Error('Plugin data owner changed before retention was saved');
    await rename(temporary, marker);
  } finally {
    const remaining = await stat(temporary);
    if (remaining && temporaryIdentity && id(remaining) === temporaryIdentity && remaining.isFile() &&
        !remaining.isSymbolicLink() && remaining.nlink === 1n && await realpath(temporary) === temporary)
      await unlink(temporary);
  }
}
function sameInventory(previous: Inventory, next: Inventory): boolean {
  return previous.directory === next.directory && previous.owner === next.owner &&
    previous.entries.length === next.entries.length && previous.entries.every((entry, index) =>
      entry.file === next.entries[index].file && entry.stamp === next.entries[index].stamp);
}

/** Main calls only while it owns the stopped Gateway lease, or before any Gateway exists. */
export async function preparePluginDataDirectory(
  stateDirectory: string,
  pluginId: string,
  declaration: NonNullable<AppPluginManifest['data']>,
): Promise<string> {
  assertPluginDataId(pluginId);
  const { state, root, stateInfo } = await roots(stateDirectory);
  if (declaration.directory !== 'managed-v1' ||
      (declaration.retention !== undefined && declaration.retention !== 'retain'))
    throw new Error('Unsupported plugin data declaration');
  try { await mkdir(root); } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
  const rootInfo = await regularDirectory(root);
  const directory = path.join(root, pluginId);
  const legacy = path.join(state, pluginId);
  const legacyInfo = declaration.migrateLegacyDirectory ? await stat(legacy) : undefined;
  const current = await stat(directory);
  if (legacyInfo && current) throw new Error(`Plugin data migration conflict for ${pluginId}: both data directories exist`);
  if (current) {
    const prepared = resolvePluginDataDirectory(state, pluginId);
    if (declaration.retention === 'retain') await retainOwner(prepared, pluginId);
    return resolvePluginDataDirectory(state, pluginId,
      declaration.retention === 'retain' ? { retention: 'retain' } : undefined);
  }
  const owner = JSON.stringify({ schemaVersion: 1, pluginId, dataId: randomUUID(),
    ...(declaration.retention === 'retain' ? { retention: 'retain' } : {}) }) + '\n';
  if (legacyInfo) {
    if (LEGACY_RESERVED.has(pluginId)) throw new Error('Legacy plugin data directory is reserved by the host');
    const inspected = await tree(legacy);
    for (const required of declaration.migrateLegacyDirectory!.requiredFiles) {
      const file = path.resolve(legacy, ...required.split('/'));
      const relative = path.relative(legacy, file);
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
          !inspected.entries.some(entry => entry.file === file && !entry.directory))
        throw new Error(`Legacy plugin data does not match its declared layout for ${pluginId}`);
    }
    const marker = path.join(legacy, PLUGIN_DATA_OWNER_FILE);
    const markerInfo = await stat(marker);
    if (markerInfo) {
      if (!markerInfo.isFile() || markerInfo.nlink !== 1n || markerInfo.size > 1024n ||
          parsePluginDataOwner(JSON.parse(await readFile(marker, 'utf8'))).pluginId !== pluginId)
        throw new Error('Legacy plugin data owner does not match');
    } else await writeFile(marker, owner, { flag: 'wx' });
    const after = await tree(legacy);
    const prior = new Map(inspected.entries.map(entry => [entry.file, entry]));
    if (after.entries.length !== inspected.entries.length + (markerInfo ? 0 : 1) ||
        after.entries.some(entry => {
          const previous = prior.get(entry.file);
          if (!previous) return entry.file !== marker;
          return entry.file === legacy ? entry.identity !== previous.identity : entry.stamp !== previous.stamp;
        })) throw new Error('Plugin data changed before migration');
    // Never merge, copy over an existing destination, or move a computed path outside this state root.
    if (await stat(directory) || id(await regularDirectory(state)) !== id(stateInfo) ||
        id(await regularDirectory(root)) !== id(rootInfo) ||
        id(await regularDirectory(legacy)) !== id(legacyInfo)) throw new Error('Plugin data changed before migration');
    await rename(legacy, directory);
  } else {
    // Publish only a complete receipt. An interruption cannot leave an unowned
    // final directory that every later startup would be unable to prepare.
    const staging = path.join(root, `.preparing-${pluginId}-${randomUUID()}`);
    await mkdir(staging);
    const stagingIdentity = id(await regularDirectory(staging));
    const marker = path.join(staging, PLUGIN_DATA_OWNER_FILE);
    try {
      await writeFile(marker, owner, { flag: 'wx' });
      if (await stat(directory) || id(await regularDirectory(state)) !== id(stateInfo) ||
          id(await regularDirectory(root)) !== id(rootInfo) ||
          id(await regularDirectory(staging)) !== stagingIdentity)
        throw new Error('Plugin data changed before preparation');
      await rename(staging, directory);
    } catch (error) {
      // These paths were created by this invocation; never recursively remove
      // a directory or touch an unexpected child while recovering preparation.
      try {
        if (id(await regularDirectory(root)) === id(rootInfo) &&
            id(await regularDirectory(staging)) === stagingIdentity) {
          const markerInfo = await stat(marker);
          if (markerInfo?.isFile() && !markerInfo.isSymbolicLink() && markerInfo.nlink === 1n && await realpath(marker) === marker)
            await unlink(marker);
          await rmdir(staging);
        }
      } catch { /* An incomplete private staging directory never authorizes a final data path. */ }
      throw error;
    }
  }
  const prepared = resolvePluginDataDirectory(state, pluginId);
  if (declaration.retention === 'retain') await retainOwner(prepared, pluginId);
  return resolvePluginDataDirectory(state, pluginId,
    declaration.retention === 'retain' ? { retention: 'retain' } : undefined);
}

/** Read only. Failure never means zero bytes or permission to remove an unowned tree. */
export async function inspectPluginData(stateDirectory: string, pluginIds: readonly string[]): Promise<PluginDataInfo> {
  let exists = false;
  try {
    const { state, root, rootInfo } = await roots(stateDirectory);
    let bytes = 0;
    let retained = false;
    const owners = ids(pluginIds);
    if (!rootInfo) return { exists: false, bytes: 0, canDelete: true };
    for (const pluginId of owners) {
      if (!await stat(path.join(root, pluginId))) continue;
      exists = true;
      const inspected = await inventory(state, pluginId);
      bytes += inspected.bytes;
      retained ||= inspected.retained === true;
      if (!Number.isSafeInteger(bytes)) throw new Error('Plugin data size exceeds the safety limit');
    }
    return { exists, bytes, canDelete: !retained, ...(retained ? { retained: true as const } : {}) };
  } catch (error) { return { exists, bytes: 0, canDelete: false, reason: message(error) }; }
}

/** Capture every owner before any native uninstall begins, inside the stopped lease. */
export async function preparePluginDataRemoval(stateDirectory: string, pluginIds: readonly string[]): Promise<PluginDataRemovalSnapshot> {
  const { state, root, stateInfo, rootInfo } = await roots(stateDirectory);
  const owners = ids(pluginIds);
  const inventories: Inventory[] = [];
  if (rootInfo) for (const pluginId of owners) {
    if (await stat(path.join(root, pluginId))) {
      const inspected = await inventory(state, pluginId);
      if (inspected.retained) throw new Error('Plugin data must be retained');
      inventories.push(inspected);
    }
  }
  const snapshot = Object.freeze({ token: randomUUID() });
  removals.set(snapshot, { state, root, stateIdentity: id(stateInfo), rootIdentity: rootInfo && id(rootInfo),
    pluginIds: owners, inventories });
  return snapshot;
}

/** Caller must retain the stopped lease and a successful authoritative native uninstall receipt. */
export async function removePluginData(snapshot: PluginDataRemovalSnapshot): Promise<void> {
  const captured = removals.get(snapshot);
  if (!captured) throw new Error('Plugin data removal snapshot is unavailable');
  removals.delete(snapshot);
  const { state, root, stateInfo, rootInfo } = await roots(captured.state);
  if (id(stateInfo) !== captured.stateIdentity || (rootInfo && id(rootInfo)) !== captured.rootIdentity)
    throw new Error('Plugin data root changed before removal');
  const current: Inventory[] = [];
  if (rootInfo) for (const pluginId of captured.pluginIds) {
    if (await stat(path.join(root, pluginId))) {
      const inspected = await inventory(state, pluginId);
      if (inspected.retained) throw new Error('Plugin data must be retained');
      current.push(inspected);
    }
  }
  if (current.length !== captured.inventories.length || current.some((item, index) =>
    !sameInventory(captured.inventories[index], item))) throw new Error('Plugin data changed before removal');
  // Recheck all owners together before touching any data. Delete only recorded regular entries,
  // with non-recursive operations, so unexpected files or links stop cleanup rather than expand it.
  for (const item of captured.inventories) {
    const directories = new Map(item.entries.filter(entry => entry.directory).map(entry => [entry.file, entry]));
    for (const entry of [...item.entries].reverse()) {
      if (id(await regularDirectory(state)) !== captured.stateIdentity ||
          id(await regularDirectory(root)) !== captured.rootIdentity)
        throw new Error('Plugin data root changed during removal');
      let parent = path.dirname(entry.file);
      while (directories.has(parent)) {
        const ancestor = directories.get(parent)!;
        if (id(await regularDirectory(parent)) !== ancestor.identity)
          throw new Error('Plugin data directory changed during removal');
        parent = path.dirname(parent);
      }
      const info = await lstat(entry.file, { bigint: true });
      if (info.isSymbolicLink() || await realpath(entry.file) !== entry.file || id(info) !== entry.identity ||
          (!entry.directory && (!info.isFile() || info.nlink !== 1n || stamp(info) !== entry.stamp)))
        throw new Error('Plugin data changed during removal');
      if (entry.directory) await rmdir(entry.file);
      else await unlink(entry.file);
    }
  }
}
