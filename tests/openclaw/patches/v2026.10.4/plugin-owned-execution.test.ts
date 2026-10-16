import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.4/019-plugin-owned-execution.cjs');
const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;

function harness() {
  const runs = new Map<string, any>();
  const stored = new Map<string, any>();
  let epoch = 'epoch-one';
  let session = {
    sessionId: 'session-one',
    lifecycleRevision: 'revision-one',
    pluginOwnerId: 'swarm-workflow',
  };
  const sameOwner = (a: any, b: any) => a && b && a.runId === b.runId && a.childSessionKey === b.childSessionKey && a.generation === b.generation;
  const persist = vi.fn(async (ids: string[], plan: (rows: Map<string, any>) => any, options: any) => {
    options.assertCurrent();
    const rows = new Map(ids.map(id => [id, structuredClone(runs.get(id))]));
    const planned = plan(rows);
    await Promise.resolve();
    options.assertCurrent();
    for (const [id, record] of planned.postimages ?? []) {
      stored.set(id, structuredClone(record));
      runs.set(id, structuredClone(record));
    }
    if (planned.postimages?.size) options.onPublished?.(planned.postimages);
  });
  const context = vm.createContext({
    subagentRuns: runs,
    structuredClone,
    isDeepStrictEqual: (a: unknown, b: unknown) =>
      isDeepStrictEqual(structuredClone(a), structuredClone(b)),
    SubagentRegistryWriteError: class extends Error {
      constructor(
        readonly outcome: string,
        cause: Error,
        readonly publication: string,
      ) {
        super(cause.message);
      }
    },
    loadSubagentSessionEntry: () => session,
    getAgentEventLifecycleGeneration: () => epoch,
    buildAgentRunTerminalOutcomeFromLifecycleEvent: (data: any) => data,
    classifySubagentTerminalOutcome: (event: any) =>
      event.data?.aborted
        ? 'cancellation'
        : event.phase === 'error' || event.data?.error
          ? 'error'
          : 'success',
    captureOpenClawStateWorkerContext: () => ({ admission: 'native' }),
    mutateSubagentRuns: persist,
    isSameSubagentRunOwner: sameOwner,
    getCurrentSubagentRunOwner: (rows: Map<string, any>, observed: any) => sameOwner(rows.get(observed.runId), observed) ? rows.get(observed.runId) : undefined,
    persistSubagentRunsOrThrow: (...ids: string[]) => {
      for (const id of ids) stored.set(id, structuredClone(runs.get(id)));
    },
    prepareSubagentRunsByRunIds: async (ids: string[]) => ({
      consume: (fn: any) => ({
        ready: true,
        value: fn(new Map(ids.map(id => [id, runs.get(id) ?? stored.get(id)]))),
      }),
    }),
  });
  vm.runInContext(
    patch.__testing.testingHelperSource +
      '\nObject.assign(globalThis, justDoPluginExecutionBindings);',
    context,
  );
  const run = (id = 'run-one') => {
    const record = {
      runId: id,
      generation: 1,
      childSessionKey: 'agent:main:subagent:fixture',
      justDoPluginExecution: {
        ...context.justDoCreatePluginExecution({
          pluginId: 'swarm-workflow',
          childSessionKey: 'agent:main:subagent:fixture',
          managedToolsLifetime: 'run',
        }),
        epoch,
        acceptedAt: 10,
        executionSettled: false,
        cleanupSettled: false,
      },
    };
    runs.set(id, record);
    stored.set(id, structuredClone(record));
    return record;
  };
  return {
    context,
    runs,
    stored,
    persist,
    run,
    setEpoch: (value: string) => {
      epoch = value;
    },
    resetSession: () => {
      session = { ...session, sessionId: 'replacement', lifecycleRevision: 'replacement-revision' };
    },
  };
}

