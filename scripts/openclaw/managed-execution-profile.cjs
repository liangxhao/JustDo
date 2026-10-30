'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyFrozenOpenClawRuntime } = require('./verify-openclaw-runtime-patches.cjs');

/** Host build adapter only. This resource is never part of the public SDK. */
function emitManagedExecutionProfile(runtimeRoot, extensionRoot, verify = verifyFrozenOpenClawRuntime) {
  const manifestPath = path.join(runtimeRoot, 'runtime-patch-manifest.json');
  // A plain upstream runtime has no prepared profile and advertises no guarantee.
  if (!fs.existsSync(manifestPath)) return false;
  const { manifest } = verify(runtimeRoot, { requireBundle: true });
  const executionPatch = manifest.patches.find(entry =>
    entry.file.endsWith('/019-plugin-owned-execution.cjs'));
  if (!executionPatch) return false;
  const destination = path.join(extensionRoot, 'execution', 'runtime-profile.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({
    formatVersion: 1,
    capability: 'managed-execution-v1',
    openclawVersion: manifest.openclawVersion,
    gatewayBundle: manifest.gatewayBundle,
    executionPatch,
  }, null, 2) + '\n');
  return true;
}

module.exports = { emitManagedExecutionProfile };
