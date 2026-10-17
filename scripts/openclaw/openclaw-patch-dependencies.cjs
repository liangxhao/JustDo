'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only these pinned provider modules are writable by the runtime patch transaction.
const PROVIDER_PACKAGE_PATH = 'node_modules/@openclaw/ai/package.json';
const PROVIDER_TRANSPORT_PATH =
  'node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs';
const PROVIDER_PARTITIONER_PATH =
  'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-Ju9VpUGl.mjs';
const PATCH_DEPENDENCY_JAVASCRIPT_PATHS = Object.freeze([
  PROVIDER_TRANSPORT_PATH,
  PROVIDER_PARTITIONER_PATH,
]);
const PATCH_DEPENDENCY_ARTIFACT_PATHS = Object.freeze([
  PROVIDER_PACKAGE_PATH,
  ...PATCH_DEPENDENCY_JAVASCRIPT_PATHS,
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
  if (version !== 'v2026.10.4') return [];
  const metadataPath = path.join(runtimeDir, PROVIDER_PACKAGE_PATH);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.name !== '@openclaw/ai' || metadata.version !== '2026.10.4') {
    throw new Error('Runtime patch dependency must be @openclaw/ai@2026.10.4');
  }
  return PATCH_DEPENDENCY_ARTIFACT_PATHS.map(relativePath => {
    const filePath = path.join(runtimeDir, relativePath);
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Runtime patch dependency is not a regular file: ${relativePath}`);
    }
    return filePath;
  });
}

module.exports = {
  PATCH_DEPENDENCY_ARTIFACT_PATHS,
  PROVIDER_PACKAGE_PATH,
  PROVIDER_PARTITIONER_PATH,
  PROVIDER_TRANSPORT_PATH,
  isRuntimePatchDependencyTarget,
  listRuntimePatchDependencyTargets,
  runtimePatchDependencyArtifactPaths,
};