describe('exact plugin execution evidence', () => {
  it('requires trusted plugin and native session ownership rather than labels', async () => {
    const h = harness();
    const record = h.run();
    record.label = 'plugin:other';
    await expect(h.context.justDoDescribePluginRun('run-one', 'other')).rejects.toThrow(
      'does not own',
    );
    expect(() =>
      h.context.justDoCreatePluginExecution({
        pluginId: 'other',
        childSessionKey: record.childSessionKey,
        managedToolsLifetime: 'run',
      }),
    ).toThrow('owned');
    await expect(h.context.justDoDescribePluginRun('run-one', undefined)).rejects.toThrow(
      'trusted plugin',
    );
  });

  it('preserves native follow-up behavior unless managed lifetime was selected', () => {
    const h = harness();
    expect(
      h.context.justDoCreatePluginExecution({ pluginId: 'ordinary', childSessionKey: 'ordinary' }),
    ).toBeUndefined();
    expect(() => h.context.justDoCreatePluginExecution({ managedToolsLifetime: 'run' })).toThrow(
      'trusted plugin',
    );
  });

  it('classifies direct native cancellation as cancellation even without SDK cancel', async () => {
    const h = harness();
    const record = h.run();
    await h.context.justDoObservePluginLifecycle(record, {
      data: { phase: 'end', aborted: true, stopReason: 'rpc', executionSettled: true },
    });
    expect((await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).outcome).toBe(
      'cancelled',
    );
  });

  it('records actual start and joins distinct execution and cleanup boundaries', async () => {
    const h = harness();
    const record = h.run();
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    h.context.justDoRegisterManagedToolCleanup(
      { runId: 'run-one', sessionId: 'session-one', registerRunCleanup: () => {} },
      record.childSessionKey,
      { acquireScopeCleanup: () => () => pending },
      async () => {},
    );
    expect((await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).state).toBe(
      'accepted',
    );
    await h.context.justDoObservePluginLifecycle(record, {
      data: { phase: 'start', startedAt: 20 },
    });
    await h.context.justDoObservePluginLifecycle(record, {
      data: { phase: 'end', endedAt: 25, executionSettled: false },
    });
    expect(
      (await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).executionSettled,
    ).toBe(false);
    const ending = h.context.justDoObservePluginLifecycle(record, {
      data: { phase: 'end', endedAt: 30, executionSettled: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).toMatchObject({
      executionStartedAt: 20,
      executionSettled: true,
      cleanupSettled: false,
    });
    release();
    await ending;
    await h.context.justDoFinishManagedRun('run-one');
    expect(await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).toMatchObject({
      state: 'settled',
      executionEndedAt: 30,
      cleanupSettled: true,
    });
    await h.context.justDoObservePluginLifecycle(record, {
      data: { phase: 'error', executionSettled: false },
    });
    expect(
      (await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).executionSettled,
    ).toBe(true);
    expect(h.persist.mock.calls[0][2].context).toEqual({ admission: 'native' });
  });

  it('does not accept aliases or missing evidence as proof of settlement', async () => {
    const h = harness();
    h.run();
    h.stored.set('alias', h.stored.get('run-one'));
    expect(await h.context.justDoDescribePluginRun('alias', 'swarm-workflow')).toEqual({
      runId: 'alias',
      state: 'unknown',
    });
    expect(await h.context.justDoDescribePluginRun('missing', 'swarm-workflow')).toEqual({
      runId: 'missing',
      state: 'unknown',
    });
    h.setEpoch('epoch-two');
    expect((await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).state).toBe(
      'unknown',
    );
  });

  it('refuses cancellation after session rotation or when a newer run owns it', async () => {
    const h = harness();
    h.run();
    h.run('newer');
    await expect(h.context.justDoPreparePluginCancel('run-one', 'swarm-workflow')).rejects.toThrow(
      'Another execution',
    );
    h.runs.delete('newer');
    const cancel = await h.context.justDoPreparePluginCancel('run-one', 'swarm-workflow');
    h.resetSession();
    expect(() => cancel.assertCurrent()).toThrow('changed');
    await expect(h.context.justDoPreparePluginCancel('run-one', 'swarm-workflow')).rejects.toThrow(
      'uncertain',
    );
  });

  it('joins local supervisor extinction and exec finalization; propagates cleanup failure', async () => {
    const h = harness();
    h.run();
    const callbacks: Array<() => Promise<void>> = [];
    let finish: () => void = () => {};
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const cleanup = vi.fn(() => pending);
    const supervisor = { acquireScopeCleanup: vi.fn(() => cleanup) };
    const wait = vi.fn(async () => {});
    const options = {
      runId: 'run-one',
      sessionId: 'session-one',
      registerRunCleanup: (fn: any) => callbacks.push(fn),
    };
    h.context.justDoRegisterManagedToolCleanup(
      options,
      'agent:main:subagent:fixture',
      supervisor,
      wait,
    );
    expect(supervisor.acquireScopeCleanup).toHaveBeenCalledWith('agent:main:subagent:fixture', {
      processTree: 'owned-only',
    });
    let ended = false;
    const joining = callbacks[0]().then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    finish();
    await joining;
    expect(wait).toHaveBeenCalledOnce();
    expect(() =>
      h.context.justDoRegisterManagedToolCleanup(options, 'another', supervisor, wait),
    ).toThrow('does not match');
    const failed: Array<() => Promise<void>> = [];
    h.context.justDoRegisterManagedToolCleanup(
      { ...options, registerRunCleanup: (fn: any) => failed.push(fn) },
      'agent:main:subagent:fixture',
      {
        acquireScopeCleanup: () => async () => {
          throw new Error('still alive');
        },
      },
      wait,
    );
    await expect(failed[0]()).rejects.toThrow('still alive');
    h.runs.get('run-one').justDoPluginExecution.executionSettled = true;
    await expect(h.context.justDoFinishManagedRun('run-one')).rejects.toThrow('still alive');
    expect(
      (await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).cleanupSettled,
    ).toBe(false);
  });

  it('keeps failed persistence out of accepted settlement evidence', async () => {
    const h = harness();
    h.run().justDoPluginExecution.executionSettled = true;
    h.persist.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(h.context.justDoFinishManagedRun('run-one')).rejects.toThrow('disk unavailable');
    expect(
      (await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).cleanupSettled,
    ).toBe(false);
  });

  it('publishes immutable native postimages without overwriting unrelated row fields', async () => {
    const h = harness();
    const before = h.run();
    Object.freeze(before.justDoPluginExecution);
    Object.freeze(before);
    h.runs.set('run-one', { ...structuredClone(before), nativeOutcome: 'new-terminal-authority' });
    await h.context.justDoFinishManagedRun('run-one');
    expect(before.justDoPluginExecution.cleanupSettled).toBe(false);
    expect(h.runs.get('run-one').justDoPluginExecution.cleanupSettled).toBe(true);
    expect(h.stored.get('run-one').nativeOutcome).toBe('new-terminal-authority');
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it('does not retry unknown commits or accept an ACK without publication', async () => {
    const h = harness();
    h.run();
    h.persist.mockRejectedValueOnce(Object.assign(new Error('lost ACK'), { outcome: 'unknown' }));
    await expect(h.context.justDoFinishManagedRun('run-one')).rejects.toThrow('lost ACK');
    expect(h.persist).toHaveBeenCalledTimes(1);
    h.persist.mockResolvedValueOnce(undefined);
    await expect(h.context.justDoFinishManagedRun('run-one')).rejects.toThrow('superseded');
    expect(h.persist).toHaveBeenCalledTimes(2);
    expect(
      (await h.context.justDoDescribePluginRun('run-one', 'swarm-workflow')).cleanupSettled,
    ).toBe(false);
  });

  it('rechecks epoch and session custody at ACK publication', async () => {
    const h = harness();
    h.run();
    h.persist.mockImplementationOnce((_ids, _plan, callbacks) =>
      Promise.resolve().then(() => {
        h.setEpoch('replacement-epoch');
        callbacks.assertCurrent();
      }),
    );
    await expect(h.context.justDoFinishManagedRun('run-one')).rejects.toThrow('original owner');
    expect(h.runs.get('run-one').justDoPluginExecution.cleanupSettled).toBe(false);
  });

  it('rejects unsupported actual execution paths without changing ordinary runs', () => {
    const h = harness();
    h.run();
    expect(() => h.context.justDoRequireManagedHarness('run-one', { id: 'cli-alias' })).toThrow(
      'local OpenClaw',
    );
    expect(h.context.justDoRequireManagedHarness('ordinary', { id: 'cli' })).toEqual({ id: 'cli' });
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([['session-one', { state: 'active', mode: 'worker-turn' }]]),
      },
    };
    expect(() =>
      h.context.justDoAssertManagedPlacement(true, context, 'session-one', 'openclaw'),
    ).toThrow('remote workers');
    expect(() =>
      h.context.justDoAssertManagedPlacement(false, context, 'session-one', 'cli'),
    ).not.toThrow();
    expect(() =>
      h.context.justDoValidateManagedExecPolicy('run-one', { host: 'node' }, false),
    ).toThrow('local Gateway');
    expect(() => h.context.justDoValidateManagedExecPolicy('run-one', {}, true)).toThrow(
      'local Gateway',
    );
  });

  it('leaves unselected tool sessions unchanged', () => {
    const h = harness();
    const supervisor = { acquireScopeCleanup: vi.fn() };
    h.context.justDoRegisterManagedToolCleanup(
      { runId: 'ordinary' },
      'ordinary',
      supervisor,
      vi.fn(),
    );
    expect(supervisor.acquireScopeCleanup).not.toHaveBeenCalled();
  });
});

describe.skipIf(!pristine)('locked native dist topology', () => {
  it('transforms every native, recovery and minified worker copy idempotently', () => {
    const dist = path.join(pristine!, 'dist');
    const files: string[] = [];
    const pending = [dist];
    while (pending.length) {
      const dir = pending.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (/\.[cm]?js$/.test(entry.name)) files.push(file);
      }
    }
    const registry = files.find(
      f =>
        path.dirname(f) === dist &&
        fs.readFileSync(f, 'utf8').includes('function createSubagentRegistrationRecord(') &&
        !f.endsWith('package-update-activation-recovery.mjs'),
    )!;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (!patch.__testing.signatures.some((name: string) => source.includes(`function ${name}(`)))
        continue;
      const changed = patch.__testing.transform(source, file, path.basename(registry));
      expect(changed).not.toBe(source);
      expect(patch.__testing.transform(changed, file, path.basename(registry))).toBe(changed);
      expect(() =>
        patch.__testing.transform(
          changed.replace('_V2026_10_4', '_V2026_9_6'),
          file,
          path.basename(registry),
        ),
      ).toThrow();
    }
  }, 120_000);
});

