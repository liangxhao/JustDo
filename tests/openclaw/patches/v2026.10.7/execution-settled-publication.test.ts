import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { transformSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/_execution-settled-publication.js');
const root = path.resolve(process.env.JUSTDO_EXECUTION_PRISTINE_DIR ??
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'build/upgrade-audit/v2026.10.7/dependency-snapshot');
const filename = path.join(root, 'dist/agent-events-DwWyqfWg.mjs');
const actualNative = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined;
const pristineFixture = fs.readFileSync(path.resolve(
  'tests/openclaw/patches/v2026.10.7/execution-settled-publication.fixture.txt'), 'utf8');
const native = actualNative ?? pristineFixture;
const runtimeRoot = path.resolve(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'build/runtimes/openclaw/win-x64');
const nativeGraphRoot = path.resolve(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ??
  'build/upgrade-audit/v2026.10.7/dependency-snapshot');
const nativeNode = path.join(runtimeRoot, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const nativeGraphAvailable = fs.existsSync(path.join(nativeGraphRoot, 'package.json')) &&
  fs.existsSync(path.join(nativeGraphRoot, 'node_modules/tslog/package.json')) &&
  fs.existsSync(path.join(nativeGraphRoot, 'dist/agent-events-DwWyqfWg.mjs')) &&
  fs.existsSync(path.join(nativeGraphRoot, 'dist/agent-run-registry-B2Kia58i.mjs'));

test('requires the real native publication owner when runtime contracts are mandatory', () => {
  if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1') {
    expect(actualNative).toBeDefined();
    expect(fs.existsSync(nativeNode)).toBe(true);
    expect(nativeGraphAvailable).toBe(true);
  }
});

describe('native cancellation and execution settlement publication', () => {
  test('checks complete pristine and patched owner functions and current-shape idempotency', () => {
    const fixtureCurrent = patch.transformExecutionSettledPublication(pristineFixture, 'locked-pristine-fixture');
    expect(() => patch.assertExecutionSettledPublication(fixtureCurrent, 'locked-pristine-fixture')).not.toThrow();
    const current = patch.transformExecutionSettledPublication(native!, filename);
    expect(patch.transformExecutionSettledPublication(current, filename)).toBe(current);
    expect(() => patch.assertExecutionSettledPublication(current, filename)).not.toThrow();
    const functions = patch.__testing.names.map((name: string) => patch.__testing.extract(current, name, filename).body).join('\n');
    const compiled = transformSync(functions, {
      minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true,
    }).code;
    expect(() => patch.assertExecutionSettledPublication(compiled, 'compiled-native')).not.toThrow();
  });

  test('refuses partial or broadened admission and changed native authority before writes', () => {
    const current = patch.transformExecutionSettledPublication(native!, filename);
    for (const damaged of [
      current.replace('data.executionSettled === true', 'Boolean(data.executionSettled)'),
      current.replace('runState.terminalPublication === runState.pendingExecutionSettlementPublication', 'true'),
      current.replace('delete runState.pendingExecutionSettlementPublication;', ''),
      current.replace('if (!runState.terminalPublication)', 'if (true)'),
      current.replace('if (!resolved || hasInvalidLifecycleStartTimestamp(event.stream, event.data))', 'if (!resolved)'),
      current.replace('function reserveAgentTerminalEvent(', 'async function reserveAgentTerminalEvent('),
      current.replace('function enrichAgentEvent(', 'async function enrichAgentEvent('),
      current.replace('function reserveAgentTerminalEvent(', 'async /* trivia */ function reserveAgentTerminalEvent('),
      current.replace('function enrichAgentEvent(', 'async\n/* trivia */ function enrichAgentEvent('),
      current.replace('event.lifecycleGeneration === pendingIdentity.lifecycleGeneration', 'true'),
      current.replace('sessionId === pendingIdentity.sessionId', 'true'),
    ]) {
      expect(damaged).not.toBe(current);
      expect(() => patch.transformExecutionSettledPublication(damaged, filename)).toThrow();
      expect(() => patch.assertExecutionSettledPublication(damaged, filename)).toThrow();
    }
    const reservation = patch.__testing.extract(current, 'reserveAgentTerminalEvent', filename);
    const pristine = patch.__testing.extract(pristineFixture, 'reserveAgentTerminalEvent', filename);
    const mixed = current.slice(0, reservation.start) + pristine.body + current.slice(reservation.end);
    expect(() => patch.transformExecutionSettledPublication(mixed, filename)).toThrow();
  }, 30_000);

  test.skipIf(!actualNative || !fs.existsSync(nativeNode) || !nativeGraphAvailable)(
    'uses real native routing, registration, epoch and producer semantics', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^OPENCLAW_/i.test(key) && !/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)));
    const child = spawnSync(nativeNode, [
      path.resolve('tests/openclaw/patches/v2026.10.7/execution-settled-publication.native-probe.mjs'), root,
      nativeGraphRoot,
      ...(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ? ['--frozen-graph'] : []),
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim().split(/\r?\n/u).at(-1)!);
    expect(result.nativeVersion).toBe('2026.10.7');
    expect(result.scenarios).toHaveLength(16);
    if (process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR) {
      expect(result.evidence).toBe('strict-frozen-artifact-native-graph');
      expect(result.runtimeIdentity.runtimeRoot).toBe(fs.realpathSync(runtimeRoot));
      console.log(`PUBLICATION_NATIVE_RUNTIME_IDENTITY=${JSON.stringify(result.runtimeIdentity)}`);
    }
    expect(result.scenarios[0].captures[2]).toMatchObject({
      admitted: true, secondAdmission: false,
      data: { phase: 'error', executionSettled: true, aborted: true, stopReason: 'aborted' },
    });
  });
});
