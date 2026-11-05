import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const { __testing: { transformMain } } = require('../../../../scripts/patches/v2026.10.7/005-app-startup-task-recovery-boundary.cjs');

// Preserve the native declaration order that previously bound dispatchTarget
// instead of entry. Its route deliberately has neither startedAt nor sessionId.
const native = `async function recoverStore(params) {
  const result = {started:0, settled:0, failed:0, skipped:0};
  for (const {sessionKey, entry: loadedEntry} of params.entries) {
    let entry = loadedEntry;
    let decision = {decision:'deferred',reason:'preparation_failed',nextOwner:'main-session-recovery'};
    try {
      if (stopped()) return result;
      const dispatchTarget = {agentId:'main',sessionKey};
      const agentId = dispatchTarget.agentId;
      const resumeDedupeKey = JSON.stringify([agentId,sessionKey]);
      if (params.handledSessionKeys.has(resumeDedupeKey)) continue;
      const observed = await commitMainSessionRecovery({target:{sessionKey}});
    } finally { mainSessionRecoveryLog.info(JSON.stringify(decision)); }
  }
  return result;
}`;

type Entry = {
  sessionId: string;
  status: string;
  abortedLastRun: boolean;
  startedAt: number;
  restartRecoveryDeliveryRunId?: string;
};
type Row = { sessionKey: string; entry: Entry };
type Counts = { started: number; settled: number; failed: number; skipped: number };
type Decision = { decision: string; reason: string; nextOwner: string };
const row = (sessionKey: string, startedAt: number, status = 'running'): Row => ({
  sessionKey,
  entry: { sessionId: `${sessionKey}-native`, status, abortedLastRun: true, startedAt,
    restartRecoveryDeliveryRunId: `${sessionKey}-run` },
});

function declarations(source: string): string {
  const ast = ts.createSourceFile('recovery.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['readJustDoMainAppStartedAtMs', 'isJustDoPriorAppMainSession',
    'settleJustDoPriorAppMainSession', 'recoverStore']);
  const functions = ast.statements.filter(statement =>
    ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text));
  expect(functions).toHaveLength(4);
  return functions.map(statement => statement.getText(ast)).join('\n');
}

function fixture(source: string, initialRows: Row[], options: {
  currentRows?: Row[];
  appStartedAt?: string;
  noHostEpoch?: boolean;
} = {}) {
  const rows = structuredClone(options.currentRows ?? initialRows);
  const recovered: string[] = [];
  const decisions: Decision[] = [];
  const recover = vm.runInNewContext(declarations(source) + ';recoverStore', {
    process: { env: options.noHostEpoch ? {} : { JUSTDO_APP_STARTED_AT_MS: options.appStartedAt ?? '100' } },
    stopped: () => false,
    randomUUID: () => 'recovery-pass',
    getAgentEventLifecycleGeneration: () => 'gateway-generation',
    createCurrentProcessOwnerLookup: () => () => false,
    readSessionEntrySummariesInWorker: async () => structuredClone(options.currentRows ? initialRows : rows),
    hasMainSessionRecoveryClaim: (entry: Entry) => Boolean(entry.restartRecoveryDeliveryRunId),
    isMainRestartRecoveryTerminalOnly: () => false,
    isTerminalSessionStatus: (status: string) => ['failed', 'interrupted', 'done'].includes(status),
    isMainRestartRecoveryCandidate: (entry: Entry) => entry.abortedLastRun,
    skippedMainSessionRecoveryDecision: (reason: string) => ({
      decision: 'deferred', reason, nextOwner: 'session-owner',
    }),
    resolveRestartRecoveryDispatchTarget: ({ sessionKey }: { sessionKey: string }) => ({ agentId: 'main', sessionKey }),
    resolveSessionWorkStartBlock: () => undefined,
    canPrepareAgentSessionWorktree: () => false,
    applySessionEntryExactReplacements: async (params: { update: (entries: Row[]) => unknown }) => params.update(rows),
    buildMainSessionRecoverySettlementPatch: () => ({ restartRecoveryDeliveryRunId: undefined }),
    resolveRestartRecoveryTerminalClientRunId: () => 'terminal',
    mainSessionRecoveryLog: {
      info: (line: string) => {
        const json = line.indexOf('{');
        if (json >= 0) decisions.push(JSON.parse(line.slice(json)));
      },
      warn: (line: string) => { throw new Error(line); },
    },
    commitMainSessionRecovery: async ({ target }: { target: { sessionKey: string } }) => {
      recovered.push(target.sessionKey);
      return { entry: rows.find(item => item.sessionKey === target.sessionKey)?.entry,
        transition: { kind: 'observed', view: { status: 'inactive' } } };
    },
  }) as (params: object) => Promise<Counts>;
  const handledSessionKeys = new Set<string>();
  return { rows, recovered, decisions, run: () => recover({
    entries: structuredClone(options.currentRows ? initialRows : rows),
    handledSessionKeys, storePath: 'memory-store', storeAgentId: 'main', gatewayRuntime: {},
  }) };
}

