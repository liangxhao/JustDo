/* eslint-disable @typescript-eslint/no-explicit-any -- Run published native owners with explicit storage and transport seams. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { functionRange, parse, collect } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const { __testing: patch } = require('../../../../scripts/patches/v2026.10.7/031-goal-continuation-admission.cjs');
const ts = require('typescript');
const runtime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? process.env.OPENCLAW_RUNTIME_DIR;
const available = runtime && fs.existsSync(path.join(runtime, patch.TARGETS.terminal));
const nativeImport = vm.compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<any>;

class AdmissionError extends Error {
  error: any;
  constructor(error: any) { super(error.message); this.error = error; }
}

async function nativeOwners() {
  const root = path.resolve(runtime!);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('2026.10.7');
  const source = fs.readFileSync(path.join(root, patch.TARGETS.terminal), 'utf8');
  expect(source).toContain('RUNTIME_GOAL_CONTINUATION_ADMISSION_V2026_10_7');
  const ast = parse(source);
  const bindings: Record<string, any> = {};
  const names = new Set([
    'normalizeOptionalString', 'isIncognitoSessionKey', 'parseCronRunScopeSuffix',
    'getAgentEventLifecycleGeneration', 'composeSessionSourceAssertion', 'recordLifecycleFence',
    'isMainRestartRecoveryCandidate', 'buildUpdatedSessionGoalStatus', 'projectMainSessionRecoveryLifecycle',
    'isAgentLifecycleYieldedWaiting', 'buildAgentRunTerminalOutcomeFromLifecycleEvent',
    'isAgentRunResumableToolTimeout', 'readAgentRunProviderReview',
  ]);
  for (const declaration of ast.statements.filter((node: any) => ts.isImportDeclaration(node))) {
    for (const binding of declaration.importClause?.namedBindings?.elements ?? []) {
      if (!names.has(binding.name.text)) continue;
      const imported = await nativeImport(pathToFileURL(path.resolve(root, 'dist', declaration.moduleSpecifier.text)).href);
      bindings[binding.name.text] = imported[(binding.propertyName ?? binding.name).text];
    }
  }
  expect(Object.keys(bindings).sort()).toEqual([...names].sort());
  const terminal = await nativeImport(pathToFileURL(path.join(root, patch.TARGETS.terminal)).href);
  const lock = await nativeImport(pathToFileURL(path.join(root, patch.TARGETS.lock)).href);
  const supportFile = path.join(root, 'dist/native-support/goal-continuation.mjs');
  expect(fs.readFileSync(supportFile, 'utf8')).toBe(fs.readFileSync(path.resolve('src/main/openclaw/runtime/native-support/goal-continuation.mjs'), 'utf8'));
  const support = await nativeImport(pathToFileURL(supportFile).href);
  const turnSource = fs.readFileSync(path.join(root, patch.TARGETS.turn), 'utf8');
  const turn = functionRange(turnSource, 'prepareAgentRunDispatch').text;
  const turnAst = parse(turn);
  const declaration = collect(turnAst, (node: any) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((decl: any) => decl.name.getText(turnAst) === 'publishGoalAdmission'))[0];
  const end = declaration.parent.statements.find((node: any) => ts.isIfStatement(node) &&
    node.expression.getText(turnAst) === 'replayedGoalAdmission').end;
  return { bindings, source, lock, support, snapshot: terminal.n,
    acceptance: turn.slice(declaration.getStart(turnAst), end) };
}

describe('published tool-timeout terminal to conditional Goal successor', () => {
  it('requires the explicitly selected frozen graph in mandatory contract runs', () => {
    if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1' || runtime) expect(available).toBe(true);
  });

  it.skipIf(!available).each(['settled', 'not-settled', 'missing-settlement', 'old-session'])(
    'composes actual native lifecycle and automatic admission for %s', async scenario => {
      const owners = await nativeOwners();
      const generation = owners.bindings.getAgentEventLifecycleGeneration();
      const scope = path.resolve('build/upgrade-audit/v2026.10.7', `goal-timeout-${randomUUID()}.sqlite`);
      const key = 'agent:a:main';
      let entry: any = { sessionId: 'session', lifecycleRevision: 'revision', lifecycleRunId: 'before',
        startedAt: 10, goal: { id: 'goal', status: 'active', updatedAt: 1, continuationTurns: 0 } };
      const controller = new AbortController();
      const lease = await owners.lock.n({ scope, identities: [key, 'session'], assertAllowed: () => {} });
      const writes: any[] = [];
      // Only persistence/publication and Gateway I/O are simulated. The complete native lifecycle
      // functions, imported outcome/recovery algorithms, conditional runtime and native lock execute.
      // This proves admission of a fresh run, not model behavior or a real tool side effect.
      const writer = vi.fn(async (_target: any, update: any, options: any) => {
        const patch = await update(structuredClone(entry));
        writes.push(patch);
        if (!patch) return undefined;
        options?.workerGuard?.assertCurrent?.();
        entry = { ...entry, ...patch };
        options?.onCommitted?.(structuredClone(entry));
        return structuredClone(entry);
      });
      const goal = owners.support.createGoalContinuationRuntime({
        generation: () => generation, admissionError: (error: any) => new AdmissionError(error),
        competingWork: owners.lock.h, pendingQueue: () => false, replyActive: () => false,
        nativeHandoff: () => false, withLifecycleLock: owners.lock.goalContinuationLifecycle, patchEntry: writer,
      });
      const context = {
        ...owners.bindings, randomUUID, goalTerminal: goal,
        deriveGatewaySessionLifecycleSnapshot: owners.snapshot,
        patchSessionEntryTarget: writer, sessionChanges: { emit: vi.fn() },
      };
      const helpers = ['isFiniteTimestamp', 'resolveLifecyclePhase', 'resolveTerminalOutcome',
        'resolveSettledLifecycleTerminalOutcome', 'derivePersistedSessionLifecyclePatch',
        'isStaleLifecycleEventForSession', 'acceptsCronRunContinuationLifecycleEvent', 'matchesProviderReviewWriter'];
      const persist = vm.runInNewContext(`${helpers.map(name => functionRange(owners.source, name).text).join('\n')}
        ;(async ${functionRange(owners.source, 'persistPreparedGatewaySessionLifecycleEvent').text})`, context);
      const event: any = { runId: 'before', clientRunId: 'before', sessionId: scenario === 'old-session' ? 'old' : 'session',
        lifecycleGeneration: generation, ts: 100,
        data: { phase: 'error', startedAt: 10, endedAt: 100, timeoutPhase: 'tool_execution',
          stopReason: 'timeout', aborted: true, executionSettled: scenario === 'settled' || scenario === 'old-session' } };
      if (scenario === 'missing-settlement') delete event.data.executionSettled;
      const request = { sessionKey: key, event,
        expectedWriter: { runId: 'before', sessionId: 'session', lifecycleRevision: 'revision' } };
      const persistEvent = (includeExpectedWriter = true) => {
        const ownerRequest = includeExpectedWriter ? request : { sessionKey: key, event };
        return persist(ownerRequest, 'error', { entry: structuredClone(entry), canonicalKey: key,
          agentId: 'a', storePath: scope, storeKeys: [key] });
      };
      const candidate = randomUUID();
      const params: any = {
        runId: candidate, lifecycleGeneration: generation, lifecycleStorePath: scope, resolvedSessionKey: key,
        activeSessionAgentId: 'a', getAdmittedSessionId: () => 'session', admission: lease, signal: controller.signal,
        context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
        readEntry: () => entry, assertCurrent: () => controller.signal.throwIfAborted(),
        request: { idempotencyKey: candidate, sessionKey: key, expectedExistingSessionId: 'session',
          expectedExistingSessionLifecycleRevision: 'revision', suppressPromptPersistence: true,
          goalContinuation: { goalId: 'goal', predecessorRunId: 'before', maxAutomaticContinuations: 25, automatic: true } },
        assertGatewayWorkAdmissionAllowed: () => entry, markAgentRunAccepted: vi.fn(),
        io: { emitAcceptance: vi.fn() }, agentDedupeKeys: [candidate],
      };
      const accepted: any = { runId: candidate, status: 'accepted', acceptedAt: 200 };
      const dispatchContext = { params, goalAdmission: goal, accepted, lifecycleStorePath: scope,
        activeGatewayWorkAdmission: lease, activeRunAbort: { controller }, assertInputOwnerCurrent: params.assertCurrent,
        capturedOperator: { armCancellation: vi.fn() }, followupCompletion: undefined, adoptedParentResume: undefined,
        assertInputAdmissionCurrent: undefined, setGatewayDedupeEntries: vi.fn(), controlUiVisible: true,
        cleanupPreaccept: vi.fn(), rejectPreaccept: vi.fn(), SessionMutationAuthorizationChangedError: AdmissionError };
      const dispatch = vm.runInNewContext(`(async () => { ${owners.acceptance}; return 'dispatch'; })`, dispatchContext);
      try {
        await persistEvent();
        if (scenario === 'settled') {
          expect(entry).toMatchObject({ status: 'interrupted', lastRunId: 'before',
            goal: { status: 'active', continuationTurns: 0 }, mainRestartRecovery: { safeToolsRequired: true },
            goalContinuationTerminal: { runId: 'before', sessionId: 'session', lifecycleRevision: 'revision',
              lifecycleGeneration: generation, phase: 'error', executionSettled: true } });
          expect(entry.lifecycleRunId).toBeUndefined();
          const terminal = structuredClone(entry.goalContinuationTerminal);
          // With no expected-writer precondition, this second call reaches 10.7's own
          // duplicate-terminal guard rather than stopping at the cleared writer identity.
          await persistEvent(false);
          expect(writes.at(-1)).toBeNull();
          expect(entry.goalContinuationTerminal).toEqual(terminal);
          expect(candidate).not.toBe(event.runId);
          await expect(dispatch()).resolves.toBe('dispatch');
          expect(entry.goal.continuationTurns).toBe(1);
          expect(entry.goalContinuationAccepted).toMatchObject({ runId: candidate, predecessorRunId: 'before' });
          expect(params.io.emitAcceptance).toHaveBeenCalledOnce();
          await expect(dispatch()).resolves.toBeUndefined();
          expect(entry.goal.continuationTurns).toBe(1);
          expect(dispatchContext.cleanupPreaccept).toHaveBeenCalledOnce();
        } else {
          expect(entry.goalContinuationTerminal).toBeUndefined();
          await expect(dispatch()).resolves.toBeUndefined();
          expect(dispatchContext.rejectPreaccept).toHaveBeenCalledWith(expect.objectContaining({
            details: { code: 'GOAL_CONTINUATION_DEFERRED', reason: 'predecessor-unconfirmed' },
          }));
          expect(entry.goal.continuationTurns).toBe(0);
          expect(params.io.emitAcceptance).not.toHaveBeenCalled();
          if (scenario === 'old-session') expect(writes[0]).toBeNull();
        }
      } finally { lease.release(); }
    }, 60000);
});
