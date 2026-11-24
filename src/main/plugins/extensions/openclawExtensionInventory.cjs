'use strict';

const fs = require('node:fs');
const path = require('node:path');
const json5Module = require('json5');
const JSON5 = json5Module.default ?? json5Module;

const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/** @param {string} extensionDir */
const isRuntimeBundledSource = (extensionDir) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
    return pkg?.openclaw?.runtimeBundled === true;
  } catch {
    return false;
  }
};

/** @typedef {{ complete: boolean; ids: string[] }} OpenClawExtensionInventory */

/** @param {unknown} error */
const isMissingPathError = (error) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );

/**
 * @param {string} extensionDir
 * @param {{ manifestOnly?: boolean }} options
 * @returns {OpenClawExtensionInventory}
 */
const inspectOpenClawExtensionCandidate = (extensionDir, { manifestOnly = false } = {}) => {
  try {
    const nativeManifestPath = path.join(extensionDir, 'openclaw.plugin.json');
    const manifestPath = [
      nativeManifestPath,
      path.join(extensionDir, '.codex-plugin', 'plugin.json'),
      path.join(extensionDir, '.cursor-plugin', 'plugin.json'),
      path.join(extensionDir, '.claude-plugin', 'plugin.json'),
    ].find(candidate => fs.existsSync(candidate));
    let manifest;
    if (manifestPath) {
      manifest = JSON5.parse(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      const agentManifestPath = path.join(extensionDir, 'plugin.json');
      if (fs.existsSync(agentManifestPath)) {
        const agentManifest = JSON.parse(fs.readFileSync(agentManifestPath, 'utf8'));
        if (
          agentManifest &&
          typeof agentManifest === 'object' &&
          !Array.isArray(agentManifest) &&
          agentManifest.$schema === AGENT_PLUGIN_MANIFEST_SCHEMA
        ) {
          manifest = agentManifest;
        }
      }
    }
    if (manifest === undefined) {
      if (manifestOnly) return { complete: false, ids: [] };
      const hasManifestlessBundleMarker = [
        'skills',
        'commands',
        'agents',
        path.join('hooks', 'hooks.json'),
        '.mcp.json',
        '.lsp.json',
        'settings.json',
      ].some(candidate => fs.existsSync(path.join(extensionDir, candidate)));
      if (!hasManifestlessBundleMarker) return { complete: false, ids: [] };
      const id =
        path
          .basename(extensionDir)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '') || 'bundle-plugin';
      return { complete: true, ids: [id] };
    }
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      const record = manifest;
      if (manifestPath === nativeManifestPath) {
        const id = record.id;
        return typeof id === 'string' && id.trim()
          ? { complete: true, ids: [id.trim()] }
          : { complete: false, ids: [] };
      }
      const bundleName =
        typeof record.name === 'string' && record.name.trim()
          ? record.name
          : path.basename(extensionDir);
      const slug = bundleName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      return { complete: true, ids: [slug || 'bundle-plugin'] };
    }
    return { complete: false, ids: [] };
  } catch {
    return { complete: false, ids: [] };
  }
};

/**
 * @param {string} extensionsDir
 * @param {{ excludeRuntimeBundledSources?: boolean; ignoredFileNames?: readonly string[] }} options
 * @returns {OpenClawExtensionInventory}
 */
const inspectOpenClawExtensionDirectory = (extensionsDir, options = {}) => {
  let entries;
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch (error) {
    return { complete: isMissingPathError(error), ids: [] };
  }

  const ids = new Set();
  let complete = true;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() && options.ignoredFileNames?.includes(entry.name)) continue;
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
    if (options.excludeRuntimeBundledSources && isRuntimeBundledSource(extensionDir)) continue;
    const candidate = inspectOpenClawExtensionCandidate(extensionDir);
    candidate.ids.forEach(id => ids.add(id));
    if (!candidate.complete) complete = false;
  }
  return { complete, ids: [...ids].sort() };
};

/** @param {string} pluginDir */
const hasCompatiblePluginBundleManifest = (pluginDir) => {
  for (const relativeManifestPath of [
    path.join('.codex-plugin', 'plugin.json'),
    path.join('.claude-plugin', 'plugin.json'),
    path.join('.cursor-plugin', 'plugin.json'),
  ]) {
    try {
      if (fs.statSync(path.join(pluginDir, relativeManifestPath)).isFile()) return true;
    } catch (error) {
      if (!isMissingPathError(error)) return true;
    }
  }
  return false;
};

/**
 * @param {string} pluginPath
 * @returns {OpenClawExtensionInventory}
 */
const inspectConfiguredPluginPath = (pluginPath) => {
  try {
    // Standalone files may export a plugin ID that is unavailable without execution.
    if (!fs.statSync(pluginPath).isDirectory()) return { complete: false, ids: [] };
  } catch (error) {
    return { complete: isMissingPathError(error), ids: [] };
  }
  const candidate = inspectOpenClawExtensionCandidate(pluginPath);
  if (candidate.complete) return candidate;
  if (hasCompatiblePluginBundleManifest(pluginPath)) return { complete: false, ids: [] };
  return inspectOpenClawExtensionDirectory(pluginPath);
};

module.exports = {
  isMissingPathError,
  isRuntimeBundledSource,
  inspectConfiguredPluginPath,
  inspectOpenClawExtensionCandidate,
  inspectOpenClawExtensionDirectory,
};
