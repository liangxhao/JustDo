import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import type { SqliteStore } from '../sqliteStore';

export type EnterpriseUIAction = 'hide' | 'disable' | 'readonly';

export type EnterpriseManifest = {
  version: string;
  name: string;
  ui?: Record<string, EnterpriseUIAction>;
  disableUpdate?: boolean;
  sync: {
    openclaw: boolean;
    skills: boolean | 'merge' | 'overwrite';
    agents: boolean | 'force';
    mcp: boolean | 'merge' | 'overwrite';
  };
  autoAcceptPrivacy?: boolean;
};

const SANDBOX_MODE_MAP: Record<string, string> = {
  off: 'local',
  'non-main': 'auto',
  all: 'sandbox',
};

const ENTERPRISE_CONFIG_DIR = 'enterprise-config';
const MANIFEST_FILE = 'manifest.json';

/**
 * Check if an enterprise config package exists at the well-known path.
 * Returns the directory path if manifest.json is found, null otherwise.
 */
export function resolveEnterpriseConfigPath(): string | null {
  const configPath = path.join(app.getPath('userData'), ENTERPRISE_CONFIG_DIR);
  const manifestPath = path.join(configPath, MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    return configPath;
  }
  return null;
}

/**
 * Read the enterprise config package and sync into SQLite.
 * Called once on startup, before openclawConfigSync.
 */
export function syncEnterpriseConfig(
  configPath: string,
  store: SqliteStore,
  mcpUpsertByName: (server: {
    name: string;
    description: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }) => void,
  mcpClearAll: () => void,
  coworkSetConfig: (config: Record<string, string>) => void,
  getWorkingDirectory: () => string | undefined,
): EnterpriseManifest | null {
  const manifestPath = path.join(configPath, MANIFEST_FILE);
  let manifest: EnterpriseManifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as EnterpriseManifest;
  } catch (error) {
    console.error('[Enterprise] failed to parse manifest.json, skipping enterprise config:', error);
    return null;
  }

  console.log(`[Enterprise] detected enterprise config: ${manifest.name} v${manifest.version}`);
  try {
    console.log(`[Enterprise] manifest: ${JSON.stringify(manifest, null, 2)}`);
  } catch {
    /* ignore serialization errors */
  }

  // Check if enterprise config version has changed since last sync.
  // Skip file copy operations (skills, agents) if version is unchanged.
  const previousManifest = store.get<EnterpriseManifest>('enterprise_config');
  const versionChanged = previousManifest?.version !== manifest.version;

  store.set('enterprise_config', manifest);

  if (manifest.autoAcceptPrivacy) {
    store.set('privacy_agreed', true);
  }

  // SQLite writes are cheap — always sync to ensure consistency.
  if (manifest.sync.openclaw) {
    syncModelConfig(configPath, store);
    syncCoworkConfig(configPath, coworkSetConfig);
  }

  const agentsForce = manifest.sync.agents === 'force';

  // File copy operations — only run when version changes to avoid
  // unnecessary I/O on every startup.
  if (versionChanged) {
    if (manifest.sync.skills) {
      const skillsMode = manifest.sync.skills === 'overwrite' ? 'overwrite' : 'merge';
      syncSkills(configPath, store, skillsMode);
    }

    if (manifest.sync.agents) {
      syncAgents(configPath, getWorkingDirectory(), agentsForce);
    }

    if (manifest.sync.mcp) {
      const mcpMode = manifest.sync.mcp === 'overwrite' ? 'overwrite' : 'merge';
      syncMcpServers(configPath, mcpUpsertByName, mcpClearAll, mcpMode);
    }
  } else {
    // Agents: force mode always copies, default mode only copies missing files
    if (manifest.sync.agents) {
      syncAgents(configPath, getWorkingDirectory(), agentsForce);
    }
    console.log('[Enterprise] version unchanged, skipping file copy for skills and MCP');
  }

  console.log('[Enterprise] config sync completed');
  return manifest;
}

const API_FORMAT_MAP: Record<string, 'anthropic' | 'openai'> = {
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
};

/**
 * Reverse-map openclaw.json models.providers → app_config.providers.
 * Enterprise openclaw.json should use real provider names as keys
 * (e.g., 'deepseek', 'anthropic') instead of the generic 'gucciai'.
 */
