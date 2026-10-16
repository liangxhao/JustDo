import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.4/026-scoped-finalize-hook-admission.cjs');
const { transform, transformTypes, createFinalizeHookAdmission, CONTRACT } = patch.__testing;
const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;
const frozenRuntime = process.env.JUSTDO_EXECUTION_RUNTIME;
const { findMatchingDelimiter } = require('../../../../scripts/patches/v2026.10.4/_patch-utils.js');
const identity = {
  runId: 'run-one',
  sessionId: 'native-one',
  sessionKey: 'agent:role:task',
  agentId: 'role',
};
const record = (selector?: unknown, handler = vi.fn(async () => ({ action: 'revise' }))) => ({
  pluginId: 'fixture',
  hookName: 'before_agent_finalize',
  appliesToAgentRun: selector,
  handler,
});
function harness(hooks: any[], factory = createFinalizeHookAdmission) {
  const registry = { typedHooks: hooks };
  const execute = vi.fn(async (_event: unknown, _context: unknown, selected?: Map<any, any>) => {
    let result;
    for (const hook of registry.typedHooks) {
      if (
        hook.hookName === 'before_agent_finalize' &&
        (!selected || (selected.has(hook) && selected.get(hook) === hook.handler))
      )
        result = await hook.handler();
    }
    return result;
  });
  const admission = factory(registry, execute);
  const runner = admission.runner({ hasHooks: () => true });
  return { registry, admission, runner, execute };
}

