import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { getSessionRuntimeStatus, invalidateTargetedSessionStatusChecks, type RuntimeSessionStatusContext } from './runtimeSessionStatus';

const sourceRoot = process.env.OPENCLAW_SOURCE ?? process.env.OPENCLAW_TEST_UPSTREAM_ROOT;
const required = process.env.OPENCLAW_REQUIRE_MANAGED_CONFIG_CONTRACTS === '1' ||
  process.env.OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS === '1';
if ((required || sourceRoot) && (!sourceRoot || !fs.existsSync(path.join(sourceRoot, 'src/gateway/session-utils-display.ts'))))
  throw new Error('The target native activity source is required.');

function nativeFunction(filename: string, name: string, dependencies: Record<string, unknown>) {
  const file = path.join(sourceRoot!, filename);
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(declarations, `one actual native ${name}`).toHaveLength(1);
  const body = ts.transpileModule(declarations[0].getText(tree).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), body + `\nreturn ${name};`)(...Object.values(dependencies));
}

// Full target functions, controlled registry ports. No Gateway, database or user state.
test.skipIf(!sourceRoot)('native descendant activity includes live, queued, nested and projected work and omits inactive flags', () => {
  expect(JSON.parse(fs.readFileSync(path.join(sourceRoot!, 'package.json'), 'utf8')).version).toBe('2026.10.6');
  const state = { live: false, queued: false, descendants: 0, projected: false };
  const project = nativeFunction('src/gateway/session-utils-display.ts', 'projectGatewaySessionRunState', {
    normalizeOptionalString: (value: unknown) => typeof value === 'string' && value ? value : undefined,
    isSubagentRunLive: () => state.live,
    isSubagentRunQueued: () => state.queued,
    resolveProjectedAgentRunProgressState: () => state.projected ? 'running' : undefined,
    resolveSubagentSessionStatus: () => state.queued ? 'queued' : 'running',
    isTerminalSessionStatus: () => false,
    getSubagentSessionStartedAt: () => 1,
    getSubagentSessionRuntimeMs: () => 0,
  });
  let child: unknown = null;
  const rowContext = {
    subagentRuns: { getDisplaySubagentRun: () => child, countActiveDescendantRuns: () => state.descendants },
    projectedAgentRuns: {}, projectedSubagentActivity: new Set<string>(),
  };
  const read = (entry: Record<string, unknown> = {}) => project({ key: 'root', entry, now: 5, rowContext }).fields;
  expect(read().hasActiveSubagentRun).toBeUndefined();
  state.descendants = 2;
  expect(read().hasActiveSubagentRun).toBe(true);
  state.descendants = 0;
  rowContext.projectedSubagentActivity.add('root');
  expect(read().hasActiveSubagentRun).toBe(true);
  rowContext.projectedSubagentActivity.clear();
  state.projected = true;
  expect(read({ spawnedBy: 'parent' }).hasActiveSubagentRun).toBe(true);
  state.projected = false;
  child = { runId: 'child-run', execution: {} };
  state.queued = true;
  expect(read()).toMatchObject({ hasActiveSubagentRun: true, subagentRunState: 'active' });
  state.queued = false; state.live = true;
  expect(read()).toMatchObject({ hasActiveSubagentRun: true, subagentRunState: 'active' });
  state.live = false; child = null;
  expect(read().hasActiveSubagentRun).toBeUndefined();
});

test.skipIf(!sourceRoot)('native main-run flags explicitly distinguish queued work and false liveness', () => {
  const project = nativeFunction('src/gateway/session-utils-display.ts', 'projectGatewaySessionActiveRun', {});
  expect(project({ active: true, status: 'queued' }, 'done')).toEqual({ hasActiveRun: true, status: 'queued' });
  expect(project({ active: true }, 'done')).toEqual({ hasActiveRun: true, status: 'running' });
  expect(project({ active: false }, 'done')).toEqual({ hasActiveRun: false, status: 'done' });
  expect(project(undefined, 'done').hasActiveRun).toBeUndefined();
});