function syncModelConfig(configPath: string, store: SqliteStore): void {
  const openclawPath = path.join(configPath, 'openclaw.json');
  if (!fs.existsSync(openclawPath)) {
    console.log('[Enterprise] no openclaw.json found, skipping model config sync');
    return;
  }
  try {
    const raw = fs.readFileSync(openclawPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const models = config.models as { providers?: Record<string, any> } | undefined;
    const agents = config.agents as { defaults?: { model?: { primary?: string } } } | undefined;

    if (!models?.providers || Object.keys(models.providers).length === 0) {
      console.log('[Enterprise] no models.providers in openclaw.json, skipping model config sync');
      return;
    }

    // Build app_config.providers from openclaw providers
    const appProviders: Record<string, any> = {};
    const allModels: Array<{
      id: string;
      name: string;
      provider?: string;
      providerKey?: string;
      supportsImage?: boolean;
    }> = [];

    for (const [providerId, providerConfig] of Object.entries(models.providers)) {
      const apiFormat = API_FORMAT_MAP[providerConfig.api] ?? 'anthropic';
      const providerModels = (providerConfig.models ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsImage: Array.isArray(m.input) && m.input.includes('image'),
      }));

      // Resolve apiKey: use plain text value, skip placeholders like ${GUCCIAI_...}
      const apiKey =
        typeof providerConfig.apiKey === 'string' && !providerConfig.apiKey.startsWith('${')
          ? providerConfig.apiKey
          : '';

      appProviders[providerId] = {
        enabled: true,
        apiKey,
        baseUrl: providerConfig.baseUrl ?? '',
        apiFormat,
        models: providerModels,
      };

      for (const m of providerModels) {
        allModels.push({ ...m, provider: providerId, providerKey: providerId });
      }
    }

    // Resolve default model from agents.defaults.model.primary ("provider/modelId")
    let defaultModel = allModels[0]?.id ?? '';
    let defaultModelProvider = Object.keys(appProviders)[0] ?? '';
    const primary = agents?.defaults?.model?.primary;
    if (primary && primary.includes('/')) {
      const slashIdx = primary.indexOf('/');
      defaultModelProvider = primary.slice(0, slashIdx);
      defaultModel = primary.slice(slashIdx + 1);
    }

    // Resolve api config from default provider
    const defaultProvider = appProviders[defaultModelProvider];
    const apiKey = defaultProvider?.apiKey ?? '';
    const baseUrl = defaultProvider?.baseUrl ?? '';

    // Merge with existing app_config to preserve theme/language/etc
    const existing = store.get<Record<string, unknown>>('app_config') ?? {};

    const appConfig = {
      ...existing,
      api: { key: apiKey, baseUrl },
      model: {
        availableModels: allModels,
        defaultModel,
        defaultModelProvider,
      },
      providers: appProviders,
    };

    store.set('app_config', appConfig);
    console.log(
      `[Enterprise] synced ${Object.keys(appProviders).length} provider(s) to app_config`,
    );
  } catch (error) {
    console.error('[Enterprise] failed to sync model config:', error);
  }
}

