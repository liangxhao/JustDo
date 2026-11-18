import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertPluginDataId, parsePluginDataOwner, PLUGIN_DATA_OWNER_FILE, resolvePluginDataDirectory } from '../../../../plugins/sdk/app-plugin-sdk/data';
import { preparePluginDataDirectory } from './pluginDataService';

export interface NativeMcpDataBinding {
  pluginId: string;
  servers: Record<string, Record<string, unknown>>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const declaration = { directory: 'managed-v1', retention: 'retain' } as const;
const preparations = new Map<string, Promise<string>>();
type Entry = { kind: 'server' | 'config'; owner: string; name: string; dataId: string; hash: string };
type Receipt = { version: 1; stateDirectory: string; configPath: string; entries: Entry[] };
const receiptPath = (configPath: string) => `${configPath}.plugin-data.json`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const suspendedServer = { enabled: false } as const;
const suspendedServerHash = digest(suspendedServer);

export function nativeMcpDataDirectory(stateDirectory: string, pluginId: string): string {
  return resolvePluginDataDirectory(stateDirectory, pluginId, { retention: 'retain' });
}

function dataIdentity(stateDirectory: string, pluginId: string): string {
  const directory = nativeMcpDataDirectory(stateDirectory, pluginId), file = path.join(directory, PLUGIN_DATA_OWNER_FILE);
  const before = fs.readFileSync(file, 'utf8'), owner = parsePluginDataOwner(JSON.parse(before));
  nativeMcpDataDirectory(stateDirectory, pluginId);
  if (fs.readFileSync(file, 'utf8') !== before) throw new Error('Plugin data owner changed');
  return owner.dataId;
}

/** New owned directories can be prepared live; same-owner calls share one publication. No migration or fallback. */
export async function prepareNativeMcpData(stateDirectory: string, pluginIds: readonly string[]): Promise<void> {
  if (!path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')) throw new Error('Invalid plugin data state root');
  const state = fs.realpathSync.native(path.resolve(stateDirectory));
  for (const id of new Set(pluginIds)) {
    assertPluginDataId(id);
    const key = JSON.stringify([state, id]);
    let pending = preparations.get(key);
    if (!pending) {
      const owned = preparePluginDataDirectory(state, id, declaration).finally(() => {
        if (preparations.get(key) === owned) preparations.delete(key);
      });
      preparations.set(key, owned);
      pending = owned;
    }
    await pending;
  }
}

function readReceipt(configPath: string, stateDirectory: string): Receipt | undefined {
  let raw: unknown;
  try {
    const file = receiptPath(configPath), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw new Error('Managed MCP data receipt is unavailable');
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!record(raw) || Object.keys(raw).some(key => !['version', 'stateDirectory', 'configPath', 'entries'].includes(key)) ||
      raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 4096 ||
      typeof raw.stateDirectory !== 'string' || typeof raw.configPath !== 'string' || raw.entries.some(entry =>
        !record(entry) ||
        !['server', 'config'].includes(String(entry.kind)) || typeof entry.owner !== 'string' ||
        typeof entry.name !== 'string' || typeof entry.dataId !== 'string' ||
        typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.hash)))
    throw new Error('Managed MCP data receipt is invalid');
  if (raw.stateDirectory !== path.resolve(stateDirectory) || raw.configPath !== path.resolve(configPath)) {
    const relative = path.relative(raw.stateDirectory, raw.configPath);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
        relative !== path.relative(path.resolve(stateDirectory), path.resolve(configPath)) ||
        raw.entries.some(entry => dataIdentity(stateDirectory, entry.owner) !== entry.dataId))
      throw new Error('Managed MCP data relocation could not be confirmed');
  }
  const receipt = raw as Receipt;
  return { ...receipt, entries: receipt.entries.map(({ kind, owner, name, dataId, hash }) => ({ kind, owner, name, dataId, hash })) };
}

/** Generated defaults must never be rediscovered as operator-owned MCP definitions after uninstall. */
export function ownedNativeMcpDataServerNames(configPath: string, stateDirectory: string): ReadonlySet<string> {
  const receipt = readReceipt(configPath, stateDirectory);
  if (!receipt) return new Set();
  const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const servers = record(config) && record(config.mcp) && record(config.mcp.servers) ? config.mcp.servers : {};
  return new Set(receipt.entries.filter(entry => entry.kind === 'server' &&
    Object.hasOwn(servers, entry.name) && digest(servers[entry.name]) === entry.hash).map(entry => entry.name));
}

