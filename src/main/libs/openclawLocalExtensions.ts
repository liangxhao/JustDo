import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const LOCAL_EXTENSIONS_DIR = 'openclaw-extensions';

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
    ? [path.join(process.resourcesPath, 'cfmind', 'extensions')]
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

  const copied: string[] = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const destDir = path.join(targetExtensionsDir, entry.name);
    // Skip if the compiled extension already exists (placed by build pipeline).
    // The runtime sync should not overwrite compiled .js with source .ts files.
    try {
      if (fs.statSync(destDir).isDirectory() && fs.existsSync(path.join(destDir, 'index.js'))) {
        continue;
      }
    } catch {
      // Target doesn't exist yet, proceed with copy.
    }
    fs.cpSync(
      path.join(sourceDir, entry.name),
      destDir,
      { recursive: true, force: true },
    );
    copied.push(entry.name);
  }

  return { sourceDir, copied };
};

export const listLocalOpenClawExtensionIds = (): string[] => {
  const sourceDir = findLocalExtensionsSourceDir();
  if (!sourceDir) {
    return [];
  }

  try {
    return fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(sourceDir, entry.name, 'openclaw.plugin.json')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const listBundledOpenClawExtensionIds = (): string[] => {
  const extensionsDir = findBundledExtensionsDir();
  if (!extensionsDir) {
    return [];
  }

  try {
    return fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(extensionsDir, entry.name, 'openclaw.plugin.json')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const hasBundledOpenClawExtension = (extensionId: string): boolean => {
  return listBundledOpenClawExtensionIds().includes(extensionId)
    || listLocalOpenClawExtensionIds().includes(extensionId);
};
