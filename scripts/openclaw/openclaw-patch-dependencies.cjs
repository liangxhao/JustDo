'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only these pinned modules are writable by the runtime patch transaction.
const PROVIDER_PACKAGE_PATH = 'node_modules/@openclaw/ai/package.json';
const PROVIDER_TRANSPORT_PATH =
  'node_modules/@openclaw/ai/dist/openai-completions-transport-BRjxCG1C.mjs';
const PROVIDER_PARTITIONER_PATH =
  'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-CpOy9-IQ.mjs';
const FS_SAFE_PACKAGE_PATH = 'node_modules/@openclaw/fs-safe/package.json';
const FS_SAFE_MOVE_PATH = 'node_modules/@openclaw/fs-safe/dist/move-path.js';
const FS_SAFE_GUARDED_MUTATION_PATH = 'node_modules/@openclaw/fs-safe/dist/guarded-mutation.js';
const PLUGIN_PUBLICATION_SUPPORT_PATH = 'dist/native-support/plugin-directory-publication.mjs';
const PATCH_DEPENDENCY_JAVASCRIPT_PATHS = Object.freeze([
  PROVIDER_TRANSPORT_PATH,
  PROVIDER_PARTITIONER_PATH,
  FS_SAFE_MOVE_PATH,
  FS_SAFE_GUARDED_MUTATION_PATH,
]);
const PATCH_DEPENDENCY_ARTIFACT_PATHS = Object.freeze([
  PROVIDER_PACKAGE_PATH,
  FS_SAFE_PACKAGE_PATH,
  ...PATCH_DEPENDENCY_JAVASCRIPT_PATHS,
  'node_modules/@openclaw/ai/dist/transports.mjs',
  'node_modules/@openclaw/ai/dist/providers.mjs',
  'node_modules/@openclaw/ai/dist/openai-completions-BkRt2Iy4.mjs',
  PLUGIN_PUBLICATION_SUPPORT_PATH,
]);

function listRuntimePatchDependencyTargets(runtimeDir) {
  return PATCH_DEPENDENCY_JAVASCRIPT_PATHS.map(relativePath => path.join(runtimeDir, relativePath))
    .filter(target => fs.existsSync(target));
}

function isRuntimePatchDependencyTarget(runtimeDir, filePath) {
  return PATCH_DEPENDENCY_JAVASCRIPT_PATHS.some(
    relativePath => path.resolve(filePath) === path.resolve(runtimeDir, relativePath),
  );
}

function runtimePatchDependencyArtifactPaths(runtimeDir, version) {
  if (version !== 'v2026.10.7') return [];
  const metadataPath = path.join(runtimeDir, PROVIDER_PACKAGE_PATH);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.name !== '@openclaw/ai' || metadata.version !== '2026.10.7') {
    throw new Error('Runtime patch dependency must be @openclaw/ai@2026.10.7');
  }
  const filesystemMetadata = JSON.parse(fs.readFileSync(path.join(runtimeDir, FS_SAFE_PACKAGE_PATH), 'utf8'));
  if (filesystemMetadata.name !== '@openclaw/fs-safe' || filesystemMetadata.version !== '0.26.0') {
    throw new Error('Runtime patch dependency must be @openclaw/fs-safe@0.26.0');
  }
  // Load after module initialization: pristine checks use the shared patch index.
  const { resolveNativeProviderTransportArtifact } = require('./verify-openclaw-pristine-contracts.cjs');
  resolveNativeProviderTransportArtifact(runtimeDir, { required: true });
  const runtimeRoot = fs.realpathSync(runtimeDir);
  return PATCH_DEPENDENCY_ARTIFACT_PATHS.map(relativePath => {
    const filePath = path.join(runtimeDir, relativePath);
    const relative = path.relative(runtimeRoot, fs.realpathSync(filePath));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !fs.statSync(filePath).isFile()) {
      throw new Error(`Runtime patch dependency is not a regular file: ${relativePath}`);
    }
    return filePath;
  });
}

module.exports = {
  FS_SAFE_PACKAGE_PATH,
  FS_SAFE_MOVE_PATH,
  FS_SAFE_GUARDED_MUTATION_PATH,
  PLUGIN_PUBLICATION_SUPPORT_PATH,
  PATCH_DEPENDENCY_ARTIFACT_PATHS,
  PROVIDER_PACKAGE_PATH,
  PROVIDER_PARTITIONER_PATH,
  PROVIDER_TRANSPORT_PATH,
  isRuntimePatchDependencyTarget,
  listRuntimePatchDependencyTargets,
  runtimePatchDependencyArtifactPaths,
};
