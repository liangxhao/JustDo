import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transformSync } from 'esbuild';

const patch = require('../../../../scripts/patches/v2026.10.4/032-goal-continuation-admission.cjs');
const { createGoalContinuationRuntime } = require('../../../../src/main/openclaw/runtime/native-support/goal-continuation.mjs');
const { functionRange, parse, collect } = require('../../../../scripts/patches/v2026.10.4/prepared-read-patch-shapes.js');
const ts = require('typescript');
const { TARGETS, CONTRACT, NATIVE_ACCEPTED, NATIVE_EXPORTS, PLUGIN_EXECUTION_EXPORTS } = patch.__testing;
const artifactRoot = path.resolve('.agent-tasks/goal-continuation');
const roots: string[] = [];
const pristine = process.env.GOAL_CONTINUATION_PRISTINE_DIR;
const previousRuntime = process.env.GOAL_CONTINUATION_PREVIOUS_DIR;
const fullGatewayBundle = process.env.GOAL_CONTINUATION_BUNDLE_FILE;
const queueChunk = pristine && path.join(pristine, 'dist/store-writer-queue-Cq6rziq_.mjs');
const generationChunk = pristine && path.join(pristine, 'dist/subagent-registry.store.sqlite-DIYyRjhZ.mjs');
const cohortChunk = pristine && path.join(pristine, 'dist/subagent-requester-settle-identity-Blu5INx9.mjs');

const sources: Record<string, string> = {
  schema: 'const AgentParamsSchema = closedObject({ message: NonEmptyString, agentId: Type.Optional(NonEmptyString) });',
  preflight: `function prepareAgentRequestPreflight(params) {
    const { request } = params;
    const canUseInternalRuntimeHandoff = params.backend;
    const expectedSessionResult = { ok: true };
    if (!expectedSessionResult.ok) return rejectInvalidRequest(expectedSessionResult.error);
    return request;
  }`,
  terminal: `async function persistGatewaySessionLifecycleEvent(params) {
    const phase = params.event.data.phase, entry = params.entry;
    const eventClientRunId = params.event.clientRunId, eventRunId = params.event.runId;
    const patch = derivePersistedSessionLifecyclePatch({ entry, event: params.event });
    return patch;
  }`,
  turn: `async function prepareAgentRunDispatch(params) { try { ${NATIVE_ACCEPTED} } catch(error) { throw error; } }`,
  lock: `async function runExclusiveSessionLifecycle(params) { return await params.run(); } export ${NATIVE_EXPORTS.lock};`,
  registry: `const subagentLifecycleController = new SubagentLifecycleController({}); export ${NATIVE_EXPORTS.registry};`,
  describe: `const sessionByKeyReadHandlers = { describe() { return { session: presentation.present(record, params) }; } };`,
  private: 'const SESSION_ENTRY_PRIVATE_CLEAR_PATCH = { activeWriterRunId: undefined }; const PRIVATE_SESSION_ENTRY_KEYS = ["activeWriterRunId"];',
};

function fixture(real = false, sourceRoot = pristine) {
  fs.mkdirSync(artifactRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifactRoot, 'test-'));
  roots.push(root);
  for (const [kind, name] of Object.entries(TARGETS) as [string, string][]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), real ? fs.readFileSync(path.join(sourceRoot!, name)) : sources[kind]);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== artifactRoot) throw new Error('Invalid Goal fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class AdmissionError extends Error {
  error: any;
  constructor(error: any) { super(error.message); this.error = error; }
}