describe('attempt-local finalization admission', () => {
  it('locks only after prompt preparation and never reevaluates a selector', async () => {
    let ownsRun = false;
    const selector = vi.fn(() => ownsRun);
    const h = harness([record(selector)]);
    expect(h.admission.required).toBe(true);
    expect(selector).not.toHaveBeenCalled();
    // Simulate before_prompt_build admitting the exact owned operation.
    ownsRun = true;
    h.admission.lock(identity);
    ownsRun = false;
    h.admission.lock(identity);
    expect(h.admission.required).toBe(true);
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(selector).toHaveBeenCalledOnce();
    expect(h.registry.typedHooks[0].handler).toHaveBeenCalledOnce();
  });

  it('cannot add a final revision after an ordinary run opted out', async () => {
    let ownsRun = false;
    const selector = vi.fn(() => ownsRun);
    const h = harness([record(selector)]);
    h.admission.lock(identity);
    ownsRun = true;
    h.admission.lock(identity);
    expect(h.admission.required).toBe(false);
    expect(await h.runner.runBeforeAgentFinalize(identity, identity)).toBeUndefined();
    expect(h.registry.typedHooks[0].handler).not.toHaveBeenCalled();
    expect(selector).toHaveBeenCalledOnce();
    const next = createFinalizeHookAdmission(h.registry, h.execute);
    next.lock({ ...identity, runId: 'next-run' });
    expect(next.required).toBe(true);
    expect(selector).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    null,
    'false',
    0,
    () => undefined,
    () => null,
    () => 'false',
    () => 0,
    () => {
      throw new Error('unavailable');
    },
    () => Promise.resolve(false),
    () => Promise.reject(new Error('async selector')),
  ])('keeps absent, invalid, failed or async selectors protected: %s', async selector => {
    const h = harness([record(selector)]);
    h.admission.lock(identity);
    expect(h.admission.required).toBe(true);
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(h.registry.typedHooks[0].handler).toHaveBeenCalledOnce();
    await Promise.resolve();
  });

  it.each(['runId', 'sessionId', 'sessionKey'])(
    'keeps missing %s protected and rejects another identity',
    async key => {
      const selector = vi.fn(() => false);
      const h = harness([record(selector)]);
      const unknown = { ...identity, [key]: '' };
      h.admission.lock(unknown);
      expect(h.admission.required).toBe(true);
      expect(selector).not.toHaveBeenCalled();
      expect(() => h.runner.runBeforeAgentFinalize(identity, identity)).toThrow(
        /different native run/,
      );
      expect(() => h.admission.lock(identity)).toThrow(/different native run/);
      await h.runner.runBeforeAgentFinalize(unknown, unknown);
    },
  );

  it('freezes only an identity projection and guards both the event and final context', () => {
    const selector = vi.fn(ctx => {
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(ctx).not.toHaveProperty('messages');
      expect(ctx).not.toHaveProperty('trace');
      return false;
    });
    const h = harness([record(selector)]);
    h.admission.lock({ ...identity, messages: ['private'], trace: { mutable: true } });
    for (const key of ['runId', 'sessionId', 'sessionKey']) {
      expect(() =>
        h.runner.runBeforeAgentFinalize(identity, { ...identity, [key]: 'replacement' }),
      ).toThrow();
      expect(() =>
        h.runner.runBeforeAgentFinalize({ ...identity, [key]: 'replacement' }, identity),
      ).toThrow();
    }
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('preserves unscoped hooks and excludes new registrations, changed handlers and retired entries', async () => {
    const selected = record(() => true);
    const excluded = record(() => false);
    const h = harness([selected, excluded]);
    h.admission.lock(identity);
    const added = record();
    h.registry.typedHooks.push(added);
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(selected.handler).toHaveBeenCalledOnce();
    expect(excluded.handler).not.toHaveBeenCalled();
    expect(added.handler).not.toHaveBeenCalled();
    selected.handler = vi.fn(async () => ({ action: 'revise' }));
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(selected.handler).not.toHaveBeenCalled();
    h.registry.typedHooks = [added];
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(added.handler).not.toHaveBeenCalled();
    expect(h.admission.required).toBe(true);
  });

  it('retains conservative native dispatch for an alternate, unlocked entry', async () => {
    const hook = record(vi.fn(() => false));
    const h = harness([hook]);
    await h.runner.runBeforeAgentFinalize(identity, identity);
    expect(hook.handler).toHaveBeenCalledOnce();
    expect(hook.appliesToAgentRun).not.toHaveBeenCalled();
  });
});

const seam = `function createHookRunner(registry) {
 async function runModifyingHook(name,event,context,options) { return options; }
 return { runBeforeAgentFinalize: (event, context) => runModifyingHook('before_agent_finalize',withAgentRunId(event,context),context,{mergeResults:mergeBeforeAgentFinalize}) };
}
function prepareStream(input, admission) {
 const { hookRunner } = input.agentSession;
 const shouldRunBeforeAgentFinalize = hookRunner?.hasHooks('before_agent_finalize');
 const onBeforeTerminalDelivery = event => runAgentHarnessBeforeAgentFinalizeHook({event,hookRunner});
 const subscription = subscribeEmbeddedAgentSession({onBeforeTerminalDelivery, deferTerminalDelivery: shouldRunBeforeAgentFinalize === true});
 return {subscription, queueHandle: {}};
}
async function runEmbeddedAttemptPromptPhase(input,promptState) {
 const {preparedStreamRuntime}=input;
 const promptAssembly = await prepareEmbeddedAttemptPromptAssembly(input);
 promptAssembly.assertHostActive?.();
 await submitPrompt();
}
function registrar(registry) {
 const registerTypedHook = (record,hookName,handler,opts,policy) => { registry.typedHooks.push({hookName,handler,pluginId:record.id}); };
 return registerTypedHook;
}`;
const current = transform(seam, 'seams.mjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('runtime-finalize-admission-')
    )
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('public atomic apply and verify', () => {
  const optionsType =
    'type PluginHookRegistrationOptions<K extends PluginHookName> = { priority?: number; };';
  const runnerType =
    'type PluginHookRegistration<K extends PluginHookName = PluginHookName> = { handler: unknown; };\ndeclare function createHookRunner(registry: unknown): { hasHooks(name: string): boolean; };';
  const runnerFile = 'hook-runner-global-Jvv9WFUW.d.ts';
  function fixture(bundle: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-finalize-admission-'));
    roots.push(root);
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'native.mjs'), seam);
    if (bundle) fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), seam);
    for (let index = 0; index < 3; index++)
      fs.writeFileSync(path.join(dist, `options-${index}.d.ts`), optionsType);
    fs.writeFileSync(path.join(dist, runnerFile), optionsType + '\n' + runnerType);
    return root;
  }
  it.each([false, true])(
    'applies and verifies exact source/bundle topology idempotently: bundle=%s',
    bundle => {
      const root = fixture(bundle);
      expect(() => patch.verifyPatch(root)).toThrow();
      expect(patch.applyPatch(root)).toHaveLength(bundle ? 6 : 5);
      expect(() => patch.verifyPatch(root)).not.toThrow();
      expect(patch.applyPatch(root)).toEqual([]);
      const native = path.join(root, 'dist', 'native.mjs');
      const before = fs.readFileSync(native, 'utf8');
      const types = path.join(root, 'dist', 'options-2.d.ts');
      fs.writeFileSync(
        types,
        'type PluginHookRegistrationOptions<K extends PluginHookName> = { priority?: number; };',
      );
      expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
      expect(fs.readFileSync(native, 'utf8')).toBe(before);
    },
  );
  it.each(['JUSTDO', 'RUNTIME'])(
    'rejects %s historical and partial input before any writes',
    prefix => {
      const root = fixture(true);
      const native = path.join(root, 'dist', 'native.mjs');
      const bundle = path.join(root, 'gateway-bundle.mjs');
      fs.appendFileSync(bundle, `\n/*${prefix}_SCOPED_FINALIZE_ADMISSION_V2026_9_8*/`);
      expect(() => patch.applyPatch(root)).toThrow(/historical/);
      expect(fs.readFileSync(native, 'utf8')).toBe(seam);
    },
  );
  it.each(['options-pristine', 'registration-pristine', 'options-missing', 'registration-missing'])(
    'rejects a co-located SDK %s declaration before any write',
    malformed => {
      const root = fixture(true);
      patch.applyPatch(root);
      const file = path.join(root, 'dist', runnerFile);
      const current = fs.readFileSync(file, 'utf8');
      const source = ts.createSourceFile('sdk.d.ts', current, ts.ScriptTarget.Latest, true);
      const options = source.statements.find(
        (node): node is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(node) && node.name.text === 'PluginHookRegistrationOptions',
      )!;
      const registration = source.statements.find(
        (node): node is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(node) && node.name.text === 'PluginHookRegistration',
      )!;
      let changed = current;
      if (malformed === 'options-pristine')
        changed =
          current.slice(0, options.getStart(source)) + optionsType + current.slice(options.end);
      if (malformed === 'registration-pristine')
        changed = options.getText(source) + '\n' + runnerType;
      if (malformed === 'options-missing')
        changed = current.slice(0, options.getStart(source)) + current.slice(options.end);
      if (malformed === 'registration-missing')
        changed =
          transformTypes(optionsType, 'options.d.ts') +
          '\n' +
          runnerType.slice(runnerType.indexOf('declare'));
      fs.writeFileSync(file, changed);
      const files = [
        ...fs.readdirSync(path.join(root, 'dist')).map(name => path.join(root, 'dist', name)),
        path.join(root, 'gateway-bundle.mjs'),
      ];
      const before = files.map(target => fs.readFileSync(target));
      for (const method of ['applyPatch', 'verifyPatch']) {
        expect(() => patch[method](root)).toThrow(/partial|missing/i);
        expect(files.map(target => fs.readFileSync(target))).toEqual(before);
      }
    },
  );
  it.each(['source', 'bundle'])(
    'rejects a complete %s paired with the opposite pristine artifact without writes',
    patchedGroup => {
      const root = fixture(true);
      const files = fs
        .readdirSync(path.join(root, 'dist'))
        .map(name => path.join(root, 'dist', name));
      const bundle = path.join(root, 'gateway-bundle.mjs');
      files.push(bundle);
      const original = new Map(files.map(file => [file, fs.readFileSync(file)]));
      patch.applyPatch(root);
      for (const file of files)
        if ((patchedGroup === 'source') === (file === bundle))
          fs.writeFileSync(file, original.get(file)!);
      const before = files.map(file => fs.readFileSync(file));
      for (const method of ['applyPatch', 'verifyPatch']) {
        expect(() => patch[method](root)).toThrow(/partially applied/);
        expect(files.map(file => fs.readFileSync(file))).toEqual(before);
      }
    },
  );
  for (const bundle of [false, true]) {
    it.each(['native', 'sdk'])(
      `rejects a complete %s group paired with a pristine other group without writes; bundle=${bundle}`,
      patchedGroup => {
        const root = fixture(bundle);
        const files = fs
          .readdirSync(path.join(root, 'dist'))
          .map(name => path.join(root, 'dist', name));
        if (bundle) files.push(path.join(root, 'gateway-bundle.mjs'));
        const pristineBytes = new Map(files.map(file => [file, fs.readFileSync(file)]));
        patch.applyPatch(root);
        for (const file of files) {
          const isSdk = file.endsWith('.d.ts');
          if ((patchedGroup === 'native' && isSdk) || (patchedGroup === 'sdk' && !isSdk))
            fs.writeFileSync(file, pristineBytes.get(file)!);
        }
        const before = files.map(file => fs.readFileSync(file));
        for (const method of ['applyPatch', 'verifyPatch']) {
          expect(() => patch[method](root)).toThrow(/partially applied/);
          expect(files.map(file => fs.readFileSync(file))).toEqual(before);
        }
      },
    );
  }
});

