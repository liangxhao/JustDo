import { app } from 'electron';
import fs from 'fs';
import JSON5 from 'json5';
import path from 'path';

import {
  normalizeOpenClawPluginPolicyId,
  OpenClawExtensionId,
} from '../../../shared/plugins/nativeIds';
import {
  inspectOpenClawExtensionDirectory,
  isMissingPathError,
  isRuntimeBundledSource,
  type OpenClawExtensionInventory,
} from './openclawExtensionInventory.cjs';

export {
  inspectOpenClawExtensionCandidate,
  inspectOpenClawExtensionDirectory,
  type OpenClawExtensionInventory,
} from './openclawExtensionInventory.cjs';

const LOCAL_EXTENSIONS_DIR = path.join('plugins', 'extensions');
const LOCAL_EXTENSION_METADATA_FILES = ['prune-policy.json'];

const isPathInside = (parentDir: string, childPath: string): boolean => {
  const relative = path.relative(parentDir, childPath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const findLocalExtensionsSourceDir = (): string | null => {
  if (app.isPackaged) {
    return null;
  }

  const candidates = [
    path.join(app.getAppPath(), LOCAL_EXTENSIONS_DIR),
    path.join(process.cwd(), LOCAL_EXTENSIONS_DIR),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  return null;
};

const findBundledExtensionsDir = (): string | null => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'cfmind', 'dist', 'extensions')]
    : [
        path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current', 'dist', 'extensions'),
        path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current', 'dist', 'extensions'),
      ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  return null;
};

/** Product policy comes only from packages staged with the bundled runtime. */
export const readBundledNativePluginPolicies = (
  externalIds: readonly string[],
): Record<string, { defaultEnabled: boolean; userToggleable: boolean }> => {
  const bundledDir = findBundledExtensionsDir();
  if (!bundledDir) return {};

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return {};
  }

  const external = new Set(externalIds.map(normalizeOpenClawPluginPolicyId));
  return Object.fromEntries(entries.flatMap(entry => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return [];
    const extensionDir = path.join(bundledDir, entry.name);
    const packagePath = path.join(extensionDir, 'package.json');
    const manifestPath = path.join(extensionDir, 'openclaw.plugin.json');
    try {
      if (!fs.lstatSync(packagePath).isFile()) return [];
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg?.openclaw?.bundledPolicy?.userToggleable !== true) return [];
      if (!fs.lstatSync(manifestPath).isFile()) return [];
      const manifest = JSON5.parse<Record<string, unknown>>(fs.readFileSync(manifestPath, 'utf8'));
      const id = typeof manifest?.id === 'string' ? manifest.id.trim() : '';
      if (!id || external.has(normalizeOpenClawPluginPolicyId(id))) return [];
      const defaultEnabled =
        manifest.enabledByDefault === true ||
        (Array.isArray(manifest.enabledByDefaultOnPlatforms) &&
          manifest.enabledByDefaultOnPlatforms.includes(process.platform));
      return [[id, { defaultEnabled, userToggleable: true }] as const];
    } catch {
      return [];
    }
  }));
};

export const syncLocalOpenClawExtensionsIntoRuntime = async (
  runtimeRoot: string,
): Promise<{ sourceDir: string | null; copied: string[] }> => {
  const sourceDir = findLocalExtensionsSourceDir();
  if (!sourceDir) {
    return { sourceDir: null, copied: [] };
  }

  const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
  try {
    if (!(await fs.promises.stat(targetExtensionsDir)).isDirectory()) {
      return { sourceDir, copied: [] };
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { sourceDir, copied: [] };
  }

  let realRuntimeRoot: string;
  let realTargetExtensionsDir: string;
  try {
    realRuntimeRoot = await fs.promises.realpath(runtimeRoot);
    realTargetExtensionsDir = await fs.promises.realpath(targetExtensionsDir);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { sourceDir, copied: [] };
  }
  if (!isPathInside(realRuntimeRoot, realTargetExtensionsDir)) {
    return { sourceDir, copied: [] };
  }

  const copied: string[] = [];
  for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || isRuntimeBundledSource(path.join(sourceDir, entry.name))) {
      continue;
    }
    const destDir = path.join(targetExtensionsDir, entry.name);
    // Skip if the compiled extension already exists (placed by build pipeline).
    // The runtime sync should not overwrite compiled .js with source .ts files.
    try {
      if ((await fs.promises.lstat(destDir)).isSymbolicLink()) continue;
      if (
        (await fs.promises.stat(destDir)).isDirectory() &&
        fs.existsSync(path.join(destDir, 'index.js'))
      ) {
        continue;
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      // Target doesn't exist yet, proceed with copy.
    }
    const extensionSourceDir = path.join(sourceDir, entry.name);
    await fs.promises.cp(extensionSourceDir, destDir, {
      recursive: true,
      force: true,
      filter: sourcePath =>
        entry.name !== OpenClawExtensionId.SMART_CANVAS ||
        path.relative(extensionSourceDir, sourcePath).split(path.sep)[0] !== 'assets',
    });
    copied.push(entry.name);
  }

  return { sourceDir, copied };
};

export const listLocalOpenClawExtensionIds = (): string[] => {
  return inspectLocalOpenClawExtensions().ids;
};

export const listBundledOpenClawExtensionIds = (): string[] => {
  const extensionsDir = findBundledExtensionsDir();
  return extensionsDir ? inspectOpenClawExtensionDirectory(extensionsDir).ids : [];
};

export const inspectBundledOpenClawExtensions = (): OpenClawExtensionInventory => {
  const extensionsDir = findBundledExtensionsDir();
  return extensionsDir
    ? inspectOpenClawExtensionDirectory(extensionsDir)
    : { complete: false, ids: [] };
};

export const inspectLocalOpenClawExtensions = (): OpenClawExtensionInventory => {
  const sourceDir = findLocalExtensionsSourceDir();
  return sourceDir
    ? inspectOpenClawExtensionDirectory(sourceDir, {
        excludeRuntimeBundledSources: true,
        ignoredFileNames: LOCAL_EXTENSION_METADATA_FILES,
      })
    : { complete: true, ids: [] };
};

export const hasBundledOpenClawExtension = (extensionId: string): boolean => {
  return (
    listBundledOpenClawExtensionIds().includes(extensionId) ||
    listLocalOpenClawExtensionIds().includes(extensionId)
  );
};