function harness() {
  let entry: any = {
    sessionId: 'session', lifecycleRevision: 'revision', lastRunId: 'before',
    goal: { id: 'goal', status: 'active', continuationTurns: 0 },
    goalContinuationTerminal: {
      runId: 'before', goalId: 'goal', sessionId: 'session', lifecycleRevision: 'revision',
      lifecycleGeneration: 'generation', executionSettled: true, yielded: false, phase: 'end',
    },
  };
  const controller = new AbortController();
  const flags = { competing: false, queue: false, handoff: false };
  let beforeCommit: (() => void | Promise<void>) | undefined;
  let lockTail = Promise.resolve();
  const lock = vi.fn(async (args: any) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { args.signal?.throwIfAborted(); return await args.run(); }
    finally { release(); }
  });
  const native = {
    admissionError: (error: any) => new AdmissionError(error), generation: () => 'generation',
    competingWork: () => flags.competing, pendingQueue: () => flags.queue,
    replyActive: () => false, nativeHandoff: () => flags.handoff,
    withLifecycleLock: lock,
    patchEntry: vi.fn(async (_scope: any, update: any, options: any) => {
      const patch = update(structuredClone(entry));
      await beforeCommit?.();
      options.workerGuard.assertCurrent();
      entry = { ...entry, ...patch };
      options.onCommitted(structuredClone(entry));
      return structuredClone(entry);
    }),
  };
  const runtime = createGoalContinuationRuntime(native);
  const params: any = {
    runId: 'candidate', lifecycleGeneration: 'generation', lifecycleStorePath: 'store', resolvedSessionKey: 'agent:a:main',
    activeSessionAgentId: 'a', getAdmittedSessionId: () => 'session',
    request: {
      idempotencyKey: 'candidate', sessionKey: 'agent:a:main',
      expectedExistingSessionId: 'session', expectedExistingSessionLifecycleRevision: 'revision',
      suppressPromptPersistence: true,
      goalContinuation: { goalId: 'goal', predecessorRunId: 'before', maxAutomaticContinuations: 25, automatic: true },
    },
    context: { chatAbortControllers: new Map(), chatQueuedTurns: new Map() },
    admission: { run: (run: any) => run(), isActive: () => true },
    signal: controller.signal, readEntry: () => entry,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const accepted: any = { runId: 'candidate', status: 'accepted', acceptedAt: 123 };
  const publish = vi.fn();
  return {
    runtime, native, params, accepted, publish, controller, flags, lock,
    entry: () => entry, replace: (value: any) => { entry = value; },
    beforeCommit: (value: () => void | Promise<void>) => { beforeCommit = value; },
    commit: () => runtime.commit(params, accepted, publish),
  };
}