function syncCoworkConfig(
  configPath: string,
  setConfig: (config: Record<string, string>) => void,
): void {
  const openclawPath = path.join(configPath, 'openclaw.json');
  if (!fs.existsSync(openclawPath)) return;

  try {
    const raw = fs.readFileSync(openclawPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const agents = config.agents as
      | { defaults?: { sandbox?: { mode?: string }; workspace?: string } }
      | undefined;
    const updates: Record<string, string> = {};

    updates.agentEngine = 'openclaw';

    if (agents?.defaults?.sandbox?.mode) {
      const mapped = SANDBOX_MODE_MAP[agents.defaults.sandbox.mode];
      if (mapped) {
        updates.executionMode = mapped;
      }
    }

    if (agents?.defaults?.workspace) {
      updates.workingDirectory = agents.defaults.workspace;
    }

    setConfig(updates);
    console.log(`[Enterprise] synced cowork config: ${JSON.stringify(updates)}`);
  } catch (error) {
    console.error('[Enterprise] failed to sync cowork config:', error);
  }
}

function syncSkills(configPath: string, store: SqliteStore, mode: 'merge' | 'overwrite'): void {
  const skillsDir = path.join(configPath, 'skills');
  if (!fs.existsSync(skillsDir)) {
    console.log('[Enterprise] no skills/ directory found, skipping skills sync');
    return;
  }

  // Skills are now managed by Gateway via skills.status RPC.
  // Enterprise skills sync is deprecated - skills should be imported via Gateway's managed directory.
  console.log(
    '[Enterprise] skills/ directory found but sync is deprecated. Use Gateway skill import instead.',
  );
  return;
}

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function syncAgents(configPath: string, workspaceDir: string | undefined, force: boolean): void {
  const agentsDir = path.join(configPath, 'agents');
  if (!fs.existsSync(agentsDir)) {
    console.log('[Enterprise] no agents/ directory found, skipping agents sync');
    return;
  }

  const targetDir = workspaceDir || path.join(app.getPath('home'), '.openclaw', 'workspace');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Copy all files from enterprise agents/ to workspace directory
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    const src = path.join(agentsDir, entry.name);
    const dest = path.join(targetDir, entry.name);
    // Default: only copy if target does not exist (preserve user modifications)
    // Force: always overwrite
    if (!force && fs.existsSync(dest)) continue;
    try {
      if (entry.isDirectory()) {
        copyDirRecursive(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
      copiedCount++;
    } catch (error) {
      console.warn(`[Enterprise] failed to copy agent file "${entry.name}":`, error);
    }
  }

  console.log(`[Enterprise] synced ${copiedCount} agent file(s) to ${targetDir}`);
}

function syncMcpServers(
  configPath: string,
  upsertByName: (server: {
    name: string;
    description: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }) => void,
  clearAll: () => void,
  mode: 'merge' | 'overwrite',
): void {
  const mcpPath = path.join(configPath, 'mcp', 'servers.json');
  if (!fs.existsSync(mcpPath)) {
    console.log('[Enterprise] no mcp/servers.json found, skipping MCP sync');
    return;
  }

  try {
    const raw = fs.readFileSync(mcpPath, 'utf-8');
    const servers = JSON.parse(raw) as Array<{
      name: string;
      description: string;
      transportType: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }>;

    if (!Array.isArray(servers)) {
      console.warn('[Enterprise] mcp/servers.json is not an array, skipping');
      return;
    }

    if (mode === 'overwrite') {
      clearAll();
    }

    let syncedCount = 0;
    for (const server of servers) {
      if (!server.name) {
        console.warn('[Enterprise] MCP server entry missing name, skipping');
        continue;
      }
      try {
        upsertByName({
          name: server.name,
          description: server.description || '',
          transportType: server.transportType || 'stdio',
          command: server.command,
          args: server.args,
          env: server.env,
        });
        syncedCount++;
      } catch (error) {
        console.warn(`[Enterprise] failed to upsert MCP server "${server.name}":`, error);
      }
    }
    console.log(`[Enterprise] synced ${syncedCount} MCP server(s) (mode: ${mode})`);
  } catch (error) {
    console.error('[Enterprise] failed to sync MCP servers:', error);
  }
}

/**
 * Deep merge source into target. Source values win on conflict.
 * Arrays are replaced (not concatenated).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Merge enterprise openclaw.json fields into the runtime-generated openclaw.json.
 * Called AFTER openclawConfigSync generates the runtime config.
 * Enterprise values override generated values; fields not in enterprise config are preserved.
 */
export function mergeEnterpriseOpenclawConfig(runtimeConfigPath: string): void {
  const enterprisePath = resolveEnterpriseConfigPath();
  if (!enterprisePath) return;

  const enterpriseOpenclawPath = path.join(enterprisePath, 'openclaw.json');
  if (!fs.existsSync(enterpriseOpenclawPath) || !fs.existsSync(runtimeConfigPath)) return;

  try {
    const runtimeRaw = fs.readFileSync(runtimeConfigPath, 'utf-8');
    const runtimeConfig = JSON.parse(runtimeRaw) as Record<string, unknown>;

    const enterpriseRaw = fs.readFileSync(enterpriseOpenclawPath, 'utf-8');
    const enterpriseConfig = JSON.parse(enterpriseRaw) as Record<string, unknown>;

    const merged = deepMerge(runtimeConfig, enterpriseConfig);
    fs.writeFileSync(runtimeConfigPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log('[Enterprise] merged enterprise openclaw.json into runtime config');
  } catch (error) {
    console.error('[Enterprise] failed to merge enterprise openclaw.json:', error);
  }
}
