import { Worker } from 'node:worker_threads';

import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import {
  inspectBundledOpenClawExtensions,
  inspectLocalOpenClawExtensions,
  inspectOpenClawExtensionDirectory,
} from '../../../plugins/extensions';
import {
  inspectConfiguredPluginPath,
  type OpenClawExtensionInventory,
} from '../../../plugins/extensions/openclawExtensionInventory.cjs';
import { isRecord } from '../configShape';

export type WorkspaceExtensionInventory = {
  workspace: Map<string, OpenClawExtensionInventory>;
  configured: Map<string, OpenClawExtensionInventory>;
};

const WORKSPACE_EXTENSION_INVENTORY_TIMEOUT_MS = 5_000;
const incompleteInventory: OpenClawExtensionInventory = { complete: false, ids: [] };
let retiringInventoryWorker: Worker | null = null;

const inspectInstalledExtensions = (stateDir: string): OpenClawExtensionInventory =>
  inspectOpenClawExtensionDirectory(path.join(stateDir, 'extensions'));

export const listInstalledOpenClawExtensionIds = (stateDir: string): string[] =>
  inspectInstalledExtensions(stateDir).ids;

export const inspectBundledPluginSources = () => {
  const bundled = inspectBundledOpenClawExtensions();
  const local = inspectLocalOpenClawExtensions();
  const ids = new Set([...bundled.ids, ...local.ids]);
  return { bundled, local, isBundledAvailable: (id: string) => ids.has(id) };
};

export const inspectOpenClawExtensionSources = (stateDir: string) => ({
  ...inspectBundledPluginSources(),
  installed: inspectInstalledExtensions(stateDir),
});

export type OpenClawExtensionSources = ReturnType<typeof inspectOpenClawExtensionSources>;

export const resolveConfiguredPluginPath = (value: string): string => {
  const trimmed = value.trim();
  const homeDir = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, homeDir);
  return path.resolve(expanded);
};

const getConfiguredPluginPaths = (plugins: Record<string, unknown>): string[] => {
  const load = isRecord(plugins.load) ? plugins.load : {};
  const loadPaths = Array.isArray(load.paths)
    ? load.paths.filter(
        (value): value is string => typeof value === 'string' && Boolean(value.trim()),
      )
    : [];
  return [...new Set(loadPaths.map(resolveConfiguredPluginPath))];
};

const workspaceExtensionDirectory = (workspaceDir: string): string =>
  path.join(workspaceDir, '.openclaw', 'extensions');

export async function collectWorkspaceExtensionInventory(
  workspaceDirs: readonly string[],
  plugins: Record<string, unknown>,
): Promise<WorkspaceExtensionInventory> {
  const unavailable = { workspace: new Map(), configured: new Map() };
  if (retiringInventoryWorker) return unavailable;
  try {
    return await new Promise<WorkspaceExtensionInventory>(resolve => {
      const worker = new Worker(path.join(__dirname, 'extensionInventoryWorker.cjs'), {
        workerData: {
          workspace: [...new Set(workspaceDirs.map(workspaceExtensionDirectory))],
          configured: getConfiguredPluginPaths(plugins),
        },
      });
      const finish = (inventory: WorkspaceExtensionInventory) => {
        clearTimeout(timeout);
        resolve(inventory);
      };
      const timeout = setTimeout(() => {
        // A synchronous OS read can outlive the deadline. Avoid starting further
        // workers until this one exits.
        retiringInventoryWorker = worker;
        void worker.terminate().catch(() => {});
        worker.unref();
        finish(unavailable);
      }, WORKSPACE_EXTENSION_INVENTORY_TIMEOUT_MS);
      worker.once('message', finish);
      worker.once('error', () => finish(unavailable));
      worker.once('exit', () => {
        if (retiringInventoryWorker === worker) retiringInventoryWorker = null;
        finish(unavailable);
      });
    });
  } catch {
    return unavailable;
  }
}

export const inspectConfiguredPluginPaths = (
  plugins: Record<string, unknown>,
  inventory?: WorkspaceExtensionInventory,
): OpenClawExtensionInventory => {
  const ids = new Set<string>();
  let complete = true;

  for (const pluginPath of getConfiguredPluginPaths(plugins)) {
    const result = inventory
      ? inventory.configured.get(pluginPath) ?? incompleteInventory
      : inspectConfiguredPluginPath(pluginPath);
    result.ids.forEach(id => ids.add(id));
    complete &&= result.complete;
  }

  return { complete, ids: [...ids].sort() };
};

export const listAvailableOpenClawExtensionIds = (
  stateDir: string,
  plugins: Record<string, unknown>,
  workspaceDirs: readonly string[] = [],
  {
    workspace,
    configured = inspectConfiguredPluginPaths(plugins, workspace),
    sources = inspectOpenClawExtensionSources(stateDir),
  }: {
    workspace?: WorkspaceExtensionInventory;
    configured?: OpenClawExtensionInventory;
    sources?: OpenClawExtensionSources;
  } = {},
): string[] | null => {
  const { bundled, local, installed } = sources;
  const workspaceInventories = workspaceDirs.map(workspaceDir => {
    const directory = workspaceExtensionDirectory(workspaceDir);
    return workspace
      ? workspace.workspace.get(directory) ?? incompleteInventory
      : inspectOpenClawExtensionDirectory(directory);
  });
  if (
    !bundled.complete ||
    bundled.ids.length === 0 ||
    !local.complete ||
    !installed.complete ||
    workspaceInventories.some(inventory => !inventory.complete) ||
    !configured.complete
  ) {
    return null;
  }
  return [
    ...new Set([
      ...bundled.ids,
      ...local.ids,
      ...installed.ids,
      ...workspaceInventories.flatMap(inventory => inventory.ids),
      ...configured.ids,
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

export const isUserToggleableBundledPlugin = (
  pluginId: string,
  appPolicies: Record<string, { defaultEnabled: boolean; userToggleable: boolean }> = {},
): boolean =>
  appPolicies[pluginId]?.userToggleable === true ||
  pluginId === OpenClawExtensionId.MEMORY_CORE ||
  pluginId === OpenClawExtensionId.WORKBOARD ||
  pluginId === OpenClawExtensionId.SMART_CANVAS ||
  pluginId === OpenClawExtensionId.TYPESAFE ||
  pluginId === OpenClawExtensionId.STT_LOCAL_CLI ||
  pluginId === LOCAL_TTS_PROVIDER_ID;