function nativeAdmissionOwner() {
  const singletons = new Map();
  const context: Record<string, any> = {
    AsyncLocalStorage, createHash, randomBytes, randomUUID, performance, setImmediate,
    process: { env: {} }, isMainThread: true, threadId: 0,
    AbortController, AbortSignal, setTimeout, clearTimeout,
    resolveGlobalSingleton: (key: any, create: any) => {
      if (!singletons.has(key)) singletons.set(key, create());
      return singletons.get(key);
    },
    createDeferredCore: () => {
      let resolve!: (value?: any) => void, reject!: (error: any) => void;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    },
    createSubsystemLogger: () => ({ debug() {}, warn() {}, error() {} }),
    areDiagnosticsEnabledForProcess: () => false,
    getAgentRunLifecycleGeneration: () => 'generation',
    isGatewaySubordinateWorkAdmissionClosed: () => false,
    withPluginRuntimeGatewayContextResolver: (_resolver: any, run: any) => run(),
    bindGatewayContextResolver: () => {},
    getPluginRuntimeGatewayRequestScope: () => undefined,
    hasGatewayContextOwner: () => true,
    SQLITE_SESSION_WRITER_QUEUES: new Map(),
    safeParseJson: JSON.parse,
  };
  const evaluate = (source: string, exports: string[]) => {
    const ast = parse(source);
    const removals: any[] = ast.statements.filter((node: any) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
    for (const node of removals.filter((node: any) => ts.isImportDeclaration(node)))
      for (const name of node.importClause?.namedBindings?.elements ?? [])
        if (!(name.name.text in context)) context[name.name.text] = () => undefined;
    for (const node of removals.sort((a: any, b: any) => b.pos - a.pos))
      source = source.slice(0, node.pos) + source.slice(node.end);
    return vm.runInNewContext(`${source}\n;({ ${exports.join(', ')} });`, context);
  };
  const queue = evaluate(fs.readFileSync(queueChunk!, 'utf8'), ['runQueuedStoreWrite', 'clearStoreWriterQueuesForTest']);
  Object.assign(context, queue);
  return evaluate(fs.readFileSync(path.join(pristine!, TARGETS.lock), 'utf8'), [
    'runExclusiveSessionLifecycle', 'beginSessionWorkAdmission', 'isCompetingSessionWorkAdmissionActive',
  ]);
}

describe('native conditional Goal admission', () => {
  it('commits the existing Goal counter and exact acceptance receipt together, then publishes', async () => {
    const h = harness();
    h.publish.mockImplementation(() => {
      expect(h.entry().goal.continuationTurns).toBe(1);
      expect(h.entry().goalContinuationAccepted.runId).toBe('candidate');
    });
    await h.commit();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.accepted.goalContinuation.continuationTurns).toBe(1);
    expect(h.entry().goal.status).toBe('active');
  });

  it('replays the same candidate without executing or counting, and rejects another candidate for that predecessor', async () => {
    const h = harness();
    await h.commit();
    h.publish.mockClear();
    expect((await h.commit()).runId).toBe('candidate');
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.entry().goal.continuationTurns).toBe(1);
    h.params.runId = h.params.request.idempotencyKey = 'other-candidate';
    await expect(h.commit()).rejects.toMatchObject({ error: { details: { reason: 'stale-predecessor' } } });
    expect(h.entry().goal.continuationTurns).toBe(1);
  });

  it.each([0, 1])('enforces native automatic limit %s, including zero', async limit => {
    const h = harness();
    h.params.request.goalContinuation.maxAutomaticContinuations = limit;
    if (limit) await h.commit();
    h.replace({ ...h.entry(), lastRunId: 'next', goalContinuationTerminal: {
      ...h.entry().goalContinuationTerminal, runId: 'next',
    } });
    h.params.runId = h.params.request.idempotencyKey = 'other';
    h.params.request.goalContinuation.predecessorRunId = 'next';
    await expect(h.commit()).rejects.toMatchObject({ error: { details: { reason: 'limit-reached' } } });
    expect(h.entry().goal.continuationTurns).toBe(limit);
  });

  it.each(['competing', 'queue', 'handoff'] as const)('revalidates %s at the last writer grant', async flag => {
    const h = harness();
    h.beforeCommit(() => { h.flags[flag] = true; });
    await expect(h.commit()).rejects.toMatchObject({ error: { details: {
      code: 'GOAL_CONTINUATION_DEFERRED',
      reason: { competing: 'main-running', queue: 'queued-input', handoff: 'native-handoff' }[flag],
    } } });
    expect(h.entry().goal.continuationTurns).toBe(0);
    expect(h.entry().goalContinuationAccepted).toBeUndefined();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('preregistered Stop and Stop during commit prevent a new accepted turn', async () => {
    const first = harness();
    first.controller.abort(new Error('Stop'));
    await expect(first.commit()).rejects.toThrow('Stop');
    expect(first.native.patchEntry).not.toHaveBeenCalled();
    const second = harness();
    second.beforeCommit(() => second.controller.abort(new Error('Stop')));
    await expect(second.commit()).rejects.toThrow('Stop');
    expect(second.entry().goal.continuationTurns).toBe(0);
    expect(second.publish).not.toHaveBeenCalled();
  });

  it('holds the native lifecycle fence through the durable commit and synchronous accepted publication', async () => {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.beforeCommit(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const original = h.commit();
    await started;
    const wake = vi.fn();
    const queuedWake = h.lock({ signal: new AbortController().signal, run: wake });
    await Promise.resolve();
    expect(wake).not.toHaveBeenCalled();
    release();
    await original;
    await queuedWake;
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]);
  });

  it.each(['sessionId', 'lifecycleRevision', 'goalId'])('rejects stale exact terminal %s', async field => {
    const h = harness();
    h.entry().goalContinuationTerminal[field] = 'old';
    await expect(h.commit()).rejects.toMatchObject({ error: { details: { reason: 'predecessor-unconfirmed' } } });
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('never upgrades idle/lastRunId into settlement and preserves actual native ownership', async () => {
    const h = harness();
    delete h.entry().goalContinuationTerminal;
    await expect(h.commit()).rejects.toMatchObject({ error: { details: { reason: 'predecessor-unconfirmed' } } });
    const yielded = harness();
    yielded.entry().goalContinuationTerminal.yielded = true;
    yielded.flags.handoff = true;
    await expect(yielded.commit()).rejects.toMatchObject({ error: { details: { reason: 'native-handoff' } } });
  });

  it('admits an exactly settled collector-only yield after native owners are gone', async () => {
    const h = harness();
    delete h.entry().lastRunId;
    h.entry().lifecycleRunId = 'before';
    h.entry().activeWriterRunId = 'before';
    h.entry().goalContinuationTerminal.yielded = true;
    await h.commit();
    expect(h.entry().goal.continuationTurns).toBe(1);
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('matches a yielded writer by the exact native execution identity when its client root identity differs', async () => {
    const h = harness();
    delete h.entry().lastRunId;
    h.entry().lifecycleRunId = 'execution-before';
    h.entry().activeWriterRunId = 'execution-before';
    h.entry().goalContinuationTerminal.yielded = true;
    h.entry().goalContinuationTerminal.executionRunId = 'execution-before';
    await h.commit();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('retains a durable settled predecessor across Gateway generations with the same native incarnation', async () => {
    const h = harness();
    h.entry().goalContinuationTerminal.lifecycleGeneration = 'previous-gateway';
    expect(h.runtime.describe(h.entry()).predecessor.runId).toBe('before');
    await h.commit();
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it('rejects a candidate whose own Gateway generation retired during preparation', async () => {
    const h = harness();
    h.beforeCommit(() => { h.params.lifecycleGeneration = 'retired'; });
    await expect(h.commit()).rejects.toThrow('retired Gateway generation');
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.entry().goal.continuationTurns).toBe(0);
  });

  it('keeps unknown commit outcomes unknown instead of issuing a definite retry refusal', async () => {
    const h = harness();
    h.native.patchEntry.mockRejectedValue(new Error('worker outcome unknown'));
    await expect(h.commit()).rejects.toThrow('worker outcome unknown');
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('blocks retired pending wake commit owners and leaves collect-only rows to the collector', () => {
    const h = harness();
    const entry = { requesterSessionKey: 'agent:a:main', requesterAgentId: 'a' };
    const pending = { entries: [entry], isCurrent: () => false, ownsRetirement: () => true };
    const controller = { pendingRequesterSettleWakeCommits: new Map([[{}, pending]]) };
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map(), controller, () => [])).toBe(true);
    controller.pendingRequesterSettleWakeCommits.clear();
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map([['collector', { collect: true }]]), controller, () => [])).toBe(false);
  });

  it('retains blocked initial transfers and unfinished wake commit owners before publication', () => {
    const h = harness();
    const entry = { requesterSessionKey: 'agent:a:main', requesterAgentId: 'a' };
    const pending: any = { entries: [entry], isCurrent: () => false, ownsRetirement: () => false, initialTransfer: { blocked: true } };
    const controller = { pendingRequesterSettleWakeCommits: new Map([[{}, pending]]) };
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map(), controller, () => [])).toBe(true);
    pending.initialTransfer.blocked = false;
    pending.inFlight = Promise.resolve();
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map(), controller, () => [])).toBe(true);
    delete pending.inFlight;
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map(), controller, () => [])).toBe(false);
    expect(h.runtime.hasNativeHandoff('agent:a:main', 'a', new Map(), controller, () => [], false)).toBe(true);
  });

  it('records only exact lifecycle terminals and explicitly describes their current incarnation', () => {
    const h = harness();
    const params = { entry: h.entry(), event: { sessionId: 'session', lifecycleGeneration: 'generation', data: { executionSettled: true } } };
    expect(h.runtime.terminal(params, 'end', 'before').goalContinuationTerminal.executionSettled).toBe(true);
    expect(h.runtime.terminal({ ...params, event: { ...params.event, data: {} } }, 'end', 'before')).toEqual({});
    expect(h.runtime.terminal(params, 'start', 'new')).toEqual({ goalContinuationTerminal: undefined });
    expect(h.runtime.describe(h.entry()).predecessor.runId).toBe('before');
    h.entry().lifecycleRevision = 'new';
    expect(h.runtime.describe(h.entry()).predecessor).toBeUndefined();
  });

  it('requires backend exact-session ingress and suppressed prompt persistence', () => {
    const h = harness();
    expect(() => h.runtime.validate(h.params.request, true)).not.toThrow();
    expect(() => h.runtime.validate(h.params.request, false)).toThrow();
    expect(() => h.runtime.validate({ ...h.params.request, suppressPromptPersistence: false }, true)).toThrow();
    expect(() => h.runtime.validate({ ...h.params.request, goalContinuation: { ...h.params.request.goalContinuation, automatic: false } }, true)).toThrow();
  });
});