describe('locked source and bundle seams', () => {
  it('preserves getters through compilation, forwards the selector and locks post-prompt', async () => {
    for (const compiled of [false, true]) {
      const source = compiled
        ? transformSync(current, { minifySyntax: true, legalComments: 'none' }).code
        : current;
      expect(transform(source, compiled ? 'gateway-bundle.mjs' : 'seams.mjs')).toBe(source);
      const registry = { typedHooks: [] as any[] };
      const selector = () => false;
      const params: any[] = [];
      const order: string[] = [];
      const context = vm.createContext({
        withAgentRunId: (event: any) => event,
        mergeBeforeAgentFinalize: () => undefined,
        subscribeEmbeddedAgentSession: (value: any) => {
          params.push(value);
          return value;
        },
        runAgentHarnessBeforeAgentFinalizeHook: (value: any) => value.hookRunner,
        prepareEmbeddedAttemptPromptAssembly: async () => {
          order.push('prompt');
          return { hookCtx: identity, assertHostActive: () => order.push('authority') };
        },
        submitPrompt: () => order.push('submit'),
      });
      vm.runInContext(
        source +
          ';Object.assign(globalThis,{createHookRunner,prepareStream,runEmbeddedAttemptPromptPhase,registrar});',
        context,
      );
      context.registrar(registry)({ id: 'fixture' }, 'before_agent_finalize', () => undefined, {
        appliesToAgentRun: selector,
      });
      expect(registry.typedHooks[0].appliesToAgentRun).toBe(selector);
      const admission = harness(registry.typedHooks).admission;
      const prepared = context.prepareStream(
        {
          agentSession: {
            hookRunner: {
              hasHooks: () => true,
              createBeforeAgentFinalizeAdmission: () => admission,
            },
          },
        },
        {},
      );
      expect(params[0].deferTerminalDelivery).toBe(true);
      await context.runEmbeddedAttemptPromptPhase(
        { preparedStreamRuntime: { stream: prepared } },
        {},
      );
      expect(order).toEqual(['prompt', 'authority', 'submit']);
      expect(params[0].deferTerminalDelivery).toBe(false);
      expect(Object.getOwnPropertyDescriptor(params[0], 'deferTerminalDelivery')?.get).toBeTypeOf(
        'function',
      );
    }
  });

  it.each([
    (value: string) => value.replace('selected.get(registration) === registration.handler', 'true'),
    (value: string) => value.replace('runFinalizeAdmission?.required ?? true', 'false'),
    (value: string) =>
      value.replace(
        'lockBeforeAgentFinalize?.(promptAssembly.hookCtx)',
        'lockBeforeAgentFinalize?.({})',
      ),
    (value: string) =>
      value.replace('appliesToAgentRun:opts.appliesToAgentRun', 'appliesToAgentRun: () => false'),
    (value: string) => value.replace(`// ${CONTRACT}\n`, ''),
    (value: string) => value.replaceAll('V2026_10_4', 'V2026_9_8'),
  ])('rejects a changed admission boundary rather than repairing it', mutate => {
    const changed = mutate(current);
    expect(changed).not.toBe(current);
    expect(() => transform(changed, 'seams.mjs')).toThrow();
  });
});