test.skipIf(!sourceRoot)('native change publications distinguish a full independent root from child lineage', () => {
  const snapshot = nativeFunction('src/gateway/session-event-payload.ts', 'buildGatewaySessionSnapshot', {
    sessionEntryForkedFromParent: () => false,
    deriveSessionUnread: () => false,
  });
  const root = snapshot({ includeSession: true, sessionRow: { key: 'root', sessionId: 'root-id' } });
  expect(root.session).toMatchObject({ key: 'root', controlOwnerSessionKey: null });
  const child = snapshot({ includeSession: true, sessionRow: { key: 'grandchild', spawnedBy: 'child', controlOwnerSessionKey: 'child' } });
  expect(child.session).toMatchObject({ key: 'grandchild', spawnedBy: 'child', controlOwnerSessionKey: 'child' });
  expect(child).not.toHaveProperty('parentSessionKey', 'root');
  const checks = new Map([['root', new Set([Symbol()])], ['unrelated', new Set([Symbol()])]]);
  invalidateTargetedSessionStatusChecks(checks, root);
  expect([...checks.keys()]).toEqual(['unrelated']);
  checks.set('root', new Set([Symbol()]));
  invalidateTargetedSessionStatusChecks(checks, child);
  expect(checks.size).toBe(0);
});

test.skipIf(!sourceRoot)('the complete native row materializer preserves omitted revisions through JSON and exact event reobservation', async () => {
  expect(JSON.parse(fs.readFileSync(path.join(sourceRoot!, 'package.json'), 'utf8')).version).toBe('2026.10.6');
  const materialize = nativeFunction('src/gateway/session-utils-row.ts', 'materializeSessionRow', {
    projectSessionDeliveryFields: () => ({}), parseGroupKey: () => undefined,
    normalizeOptionalString: () => undefined, normalizeControlUiBasePath: () => '',
    isPinnableSessionEntry: () => false, sessionModelRevision: () => 'model-revision',
    sessionEntryForkedFromParent: () => false, projectSessionRowProfiles: () => ({}),
    resolveGatewaySessionKind: () => 'direct', sessionClassificationForRow: () => ({}),
    deriveSessionUnread: () => false, projectSessionProviderReview: () => undefined,
    resolveEffectiveResponseUsage: () => 'off', resolveQueueSettingsCore: () => ({ mode: 'collect' }),
    INTERNAL_MESSAGE_CHANNEL: 'webchat', resolveSessionModelOverrideSource: () => undefined,
    resolveProjectedSessionContextBudgetStatus: () => undefined, projectSessionRowChildLinks: () => undefined,
  });
  const projectActivity = nativeFunction('src/gateway/session-utils-display.ts', 'projectGatewaySessionActiveRun', {});
  const productId = 'e7d0c7d7-ef00-40b0-b7ed-645479f97739';
  const key = `agent:main:justdo:${productId}`;
  const native = (lifecycleRevision?: string) => {
    const row = materialize({ cfg: {}, key, agentId: 'main',
      entry: { sessionId: 'native-existing', updatedAt: 1, lifecycleRevision },
      thinkingProjection: {}, contextWindowProfile: {}, fastModeState: {},
      rowModelIdentity: {}, selectedModel: {}, pluginExtensions: [],
    }).row;
    return JSON.parse(JSON.stringify({ session: { ...row, ...projectActivity({ active: false }, row.status) } }));
  };
  const absentRevision = native();
  expect(absentRevision.session).not.toHaveProperty('lifecycleRevision');
  expect(native('revision').session.lifecycleRevision).toBe('revision');
  for (const changed of [false, true]) {
    let calls = 0;
    const context = {
      store: { getSession: () => ({ id: productId, agentId: 'main', cwd: '/workspace', permissionMode: 'ask', status: 'idle' }),
        getSessionRuns: () => [{ state: 'completed' }] },
      ensureGatewayClientReady: async () => {}, gatewayClientGeneration: 1,
      targetedSessionStatusChecks: new Map(), unknownSessionRuns: new Map(), disconnectedSessionIds: new Set(),
      disconnectedRecoveryPromises: new Map(), compactionInFlightSessionIds: new Set(),
      isSessionActive: () => false, goalContinuationCoordinator: { getSnapshot: () => undefined },
      gatewayClient: { request: async (method: string, params: unknown) => {
        expect([method, params]).toEqual(['sessions.describe', { key, agentId: 'main' }]);
        calls += 1;
        if (calls === 1) {
          invalidateTargetedSessionStatusChecks(context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
          return absentRevision;
        }
        return changed ? native('new-revision') : native();
      } },
    } as unknown as RuntimeSessionStatusContext;
    const result = await getSessionRuntimeStatus.call(context, productId, { targeted: true, includeSubagents: true });
    expect(result).toEqual({ known: !changed, mainRunning: false, subagentRunning: false, running: false });
    expect(calls).toBe(2);
  }
});