/** Replace only this package's matching launch definitions, including content from earlier installations. */
export function suspendNativeMcpDataServers(
  config: Record<string, unknown>, pluginIds: ReadonlySet<string>, stateDirectory: string,
  configPath: string, userServerNames: ReadonlySet<string>,
): { receipt: string; names: string[] } | undefined {
  const previous = readReceipt(configPath, stateDirectory);
  if (!previous) return;
  const mcp = record(config.mcp) ? config.mcp : {};
  const servers = record(mcp.servers) ? mcp.servers : {};
  const owned = new Map<string, Entry>();
  for (const entry of previous.entries) {
    if (entry.kind !== 'server' || !pluginIds.has(entry.owner) || userServerNames.has(entry.name) ||
        !Object.hasOwn(servers, entry.name) || digest(servers[entry.name]) !== entry.hash) continue;
    if (!owned.has(entry.name)) owned.set(entry.name, entry);
  }
  if (!owned.size) return;
  const entries = previous.entries.filter(entry => entry.kind !== 'server' || !owned.has(entry.name));
  for (const entry of owned.values()) {
    servers[entry.name] = { ...suspendedServer };
    entries.push(entry);
    if (entry.hash !== suspendedServerHash) entries.push({ ...entry, hash: suspendedServerHash });
  }
  if (entries.length > 4096) throw new Error('Managed MCP data receipt exceeds its limit');
  return { receipt: JSON.stringify({ ...previous, entries }) + '\n', names: [...owned.keys()] };
}

/** Only a matching content digest withdraws our previous defaults; it grants no plugin authority. */
export function projectNativeMcpData(
  config: Record<string, unknown>, bindings: readonly NativeMcpDataBinding[], stateDirectory: string,
  configPath: string, userServerNames: ReadonlySet<string> = new Set(),
  restoreSuspendedOwners: ReadonlySet<string> = new Set(),
): string | undefined {
  const previous = readReceipt(configPath, stateDirectory);
  if (!bindings.length && !previous) return;
  const plugins = record(config.plugins) ? config.plugins : {};
  const entries = record(plugins.entries) ? plugins.entries : {};
  const mcp = record(config.mcp) ? config.mcp : {};
  const servers: Record<string, unknown> = Object.assign(Object.create(null), record(mcp.servers) ? mcp.servers : {});
  const retained: Entry[] = [];
  const suspended = new Map<string, Entry>();
  for (const entry of previous?.entries ?? []) {
    if (entry.kind === 'server') {
      if (!userServerNames.has(entry.name) && Object.hasOwn(servers, entry.name) && digest(servers[entry.name]) === entry.hash) {
        retained.push(entry);
        if (entry.hash === suspendedServerHash) suspended.set(entry.name, entry);
        delete servers[entry.name];
      }
    } else {
      const plugin = entries[entry.owner], settings = record(plugin) && record(plugin.config) ? plugin.config : undefined;
      if (settings && Object.hasOwn(settings, 'dataDirectory') && digest(settings.dataDirectory) === entry.hash) {
        retained.push(entry);
        delete settings.dataDirectory;
      }
    }
  }
  const next: Receipt = { version: 1, stateDirectory: path.resolve(stateDirectory), configPath: path.resolve(configPath), entries: [] };
  for (const binding of bindings) {
    assertPluginDataId(binding.pluginId);
    const directory = nativeMcpDataDirectory(stateDirectory, binding.pluginId);
    const dataId = dataIdentity(stateDirectory, binding.pluginId);
    const value = entries[binding.pluginId];
    const plugin = record(value) ? value : {};
    const settings = record(plugin.config) ? plugin.config : {};
    if (Object.hasOwn(settings, 'dataDirectory') && settings.dataDirectory !== directory) continue;
    if (!Object.hasOwn(settings, 'dataDirectory')) {
      settings.dataDirectory = directory;
      next.entries.push({ kind: 'config', owner: binding.pluginId, name: 'dataDirectory', dataId, hash: digest(directory) });
    }
    entries[binding.pluginId] = { ...plugin, config: settings };
    for (const [name, definition] of Object.entries(binding.servers)) {
      if (userServerNames.has(name) || Object.hasOwn(servers, name)) continue;
      const suspension = suspended.get(name);
      if (suspension?.owner === binding.pluginId && suspension.dataId === dataId &&
          !restoreSuspendedOwners.has(binding.pluginId)) {
        servers[name] = { ...suspendedServer };
        next.entries.push(suspension);
        continue;
      }
      const server = { ...definition, env: { ...(record(definition.env) ? definition.env : {}), PLUGIN_DATA: directory } };
      servers[name] = server;
      next.entries.push({ kind: 'server', owner: binding.pluginId, name, dataId, hash: digest(server) });
    }
  }
  config.plugins = { ...plugins, entries };
  config.mcp = { ...mcp, servers };
  // The receipt leads config publication: retain only old values actually observed
  // before this write, so a crash at that boundary can still withdraw either result.
  for (const entry of retained) if (!next.entries.some(item => item.kind === entry.kind && item.owner === entry.owner &&
      item.name === entry.name && item.hash === entry.hash)) next.entries.push(entry);
  if (next.entries.length > 4096) throw new Error('Managed MCP data receipt exceeds its limit');
  return JSON.stringify(next) + '\n';
}

/** Publish the small hash-only receipt before config; rollback it if the config publication fails. */
export function publishNativeMcpDataReceipt(configPath: string, content: string | undefined, publish: () => void): void {
  if (content === undefined) return publish();
  const file = receiptPath(configPath);
  let before: string | undefined;
  try { before = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const write = (value: string) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  if (before === content) return publish();
  write(content);
  try { publish(); }
  catch (error) {
    try { if (before === undefined) fs.unlinkSync(file); else write(before); }
    catch { throw new Error('Configuration publication failed and its managed MCP data receipt could not be restored', { cause: error }); }
    throw error;
  }
}
