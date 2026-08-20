import { app } from 'electron';
import fs from 'fs';
import JSON5 from 'json5';
import path from 'path';

import { listRetiredBundledOpenClawExtensionIds } from './openclawExtensionRegistry';

const LOCAL_EXTENSIONS_DIR = 'openclaw-extensions';

const isPathInside = (parentDir: string, childPath: string): boolean => {
  const relative = path.relative(parentDir, childPath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export type OpenClawExtensionInventory = {
  complete: boolean;
  ids: string[];
};

const isMissingPathError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );

export const inspectOpenClawExtensionCandidate = (
  extensionDir: string,
): OpenClawExtensionInventory => {
  try {
    const manifest = JSON5.parse(
      fs.readFileSync(path.join(extensionDir, 'openclaw.plugin.json'), 'utf8'),
    ) as unknown;
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      const id = (manifest as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) {
        return { complete: true, ids: [id.trim()] };
      }
    }
    return { complete: false, ids: [] };
  } catch {
    return { complete: false, ids: [] };
  }
};

export const inspectOpenClawExtensionDirectory = (
  extensionsDir: string,
): OpenClawExtensionInventory => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch (error) {
    return { complete: isMissingPathError(error), ids: [] };
  }

  const ids = new Set<string>();
  let complete = true;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const extensionDir = path.join(extensionsDir, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = fs.statSync(extensionDir).isDirectory();
      } catch {
        complete = false;
        continue;
      }
    }
    if (!isDirectory) {
      complete = false;
      continue;
    }
    const candidate = inspectOpenClawExtensionCandidate(extensionDir);
    candidate.ids.forEach(id => ids.add(id));
    if (!candidate.complete) complete = false;
  }
  return { complete, ids: [...ids].sort() };
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

export const syncLocalOpenClawExtensionsIntoRuntime = (
  runtimeRoot: string,
): { sourceDir: string | null; copied: string[] } => {
  const sourceDir = findLocalExtensionsSourceDir();
  if (!sourceDir) {
    return { sourceDir: null, copied: [] };
  }

  const targetExtensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
  try {
    if (!fs.statSync(targetExtensionsDir).isDirectory()) {
      return { sourceDir, copied: [] };
    }
  } catch {
    return { sourceDir, copied: [] };
  }

  let realRuntimeRoot: string;
  let realTargetExtensionsDir: string;
  try {
    realRuntimeRoot = fs.realpathSync(runtimeRoot);
    realTargetExtensionsDir = fs.realpathSync(targetExtensionsDir);
  } catch {
    return { sourceDir, copied: [] };
  }
  if (!isPathInside(realRuntimeRoot, realTargetExtensionsDir)) {
    return { sourceDir, copied: [] };
  }

  for (const retiredId of listRetiredBundledOpenClawExtensionIds()) {
    const retiredDir = path.join(targetExtensionsDir, retiredId);
    try {
      if (fs.lstatSync(retiredDir).isSymbolicLink()) continue;
      const realRetiredDir = fs.realpathSync(retiredDir);
      if (!isPathInside(realTargetExtensionsDir, realRetiredDir)) continue;
    } catch (error) {
      if (isMissingPathError(error)) continue;
      return { sourceDir, copied: [] };
    }
    fs.rmSync(retiredDir, { recursive: true, force: true });
  }

  const copied: string[] = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const destDir = path.join(targetExtensionsDir, entry.name);
    // Skip if the compiled extension already exists (placed by build pipeline).
    // The runtime sync should not overwrite compiled .js with source .ts files.
    try {
      if (fs.lstatSync(destDir).isSymbolicLink()) continue;
      if (fs.statSync(destDir).isDirectory() && fs.existsSync(path.join(destDir, 'index.js'))) {
        continue;
      }
    } catch (error) {
      if (!isMissingPathError(error)) return { sourceDir, copied };
      // Target doesn't exist yet, proceed with copy.
    }
    fs.cpSync(path.join(sourceDir, entry.name), destDir, { recursive: true, force: true });
    copied.push(entry.name);
  }

  return { sourceDir, copied };
};

export const listLocalOpenClawExtensionIds = (): string[] => {
  const sourceDir = findLocalExtensionsSourceDir();
  return sourceDir ? inspectOpenClawExtensionDirectory(sourceDir).ids : [];
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
    ? inspectOpenClawExtensionDirectory(sourceDir)
    : { complete: true, ids: [] };
};

export const hasBundledOpenClawExtension = (extensionId: string): boolean => {
  return (
    listBundledOpenClawExtensionIds().includes(extensionId) ||
    listLocalOpenClawExtensionIds().includes(extensionId)
  );
};