function nativeFunction(source: string, name: string) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(signature, start + signature.length)).toBe(-1);
  const paren = source.indexOf('(', start);
  const close = findMatchingDelimiter(source, paren, '(', ')', name);
  const open = source.indexOf('{', close);
  return source.slice(start, findMatchingDelimiter(source, open, '{', '}', name) + 1);
}

function nativeBindings(source: string, bindings: Record<string, unknown>) {
  const result = { ...bindings };
  // esbuild gives imported globals numeric aliases in the real Gateway bundle.
  // Bind only identifiers present in the extracted native functions; do not
  // rewrite their bodies or the admission/dispatch implementation being tested.
  const ast = ts.createSourceFile(
    'native.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const base = node.text.replace(/\$?\d+$/, '');
      if (base !== node.text && Object.hasOwn(bindings, base)) result[node.text] = bindings[base];
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

describe.skipIf(!pristine && !frozenRuntime)('actual locked native publication pipeline', () => {
  const dist = pristine ? path.join(pristine, 'dist') : '';
  const files = pristine ? fs.readdirSync(dist).filter(name => name.endsWith('.mjs')) : [];
  const cache = new Map<string, string>();
  const find = (anchor: string) => {
    if (frozenRuntime) {
      const name = 'gateway-bundle.mjs';
      const source = cache.get(name) ?? fs.readFileSync(path.join(frozenRuntime, name), 'utf8');
      cache.set(name, source);
      if (!source.includes(anchor))
        throw new Error('Final Gateway bundle fixture missing: ' + anchor);
      return { name, source };
    }
    for (const name of files) {
      const source = cache.get(name) ?? fs.readFileSync(path.join(dist, name), 'utf8');
      cache.set(name, source);
      if (source.includes(anchor)) return { name, source };
    }
    throw new Error('Locked native fixture missing: ' + anchor);
  };

  it.skipIf(!pristine || Boolean(frozenRuntime))(
    'validates every pristine JavaScript and all four SDK declaration copies in memory',
    () => {
      const targets = new Map<string, string>();
      for (const anchor of [
        'function createHookRunner(',
        'function prepareStream(',
        'async function runEmbeddedAttemptPromptPhase(',
        'const registerTypedHook =',
      ]) {
        const file = find(anchor);
        expect(file).toBeDefined();
        targets.set(file.name, file.source);
      }
      for (const [name, source] of targets) {
        const changed = transform(source, name);
        expect(changed).not.toBe(source);
        expect(transform(changed, name)).toBe(changed);
      }
      const types = fs
        .readdirSync(dist)
        .filter(name => name.endsWith('.d.ts'))
        .map(name => ({ name, source: fs.readFileSync(path.join(dist, name), 'utf8') }))
        .filter(
          file =>
            file.source.includes(
              'type PluginHookRegistrationOptions<K extends PluginHookName> = {',
            ) ||
            file.source.includes(
              'type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {',
            ),
        );
      expect(types).toHaveLength(4);
      for (const { name, source } of types) {
        const changed = transformTypes(source, name);
        expect(changed).toContain('appliesToAgentRun');
        expect(transformTypes(changed, name)).toBe(changed);
      }
    },
    60_000,
  );

  it.skipIf(!frozenRuntime)(
    'requires the final Gateway bundle admission to be fully applied',
    () => {
      const source = find('function createHookRunner(').source;
      expect(source).toContain('createBeforeAgentFinalizeAdmission');
      expect(transform(source, 'gateway-bundle.mjs')).toBe(source);
    },
    60_000,
  );

  it('dispatches the frozen registration set through the real native runner and its error/timeout boundaries', async () => {
    const file = find('function createHookRunner(');
    const changed = frozenRuntime ? file.source : transform(file.source, file.name);
    const timeout = vi.fn((promise: Promise<unknown>, _timeoutMs: number) => promise);
    const logger = { debug: vi.fn(), error: vi.fn() };
    const runnerSource = nativeFunction(changed, 'createHookRunner');
    const callName = (source: string, name: string) => {
      const names = [
        ...new Set(
          [...source.matchAll(new RegExp('\\b' + name + '(?:\\$?\\d+)?\\s*\\(', 'g'))].map(match =>
            match[0].replace(/\s*\($/, ''),
          ),
        ),
      ];
      expect(names).toHaveLength(1);
      return names[0];
    };
    const helpers = [
      'withAgentRunId',
      'withoutIncognitoLlmContent',
      'getHooksForName',
      'createFinalizeHookAdmission',
    ].map(name => nativeFunction(changed, callName(runnerSource, name)));
    helpers.push(nativeFunction(changed, callName(helpers[2], 'isHookContextEligible')));
    const runtimeSource = helpers.join('\n') + '\n' + runnerSource;
    const context = vm.createContext(
      nativeBindings(runtimeSource, {
        AsyncLocalStorage,
        randomUUID,
        DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: {},
        DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: { before_agent_finalize: 15000 },
        clampPositiveTimerTimeoutMs: (value: any) =>
          typeof value === 'number' && value > 0 ? value : undefined,
        withHookTimeout: timeout,
        readClaimingHookAdmission: () => undefined,
        HookIsolationError: class extends Error {},
        formatHookErrorForLog: (error: unknown) => String(error),
        isIncognitoSessionKey: () => false,
      }),
    );
    const make = vm.runInContext(runtimeSource + ';createHookRunner;', context);
    const accepted = record(
      vi.fn(() => true),
      vi.fn(async () => ({ action: 'finalize' })),
    );
    const failed = {
      ...record(
        () => true,
        vi.fn(async () => {
          throw new Error('hook failed');
        }),
      ),
      priority: 10,
      timeoutMs: 7,
    };
    const excluded = record(vi.fn(() => false));
    const registry = { typedHooks: [failed, accepted, excluded] };
    const native = make(registry, { logger });
    const admission = native.createBeforeAgentFinalizeAdmission();
    admission.lock(identity);
    registry.typedHooks.push(record());
    const runner = admission.runner(native);
    expect(await runner.runBeforeAgentFinalize(identity, identity)).toMatchObject({
      action: 'finalize',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('hook failed'));
    expect(timeout.mock.calls.map(call => call[1])).toEqual([7, 15000]);
    expect(excluded.handler).not.toHaveBeenCalled();
    expect(registry.typedHooks[3].handler).not.toHaveBeenCalled();
    expect(accepted.appliesToAgentRun).toHaveBeenCalledOnce();
    accepted.handler = vi.fn(async () => ({ action: 'revise' }));
    registry.typedHooks = [accepted];
    expect(await runner.runBeforeAgentFinalize(identity, identity)).toBeUndefined();
    expect(accepted.handler).not.toHaveBeenCalled();
  });

  it('preserves the real aborted/retry/error guards before any final hook invocation', async () => {
    const file = find('function prepareStream(');
    const changed = frozenRuntime ? file.source : transform(file.source, file.name);
    const ast = ts.createSourceFile(
      'prepare.mjs',
      nativeFunction(changed, 'prepareStream'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onBeforeTerminalDelivery')
        initializer = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(initializer).toBeDefined();
    const invoked = vi.fn();
    for (const mode of ['aborted', 'retry', 'error']) {
      const callbackSource = '(' + initializer!.getText(ast) + ')';
      const callback = vm.runInNewContext(
        callbackSource,
        nativeBindings(callbackSource, {
          shouldRunBeforeAgentFinalize: true,
          completionCheck: undefined,
          beforeAgentFinalizeRevisionReason: undefined,
          resolveFinalAssistantVisibleText: () => 'draft',
          resolveFinalAssistantRawText: () => 'draft',
          normalizeOptionalString: (value: unknown) => value,
          agentSession: { clientToolCallSlots: [] },
          input: {
            getRunState: () => ({ aborted: mode === 'aborted' }),
            runAbortController: { signal: { aborted: mode === 'aborted' } },
          },
          attempt: { silentExpected: false },
          runAgentHarnessBeforeAgentFinalizeHook: invoked,
        }),
      );
      await callback({
        hasAssistantVisibleText: true,
        assistantTexts: ['draft'],
        willRetry: mode === 'retry',
        isError: mode === 'error',
      });
    }
    expect(invoked).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'publishes ordinary text before terminal and holds an owned revision; owned=%s',
    async owned => {
      const file = find('function createReplyDelivery(');
      const events: any[] = [];
      const prepareSource = frozenRuntime ? file.source : transform(file.source, file.name);
      const hooksFile = find('function createHookRunner(');
      const hookSource = frozenRuntime
        ? hooksFile.source
        : transform(hooksFile.source, hooksFile.name);
      const factory = vm.runInNewContext(
        nativeFunction(hookSource, 'createFinalizeHookAdmission') + ';createFinalizeHookAdmission;',
      );
      const h = harness([record(() => owned)], factory);
      const prepareAst = ts.createSourceFile(
        'prepare.mjs',
        nativeFunction(prepareSource, 'prepareStream'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      let getter: ts.GetAccessorDeclaration | undefined;
      const visit = (node: ts.Node) => {
        if (
          ts.isGetAccessorDeclaration(node) &&
          node.name.getText(prepareAst) === 'deferTerminalDelivery'
        )
          getter = node;
        ts.forEachChild(node, visit);
      };
      visit(prepareAst);
      expect(getter).toBeDefined();
      const params: any = vm.runInNewContext('({' + getter!.getText(prepareAst) + '})', {
        shouldRunBeforeAgentFinalize: true,
        runFinalizeAdmission: h.admission,
      });
      Object.assign(params, { runId: identity.runId, onBeforeTerminalDelivery: () => undefined });
      const state: any = {
        pendingEventChain: undefined,
        assistantMessageStartIndex: 0,
        assistantMessageIndex: 0,
        shouldEmitPartialReplies: false,
        answerSegments: [],
        deferredBlockReplies: [],
        toolMetas: [],
        deferBlockReplyDelivery: true,
        assistantTexts: [],
        messagingToolSentTexts: [],
        messagingToolSentTextsNormalized: [],
        messagingToolSentTargets: [],
        messagingToolSentMediaUrls: [],
        toolSummaryById: new Map(),
      };
      const deliverySource = nativeFunction(file.source, 'createReplyDelivery');
      const startSource = nativeFunction(file.source, 'handleAgentStart');
      const context = vm.createContext(
        nativeBindings(deliverySource + '\n' + startSource, {
          randomUUID,
          emitAgentEventIfCurrent: (event: any) => {
            events.push(event);
            return true;
          },
          runBestEffortCallback: ({ callback }: any) => callback(),
          consumePendingAssistantReplyDirectivesIntoReply: (_state: any, payload: any) => payload,
          hasAssistantVisibleReply: (payload: any) => Boolean(payload.text),
          getReplyPayloadMetadata: () => undefined,
          copyReplyPayloadMetadata: () => undefined,
          normalizeTextForComparison: (text: string) => text,
          emitLifecycleAgentEvent: () => undefined,
        }),
      );
      const delivery = vm.runInContext(
        deliverySource + ';createReplyDelivery;',
        context,
      )({ params, state, log: { debug: () => undefined } });
      const start = vm.runInContext(startSource + ';handleAgentStart;', context);
      h.admission.lock(identity); // after before_prompt_build, before the native agent_start.
      start({ params, state, log: { debug: () => undefined } });
      expect(state.deferBlockReplyDelivery).toBe(owned);
      delivery.emitAssistantStreamData({ text: 'draft', delta: 'draft' });
      expect(events.filter(event => event.stream === 'assistant').length).toBe(owned ? 0 : 1);
      if (owned) {
        // This is the native revise path: discard the draft, then release only the accepted answer.
        delivery.clearAssistantStream();
        delivery.emitAssistantStreamData(
          { text: 'accepted', delta: '', replace: true },
          { finalMessage: true },
        );
        expect(events).toHaveLength(0);
        delivery.releaseDeferredReplies();
        expect(
          events.filter(event => event.stream === 'assistant').map(event => event.data.text),
        ).toEqual(['accepted']);
      }
      // Native compaction reset and same-prompt agent_start read the original getter.
      state.deferBlockReplyDelivery =
        typeof params.onBeforeTerminalDelivery === 'function' &&
        params.deferTerminalDelivery !== false;
      start({ params, state, log: { debug: () => undefined } });
      expect(state.deferBlockReplyDelivery).toBe(owned);
    },
  );
});
