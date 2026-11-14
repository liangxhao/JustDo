import fs from 'node:fs/promises';
import { EOL } from 'node:os';
import path from 'node:path';

import JSON5 from 'json5';

import { normalizeOpenClawPluginPolicyId } from '../../../shared/plugins/nativeIds';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { resolveOpenClawRuntimeResourcePaths } from '../../openclaw/runtime/openclawEngineManager';
import { diagnosticExportTime, formatDiagnosticJson } from './exportFormat';
import { diagnosticDetailText } from './exportSessionDetails';
import { assertDiagnosticLogPath } from './logScanner';

export const DIAGNOSTIC_PLUGIN_INVENTORY_FILE = 'plugins.json';

const READ_TIMEOUT_MS = 3000;
const SOURCE_RECORD_LIMIT = 1000;
const SOURCE_BYTES = 48 * 1024;
const CONFIG_BYTES = 2 * 1024 * 1024;
const MANIFEST_BYTES = 512 * 1024;
const LOCAL_FILES_LIMIT = 1000;

type InventoryGap =
  | 'offline'
  | 'scope_unavailable'
  | 'saved_policy_unavailable'
  | 'local_discovery_only'
  | 'local_discovery_incomplete'
  | 'read_failed'
  | 'invalid_response'
  | 'timeout'
  | 'output_limit';
type InventoryRecord = Record<string, unknown>;
type InventoryProjector = (row: InventoryRecord) => InventoryRecord | undefined;
type InventoryReader = (signal: AbortSignal) => unknown | Promise<unknown>;
interface PluginInventorySource {
  status: 'available' | 'partial' | 'unavailable';
  gaps: InventoryGap[];
  seen: number;
  omitted: number;
  entries: InventoryRecord[];
}

interface NativeExtensionInventory {
  entries: InventoryRecord[];
  gaps: InventoryGap[];
  savedSkills?: PluginInventorySource;
  savedNativeHooks?: PluginInventorySource;
  nativeMcpServers?: PluginInventorySource;
}

interface InventoryInputs {
  client?: GatewayClientLike | null;
  agentId?: string;
  sessionKey?: string | null;
  readExtensions?: (
    signal: AbortSignal,
  ) => NativeExtensionInventory | Promise<NativeExtensionInventory>;
  readAppPlugins?: InventoryReader;
  readSavedHooks?: InventoryReader;
  readMcpServers?: InventoryReader;
}

export interface DiagnosticPluginInventory {
  scope: 'environment_at_export';
  collectedAt: number;
  extensions: PluginInventorySource;
  appCompanions: PluginInventorySource;
  skills: PluginInventorySource & { scope: 'selected_session' | 'selected_agent' };
  hooks: PluginInventorySource & { scope: 'selected_agent' };
  savedSkills: PluginInventorySource;
  savedHooks: PluginInventorySource;
  savedNativeHooks: PluginInventorySource;
  mcpServers: PluginInventorySource;
  nativeMcpServers: PluginInventorySource;
}

const object = (value: unknown): InventoryRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as InventoryRecord)
    : undefined;
const text = (value: unknown, limit = 160) => diagnosticDetailText(value, limit);
const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  /^[\p{L}\p{N}_.:@/-]{1,160}$/u.test(value) &&
  !value.startsWith('/') &&
  !/^[a-z]:\//iu.test(value) &&
  !value.includes('://') &&
  !value.includes('..')
    ? text(value)
    : undefined;
const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const oneOf = (value: unknown, values: readonly string[]) =>
  typeof value === 'string' && values.includes(value) ? value : undefined;
const version = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-z][0-9a-z.+_-]{0,95}$/iu.test(value)
    ? text(value, 96)
    : undefined;
const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .slice(0, 64)
    .map(identifier)
    .filter((item): item is string => !!item);
  return values.length ? [...new Set(values)] : undefined;
};
const named = (row: InventoryRecord, key: string) => text(row[key]);
const unavailable = (gap: InventoryGap): PluginInventorySource => ({
  status: 'unavailable',
  gaps: [gap],
  seen: 0,
  omitted: 0,
  entries: [],
});

