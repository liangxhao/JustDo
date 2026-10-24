// Historical v2026.10.4 test/patch target inventory frozen from 04716a4655d6.
// The active builder imports only scripts/openclaw/openclaw-patch-dependencies.cjs.
// No historical artifact validation or installation path is exposed here.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only these pinned modules are writable by the runtime patch transaction.
const PROVIDER_TRANSPORT_PATH =
  'node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs';
const PROVIDER_PARTITIONER_PATH =
  'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-Ju9VpUGl.mjs';
const FS_SAFE_MOVE_PATH = 'node_modules/@openclaw/fs-safe/dist/move-path.js';
const FS_SAFE_GUARDED_MUTATION_PATH = 'node_modules/@openclaw/fs-safe/dist/guarded-mutation.js';
const PATCH_DEPENDENCY_JAVASCRIPT_PATHS = Object.freeze([
  PROVIDER_TRANSPORT_PATH,
  PROVIDER_PARTITIONER_PATH,
  FS_SAFE_MOVE_PATH,
  FS_SAFE_GUARDED_MUTATION_PATH,
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

module.exports = {
  PROVIDER_PARTITIONER_PATH,
  PROVIDER_TRANSPORT_PATH,
  isRuntimePatchDependencyTarget,
  listRuntimePatchDependencyTargets,
};