describe('locked Goal runtime patch boundaries', () => {
  it.skipIf(!generationChunk || !cohortChunk || !fs.existsSync(generationChunk) || !fs.existsSync(cohortChunk))
    .each(['pending', 'dispatching', 'delivery-pending', 'delivery-in-progress'])(
      'keeps the older task %s custody when a newer collector shares its child session, using native predicates', kind => {
        const source = (file: string, name: string) => functionRange(fs.readFileSync(file, 'utf8'), name).text;
        const api = vm.runInNewContext([
          ...['normalizeGeneration', 'compareSubagentRunGeneration', 'recordLatestSubagentRun'].map(name => source(generationChunk!, name)),
          source(path.join(pristine!, TARGETS.registry), 'listUnsettledRequesterChildrenInRuns'),
          source(cohortChunk!, 'hasRequesterCompletionCohort'),
          source(cohortChunk!, 'isRequesterCompletionCohortCurrent'),
          ';({ listUnsettledRequesterChildrenInRuns, hasRequesterCompletionCohort, isRequesterCompletionCohortCurrent, compareSubagentRunGeneration })',
        ].join('\n'), {
          asFiniteNumber: (value: any) => typeof value === 'number' && Number.isFinite(value) ? value : undefined,
          hasSubagentRunEnded: (entry: any) => entry.execution.status === 'terminal',
          isRetainedUnendedSubagentRun: () => true,
          getSubagentSessionStartedAt: (entry: any) => entry.execution.startedAt,
        });
        const older: any = {
          runId: 'old', taskRunId: 'task-old', createdAt: 1, generation: 1,
          childSessionKey: 'agent:a:child', childAgentId: 'a',
          requesterSessionKey: 'agent:a:main', requesterAgentId: 'a',
          expectsCompletionMessage: true, collect: false,
          execution: { status: 'terminal', endedAt: 1 },
          delivery: { status: kind === 'delivery-in-progress' ? 'in_progress' : 'pending' },
          ...(kind.startsWith('delivery-') ? {} : {
            requesterSettleWake: { status: kind, batchRunIds: ['old'], rearmGeneration: 1 },
          }),
        };
        const newer = { ...older, runId: 'new', taskRunId: 'task-new', createdAt: 2, generation: 2,
          collect: true, expectsCompletionMessage: false, requesterSettleWake: undefined };
        const runs = new Map([['old', older], ['new', newer]]);
        const latest = (key: string, matches?: (entry: any) => boolean) => [...runs.values()]
          .filter(entry => entry.childSessionKey === key && (!matches || matches(entry)))
          .sort(api.compareSubagentRunGeneration).at(-1) ?? null;
        const currentCustody = (entry: any) => api.isRequesterCompletionCohortCurrent(entry, latest);
        expect(api.listUnsettledRequesterChildrenInRuns({ requesterSessionKey: 'agent:a:main', requesterAgentId: 'a', runs })).toEqual([]);
        expect(currentCustody(older)).toBe(true);
        const h = harness();
        const controller = { pendingRequesterSettleWakeCommits: new Map() };
        const blocked = () => h.runtime.hasNativeHandoff('agent:a:main', 'a', runs, controller,
          api.listUnsettledRequesterChildrenInRuns, true, currentCustody);
        expect(blocked()).toBe(true);
        newer.taskRunId = 'task-old';
        expect(currentCustody(older)).toBe(false);
        expect(blocked()).toBe(false);
        newer.taskRunId = 'task-new';
        older.delivery.status = 'delivered';
        delete older.requesterSettleWake;
        expect(blocked()).toBe(false);
      },
    );

  it.skipIf(!queueChunk || !fs.existsSync(queueChunk))('uses the actual native identity locks to serialize human and native-wake ingress behind the count commit', async () => {
    const api = nativeAdmissionOwner();
    const h = harness();
    const target = { scope: 'store', identities: ['agent:a:main', 'session'], assertAllowed: () => {} };
    h.params.admission = await api.beginSessionWorkAdmission(target);
    h.native.withLifecycleLock = api.runExclusiveSessionLifecycle;
    h.native.competingWork = api.isCompetingSessionWorkAdmissionActive;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.beforeCommit(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    const continuing = h.commit();
    await started;
    const human = vi.fn(), wake = vi.fn();
    const nextHuman = api.beginSessionWorkAdmission({ ...target, assertAllowed: human });
    const nextWake = api.beginSessionWorkAdmission({ ...target, assertAllowed: wake });
    await Promise.resolve();
    expect(human).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    release();
    await continuing;
    const [humanLease, wakeLease] = await Promise.all([nextHuman, nextWake]);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(human.mock.invocationCallOrder[0]);
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(wake.mock.invocationCallOrder[0]);
    humanLease.release(); wakeLease.release(); h.params.admission.release();
  });

  it('rejects pristine verification and is exactly idempotent after complete source application', () => {
    const root = fixture();
    expect(() => patch.verifyPatch(root)).toThrow('missing');
    expect(patch.applyPatch(root)).toHaveLength(8);
    expect(patch.applyPatch(root)).toEqual([]);
    expect(() => patch.verifyPatch(root)).not.toThrow();
  });

  it('accepts only the exact 019 companion export block alongside the anchored original registry exports', () => {
    const root = fixture();
    fs.appendFileSync(path.join(root, TARGETS.registry), `\nexport ${PLUGIN_EXECUTION_EXPORTS};\n`);
    expect(patch.applyPatch(root)).toHaveLength(8);
    expect(patch.applyPatch(root)).toEqual([]);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    fs.appendFileSync(path.join(root, TARGETS.registry), '\nexport { unknownOwner };\n');
    const before = fs.readFileSync(path.join(root, TARGETS.registry), 'utf8');
    expect(() => patch.applyPatch(root)).toThrow('unknown native export topology');
    expect(fs.readFileSync(path.join(root, TARGETS.registry), 'utf8')).toBe(before);
  });

  it.each([false, true])('verifies the complete support and native bindings in a final bundle: syntaxMinified=%s', minifySyntax => {
    const root = fixture();
    patch.applyPatch(root);
    const fragments = Object.values(TARGETS).map((name: any) => {
      let source = fs.readFileSync(path.join(root, name), 'utf8');
      const ast = parse(source);
      const removals = ast.statements.filter((node: any) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
      for (const node of removals.reverse()) source = source.slice(0, node.pos) + source.slice(node.end);
      return source;
    });
    const source = createGoalContinuationRuntime.toString() + '\n' + fragments.join('\n').replace(/\bgoalContinuationLifecycle\b/g, 'runExclusiveSessionLifecycle');
    const bundled = transformSync(source, { loader: 'js', target: 'node24', minifySyntax }).code;
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), `// ${CONTRACT}\n${bundled}`);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    expect(patch.applyPatch(root)).toEqual([]);
    const namespaceBundle = bundled.replace(/\bType\./g, 'typebox_exports.');
    expect(() => patch.__testing.verifyBundle(namespaceBundle)).not.toThrow();
    expect(() => patch.__testing.verifyBundle(namespaceBundle.replace('goalContinuation: typebox_exports.Optional', 'goalContinuation: untrustedType.Optional'))).toThrow('Goal schema changed');
    const tree = parse(namespaceBundle);
    const clear = collect(tree, (node: any) => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'SESSION_ENTRY_PRIVATE_CLEAR_PATCH')[0];
    const statement = clear.parent.parent;
    // Remove only that declaration, including when esbuild combines const statements.
    const remaining = statement.declarationList.declarations.filter((node: any) => node !== clear);
    const replacement = remaining.length ? `const ${remaining.map((node: any) => node.getText(tree)).join(', ')};` : '';
    const shaken = namespaceBundle.slice(0, statement.getStart(tree)) + replacement + namespaceBundle.slice(statement.end);
    expect(() => patch.__testing.verifyBundle(shaken)).not.toThrow();
    expect(() => patch.__testing.verifyBundle(`${shaken}\nvoid SESSION_ENTRY_PRIVATE_CLEAR_PATCH;`)).toThrow();
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled.replace('maxAutomaticContinuations', 'untrustedLimit'));
    expect(() => patch.verifyPatch(root)).toThrow();
  });

  it.skipIf(!fullGatewayBundle)('verifies the real complete Gateway bundle without changing its bytes', () => {
    const source = fs.readFileSync(fullGatewayBundle!, 'utf8');
    patch.__testing.verifyBundle(source);
    expect(fs.readFileSync(fullGatewayBundle!, 'utf8')).toBe(source);
  }, 120_000);

  it.each(['extra-owner', 'partial-wrapper', 'missing-owner', 'stale-support'])('rejects %s before any source write', mode => {
    const root = fixture();
    if (mode === 'extra-owner') fs.writeFileSync(path.join(root, 'dist/extra.mjs'), sources.turn);
    if (mode === 'missing-owner') fs.rmSync(path.join(root, TARGETS.registry));
    if (mode === 'partial-wrapper') {
      fs.writeFileSync(path.join(root, TARGETS.turn), sources.turn.replace('params.markAgentRunAccepted(true);', 'params.markAgentRunAccepted(false);'));
    }
    if (mode === 'stale-support') {
      fs.mkdirSync(path.join(root, 'dist/native-support'));
      fs.writeFileSync(path.join(root, 'dist/native-support/goal-continuation.mjs'), 'historical');
    }
    const before = new Map(Object.values(TARGETS).filter((name: any) => fs.existsSync(path.join(root, name))).map((name: any) => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
    expect(() => patch.applyPatch(root)).toThrow();
    for (const [name, source] of before) expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe(source);
  });

  it.skipIf(!pristine)('applies the complete locked npm owner set, not synthetic owner names', () => {
    const root = fixture(true);
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toHaveLength(8);
    expect(patch.applyPatch(root)).toEqual([]);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    for (const name of Object.values(TARGETS) as string[])
      expect(() => transformSync(fs.readFileSync(path.join(root, name), 'utf8'), { loader: 'js', target: 'node24' })).not.toThrow();
  });

  it.skipIf(!previousRuntime)('composes with the actual 001..031 owner sources and preserves 019 verification', () => {
    const root = fixture(true, previousRuntime);
    expect(patch.applyPatch(root)).toHaveLength(8);
    expect(patch.applyPatch(root)).toEqual([]);
    patch.verifyPatch(root);
    const ownedExecution = require('../../../../scripts/patches/v2026.10.4/019-plugin-owned-execution.cjs');
    for (const name of [TARGETS.registry, TARGETS.turn]) {
      const file = path.join(root, name);
      const source = fs.readFileSync(file, 'utf8');
      expect(ownedExecution.__testing.transform(source, file, path.basename(TARGETS.registry))).toBe(source);
    }
  });

  it.skipIf(!pristine)('records terminal evidence only after the actual native lifecycle owner checks and never in public projections', async () => {
    const source = fs.readFileSync(path.join(pristine!, TARGETS.terminal), 'utf8');
    const transformed = patch.__testing.transform(source, ['terminal'], TARGETS.terminal);
    expect(functionRange(transformed, 'derivePersistedSessionLifecyclePatch').text).not.toContain('goalTerminal');
    expect(functionRange(transformed, 'deriveGatewaySessionLifecycleProjectionPatch').text).not.toContain('goalTerminal');
    const h = harness();
    h.entry().lifecycleRunId = 'before';
    const updates: any[] = [];
    const derive = vi.fn(() => ({ status: 'done', lastRunId: 'before', lifecycleRunId: undefined }));
    const context = {
      goalTerminal: h.runtime,
      resolveLifecyclePhase: (event: any) => event.data.phase,
      loadGatewaySessionEntry: () => ({ entry: h.entry(), canonicalKey: 'agent:a:main', storePath: 'store', agentId: 'a' }),
      isIncognitoSessionKey: () => false, parseCronRunScopeSuffix: () => ({}),
      isStaleLifecycleEventForSession: () => false,
      normalizeOptionalString: (value: any) => typeof value === 'string' ? value.trim() || undefined : undefined,
      derivePersistedSessionLifecyclePatch: derive,
      patchSessionEntryCore: async (_scope: any, update: any) => {
        const value = await update(structuredClone(h.entry())); updates.push(value); return value;
      },
      getAgentEventLifecycleGeneration: () => 'generation',
    };
    const run = vm.runInNewContext(`(async ${functionRange(transformed, 'persistGatewaySessionLifecycleEvent').text})`, context);
    const request = {
      sessionKey: 'agent:a:main',
      event: { runId: 'before', sessionId: 'session', lifecycleGeneration: 'generation', data: { phase: 'end', executionSettled: true } },
      expectedWriter: { runId: 'before', sessionId: 'session', lifecycleRevision: 'revision' },
    };
    await run(request);
    expect(updates.at(-1).goalContinuationTerminal).toMatchObject({ runId: 'before', executionSettled: true });
    await run({ ...request, expectedWriter: { ...request.expectedWriter, lifecycleRevision: 'old' } });
    expect(updates.at(-1)).toBeNull();
    derive.mockReturnValueOnce({} as any);
    await run(request);
    expect(updates.at(-1)).toBeNull();
  });

  it('projects the exact authorized lifecycle revision when the native presented row omits it', () => {
    const original = pristine ? fs.readFileSync(path.join(pristine, TARGETS.describe), 'utf8') : sources.describe;
    const transformed = patch.__testing.transform(original, ['describe'], TARGETS.describe);
    const ast = parse(transformed);
    const observation = collect(ast, (node: any) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'goalObservation' && node.expression.name.text === 'describe')[0];
    const result = observation.parent.parent;
    expect(ts.isObjectLiteralExpression(result)).toBe(true);
    const h = harness();
    const nativeRow = { key: 'agent:a:main', sessionId: 'session', goal: h.entry().goal };
    expect(nativeRow).not.toHaveProperty('lifecycleRevision');
    const record = { entry: h.entry() };
    const actual = vm.runInNewContext(`(${result.getText(ast)})`, {
      presentation: { present: () => nativeRow }, record, params: {}, goalObservation: h.runtime,
    });
    expect(actual.sessionId).toBe('session');
    expect(actual.lifecycleRevision).toBe('revision');
    expect(actual.goalContinuation.predecessor.lifecycleRevision).toBe('revision');
    expect(actual.goalContinuation.predecessor.runId).toBe('before');
  });

  it('executes the transformed final native accepted-writer seam through the real support implementation', async () => {
    const original = pristine ? fs.readFileSync(path.join(pristine, TARGETS.turn), 'utf8') : sources.turn;
    const transformed = patch.__testing.transform(original, ['turn'], TARGETS.turn);
    const range = functionRange(transformed, 'prepareAgentRunDispatch');
    const ast = parse(range.text);
    const declarations = collect(ast, (node: any) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl: any) => decl.name.getText(ast) === 'publishGoalAdmission'));
    const start = declarations[0].getStart(ast);
    const block = declarations[0].parent;
    const end = block.statements.find((node: any) => ts.isIfStatement(node) && node.expression.getText(ast) === 'replayedGoalAdmission').end;
    const seam = range.text.slice(start, end);
    const h = harness();
    h.params.assertGatewayWorkAdmissionAllowed = h.params.readEntry;
    h.params.markAgentRunAccepted = vi.fn();
    h.params.io = { emitAcceptance: vi.fn() };
    h.params.agentDedupeKeys = ['candidate'];
    const context = {
      params: h.params, goalAdmission: h.runtime, accepted: h.accepted,
      lifecycleStorePath: 'store', activeGatewayWorkAdmission: h.params.admission,
      activeRunAbort: { controller: h.controller }, assertInputOwnerCurrent: h.params.assertCurrent,
      capturedOperator: { armCancellation: vi.fn() }, followupCompletion: undefined,
      adoptedParentResume: undefined, assertInputAdmissionCurrent: undefined,
      setGatewayDedupeEntries: vi.fn(), controlUiVisible: true,
      cleanupPreaccept: vi.fn(), rejectPreaccept: vi.fn(),
      SessionMutationAuthorizationChangedError: AdmissionError,
    };
    const run = vm.runInNewContext(`(async () => { ${seam}; return 'dispatch'; })`, context);
    h.flags.handoff = true;
    await expect(run()).resolves.toBeUndefined();
    expect(context.rejectPreaccept).toHaveBeenCalledWith(expect.objectContaining({
      details: { code: 'GOAL_CONTINUATION_DEFERRED', reason: 'native-handoff' },
    }));
    expect(h.entry().goal.continuationTurns).toBe(0);
    expect(h.params.io.emitAcceptance).not.toHaveBeenCalled();
    h.flags.handoff = false;
    await expect(run()).resolves.toBe('dispatch');
    expect(h.entry().goal.continuationTurns).toBe(1);
    expect(h.params.io.emitAcceptance).toHaveBeenCalledWith([true, h.accepted, undefined], { runId: 'candidate' });
    expect(context.capturedOperator.armCancellation).toHaveBeenCalledOnce();
    await expect(run()).resolves.toBeUndefined();
    expect(h.entry().goal.continuationTurns).toBe(1);
    expect(context.cleanupPreaccept).toHaveBeenCalledOnce();
    const commit = vi.spyOn(h.runtime, 'commit');
    delete h.params.request.goalContinuation;
    const calls = h.params.io.emitAcceptance.mock.calls.length;
    const ordinary = run();
    // Native non-Goal acceptance still publishes before control returns to its caller.
    expect(h.params.io.emitAcceptance).toHaveBeenCalledTimes(calls + 1);
    expect(commit).not.toHaveBeenCalled();
    await expect(ordinary).resolves.toBe('dispatch');
  });
});