const seamFixture = `
function persistSubagentRuns() {}
function getCodeModeExecBeforeHookMetadata(params) { return undefined; }
function createSubagentRegistrationRecord(params, context) { return normalizeSubagentRunState({ runId: params.runId }); }
async function registerPluginSubagentRunFromGateway(params) {
  params.assertCurrent();
  if (adoptPausedSubagentRunForFollowUp({ childSessionKey: params.childSessionKey, task: params.task })) return;
  await registerSubagentRun({ cleanup: 'keep', expectsCompletionMessage: false });
}
function createSubagentRegistryListener(config) { return async evt => {
  const phase = evt.data?.phase; const entry = config.runs.get(evt.runId);
  if (phase === 'start') return;
}; }
async function executeAgentRun(params) { try { await execute(params); } finally { release(); } }
async function prepareAgentRunDispatch(params) { const { resolvedRuntime } = resolveAgentRunAdmissionModel(params); await params.acquireGatewayWorkAdmission(); }
function dispatchAgentRunFromGateway(params) { const invoke = () => agentCommandFromGatewayIngress(params); return invoke(); }
function runAgentAttempt(params) { const cli = params.harness ? { useCliExecution: false } : resolveRunEntryCliRuntime(params.provider); return cli; }
function resolveEmbeddedRunModelSetup(params) { const selected = selectAgentHarness(params.runParams); return selected; }
function selectEmbeddedRunHarness(params) { const selected = selectAgentHarness(params.runParams); return selected; }
function selectEmbeddedRunHarnessForPreparedAttempts(params) { const selected = selectAgentHarnessForPreparedModelProviders(params.runParams); return selected; }
function prepareEmbeddedRunRuntime(params) { let selected = params.agentHarness; selected = selectNext(); return selected; }
function createSyntheticPluginRuntimeClient(options) { return { internal: { syntheticClient: true } }; }
function resolveInProcessGatewayDispatch(method, params, options) { const client = createSyntheticPluginRuntimeClient({ agentRunTracking: true }); return mergePluginRuntimeClientInternal(client, options ? { native: true } : undefined); }
function createGatewaySubagentRuntime(resolveGatewayContext, overridePolicies, runtimeLifetime) { return {
  async run(request) { const params = { ...request }; return await dispatchGatewayMethodInProcess('agent', { message: params.message }, { native: true }); },
  waitForRun: wait, deleteSession: remove
}; }
function createOpenClawCodingToolsInternal(options) { const scope = resolveProcessToolScopeKey(options); if (options.oneShotCliRun && options.registerRunCleanup) nativeCleanup(); const policy = projectEffectiveExecPolicy({}); return createCoreCodingTools({}); }
function createUnavailableSubagentRuntime() { return { waitForRun: unavailable }; }
function createDeferredGatewaySubagentRuntime() { return { waitForRun: params => runtime.waitForRun(params) }; }
function createPluginRuntimeResolver(state) { return { waitForRun: params => runWithPluginScope(() => runtime.waitForRun(params)) }; }
function registerIngress(params) { register({ pluginId: normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId), task: params.task }); }
`;