test('settles the exact prior-host row and retains native recovery inside the current host epoch', async () => {
  const source = transformMain(native, 'fixture.mjs');
  const f = fixture(source, [row('older', 50), row('current', 150)]);

  expect(await f.run()).toMatchObject({ settled: 1, failed: 0 });
  expect(f.rows[0].entry).toMatchObject({ sessionId: 'older-native', status: 'failed', abortedLastRun: false });
  expect(f.rows[1].entry).toMatchObject({ status: 'running', abortedLastRun: true });
  expect(f.recovered).toEqual(['current']);
  expect(f.decisions[0]).toEqual({ decision: 'settled', reason: 'prior_app_interrupted', nextOwner: 'none' });
  expect(transformMain(source, 'fixture.mjs')).toBe(source);
});

test('preserves standalone native recovery without a host epoch', async () => {
  const f = fixture(transformMain(native, 'fixture.mjs'), [row('older', 50)], { noHostEpoch: true });
  expect(await f.run()).toMatchObject({ settled: 0, failed: 0 });
  expect(f.recovered).toEqual(['older']);
  expect(f.rows[0].entry.status).toBe('running');
});

test('reports unconfirmed settlement as a failed recovery attempt without broadening native status authority', async () => {
  const rows = [row('interrupted', 50, 'interrupted')];
  const f = fixture(transformMain(native, 'fixture.mjs'), rows);

  expect(await f.run()).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
  expect(f.rows).toEqual(rows);
  expect(f.recovered).toEqual([]);
  expect(f.decisions).toEqual([{ decision: 'blocked', reason: 'prior_app_settlement_unconfirmed', nextOwner: 'operator' }]);
});

test('does not retire a replacement physical session when the durable identity changes', async () => {
  const listed = [row('older', 50)];
  const currentRows = [{ ...listed[0], entry: { ...listed[0].entry, sessionId: 'replacement-native' } }];
  const f = fixture(transformMain(native, 'fixture.mjs'), listed, { currentRows });

  expect(await f.run()).toMatchObject({ settled: 0, failed: 1 });
  expect(f.rows).toEqual(currentRows);
  expect(f.recovered).toEqual([]);
});

test('supports native binding aliases, including dollar signs, without matching unrelated routing declarations', async () => {
  const aliased = native.replaceAll('loadedEntry', 'loaded$entry').replace(/\bentry\b/g, 'entry$view')
    .replace('entry$view: loaded$entry', 'entry: loaded$entry');
  const f = fixture(transformMain(aliased, 'aliases.mjs'), [row('older', 50)]);
  expect(await f.run()).toMatchObject({ settled: 1, failed: 0 });
});