function projectSource(
  value: unknown,
  project: InventoryProjector,
  gaps: InventoryGap[] = [],
): PluginInventorySource {
  if (!Array.isArray(value)) return unavailable('invalid_response');
  const entries: InventoryRecord[] = [];
  let bytes = 0;
  let invalid = 0;
  let capped = value.length > SOURCE_RECORD_LIMIT;
  for (const item of value.slice(0, SOURCE_RECORD_LIMIT)) {
    const row = object(item);
    const entry = row && project(row);
    if (!entry) {
      invalid++;
      continue;
    }
    const indented = JSON.stringify(entry, null, 2).replaceAll('\n', `${EOL}      `);
    const size = Buffer.byteLength(`      ${indented},${EOL}`);
    if (size > SOURCE_BYTES - bytes) {
      capped = true;
      continue;
    }
    entries.push(entry);
    bytes += size;
  }
  const issues = [
    ...gaps,
    ...(invalid ? ['invalid_response' as const] : []),
    ...(capped ? ['output_limit' as const] : []),
  ];
  return {
    status: issues.length ? 'partial' : 'available',
    gaps: [...new Set(issues)],
    seen: value.length,
    omitted: value.length - entries.length,
    entries,
  };
}

async function readSource(
  read: InventoryReader | undefined,
  project: (value: unknown) => PluginInventorySource,
  signal?: AbortSignal,
): Promise<PluginInventorySource> {
  if (!read) return unavailable('scope_unavailable');
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stop: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(readSignal.reason);
      readSignal.addEventListener('abort', stop, { once: true });
    });
    const value = await Promise.race([Promise.resolve().then(() => read(readSignal)), interrupted]);
    readSignal.throwIfAborted();
    return value === undefined ? unavailable('scope_unavailable') : project(value);
  } catch {
    signal?.throwIfAborted();
    return unavailable(timeout.aborted ? 'timeout' : 'read_failed');
  } finally {
    if (stop) readSignal.removeEventListener('abort', stop);
  }
}