describe('public execution capability preflight', () => {
  it('treats native, SDK, bundle and support as one current or pristine capability', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-execution-preflight-'));
    const registry = 'subagent-registry-fixture.mjs';
    const declaration = 'type SubagentRunParams = {\n};\ntype SubagentRuntime = {\n    waitForRun: (params: SubagentWaitParams) => Promise<AgentWaitResult>;\n};\ntype PluginHookToolKind = "code_mode_exec";';
    const originals: Record<string, string> = { ['dist/' + registry]: seamFixture };
    for (let i = 0; i < 5; i++) originals[`dist/sdk-${i}.d.ts`] = declaration;
    const snapshot = () => {
      const result: Record<string, string> = {};
      const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else result[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
        }
      };
      visit(root);
      return result;
    };
    const write = (contents: Record<string, string>) => {
      for (const [file, content] of Object.entries(contents)) fs.writeFileSync(path.join(root, file), content);
    };
    const refused = () => {
      const before = snapshot();
      expect(() => patch.applyPatch(root)).toThrow();
      expect(snapshot()).toEqual(before);
    };
    try {
      fs.mkdirSync(path.join(root, 'dist'));
      write(originals);
      expect(patch.applyPatch(root)).toHaveLength(6);
      expect(patch.verifyPatch(root)).toEqual([]);
      expect(patch.applyPatch(root)).toEqual([]);
      const current = snapshot();
      for (const file of Object.keys(originals)) {
        write(current);
        write({ [file]: originals[file] });
        refused();
      }
      write(current);
      const support = path.join(root, 'dist/native-support/plugin-owned-execution.mjs');
      fs.unlinkSync(support);
      refused();
      write(current);
      write(originals);
      refused();
      write(current);
      write({ 'dist/sdk-4.d.ts': current[path.join('dist', 'sdk-4.d.ts')].replace('type PluginHookToolKind = "code_mode_exec" | "code_mode_wait";', 'type PluginHookToolKind = "code_mode_exec";') });
      refused();
      write(current);
      const bundled = require('esbuild').transformSync(
        patch.__testing.testingHelperSource.split('\nconst justDoPluginExecutionBindings')[0] + '\n' + current[path.join('dist', registry)].replace(/import \{ createPluginOwnedExecutionRuntime \} from "[^"]+";/, ''),
        { target: 'node24', minifyWhitespace: true, legalComments: 'none' },
      ).code;
      fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundled);
      expect(patch.verifyPatch(root)).toEqual([]);
      expect(patch.applyPatch(root)).toEqual([]);
      write(originals);
      fs.unlinkSync(support);
      refused();
      write(current);
      fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), seamFixture);
      refused();
      fs.unlinkSync(path.join(root, 'gateway-bundle.mjs'));
      fs.unlinkSync(support);
      write(originals);
      write({ 'dist/sdk-4.d.ts': declaration.replace('waitForRun:', 'changed:') });
      refused();
      expect(fs.existsSync(support)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('current execution seam custody', () => {
  const file = 'execution-seams.mjs';
  const registry = 'subagent-registry-fixture.mjs';
  const current = patch.__testing.transform(seamFixture, file, registry);
  const mutateFunction = (name: string, mutate: (body: string) => string) => {
    let changed = false;
    const value = patch.__testing.editFunction(current, name, (body: string) => {
      const next = mutate(body);
      changed = next !== body;
      return next;
    });
    expect(changed).toBe(true);
    expect(() => patch.__testing.transform(value, file, registry)).toThrow();
  };
  it('rebuilds every current seam without retaining a pristine function baseline', () => {
    expect(patch.__testing.transform(current, file, registry)).toBe(current);
    const nativeChange = current.replace(
      'nativeCleanup();',
      'nativeCleanup(); otherNativeCleanup();',
    );
    expect(patch.__testing.transform(nativeChange, file, registry)).toBe(nativeChange);
  });
  it('recognizes bundled syntax and independent method-local alpha renaming', () => {
    let renamed = current;
    for (const name of patch.__testing.signatures)
      renamed = patch.__testing.editFunction(renamed, name, (body: string) =>
        body
          .replace(/\bparams\b/g, 'nativeParams')
          .replace(/(?<!\.)\bcontext\b(?!\s*:)/g, 'nativeContext'),
      );
    expect(patch.__testing.transform(renamed, file, registry)).toBe(renamed);
    const bundled = require('esbuild').transformSync(
      current.replace(
        /import \{ createPluginOwnedExecutionRuntime \} from "[^"]+";/,
        patch.__testing.testingHelperSource.split('\nconst justDoPluginExecutionBindings')[0],
      ),
      {
        target: 'node24',
        minifySyntax: false,
        minifyWhitespace: true,
        minifyIdentifiers: false,
      },
    ).code;
    expect(patch.__testing.transform(bundled, 'gateway-bundle.mjs', registry)).toBe(bundled);
    const initialized = bundled.replace(/const (justDoPluginExecutionBindings\d*)\s*=/,
      'let $1; $1 =');
    expect(initialized).not.toBe(bundled);
    expect(patch.__testing.transform(initialized, 'gateway-bundle.mjs', registry)).toBe(initialized);
  });
  it.each([
    [
      'getCodeModeExecBeforeHookMetadata',
      (body: string) => body.replace('CODE_MODE_WAIT_TOOL_NAME', 'CODE_MODE_EXEC_TOOL_NAME'),
    ],
    [
      'createSubagentRegistrationRecord',
      (body: string) => body.replace('executionSettled: false', 'executionSettled: true'),
    ],
    [
      'registerPluginSubagentRunFromGateway',
      (body: string) =>
        body.replace('justDoCreatePluginExecution(params)', 'justDoCreatePluginExecution(other)'),
    ],
    [
      'registerPluginSubagentRunFromGateway',
      (body: string) =>
        body.replace('justDoPluginExecution ? false', 'justDoPluginExecution ? true'),
    ],
    [
      'createSubagentRegistryListener',
      (body: string) =>
        body.replace(
          'await justDoObservePluginLifecycle(',
          'void 0 && await justDoObservePluginLifecycle(',
        ),
    ],
    [
      'executeAgentRun',
      (body: string) =>
        body.replace(
          'await justDoCloseManagedRun(params.runId)',
          'void 0 && await justDoCloseManagedRun(params.runId)',
        ),
    ],
    [
      'prepareAgentRunDispatch',
      (body: string) =>
        body.replace('justDoAssertManagedPlacement(true,', 'justDoAssertManagedPlacement(false,'),
    ],
    [
      'dispatchAgentRunFromGateway',
      (body: string) =>
        body.replace(
          'justDoManagedRunEnabled(params.runId)',
          'justDoManagedRunEnabled(other.runId)',
        ),
    ],
    [
      'runAgentAttempt',
      (body: string) =>
        body.replace(
          'justDoRequireManagedHarness(params.runId,',
          'justDoRequireManagedHarness(other.runId,',
        ),
    ],
    [
      'resolveEmbeddedRunModelSetup',
      (body: string) => body.replace('params.runParams.runId', 'other.runId'),
    ],
    [
      'selectEmbeddedRunHarness',
      (body: string) => body.replace('params.runParams.runId', 'other.runId'),
    ],
    [
      'selectEmbeddedRunHarnessForPreparedAttempts',
      (body: string) => body.replace('params.runParams.runId', 'other.runId'),
    ],
    [
      'prepareEmbeddedRunRuntime',
      (body: string) => body.replace('params.runParams.runId', 'other.runId'),
    ],
    [
      'createSyntheticPluginRuntimeClient',
      (body: string) =>
        body.replace('justDoManagedToolsLifetime: "run"', 'justDoManagedToolsLifetime: "session"'),
    ],
    [
      'resolveInProcessGatewayDispatch',
      (body: string) =>
        body.replace(
          'justDoManagedToolsLifetime: options?.justDoManagedToolsLifetime',
          'justDoManagedToolsLifetime: "run"',
        ),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) => body.replace('request.timeoutSeconds < 0', 'request.timeoutSeconds < -1'),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace('Math.min(params.timeoutSeconds || cap, cap)', 'params.timeoutSeconds || cap'),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) => body.replace('params.assertCurrent?.();', ''),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace('pluginRuntimeOwnerId: pluginId', 'pluginRuntimeOwnerId: "other-plugin"'),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace('runId: params.runId, clearQueued:', 'runId: "other-run", clearQueued:'),
    ],
    ['createGatewaySubagentRuntime', (body: string) => body.replace('owned.assertCurrent();', '')],
    [
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace(
          'getInProcessGatewayRequestContext(justDoGatewayResolver)',
          'getInProcessGatewayRequestContext(overridePolicies)',
        ),
    ],
    [
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace(
          'justDoGatewayLifetime?.throwIfAborted()',
          'runtimeLifetime?.throwIfAborted()',
        ),
    ],
    [
      'createOpenClawCodingToolsInternal',
      (body: string) =>
        body.replace(
          'justDoRegisterManagedToolCleanup(',
          'void 0 && justDoRegisterManagedToolCleanup(',
        ),
    ],
    [
      'createOpenClawCodingToolsInternal',
      (body: string) =>
        body.replace(
          'justDoValidateManagedExecPolicy(options?.runId,',
          'justDoValidateManagedExecPolicy(other.runId,',
        ),
    ],
    [
      'createOpenClawCodingToolsInternal',
      (body: string) => body.replace('host:"gateway"', 'host:"node"'),
    ],
    [
      'createUnavailableSubagentRuntime',
      (body: string) => body.replace('describeRun: unavailable', 'describeRun: unrelated'),
    ],
    [
      'createDeferredGatewaySubagentRuntime',
      (body: string) => body.replace('.describeRun(params)', '.waitForRun(params)'),
    ],
    [
      'createPluginRuntimeResolver',
      (body: string) =>
        body.replace(
          'assertCurrent: () => runWithPluginScope(() => undefined)',
          'assertCurrent: () => undefined',
        ),
    ],
  ] as const)('rejects a changed %s execution/ownership seam', (name, mutate) =>
    mutateFunction(name, mutate),
  );
  it.each(['createOpenClawCodingToolsInternal', 'createSubagentRegistryListener'])(
    'rejects a %s cleanup/observation moved into another branch',
    name => {
      mutateFunction(name, body =>
        body.replace(
          /(?:await )?justDo(?:RegisterManagedToolCleanup|ObservePluginLifecycle)\([^;]+\);/,
          statement => `if (false) { ${statement} }`,
        ),
      );
    },
  );
  it('rejects an owned SDK lookup imported from an unrelated registry', () => {
    const external = patch.__testing.transform(
      patch.__testing.editFunction(seamFixture, 'createSubagentRegistryListener', () => ''),
      file,
      registry,
    );
    const altered = patch.__testing.editFunction(
      external,
      'createGatewaySubagentRuntime',
      (body: string) =>
        body.replace(`import("./${registry}")`, 'import("./unrelated-registry.mjs")'),
    );
    expect(altered).not.toBe(external);
    expect(() => patch.__testing.transform(altered, file, registry)).toThrow('binding');
  });
  it('rejects the registration caller lifetime constant and duplicate projection', () => {
    const projection = 'managedToolsLifetime: params.client?.internal?.justDoManagedToolsLifetime,';
    expect(current).toContain(projection);
    expect(() =>
      patch.__testing.transform(
        current.replace(projection, 'managedToolsLifetime: "run",'),
        file,
        registry,
      ),
    ).toThrow('projection');
    expect(() =>
      patch.__testing.transform(
        current.replace(projection, projection + 'managedToolsLifetime: "run",'),
        file,
        registry,
      ),
    ).toThrow('projection');
  });
  it('rejects wrong static helper and ACP modules before recognizing a current runtime', () => {
    const native = patch.__testing.editFunction(seamFixture, 'createSubagentRegistryListener', () => '');
    const patched = patch.__testing.transform(native, file, registry);
    expect(() =>
      patch.__testing.transform(
        patched.replace('from "./' + registry + '"', 'from "./other-registry.mjs"'),
        file,
        registry,
      ),
    ).toThrow('import');
    expect(() =>
      patch.__testing.transform(
        patched.replace('from "./session-meta-readonly-CvCR0QQG.mjs"', 'from "./other-policy.mjs"'),
        file,
        registry,
      ),
    ).toThrow('import');
    expect(() =>
      patch.__testing.transform(
        patched.replace(
          'import { justDoRegisterManagedToolCleanup,',
          'import { justDoRegisterManagedToolCleanup as anotherCleanup,',
        ),
        file,
        registry,
      ),
    ).toThrow('import');
  });
});