test('rejects missing, ambiguous or shadowed native entry bindings', () => {
  expect(() => transformMain(native.replace('let entry = loadedEntry;', ''), 'missing.mjs')).toThrow(/entry binding/);
  expect(() => transformMain(native.replace('let entry = loadedEntry;',
    'let entry = loadedEntry; let secondEntry = loadedEntry;'), 'ambiguous.mjs')).toThrow(/entry binding/);
  expect(() => transformMain(native.replace('const dispatchTarget =',
    'let entry = {sessionId:"wrong"}; const dispatchTarget ='), 'shadowed.mjs')).toThrow(/entry binding/);
  expect(() => transformMain(native.replace('const observed =',
    'const {entry} = {entry:dispatchTarget}; const observed ='), 'destructured-shadow.mjs')).toThrow(/entry binding/);
});

test('rejects historical, partially patched and incorrectly bound current-marker artifacts', () => {
  const source = transformMain(native, 'fixture.mjs');
  const historical = /rebuild from pristine/;
  expect(() => transformMain(source.replace('await applySessionEntryExactReplacements(',
    'await applySessionEntryReplacements('), 'old-writer.mjs')).toThrow(historical);
  expect(() => transformMain(source.replace('if (isJustDoPriorAppMainSession(entry)) {',
    'if (isJustDoPriorAppMainSession(dispatchTarget)) {'), 'wrong-guard.mjs')).toThrow(historical);
  expect(() => transformMain(source.replace('sessionId: entry.sessionId,',
    'sessionId: dispatchTarget.sessionId,'), 'wrong-session.mjs')).toThrow(historical);
  expect(() => transformMain(source.replace('result.failed++;', 'result.skipped++;'),
    'old-deferred.mjs')).toThrow(historical);
  expect(() => transformMain(source.replaceAll('V2026_10_7', 'V2026_9_6'), 'old-marker.mjs')).toThrow();
});

const pristineRoot = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;
const nativeFile = 'dist/main-session-restart-recovery-BePtcRv6.mjs';

describe.skipIf(!pristineRoot)('locked native restart-recovery owner (in-memory storage only)', () => {
  function patchedNative() {
    const metadata = JSON.parse(fs.readFileSync(path.join(pristineRoot!, 'package.json'), 'utf8'));
    expect({ name: metadata.name, version: metadata.version }).toEqual({ name: 'openclaw', version: '2026.10.7' });
    const source = fs.readFileSync(path.join(pristineRoot!, nativeFile), 'utf8');
    expect(source).not.toContain('RUNTIME_APP_STARTUP_MAIN_RECOVERY_BOUNDARY');
    const patched = transformMain(source, nativeFile);
    expect(transformMain(patched, nativeFile)).toBe(patched);
    return patched;
  }

  test('retires the old exact claim once and lets current-host recovery reach native observe', async () => {
    const f = fixture(patchedNative(), [row('older', 50), row('current', 150)]);
    expect(await f.run()).toEqual({ started: 0, settled: 1, failed: 0, skipped: 1 });
    expect(f.recovered).toEqual(['current']);
    expect(f.decisions).toContainEqual(expect.objectContaining({ decision: 'settled', reason: 'prior_app_interrupted' }));

    expect(await f.run()).toMatchObject({ settled: 0, failed: 0 });
    expect(f.recovered).toEqual(['current', 'current']);
    expect(f.decisions.filter(item => item.reason === 'prior_app_interrupted')).toHaveLength(1);
  });

  test('ends an unconfirmed recovery attempt without rewriting interrupted execution or entering native dispatch', async () => {
    const rows = [row('older', 50, 'interrupted')];
    const f = fixture(patchedNative(), rows);
    expect(await f.run()).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
    expect(f.rows).toEqual(rows);
    expect(f.recovered).toEqual([]);
    expect(f.decisions[0]).toMatchObject({ decision: 'blocked', reason: 'prior_app_settlement_unconfirmed' });
  });
});