const projectExtension: InventoryProjector = row => {
  const id = identifier(row.id);
  if (!id) return;
  return {
    id,
    name: named(row, 'name'),
    version: version(row.version),
    origin: oneOf(row.origin, ['bundled', 'managed', 'configured_only']),
    packagePresent: bool(row.packagePresent),
    configuredEnabled: bool(row.configuredEnabled),
    savedPolicyBlock: oneOf(row.savedPolicyBlock, ['globally_disabled', 'denied']),
    savedAllowlistIncluded: bool(row.savedAllowlistIncluded),
    packageDefaultEnabled: bool(row.packageDefaultEnabled),
    kind: strings(row.kind),
    providers: strings(row.providers),
    channels: strings(row.channels),
    tools: strings(row.tools),
    declaredMcpServers: strings(row.declaredMcpServers),
  };
};
const projectApp: InventoryProjector = row => {
  const id = identifier(row.id);
  if (!id) return;
  return {
    id,
    version: version(row.version),
    artifactSelected: bool(row.installed),
    state: oneOf(row.state, ['prepared', 'active', 'cleanup', 'blocked']),
    commands: strings(row.commands),
    slots: strings(row.slots),
  };
};
const projectSkill: InventoryProjector = row => {
  const id = identifier(row.skillKey);
  if (!id || typeof row.disabled !== 'boolean') return;
  return {
    id,
    name: named(row, 'name'),
    source: identifier(row.source),
    bundled: bool(row.bundled),
    configuredEnabled: !row.disabled,
    eligible: bool(row.eligible),
    blockedByAllowlist: bool(row.blockedByAllowlist),
    blockedByAgentFilter: bool(row.blockedByAgentFilter),
    platformIncompatible: bool(row.platformIncompatible),
    modelVisible: bool(row.modelVisible),
    userInvocable: bool(row.userInvocable),
  };
};
const projectHook: InventoryProjector = row => {
  const id = identifier(row.hookKey);
  if (!id || typeof row.enabledByConfig !== 'boolean') return;
  return {
    id,
    name: named(row, 'name'),
    source: identifier(row.source),
    pluginId: identifier(row.pluginId),
    configuredEnabled: row.enabledByConfig,
    loadable: bool(row.loadable),
    requirementsSatisfied: bool(row.requirementsSatisfied),
    events: strings(row.events),
    unknownEvents: strings(row.unknownEvents),
  };
};
const projectSavedHook: InventoryProjector = row => {
  const id = identifier(row.id);
  return id && typeof row.enabled === 'boolean'
    ? { id, configuredEnabled: row.enabled }
    : undefined;
};
const projectMcp: InventoryProjector = row => {
  const name = named(row, 'name');
  if (!name || typeof row.enabled !== 'boolean') return;
  return {
    name,
    configuredEnabled: row.enabled,
    transport: oneOf(row.transportType, ['stdio', 'sse', 'http']),
    builtIn: bool(row.isBuiltIn),
  };
};
export async function collectDiagnosticPluginInventory(
  inputs: InventoryInputs,
  signal?: AbortSignal,
): Promise<DiagnosticPluginInventory> {
  const { agentId, client, sessionKey } = inputs;
  signal?.throwIfAborted();
  const fromGateway = (
    method: 'skills.status' | 'hooks.status',
    params: { agentId: string; sessionKey?: string },
    key: 'skills' | 'hooks',
    projector: InventoryProjector,
  ) =>
    client
      ? readSource(
          requestSignal =>
            client.request<unknown>(method, params, {
              signal: requestSignal,
              timeoutMs: READ_TIMEOUT_MS,
            }),
          value => {
            const result = object(value);
            if (
              key === 'skills' &&
              result?.agentId !== undefined &&
              result.agentId !== params.agentId
            )
              return unavailable('invalid_response');
            return projectSource(result?.[key], projector);
          },
          signal,
        )
      : unavailable('offline');
  const collectedAt = Date.now();
  let savedSkills = unavailable('saved_policy_unavailable');
  let savedNativeHooks = unavailable('saved_policy_unavailable');
  let nativeMcpServers = unavailable('saved_policy_unavailable');
  const [extensions, appCompanions, skills, hooks, savedHooks, mcpServers] = await Promise.all([
    readSource(
      inputs.readExtensions,
      value => {
        const result = value as NativeExtensionInventory;
        savedSkills = result.savedSkills ?? savedSkills;
        savedNativeHooks = result.savedNativeHooks ?? savedNativeHooks;
        nativeMcpServers = result.nativeMcpServers ?? nativeMcpServers;
        return projectSource(result.entries, projectExtension, result.gaps);
      },
      signal,
    ),
    readSource(inputs.readAppPlugins, value => projectSource(value, projectApp), signal),
    agentId
      ? fromGateway(
          'skills.status',
          { agentId, ...(sessionKey ? { sessionKey } : {}) },
          'skills',
          projectSkill,
        )
      : unavailable('scope_unavailable'),
    agentId
      ? fromGateway('hooks.status', { agentId }, 'hooks', projectHook)
      : unavailable('scope_unavailable'),
    readSource(inputs.readSavedHooks, value => projectSource(value, projectSavedHook), signal),
    readSource(inputs.readMcpServers, value => projectSource(value, projectMcp), signal),
  ]);
  return {
    scope: 'environment_at_export',
    collectedAt,
    extensions,
    appCompanions,
    skills: { ...skills, scope: sessionKey ? 'selected_session' : 'selected_agent' },
    hooks: { ...hooks, scope: 'selected_agent' },
    savedSkills,
    savedHooks,
    savedNativeHooks,
    mcpServers,
    nativeMcpServers,
  };
}

export function serializeDiagnosticPluginInventory(inventory: DiagnosticPluginInventory): string {
  const { scope, collectedAt, ...sources } = inventory;
  return formatDiagnosticJson({
    scope,
    collectedAt: diagnosticExportTime(collectedAt),
    ...Object.fromEntries(
      Object.entries<PluginInventorySource>(sources).map(([key, value]) => [
        key,
        {
          ...value,
          seen: value.seen === value.entries.length ? undefined : value.seen,
          omitted: value.omitted || undefined,
          gaps: value.gaps.length ? value.gaps : undefined,
        },
      ]),
    ),
  });
}

