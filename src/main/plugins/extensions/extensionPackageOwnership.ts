import { execFile } from 'child_process';
import { promisify } from 'util';

import { t } from '../../core/i18n';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

const OUTPUT_PREFIX = 'PLUGIN_PACKAGE_OWNERSHIP=';

export interface ExtensionPackageOwnership {
  ownerId: string;
  pluginIds: string[];
  installPath: string;
}

// Native metadata and its ownership resolver remain authoritative. This reader
// never loads plugin entry modules or starts the Gateway.
const NATIVE_METADATA_LOADER = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = path.join(process.cwd(), 'dist');
const load = async (prefix, name) => {
  for (const file of fs.readdirSync(dist).filter(file => file.startsWith(prefix) && /\.m?js$/.test(file))) {
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.entries(module).find(([key, value]) =>
      typeof value === 'function' && (key === name || value.name === name))?.[1];
    if (fn) return fn;
  }
  throw new Error('Native plugin ownership export unavailable: ' + name);
};
`;

export const EXTENSION_PACKAGE_OWNERSHIP_SCRIPT =
  NATIVE_METADATA_LOADER +
  String.raw`
const getConfig = await load('io.runtime-', 'getRuntimeConfig');
const resolveWorkspace = await load('control-plane-workspace-', 'resolvePluginControlPlaneWorkspace');
const loadMetadata = await load('plugin-metadata-snapshot-', 'loadPluginMetadataSnapshot');
const createOwnership = await load('installed-plugin-package-ownership-', 'createInstalledPluginOwnershipResolver');
const config = getConfig();
const { workspaceDir } = resolveWorkspace({ config });
const metadata = loadMetadata({ config, workspaceDir, env: process.env, allowCurrent: false });
const resolver = createOwnership(metadata.index, process.env);
const packages = new Map();
for (const plugin of metadata.index.plugins) {
  const resolved = resolver.resolvePackage(plugin.pluginId);
  if (!resolved.ok || !resolved.value.installRecord.installPath) continue;
  const { installOwner: ownerId, pluginIds, installRecord } = resolved.value;
  packages.set(ownerId, { ownerId, pluginIds, installPath: installRecord.installPath });
}
process.stdout.write('${OUTPUT_PREFIX}' + JSON.stringify([...packages.values()]));
`;

const EXTENSION_ARTIFACT_IDS_SCRIPT =
  NATIVE_METADATA_LOADER +
  String.raw`
const directory = process.env.PLUGIN_ARTIFACT_DIRECTORY;
const root = fs.realpathSync(directory);
const loadRegistry = await load('manifest-registry-', 'loadPluginManifestRegistryCore');
const registry = loadRegistry({ config: { plugins: { load: { paths: [directory] } } }, env: process.env });
const ids = registry.plugins.flatMap(plugin => {
  try { return fs.realpathSync(plugin.rootDir) === root ? [plugin.id] : []; }
  catch { return []; }
});
process.stdout.write('${OUTPUT_PREFIX}' + JSON.stringify([...new Set(ids)].sort()));
`;

const execute = promisify(execFile);

const readNativeMetadata = async (
  manager: OpenClawEngineManager,
  script: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<unknown> => {
  const cli = await manager.buildCliEnvironment();
  let stdout: string;
  try {
    const result = await execute(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: cli.runtimeRoot,
      env: {
        ...cli.env,
        ...environment,
        ELECTRON_RUN_AS_NODE: '1',
        OPENCLAW_HOME: manager.getBaseDir(),
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4_000_000,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch {
    throw new Error(t('extensionPackageOwnershipUnconfirmed'));
  }
  const start = stdout.lastIndexOf(OUTPUT_PREFIX);
  if (start < 0) throw new Error(t('extensionPackageOwnershipUnconfirmed'));
  try {
    return JSON.parse(stdout.slice(start + OUTPUT_PREFIX.length));
  } catch {
    throw new Error(t('extensionPackageOwnershipUnconfirmed'));
  }
};

export const readExtensionPackageOwnership = async (
  manager: OpenClawEngineManager,
): Promise<ExtensionPackageOwnership[]> => {
  const raw = await readNativeMetadata(manager, EXTENSION_PACKAGE_OWNERSHIP_SCRIPT);
  if (
    !Array.isArray(raw) ||
    raw.some(
      entry =>
        !entry ||
        typeof entry.ownerId !== 'string' ||
        !entry.ownerId ||
        typeof entry.installPath !== 'string' ||
        !entry.installPath ||
        !Array.isArray(entry.pluginIds) ||
        !entry.pluginIds.length ||
        entry.pluginIds.some((id: unknown) => typeof id !== 'string' || !id),
    )
  ) {
    throw new Error(t('extensionPackageOwnershipUnconfirmed'));
  }
  return raw;
};

export const readExtensionArtifactPluginIds = async (
  manager: OpenClawEngineManager,
  directory: string,
): Promise<string[]> => {
  const raw = await readNativeMetadata(manager, EXTENSION_ARTIFACT_IDS_SCRIPT, {
    PLUGIN_ARTIFACT_DIRECTORY: directory,
  });
  if (!Array.isArray(raw) || !raw.length || raw.some(id => typeof id !== 'string' || !id))
    throw new Error(t('extensionPackageOwnershipUnconfirmed'));
  return raw;
};
