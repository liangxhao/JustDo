'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hostTarget, targetContract } = require('../runtime/setup-node-runtime.cjs');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
assert.equal(args.length, 4,
  'Usage: node scripts/test/run-openclaw-module-contracts.cjs --runtime-dir <frozen-runtime> --source-root <target-source>');
assert.equal(args[0], '--runtime-dir');
assert.equal(args[2], '--source-root');
const runtime = fs.realpathSync(path.resolve(args[1]));
const source = fs.realpathSync(path.resolve(args[3]));
const executable = path.join(runtime, 'node-runtime', targetContract(hostTarget()).executable);
assert.ok(fs.existsSync(executable), 'The selected runtime must carry its own Node executable.');
assert.ok(fs.existsSync(path.join(source, 'packages/gateway-protocol/src/schema/agents-models-skills.ts')),
  'The target management contract source is required; skipping is not allowed.');
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = app.openclaw.version.startsWith('v') ? app.openclaw.version : `v${app.openclaw.version}`;
function sourceGit(command) {
  const result = spawnSync('git', ['-C', source, ...command], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.ok(!result.error && !result.signal && result.status === 0,
    `Cannot admit target source: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
const sourceCommit = sourceGit(['rev-parse', '--verify', 'HEAD^{commit}']);
assert.equal(sourceCommit, sourceGit(['rev-parse', '--verify', `${tag}^{commit}`]),
  'Management source HEAD must be the exact target tag.');
assert.equal(sourceGit(['status', '--porcelain', '--untracked-files=no']), '',
  'Management source must have no tracked changes.');
process.stdout.write(`MODULE_CONTRACT_SOURCE=${JSON.stringify({ tag, commit: sourceCommit })}\n`);

// Each native probe independently admits the immutable manifest/current recipe and exact Node.
// The source-contract step is deliberately separate from artifact behavior evidence.
const steps = [
  ['native protocol requests', ['tests/openclaw/runtime/module-api-protocol.native-smoke.mjs', runtime]],
  ['Main startup config, native schema, legacy rules and lifecycle policy', [
    path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run', 'tests/openclaw/runtime/managed-config-native-schema.test.ts',
    'tests/openclaw/runtime/runtime-bundled-dependencies-native-contract.test.ts',
    'src/shared/app/shutdownPolicy.test.ts',
    'tests/openclaw/runtime/workspace-preflight-native-contract.test.ts',
    '--pool=threads', '--maxWorkers=1',
  ]],
  ['all local extensions register with the native SDK', ['tests/openclaw/runtime/local-extension-registration.native-smoke.mjs', runtime]],
  ['native worktree maintenance receipts', ['tests/openclaw/runtime/worktree-maintenance-receipts.native-probe.mjs', runtime]],
  ['native OpenAI transcription transport', ['tests/openclaw/runtime/openai-transcription.native-smoke.mjs', runtime]],
  ['native Workshop files, versions and SQLite ownership', ['tests/openclaw/runtime/workshop-library.native-probe.mjs', runtime]],
  ['management source contracts and retired handlers', [
    path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run', 'tests/openclaw/runtime/management-protocol-native.test.ts',
    'src/main/engine/openclaw/runtimeSessionStatus.targeted.native-contract.test.ts',
    '--pool=threads', '--maxWorkers=1',
  ]],
  ['Workboard native handlers and SQLite adapter', [
    path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run', '--config', 'scripts/workboard-upstream.vitest.config.mts',
    '--pool=threads', '--maxWorkers=1',
  ]],
  ['native all-data database schema maintenance and ownership', [
    'tests/openclaw/runtime/native-database-upgrade.native-probe.mjs', runtime, source,
  ], 600_000],
  ['real Electron Main native database archive admission', [
    'tests/openclaw/runtime/native-database-identity.electron-probe.cjs', runtime,
  ]],
  ['native workspace readiness contracts and actual Main response correlation', [
    'tests/openclaw/runtime/workspace-preflight.native-probe.cjs', runtime, source,
  ]],
  ['native offline canonical preparation and durable session proof', [
    'tests/openclaw/runtime/native-canonical-preparation.native-probe.mjs', runtime,
  ], 600_000],
  ['all Team and Swarm user-message paths', [
    'scripts/test/run-collaboration-send-contracts.cjs', '--runtime-dir', runtime, '--source-root', source,
  ], 3_600_000],
];
for (const [label, command, timeout = 240_000] of steps) {
  process.stdout.write(`\nModule contract gate: ${label}\n`);
  const result = spawnSync(executable, command, {
    cwd: root,
    env: { ...process.env, OPENCLAW_RUNTIME: runtime, OPENCLAW_TEST_NATIVE_RUNTIME_DIR: runtime, OPENCLAW_SOURCE: source,
      OPENCLAW_TEST_UPSTREAM_ROOT: source, OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS: '1',
      OPENCLAW_REQUIRE_MANAGED_CONFIG_CONTRACTS: '1', OPENCLAW_REQUIRE_BUNDLED_DEPENDENCIES: '1' },
    windowsHide: true,
    stdio: 'inherit',
    timeout,
  });
  if (result.error || result.signal || result.status !== 0) {
    process.stderr.write(`Module contract gate failed: ${label}${result.error ? `: ${result.error.message}` : ''}\n`);
    process.exit(result.status || 1);
  }
}
process.stdout.write('\nAll module contract gates passed.\n');
