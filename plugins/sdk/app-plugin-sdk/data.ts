import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Host-prepared private plugin data. Persisted retention is independent of package lifetime. */
export const PLUGIN_DATA_DIRECTORY = 'plugin-data';
export const PLUGIN_DATA_OWNER_FILE = '.owner.json';
export interface PluginDataOwner {
  readonly schemaVersion: 1;
  readonly pluginId: string;
  readonly dataId: string;
  readonly retention?: 'retain';
}

export function assertPluginDataId(pluginId: string): void {
  if (typeof pluginId !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(pluginId) ||
      pluginId.length > 96 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(pluginId))
    throw new Error('Invalid plugin data owner');
}

export function parsePluginDataOwner(value: unknown): PluginDataOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin data owner');
  const owner = value as Record<string, unknown>;
  const retained = Object.hasOwn(owner, 'retention');
  if (Object.keys(owner).length !== (retained ? 4 : 3) ||
      Object.keys(owner).some(key => !['schemaVersion', 'pluginId', 'dataId', 'retention'].includes(key)) ||
      (retained && owner.retention !== 'retain') || owner.schemaVersion !== 1 ||
      typeof owner.pluginId !== 'string' || typeof owner.dataId !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner.dataId))
    throw new Error('Invalid plugin data owner');
  assertPluginDataId(owner.pluginId);
  return Object.freeze({ schemaVersion: 1, pluginId: owner.pluginId, dataId: owner.dataId,
    ...(retained ? { retention: 'retain' as const } : {}) });
}

/** Resolve only an already prepared, host-owned directory. Never creates, migrates or falls back. */
export function resolvePluginDataDirectory(
  stateDirectory: string,
  pluginId: string,
  options?: { readonly retention: 'retain' },
): string {
  assertPluginDataId(pluginId);
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).length !== 1 || options.retention !== 'retain'))
    throw new Error('Plugin data retention is unavailable');
  if (!path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')) throw new Error('Plugin data is unavailable');
  const state = path.resolve(stateDirectory);
  const directory = path.join(state, PLUGIN_DATA_DIRECTORY, pluginId);
  for (const entry of [state, path.dirname(directory), directory]) {
    const info = lstatSync(entry);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(entry) !== entry)
      throw new Error('Plugin data directory is not a regular directory');
  }
  const file = path.join(directory, PLUGIN_DATA_OWNER_FILE);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 || realpathSync(file) !== file)
    throw new Error('Plugin data owner is unavailable');
  const owner = parsePluginDataOwner(JSON.parse(readFileSync(file, 'utf8')));
  const after = lstatSync(file);
  if (owner.pluginId !== pluginId || info.dev !== after.dev || info.ino !== after.ino ||
      info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs)
    throw new Error('Plugin data owner changed');
  if (options?.retention === 'retain' && owner.retention !== 'retain')
    throw new Error('Plugin data retention is unavailable');
  return directory;
}