interface DiagnosticPluginLocations {
  stateDir: string;
  configPath: string;
  runtimeRoots: readonly string[];
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Resolve only the staged runtime selector. Other links are refused before traversal. */
async function resolveInventoryRuntimeRoot(roots: readonly string[], signal: AbortSignal) {
  for (const root of new Set(roots)) {
    try {
      const parent = path.dirname(root);
      await assertDiagnosticLogPath(parent, signal);
      const stat = await fs.lstat(root);
      if (stat.isDirectory()) return root;
      if (
        !stat.isSymbolicLink() ||
        path.basename(root) !== 'current' ||
        path.basename(parent) !== 'openclaw-runtime' ||
        path.basename(path.dirname(parent)) !== 'vendor'
      )
        continue;
      const target = path.resolve(parent, await fs.readlink(root));
      const relativeTarget = path.relative(parent, target);
      if (!/^(?:win|mac|linux)-(?:arm64|x64)$/.test(relativeTarget)) continue;
      await assertDiagnosticLogPath(target, signal);
      if ((await fs.lstat(target)).isDirectory()) return target;
    } catch {
      signal.throwIfAborted();
    }
  }
}

async function readJson(file: string, maxBytes: number, signal: AbortSignal) {
  await assertDiagnosticLogPath(file, signal);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > maxBytes) throw new Error('unreadable');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > maxBytes
    )
      throw new Error('unreadable');
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size)
      throw new Error('source_changed');
    const json = object(
      JSON5.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, offset))),
    );
    if (!json) throw new Error('unreadable');
    return json;
  } finally {
    await handle.close();
  }
}

const extensionManifestPaths = [
  'openclaw.plugin.json',
  '.codex-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
] as const;
const AGENT_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const bundleSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');

async function readBundledMcpNames(directory: string, signal: AbortSignal): Promise<string[]> {
  try {
    const mcp = await readJson(path.join(directory, '.mcp.json'), MANIFEST_BYTES, signal);
    return Object.keys(object(mcp.mcpServers) ?? object(mcp.servers) ?? mcp).filter(
      name => !name.startsWith('$'),
    );
  } catch (error) {
    if (!missing(error)) throw error;
    return [];
  }
}

