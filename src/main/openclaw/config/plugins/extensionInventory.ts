import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import {
  hasBundledOpenClawExtension,
  inspectBundledOpenClawExtensions,
  inspectLocalOpenClawExtensions,
  inspectOpenClawExtensionCandidate,
  inspectOpenClawExtensionDirectory,
} from '../../../plugins/extensions';
import { isRecord } from '../configShape';

export type ConfiguredPluginInventory = {
  complete: boolean;
  ids: string[];
};

export const listInstalledOpenClawExtensionIds = (stateDir: string): string[] =>
  inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions')).ids;

export const resolveConfiguredPluginPath = (value: string): string => {
  const trimmed = value.trim();
  const homeDir = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
};

export const isMissingConfiguredPluginPath = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );

export const hasCompatiblePluginBundleManifest = (pluginDir: string): boolean => {
  for (const relativeManifestPath of [
    path.join('.codex-plugin', 'plugin.json'),
    path.join('.claude-plugin', 'plugin.json'),
    path.join('.cursor-plugin', 'plugin.json'),
  ]) {
    try {
      if (fs.statSync(path.join(pluginDir, relativeManifestPath)).isFile()) return true;
    } catch (error) {
      // A non-missing error means the candidate cannot be inventoried safely.
      if (!isMissingConfiguredPluginPath(error)) return true;
    }
  }
  return false;
};

export const inspectConfiguredPluginPaths = (
  plugins: Record<string, unknown>,
): ConfiguredPluginInventory => {
  const load = isRecord(plugins.load) ? plugins.load : {};
  const loadPaths = Array.isArray(load.paths)
    ? load.paths.filter(
        (value): value is string => typeof value === 'string' && Boolean(value.trim()),
      )
    : [];
  const ids = new Set<string>();
  let complete = true;

  for (const configuredPath of loadPaths) {
    const existingPath = resolveConfiguredPluginPath(configuredPath);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(existingPath);
    } catch (error) {
      if (isMissingConfiguredPluginPath(error)) continue;
      complete = false;
      continue;
    }
    if (!stats.isDirectory()) {
      // Standalone plugin files may export an id that cannot be inferred without executing code.
      complete = false;
      continue;
    }

    const directInventory = inspectOpenClawExtensionCandidate(existingPath);
    if (directInventory.complete) {
      directInventory.ids.forEach(id => ids.add(id));
      continue;
    }
    if (hasCompatiblePluginBundleManifest(existingPath)) {
      complete = false;
      continue;
    }
    const rootInventory = inspectOpenClawExtensionDirectory(existingPath);
    rootInventory.ids.forEach(id => ids.add(id));
    if (!rootInventory.complete) complete = false;
  }

  return { complete, ids: [...ids].sort() };
};

export const listAvailableOpenClawExtensionIds = (
  stateDir: string,
  plugins: Record<string, unknown>,
  workspaceDirs: readonly string[] = [],
): string[] | null => {
  const bundledInventory = inspectBundledOpenClawExtensions();
  const localInventory = inspectLocalOpenClawExtensions();
  const installedInventory = inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions'));
  const workspaceInventories = workspaceDirs.map(workspaceDir =>
    inspectOpenClawExtensionDirectory(path.join(workspaceDir, '.openclaw', 'extensions')),
  );
  const configuredInventory = inspectConfiguredPluginPaths(plugins);
  if (
    !bundledInventory.complete ||
    bundledInventory.ids.length === 0 ||
    !localInventory.complete ||
    !installedInventory.complete ||
    workspaceInventories.some(inventory => !inventory.complete) ||
    !configuredInventory.complete
  ) {
    return null;
  }
  return [
    ...new Set([
      ...bundledInventory.ids,
      ...localInventory.ids,
      ...installedInventory.ids,
      ...workspaceInventories.flatMap(inventory => inventory.ids),
      ...configuredInventory.ids,
    ]),
  ].sort();
};

export const readPreinstalledPluginIds = (): string[] => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plugins = pkg.openclaw?.plugins;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .map((p: { id?: string }) => p.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
};

export const isBundledPluginAvailable = (pluginId: string): boolean => {
  return hasBundledOpenClawExtension(pluginId);
};

export const isUserToggleableBundledPlugin = (pluginId: string): boolean =>
  pluginId === OpenClawExtensionId.MEMORY_CORE ||
  pluginId === OpenClawExtensionId.WORKBOARD ||
  pluginId === OpenClawExtensionId.AGENT_TEAM ||
  pluginId === OpenClawExtensionId.WIDGET_KIT ||
  pluginId === OpenClawExtensionId.DRAWIO ||
  pluginId === OpenClawExtensionId.SWARM_WORKFLOW ||
  pluginId === OpenClawExtensionId.TYPESAFE ||
  pluginId === OpenClawExtensionId.STT_LOCAL_CLI ||
  pluginId === LOCAL_TTS_PROVIDER_ID;
