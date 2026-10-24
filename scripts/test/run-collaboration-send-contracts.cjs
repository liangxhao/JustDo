'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { hostTarget, targetContract } = require('../runtime/setup-node-runtime.cjs');
const { verifyOpenClawPatchManifest, verifyFrozenOpenClawRuntime } = require('../openclaw/verify-openclaw-runtime-patches.cjs');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const args = process.argv.slice(2);
  assert.deepEqual([args.length, args[0], args[2]], [4, '--runtime-dir', '--source-root'],
    'Usage: node scripts/test/run-collaboration-send-contracts.cjs --runtime-dir <runtime> --source-root <target-source>');
  const runtime = fs.realpathSync(path.resolve(args[1]));
  const source = fs.realpathSync(path.resolve(args[3]));
  const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = app.openclaw.version.startsWith('v') ? app.openclaw.version : `v${app.openclaw.version}`;
  const sourceGit = command => {
    const result = spawnSync('git', ['-C', source, ...command], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.ok(!result.error && !result.signal && result.status === 0, 'Cannot admit exact upstream source.');
    return result.stdout.trim();
  };
  const sourceCommit = sourceGit(['rev-parse', '--verify', 'HEAD^{commit}']);
  assert.equal(sourceCommit, sourceGit(['rev-parse', '--verify', `${tag}^{commit}`]),
    'Sending contracts must use the exact target tag.');
  assert.equal(sourceGit(['status', '--porcelain', '--untracked-files=no']), '');
  const target = hostTarget();
  const manifest = verifyOpenClawPatchManifest(runtime, { repoRoot: root,
    expectedVersion: app.openclaw.version, expectedTarget: target, requireBundle: true });
  verifyFrozenOpenClawRuntime(runtime, { expectedVersion: app.openclaw.version, expectedTarget: target, requireBundle: true });
  const executable = path.join(runtime, 'node-runtime', targetContract(target).executable);
  const { verifyCollaborationExtensionAssembly } = await import(pathToFileURL(
    path.join(root, 'tests/openclaw/runtime/extension-assembly-contract.mjs')).href);
  const assembly = verifyCollaborationExtensionAssembly(runtime);
  process.stdout.write(`COLLABORATION_SEND_IDENTITY=${JSON.stringify({ tag, sourceCommit,
    runtime, buildRecipeSha256: manifest.buildRecipeSha256,
    manifestSha256: assembly.manifestSha256, assemblySha256: assembly.assemblySha256,
    entries: assembly.entries })}\n`);
  const steps = [
    ['exact upstream activity, Main admission and Team settlement contracts', [
      path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run',
      'src/main/engine/openclaw/runtimeSessionStatus.targeted.native-contract.test.ts',
      'src/main/engine/openclaw/runtimeSessionStatus.targeted.test.ts',
      'tests/openclaw/runtime/goal-point-read.native-contract.test.ts',
      'tests/openclaw/runtime/extension-assembly-contract.test.ts',
      'src/main/ipc/cowork/sessions.sendAdmission.test.ts',
      'src/main/ipc/cowork/sessions.targetedEventRetry.test.ts',
      'src/main/cowork/agent-team/agentTeamLaunchCoordinator.test.ts',
      'tests/openclaw/extensions/agent-team/discussion-execution.test.ts',
      'tests/openclaw/extensions/agent-team/discussion-summary.test.ts',
      '--pool=threads', '--maxWorkers=1',
    ], 120_000],
    ['actual Main preparation, delayed native events and targeted admission', [
      'tests/openclaw/runtime/main-send-admission.native-probe.mjs', runtime,
    ], 900_000],
    ['actual Renderer main-chat wire and initial dispatch', [
      'tests/openclaw/runtime/collaboration-main-send.native-probe.mjs', runtime,
    ], 900_000],
    ['Agent Team source, direct member and real group messages', [
      'tests/openclaw/runtime/agent-team-message-paths.native-probe.mjs', runtime,
    ], 900_000],
    ['Swarm source and node note, continuation and retry', [
      'tests/openclaw/runtime/swarm-workflow-send.native-probe.mjs', runtime,
    ], 900_000],
  ];
  const results = [];
  // Native fixtures are intentionally serial: do not compete for the native
  // canonical worker's bounded commit authorization or share a user profile.
  for (const [label, command, timeout] of steps) {
    process.stdout.write(`\nCollaboration send gate: ${label}\n`);
    const startedAt = Date.now();
    const result = spawnSync(executable, command, { cwd: root, windowsHide: true,
      env: { ...process.env, OPENCLAW_SOURCE: source, OPENCLAW_TEST_UPSTREAM_ROOT: source,
        OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS: '1', OPENCLAW_REQUIRE_MANAGED_CONFIG_CONTRACTS: '1',
        OPENCLAW_TEST_NATIVE_RUNTIME_DIR: runtime }, stdio: 'inherit', timeout });
    results.push({ label, elapsedMs: Date.now() - startedAt, exitCode: result.status, signal: result.signal });
    assert.ok(!result.error && !result.signal && result.status === 0,
      `Collaboration sending gate failed: ${label}${result.error ? `: ${result.error.message}` : ''}`);
  }
  const finalAssembly = verifyCollaborationExtensionAssembly(runtime);
  assert.equal(finalAssembly.assemblySha256, assembly.assemblySha256, 'Sending evidence cannot survive source or output drift.');
  verifyOpenClawPatchManifest(runtime, { repoRoot: root, expectedVersion: app.openclaw.version, expectedTarget: target });
  process.stdout.write(`COLLABORATION_SEND_PASSED=${JSON.stringify({ sourceCommit,
    assemblySha256: assembly.assemblySha256, results,
    scope: 'Production host/controller and actual native protocol with synthetic models; excludes full desktop UI and business-model quality.' })}\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