async function readExtensionManifest(
  directory: string,
  signal: AbortSignal,
): Promise<InventoryRecord | undefined> {
  for (const relative of extensionManifestPaths) {
    const file = path.join(directory, relative);
    try {
      const manifest = await readJson(file, MANIFEST_BYTES, signal);
      if (relative === 'plugin.json' && manifest.$schema !== AGENT_MANIFEST_SCHEMA) continue;
      const id =
        relative === 'openclaw.plugin.json'
          ? text(manifest.id)
          : bundleSlug(
              typeof manifest.name === 'string' ? manifest.name : path.basename(directory),
            );
      if (!id) return;
      let version = text(manifest.version, 96);
      if (!version) {
        try {
          version = text(
            (await readJson(path.join(directory, 'package.json'), MANIFEST_BYTES, signal)).version,
            96,
          );
        } catch {
          signal.throwIfAborted();
        }
      }
      return {
        id,
        name: manifest.name,
        version,
        packagePresent: true,
        packageDefaultEnabled:
          manifest.enabledByDefault === true ||
          (Array.isArray(manifest.enabledByDefaultOnPlatforms) &&
            manifest.enabledByDefaultOnPlatforms.includes(process.platform)),
        kind: typeof manifest.kind === 'string' ? [manifest.kind] : manifest.kind,
        providers: manifest.providers,
        channels: manifest.channels,
        tools: object(manifest.contracts)?.tools,
        declaredMcpServers: [
          ...Object.keys(object(manifest.mcpServers) ?? {}),
          ...(relative === 'openclaw.plugin.json'
            ? []
            : await readBundledMcpNames(directory, signal)),
        ],
      };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  // The host plugin importer also accepts packs built from conventional bundle components.
  for (const marker of [
    'skills',
    'commands',
    'agents',
    'hooks/hooks.json',
    '.mcp.json',
    '.lsp.json',
    'settings.json',
  ]) {
    try {
      await assertDiagnosticLogPath(path.join(directory, marker), signal);
      return {
        id: bundleSlug(path.basename(directory)) || 'bundle-plugin',
        packagePresent: true,
        declaredMcpServers: await readBundledMcpNames(directory, signal),
      };
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

const sourceFromConfig = (value: unknown, project: InventoryProjector) => {
  if (value === undefined) return projectSource([], project);
  const rows = object(value);
  if (!rows || Object.hasOwn(rows, '$include')) return unavailable('saved_policy_unavailable');
  return projectSource(
    Object.entries(rows).map(([id, settings]) => ({ id, settings })),
    project,
  );
};

const projectSavedEnablement: InventoryProjector = row => {
  const id = identifier(row.id);
  const settings = object(row.settings);
  if (!id || !settings || Object.hasOwn(settings, '$include')) return;
  return { id, configuredEnabled: bool(settings.enabled) };
};

function projectNativeMcp(
  config: InventoryRecord | undefined,
  extensions: InventoryRecord[],
  configAvailable: boolean,
): PluginInventorySource {
  const configured = object(config?.servers);
  if (
    config &&
    (Object.hasOwn(config, '$include') ||
      (config.servers !== undefined && (!configured || Object.hasOwn(configured, '$include'))))
  )
    return unavailable('saved_policy_unavailable');
  const owners = new Map<string, Set<string>>();
  for (const extension of extensions) {
    const id = identifier(extension.id);
    if (!id) continue;
    for (const name of strings(extension.declaredMcpServers) ?? []) {
      const ids = owners.get(name) ?? new Set<string>();
      ids.add(id);
      owners.set(name, ids);
    }
  }
  const names = new Set([...Object.keys(configured ?? {}), ...owners.keys()]);
  return projectSource(
    [...names].map(name => ({ name })),
    row => {
      const name = identifier(row.name);
      if (!name) return;
      const settings = object(
        configured && Object.hasOwn(configured, name) ? configured[name] : undefined,
      );
      if (settings && Object.hasOwn(settings, '$include')) return;
      const transport =
        typeof settings?.command === 'string' && settings.command.trim()
          ? 'stdio'
          : typeof settings?.url === 'string' && settings.url.trim()
            ? settings.transport === 'sse'
              ? 'sse'
              : 'http'
            : undefined;
      return {
        name,
        declaredBy: [...(owners.get(name) ?? [])].sort().slice(0, 32),
        configuredEnabled: bool(settings?.enabled) ?? (transport ? true : undefined),
        configuredTransport: transport,
        ...(config?.enabled === false ? { savedPolicyBlock: 'globally_disabled' } : {}),
      };
    },
    ['local_discovery_only', ...(!configAvailable ? ['saved_policy_unavailable' as const] : [])],
  );
}

function savedConfigEntries(value: unknown, nesting?: 'internal'): PluginInventorySource {
  const valueAt = (root: unknown, keys: string[]): unknown => {
    let current = root;
    for (const key of keys) {
      if (current === undefined) return undefined;
      const row = object(current);
      if (!row || Object.hasOwn(row, '$include')) return null;
      current = row[key];
    }
    return current;
  };
  return sourceFromConfig(
    valueAt(value, nesting ? [nesting, 'entries'] : ['entries']),
    projectSavedEnablement,
  );
}

/** Saved policy and local package facts only. No native process or plugin code is loaded. */
export async function readDiagnosticNativeExtensions(
  { stateDir, configPath, runtimeRoots }: DiagnosticPluginLocations,
  signal: AbortSignal,
): Promise<NativeExtensionInventory> {
  const gaps: InventoryGap[] = ['local_discovery_only'];
  const runtime = await resolveInventoryRuntimeRoot(runtimeRoots, signal);
  const bundledPluginsDir =
    runtime && resolveOpenClawRuntimeResourcePaths(runtime, stateDir).bundledPluginsDir;
  let config: InventoryRecord | undefined;
  let policy: InventoryRecord | undefined;
  try {
    config = await readJson(configPath, CONFIG_BYTES, signal);
    if (Object.hasOwn(config, '$include')) {
      config = undefined;
      throw new Error('invalid_saved_policy');
    }
    const pluginConfig = config.plugins === undefined ? {} : object(config.plugins);
    const pluginEntries = object(pluginConfig?.entries);
    if (
      !pluginConfig ||
      Object.hasOwn(pluginConfig, '$include') ||
      (pluginConfig.enabled !== undefined && typeof pluginConfig.enabled !== 'boolean') ||
      (pluginConfig.entries !== undefined &&
        (!pluginEntries || Object.hasOwn(pluginEntries, '$include'))) ||
      [pluginConfig.allow, pluginConfig.deny].some(
        value =>
          value !== undefined &&
          (!Array.isArray(value) || value.some(id => typeof id !== 'string')),
      )
    )
      throw new Error('invalid_saved_policy');
    policy = pluginConfig;
  } catch {
    signal.throwIfAborted();
    gaps.push('saved_policy_unavailable');
  }

  const roots = [
    [bundledPluginsDir, 'bundled'],
    [path.join(stateDir, 'extensions'), 'managed'],
  ] as const;
  const entries: InventoryRecord[] = [];
  const found = new Set<string>();
  let examined = 0;
  for (const [root, origin] of roots) {
    if (!root) {
      gaps.push('local_discovery_incomplete');
      continue;
    }
    try {
      await assertDiagnosticLogPath(root, signal);
      const directory = await fs.opendir(root);
      for await (const child of directory) {
        signal.throwIfAborted();
        if (++examined > LOCAL_FILES_LIMIT) {
          gaps.push('output_limit');
          break;
        }
        if (child.name.startsWith('.')) continue;
        if (child.isSymbolicLink()) {
          gaps.push('local_discovery_incomplete');
          continue;
        }
        if (!child.isDirectory()) continue;
        try {
          const entry = await readExtensionManifest(path.join(root, child.name), signal);
          if (!entry) {
            gaps.push('local_discovery_incomplete');
            continue;
          }
          found.add(normalizeOpenClawPluginPolicyId(entry.id as string));
          entries.push({ ...entry, origin });
        } catch {
          signal.throwIfAborted();
          gaps.push('local_discovery_incomplete');
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(origin === 'managed' && missing(error))) gaps.push('local_discovery_incomplete');
    }
  }

  if (policy) {
    const allow = new Set(
      (policy.allow as string[] | undefined)?.map(normalizeOpenClawPluginPolicyId),
    );
    const deny = new Set(
      (policy.deny as string[] | undefined)?.map(normalizeOpenClawPluginPolicyId),
    );
    const configured = new Map<string, boolean | undefined>();
    const savedEntries = Object.entries(object(policy.entries) ?? {});
    if (savedEntries.length > LOCAL_FILES_LIMIT) gaps.push('output_limit');
    for (const [id, settings] of savedEntries.slice(0, LOCAL_FILES_LIMIT)) {
      const normalized = normalizeOpenClawPluginPolicyId(id);
      const entry = object(settings);
      if (
        !entry ||
        Object.hasOwn(entry, '$include') ||
        (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
      ) {
        gaps.push('saved_policy_unavailable');
        configured.set(normalized, undefined);
      } else {
        configured.set(normalized, bool(entry.enabled));
      }
      if (!found.has(normalized)) {
        entries.push({ id, origin: 'configured_only' });
        found.add(normalized);
      }
    }
    for (const id of [...allow, ...deny]) {
      if (entries.length >= LOCAL_FILES_LIMIT) {
        gaps.push('output_limit');
        break;
      }
      if (!found.has(id) && !configured.has(id)) {
        entries.push({ id, origin: 'configured_only' });
        found.add(id);
      }
    }
    for (const entry of entries) {
      const id = normalizeOpenClawPluginPolicyId(entry.id as string);
      entry.configuredEnabled = configured.get(id);
      if (policy.enabled === false) entry.savedPolicyBlock = 'globally_disabled';
      else if (deny.has(id)) entry.savedPolicyBlock = 'denied';
      if (allow.size > 0) entry.savedAllowlistIncluded = allow.has(id);
    }
  }
  return {
    entries: entries.sort((left, right) => String(left.id).localeCompare(String(right.id))),
    gaps: [...new Set(gaps)],
    savedSkills: config && savedConfigEntries(config.skills),
    savedNativeHooks: config && savedConfigEntries(config.hooks, 'internal'),
    nativeMcpServers:
      config?.mcp !== undefined && !object(config.mcp)
        ? unavailable('saved_policy_unavailable')
        : projectNativeMcp(object(config?.mcp), entries, config !== undefined),
  };
}
