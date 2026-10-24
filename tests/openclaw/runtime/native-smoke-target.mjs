import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Native probes must name the freshly frozen artifact and use its bundled Node. */
export function resolveNativeSmokeTarget(requestedRuntime) {
  const requested = requestedRuntime ?? process.argv[2] ?? process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
  assert.ok(requested, 'Pass the final runtime directory explicitly.');
  const runtimeRoot = fs.realpathSync(path.resolve(requested));
  const app = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const { hostTarget, targetContract } = require('../../../scripts/runtime/setup-node-runtime.cjs');
  const { verifyOpenClawPatchManifest } = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
  const target = hostTarget();
  const manifest = verifyOpenClawPatchManifest(runtimeRoot, { expectedVersion: app.openclaw.version, expectedTarget: target });
  const executable = path.join(runtimeRoot, 'node-runtime', targetContract(target).executable);
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable),
    'Run this probe with the selected runtime/node-runtime executable.');
  const identity = {
    runtimeRoot, openclawVersion: manifest.openclawVersion, target: manifest.target,
    nodeVersion: process.version, executable: fs.realpathSync(executable),
    patchSetSha256: manifest.patchSetSha256, buildRecipeSha256: manifest.buildRecipeSha256,
    gatewayBundleSha256: manifest.gatewayBundle.sha256,
    nodeRuntimeManifestSha256: manifest.sourceArtifacts.nodeRuntimeManifestSha256,
  };
  console.log(`NATIVE_RUNTIME_IDENTITY=${JSON.stringify(identity)}`);
  return { runtimeRoot, executable, identity };
}
