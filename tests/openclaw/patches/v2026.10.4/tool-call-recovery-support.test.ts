import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { build, buildSync } from 'esbuild';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const {
  __testing: support,
} = require('../../../../scripts/patches/v2026.10.4/030-tool-call-format-recovery.cjs');
const { extractFunction } = support;
const root = path.resolve(__dirname, '../../../..');
const supportDirectory = path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery');
const bundle = buildSync({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(supportDirectory, 'policy.mjs'))};
      export * from ${JSON.stringify(path.join(supportDirectory, 'facts.mjs'))};
      export * from ${JSON.stringify(path.join(supportDirectory, 'loop.mjs'))};`,
    resolveDir: root,
    sourcefile: 'recovery-support-entry.mjs',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
}).outputFiles[0].text;

describe('complete native support admission', () => {
  let fixtureRoot: string;
  afterEach(() => {
    if (fixtureRoot) {
      expect(path.dirname(fixtureRoot)).toBe(os.tmpdir());
      expect(path.basename(fixtureRoot)).toMatch(/^tool-call-recovery-support-/);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
  const create = (complete: boolean) => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-call-recovery-support-'));
    const directory = path.join(fixtureRoot, 'dist/native-support');
    if (complete) {
      fs.mkdirSync(directory, { recursive: true });
      for (const name of ['policy', 'facts', 'loop']) {
        fs.copyFileSync(path.join(supportDirectory, `${name}.mjs`), path.join(directory, `tool-call-recovery-${name}.mjs`));
      }
    }
    return directory;
  };
  const snapshot = (directory: string) => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name))]);

  it('admits pristine source without creating support files', () => {
    create(false);
    expect(() => support.verifySupport(fixtureRoot, root, false)).not.toThrow();
    expect(fs.readdirSync(fixtureRoot)).toEqual([]);
  });
  it('verifies complete current support without changing bytes', () => {
    const directory = create(true);
    const before = snapshot(directory);
    expect(() => support.verifySupport(fixtureRoot, root, true)).not.toThrow();
    expect(snapshot(directory)).toEqual(before);
  });
  it.each(['policy', 'facts', 'loop'])('rejects missing %s without repairing it', name => {
    const directory = create(true);
    fs.unlinkSync(path.join(directory, `tool-call-recovery-${name}.mjs`));
    const before = snapshot(directory);
    expect(() => support.verifySupport(fixtureRoot, root, true)).toThrow(/partial/);
    expect(snapshot(directory)).toEqual(before);
  });
  it.each(['policy', 'facts', 'loop'])('rejects changed %s without modifying another file', name => {
    const directory = create(true);
    fs.writeFileSync(path.join(directory, `tool-call-recovery-${name}.mjs`), 'changed support');
    const before = snapshot(directory);
    expect(() => support.verifySupport(fixtureRoot, root, true)).toThrow(/partial/);
    expect(snapshot(directory)).toEqual(before);
  });
  it('rejects support-only leftovers on unpatched source', () => {
    const directory = create(true);
    const before = snapshot(directory);
    expect(() => support.verifySupport(fixtureRoot, root, false)).toThrow(/partial/);
    expect(snapshot(directory)).toEqual(before);
  });
});

describe('format recovery support binding', () => {
  it('verifies complete policy and fact implementations after real esbuild bundling', () => {
    expect(() => support.verifyBundledSupport(bundle, root)).not.toThrow();
  });

  it('rejects a changed bundled opportunity limit', () => {
    const changed = bundle.replace(
      /\bTOOL_CALL_RECOVERY_LIMIT\s*=\s*2\b/,
      'TOOL_CALL_RECOVERY_LIMIT = 3',
    );

    expect(changed).not.toBe(bundle);
    expect(() => support.verifyBundledSupport(changed, root)).toThrow(/constant.*partial or stale/);
  });

  it('rejects a changed response evidence helper', () => {
    const changed = bundle.replace(
      'const content = toolCallRecoveryFactsObserveAssistant(assistant);',
      'const content = {};',
    );

    expect(changed).not.toBe(bundle);
    expect(() => support.verifyBundledSupport(changed, root)).toThrow(/function.*partial or stale/);
  });

  it('rejects ambiguous exported function bindings', () => {
    const changed = `${bundle}\nfunction observeToolCallRecoveryResponse() { return {}; }`;

    expect(() => support.verifyBundledSupport(changed, root)).toThrow(/function binding changed/);
  });

  it.each(['embedded-agent-fixture.mjs', 'worker/worker.mjs'])(
    'binds both modules and verifies exact imports in %s',
    filename => {
      const file = path.join(root, 'runtime-fixture/dist', filename);
      const bound = support.bindSupport('function runPreparedEmbeddedLoop() {}', file, false);

      expect(bound).toContain('tool-call-recovery-policy.mjs');
      expect(bound).toContain('tool-call-recovery-facts.mjs');
      expect(support.bindSupport(bound, file, true)).toBe(bound);
      expect(support.bindSupport(bound, file, false)).toBe(bound);
    },
  );

  it('rejects partial imports instead of adding another support binding', () => {
    const file = path.join(root, 'runtime-fixture/dist/embedded-agent-fixture.mjs');
    const bound = support.bindSupport('function runPreparedEmbeddedLoop() {}', file, false);
    const partial = bound.replace(
      'resolveToolCallRecovery, TOOL_CALL_RECOVERY_LIMIT, TOOL_CALL_RECOVERY_REASON',
      'resolveToolCallRecovery',
    );

    expect(partial).not.toBe(bound);
    expect(() => support.bindSupport(partial, file, false)).toThrow(/missing or partial/);
    expect(() => support.bindSupport(partial, file, true)).toThrow(/missing or partial/);
    expect(() => support.bindSupport('function runPreparedEmbeddedLoop() {}', file, true)).toThrow(
      /missing or partial/,
    );
  });

  it('uses the exact SDK support path and rejects comment, alias and duplicate imports', () => {
    const file = path.join(root, 'runtime-fixture/node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs');
    const bound = support.bindSupport('function finalizeOpenAICompletionsToolCalls() {}', file, false);
    expect(bound).toContain('../../../../dist/native-support/tool-call-recovery-facts.mjs');
    expect(support.bindSupport(bound, file, true)).toBe(bound);
    const declaration = bound.split('\n')[0];
    for (const changed of ['// ' + bound, bound.replace('resolveToolCallRecovery,', 'resolveToolCallRecovery as other,'), declaration + '\n' + bound]) {
      expect(() => support.bindSupport(changed, file, true)).toThrow(/missing or partial/);
    }
  });
});

describe('dynamic-import recovery support initializers', () => {
  let lazyBundle: string;
  let strictLazyBundle: string;
  beforeAll(async () => {
    const prefix = '/runtime/dist/';
    const owner = prefix + 'embedded-agent-DOz9dy-9.mjs';
    const nestedOwner = prefix + 'builtin-openclaw-qVsnLx0N.mjs';
    const coreOwner = prefix + 'agent-core-RzJjRVA2.mjs';
    const producerOwner = '/runtime/node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs';
    const dispatchOwner = prefix + 'agent-turn-service-CVZmpyt7.mjs';
    const modules: Record<string, string> = {
      [owner]: `import { resolveToolCallRecovery, TOOL_CALL_RECOVERY_LIMIT, TOOL_CALL_RECOVERY_REASON } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-policy.mjs')};
        import { observeToolCallRecoveryResponse, projectToolCallRecoveryRejectionFeedback } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-facts.mjs')};
        import { createToolCallValidationRecovery } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-loop.mjs')};
        export function runPreparedEmbeddedLoop(input) {
          return [createToolCallValidationRecovery, resolveToolCallRecovery(input), observeToolCallRecoveryResponse(input), projectToolCallRecoveryRejectionFeedback(input), TOOL_CALL_RECOVERY_LIMIT, TOOL_CALL_RECOVERY_REASON];
        }`,
      [nestedOwner]: `import { installToolCallValidationRecovery } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-loop.mjs')};
        export async function submitEmbeddedAttemptPrompt(input) { return installToolCallValidationRecovery(input.agent, input.recover); }`,
      [coreOwner]: `import { readToolCallValidationRecovery, prepareToolCallValidationHandoff, assertToolCallValidationModel } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-loop.mjs')};
        import { observeToolCallRecoveryResponse } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-facts.mjs')};
        export async function streamAgentResponse(input) { return [readToolCallValidationRecovery, prepareToolCallValidationHandoff, assertToolCallValidationModel, observeToolCallRecoveryResponse(input)]; }`,
      [producerOwner]: `import { projectToolCallRecoveryRejectionFeedback } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-facts.mjs')};
        export function finalizeOpenAICompletionsToolCalls(calls, validator) { return projectToolCallRecoveryRejectionFeedback(calls, validator); }`,
      [dispatchOwner]: `import { projectToolCallRecoveryFailureSummary } from ${JSON.stringify(prefix + 'native-support/tool-call-recovery-policy.mjs')};
        export function dispatchAgentRunFromGateway(input) { return projectToolCallRecoveryFailureSummary(input.result, input.error, false); }`,
    };
    for (const name of ['policy', 'facts', 'loop'])
      modules[prefix + `native-support/tool-call-recovery-${name}.mjs`] = fs.readFileSync(path.join(supportDirectory, `${name}.mjs`), 'utf8');
    const options: Parameters<typeof build>[0] = {
      stdin: { contents: `export const loadCore = () => import(${JSON.stringify(coreOwner)}); export const load = () => import(${JSON.stringify(owner)}); export const loadNested = () => import(${JSON.stringify(nestedOwner)}); export const loadProducer = () => import(${JSON.stringify(producerOwner)}); export const loadDispatch = () => import(${JSON.stringify(dispatchOwner)});`, resolveDir: root, sourcefile: 'lazy-recovery-entry.mjs' },
      bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{ name: 'lazy-recovery-support', setup(plugin) {
        plugin.onResolve({ filter: /^\/runtime\// }, args => ({ path: args.path, namespace: 'lazy-recovery' }));
        plugin.onLoad({ filter: /.*/, namespace: 'lazy-recovery' }, args => ({ contents: modules[args.path], loader: 'js' }));
      } }],
    };
    const [result, strictResult] = await Promise.all([
      build(options),
      build({ ...options, tsconfigRaw: { compilerOptions: { alwaysStrict: true } } }),
    ]);
    lazyBundle = result.outputFiles[0].text;
    strictLazyBundle = strictResult.outputFiles[0].text;
  });

  const changed = (pattern: string | RegExp, replacement: string) => {
    const result = typeof pattern === 'string' ? lazyBundle.replaceAll(pattern, replacement) : lazyBundle.replace(pattern, replacement);
    expect(result).not.toBe(lazyBundle);
    return result;
  };

  it('verifies real esbuild lazy declarations and unconditional runner initialization', () => {
    expect(lazyBundle).toMatch(/var TOOL_CALL_RECOVERY_LIMIT, /);
    expect(lazyBundle).toContain('init_tool_call_recovery_policy();');
    expect(() => support.verifyBundledSupport(lazyBundle, root)).not.toThrow();
  });

  it('verifies exact leading strict directives generated by the real compiler', () => {
    expect(strictLazyBundle).toContain('"use strict";');
    expect(() => support.verifyBundledSupport(strictLazyBundle, root)).not.toThrow();
  });

  it('requires unconditional loop initialization in the attempt owner too', () => {
    const owner = lazyBundle.indexOf('"lazy-recovery:/runtime/dist/builtin-openclaw-qVsnLx0N.mjs"');
    expect(owner).toBeGreaterThan(0);
    const end = lazyBundle.indexOf('\n});', owner);
    const fragment = lazyBundle.slice(owner, end);
    expect(fragment).toContain('init_tool_call_recovery_loop();');
    const missing = lazyBundle.slice(0, owner) + fragment.replace('init_tool_call_recovery_loop();', '') + lazyBundle.slice(end);
    expect(() => support.verifyBundledSupport(missing, root)).toThrow(/initialization/);
  });

  it.each(['', 'if (ready) init_tool_call_recovery_facts();',
    'sideEffect(); init_tool_call_recovery_facts();',
    'init_tool_call_recovery_facts(); init_tool_call_recovery_facts();'])(
    'rejects changed SDK producer initialization: %s', replacement => {
      const owner = lazyBundle.indexOf('"lazy-recovery:/runtime/node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs"');
      expect(owner).toBeGreaterThan(0);
      const end = lazyBundle.indexOf('\n});', owner);
      const fragment = lazyBundle.slice(owner, end);
      expect(fragment).toContain('init_tool_call_recovery_facts();');
      const missing = lazyBundle.slice(0, owner) + fragment.replace('init_tool_call_recovery_facts();', replacement) + lazyBundle.slice(end);
      expect(() => support.verifyBundledSupport(missing, root)).toThrow(/initialization/);
    });

  it.each(['', 'if (ready) init_tool_call_recovery_policy();',
    'sideEffect(); init_tool_call_recovery_policy();',
    'init_tool_call_recovery_policy(); init_tool_call_recovery_policy();'])(
    'requires unconditional initialization in the terminal dispatch owner: %s', replacement => {
      const owner = lazyBundle.indexOf('"lazy-recovery:/runtime/dist/agent-turn-service-CVZmpyt7.mjs"');
      expect(owner).toBeGreaterThan(0);
      const end = lazyBundle.indexOf('\n});', owner);
      const fragment = lazyBundle.slice(owner, end);
      expect(fragment).toContain('init_tool_call_recovery_policy();');
      const altered = lazyBundle.slice(0, owner) + fragment.replace('init_tool_call_recovery_policy();', replacement) + lazyBundle.slice(end);
      expect(() => support.verifyBundledSupport(altered, root)).toThrow(/initialization/);
    });

  it.each(['"use unknown";', '"use strict"; "use strict";', '("use strict");', 'sideEffect(); "use strict";'])(
    'rejects extra or non-directive initializer prefixes: %s', prefix => {
      const changed = lazyBundle.replace('TOOL_CALL_RECOVERY_LIMIT = 2;', prefix + ' TOOL_CALL_RECOVERY_LIMIT = 2;');
      expect(changed).not.toBe(lazyBundle);
      expect(() => support.verifyBundledSupport(changed, root)).toThrow();
    },
  );

  it.each([
    ['changed value', 'TOOL_CALL_RECOVERY_LIMIT = 2;', 'TOOL_CALL_RECOVERY_LIMIT = 3;'],
    ['conditional assignment', 'TOOL_CALL_RECOVERY_LIMIT = 2;', 'if (true) { TOOL_CALL_RECOVERY_LIMIT = 2; }'],
    ['duplicate assignment', 'TOOL_CALL_RECOVERY_LIMIT = 2;', 'TOOL_CALL_RECOVERY_LIMIT = 2; TOOL_CALL_RECOVERY_LIMIT = 2;'],
    ['extra effect', 'TOOL_CALL_RECOVERY_LIMIT = 2;', 'sideEffect(); TOOL_CALL_RECOVERY_LIMIT = 2;'],
    ['missing initialization', 'init_tool_call_recovery_policy();', ''],
    ['conditional initialization', 'init_tool_call_recovery_policy();', 'if (false) init_tool_call_recovery_policy();'],
    ['nested initialization', 'init_tool_call_recovery_policy();', '(() => init_tool_call_recovery_policy())();'],
    ['early return', 'init_tool_call_recovery_policy();', 'return; init_tool_call_recovery_policy();'],
    ['late initialization', 'init_tool_call_recovery_policy();', 'sideEffect(); init_tool_call_recovery_policy();'],
    ['duplicate initialization', 'init_tool_call_recovery_policy();', 'init_tool_call_recovery_policy(); init_tool_call_recovery_policy();'],
    ['wrong module', '/dist/native-support/tool-call-recovery-policy.mjs', '/dist/native-support/foreign-policy.mjs'],
    ['wrong runner', '/dist/embedded-agent-DOz9dy-9.mjs', '/dist/foreign-owner.mjs'],
  ])('rejects %s', (_name, pattern, replacement) => {
    const source = changed(pattern, replacement);
    expect(() => support.verifyBundledSupport(source, root)).toThrow();
  });

  it('rejects duplicate top-level declarations and initializer factories', () => {
    expect(() => support.verifyBundledSupport(lazyBundle + '\nvar TOOL_CALL_RECOVERY_LIMIT;', root)).toThrow();
    expect(() => support.verifyBundledSupport(lazyBundle + '\nvar init_tool_call_recovery_policy;', root)).toThrow();
    const ast = ts.createSourceFile('lazy.mjs', lazyBundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const factory = ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText() === 'init_tool_call_recovery_policy'));
    expect(factory).toBeDefined();
    const duplicate = factory!.getText(ast).replace('var init_tool_call_recovery_policy', 'var init_duplicate_policy');
    expect(() => support.verifyBundledSupport(lazyBundle + '\n' + duplicate, root)).toThrow();
  });
});

const dist = path.join(
  process.env.OPENCLAW_PRISTINE_DIR ?? path.join(root, 'vendor/openclaw-runtime/current'),
  'dist',
);
const nativeFile =
  fs.existsSync(dist) &&
  fs
    .readdirSync(dist)
    .find(
      name =>
        /^embedded-agent-.*\.mjs$/.test(name) &&
        fs
          .readFileSync(path.join(dist, name), 'utf8')
          .includes('function prepareTerminalWithSettledTurnFinalization('),
    );
const nativeSource = nativeFile ? fs.readFileSync(path.join(dist, nativeFile), 'utf8') : '';

describe.skipIf(!nativeFile)('native recovery helper aliases in a real esbuild graph', () => {
  it('verifies a patched pristine loop when another module forces helper names to change', async () => {
    const names = [
      'emitAgentEvent',
      'emitDiagnosticsTimelineEvent',
      'isEmbeddedRunTerminalInterrupted',
      'recordModelFallbackStop',
      'isRunRetryBudgetExhausted',
      'recordRunRetry',
      'beginRunAttempt',
    ];
    const helpers = (origin: string) =>
      names
        .map(
          name =>
            `export function ${name}(...args) { return { origin: ${JSON.stringify(origin)}, args }; }`,
        )
        .join('\n');
    const part = extractFunction(nativeSource, 'runPreparedEmbeddedLoop');
    const patched = support.transformRunner(`async ${part.body}`, 'native-alias-fixture.mjs');
    const modules: Record<string, string> = {
      'recovery-graph:first': helpers('first'),
      'recovery-graph:second': `${helpers('second')}
        export function recoverEmbeddedRunAttempt(input) {
          emitAgentEvent(input);
          emitDiagnosticsTimelineEvent(input);
          return isEmbeddedRunTerminalInterrupted(input);
        }
        export function createProviderReviewRun(input) { return recordModelFallbackStop(input); }`,
      'recovery-graph:loop': `
        import { ${names.join(', ')}, recoverEmbeddedRunAttempt, createProviderReviewRun }
          from 'recovery-graph:second';
        import { resolveToolCallRecovery, TOOL_CALL_RECOVERY_LIMIT, TOOL_CALL_RECOVERY_REASON, projectToolCallRecoveryFailureSummary }
          from ${JSON.stringify(path.join(supportDirectory, 'policy.mjs'))};
        import { observeToolCallRecoveryResponse, projectToolCallRecoveryRejectionFeedback }
          from ${JSON.stringify(path.join(supportDirectory, 'facts.mjs'))};
        import { createToolCallValidationRecovery } from ${JSON.stringify(path.join(supportDirectory, 'loop.mjs'))};
        export * from ${JSON.stringify(path.join(supportDirectory, 'loop.mjs'))};
        ${patched}
        export { runPreparedEmbeddedLoop, projectToolCallRecoveryRejectionFeedback, projectToolCallRecoveryFailureSummary };`,
      'recovery-graph:entry': `
        import * as first from 'recovery-graph:first';
        export const firstBindings = [${names.map(name => `first.${name}`).join(', ')}];
        export * from 'recovery-graph:loop';`,
    };
    const result = await build({
      entryPoints: ['recovery-graph:entry'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      plugins: [
        {
          name: 'recovery-helper-collision-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^recovery-graph:/ }, args => ({
              path: args.path,
              namespace: 'recovery-graph',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'recovery-graph' }, args => ({
              contents: modules[args.path],
              loader: 'js',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const collided = result.outputFiles[0].text;

    for (const name of names) expect(collided).toMatch(new RegExp(`function ${name}2\\(`));
    expect(() => support.verifyBundledSupport(collided, root)).not.toThrow();
    expect(support.transformRunner(collided, 'gateway-bundle.mjs', { verifyOnly: true })).toBe(
      collided,
    );
  });
});

describe.skipIf(!nativeFile)('handled recovery at pristine native finalization boundaries', () => {
  it.each([
    ['payload scrub', 'payloadsForTerminalPath: undefined', 'payloadsForTerminalPath'],
    ['text metadata scrub', 'finalAssistantRawText: undefined', 'finalAssistantRawText: input.finalAssistantRawText'],
  ])('rejects a historical terminal that weakens the %s', (_name, current, historical) => {
    const source = support.transformRunner(
      `async ${extractFunction(nativeSource, 'resolveEmbeddedRunTerminal').body}`,
      'native-revision-proof-fixture.mjs',
    );
    const weakened = source.replace(current, historical);
    expect(weakened).not.toBe(source);
    expect(() => support.transformRunner(weakened, 'native-revision-proof-fixture.mjs', { verifyOnly: true }))
      .toThrow(/historical or partial/);
  });

  it('skips settled text generation while retaining original preparation and custody', async () => {
    const part = extractFunction(nativeSource, 'prepareTerminalWithSettledTurnFinalization');
    const transformed = support.transformRunner(
      `async ${part.body}`,
      'native-finalization-fixture.mjs',
    );
    const prepared = { agentMeta: {}, payloadsWithToolMedia: [] };
    const request = vi.fn((): string | null => 'A model request must not be scheduled');
    const model = vi.fn(() => {
      throw new Error('Unexpected extra finalization request');
    });
    const prepare = vi.fn(() => prepared);
    const context = {
      observeReplyDelivery: vi.fn(async () => 'missing'),
      prepareEmbeddedRunTerminal: prepare,
      resolveSettledTurnFinalizationRequest: request,
      runPreparedSettledTurnFinalization: model,
    };
    const run = vm.runInNewContext(
      `${transformed}; prepareTerminalWithSettledTurnFinalization`,
      context,
    );
    const terminalState = { outcome: { status: 'failed' }, signalOwnedInterruption: false };
    const attempt = { answerSegments: [], marker: 'original-attempt' };
    const initial = {
      attempt,
      terminalState,
      currentAttemptCompletedAssistant: {},
      sessionIdUsed: 'session',
    };
    const input = {
      toolCallRecoveryHandled: true,
      initial,
      terminalBase: { runParams: {}, activeErrorContext: {} },
      lastRunPromptUsage: { input: 42 },
      finalization: {
        modelApi: 'openai-completions',
        executionContract: 'default',
        hasTerminalToolPresentation: false,
        harness: { finalizeSettledTurn: model },
      },
    };

    const result = await run(input);

    expect(request).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toMatchObject({ attempt, terminalState });
    expect(result).toMatchObject({ finalizationOutcome: 'not-attempted', prepared });
    expect(result.attempt).toBe(attempt);
    expect(result.terminalState).toBe(terminalState);
    expect(result.lastRunPromptUsage).toBe(input.lastRunPromptUsage);

    request.mockReturnValueOnce(null);
    const unhandled = await run({ ...input, toolCallRecoveryHandled: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(unhandled.finalizationOutcome).toBe('not-attempted');
  });

  it.each([
    ['failure', {}, { status: 'failed' }],
    ['cancel', {}, { status: 'aborted' }],
    ['timeout', {}, { status: 'timeout' }],
    ['approval', { didSendDeterministicApprovalPrompt: true }, { status: 'ok' }],
    ['yield', { yieldDetected: true }, { status: 'ok' }],
    ['client tools', { clientToolCalls: [] }, { status: 'ok' }],
  ])(
    'skips other model retries and passes the real %s state to native completion',
    async (_name, activity, outcome) => {
      const part = extractFunction(nativeSource, 'resolveEmbeddedRunTerminal');
      const transformed = support.transformRunner(
        `async ${part.body}`,
        'native-terminal-fixture.mjs',
      );
      const complete = vi.fn(async (input: unknown) => ({
        action: 'complete',
        result: Object.assign(input as object, { meta: {} }),
      }));
      const reasoning = vi.fn(() => 'unexpected reasoning retry');
      const empty = vi.fn(() => 'unexpected empty retry');
      const settled = vi.fn(() => 'unexpected settled retry');
      const incomplete = vi.fn(() =>
        outcome.status === 'failed' ? 'Format correction exhausted.' : null,
      );
      const context = {
        projectAgentRunAttemptTerminal: () => ({ externalAbort: outcome.status === 'aborted' }),
        isEmbeddedRunTerminalAbort: (value: { status: string }) => value.status === 'aborted',
        isEmbeddedRunTerminalTimeout: (value: { status: string }) => value.status === 'timeout',
        isEmbeddedRunTerminalInterrupted: (value: { status: string }) =>
          ['aborted', 'timeout'].includes(value.status),
        resolveSilentToolResultReplyPayload: () => undefined,
        resolveSettledToolBatchEvidence: () => ({ intentionalTermination: false }),
        shouldTreatEmptyAssistantReplyAsSilent: () => false,
        resolveReplyExpectation: () => 'required',
        resolveSourceReplyDelivery: () => 'missing',
        resolveIncompleteTurnPayloadText: incomplete,
        resolveReasoningOnlyRetryInstruction: reasoning,
        resolveEmptyResponseRetryInstruction: empty,
        resolveSettledToolTerminalContinuationInstruction: settled,
        completeEmbeddedRun: complete,
      };
      const run = vm.runInNewContext(`${transformed}; resolveEmbeddedRunTerminal`, context);
      const terminalState = { outcome, signalOwnedInterruption: outcome.status === 'aborted' };
      const attempt = { terminal: {}, ...activity };
      const retryState = { reasoningOnlyAttempts: 0, emptyResponseAttempts: 0 };
      const input = {
        toolCallRecoveryHandled: true,
        runParams: {},
        attempt,
        terminalState,
        retryState,
        replayState: { hadPotentialSideEffects: true },
        settledTurnFinalizationOutcome: 'not-attempted',
        sessionPromptState: { clearCompactionContinuation: vi.fn() },
      };

      const result = await run(input);

      expect(reasoning).not.toHaveBeenCalled();
      expect(empty).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      const completion = complete.mock.calls[0][0] as typeof input & {
        incompleteTurnFallbackSafe: boolean;
        incompleteTurnText?: string;
      };
      expect(completion.attempt).toBe(attempt);
      expect(completion.terminalState).toBe(terminalState);
      expect(completion.retryState).toBe(retryState);
      expect(completion.incompleteTurnFallbackSafe).toBe(false);
      expect(completion.incompleteTurnText).toBe(
        outcome.status === 'failed' ? 'Format correction exhausted.' : undefined,
      );
      expect(input.sessionPromptState.clearCompactionContinuation).toHaveBeenCalledTimes(1);
      expect(retryState).toEqual({ reasoningOnlyAttempts: 0, emptyResponseAttempts: 0 });
      expect(result.result).toBe(completion);
      expect(result.result.meta.modelFallbackStopReason).toBe('tool_call_format_recovery');
    },
  );
});

describe.skipIf(!nativeFile)('handled recovery across real native completion and candidate classification', () => {
  const readNativeModule = (prefix: string, signature: string) => {
    const file = fs.readdirSync(dist).find(name =>
      name.startsWith(prefix) && name.endsWith('.mjs') &&
      fs.readFileSync(path.join(dist, name), 'utf8').includes(signature),
    );
    if (!file) throw new Error(`Missing pristine native module: ${prefix} (${signature})`);
    return fs.readFileSync(path.join(dist, file), 'utf8');
  };

  const loadNativeBoundary = (renameAttempt = false) => {
    const classifierSource = readNativeModule('result-fallback-classifier-', 'function classifyEmbeddedAgentRunResultForModelFallback(');
    const terminalHelpersSource = readNativeModule('builtin-openclaw-', 'function resolveIncompleteTurnPayloadText(');
    const entrySource = readNativeModule('run-entry-', 'modelFallbackStopReason');
    const entryAst = ts.createSourceFile('native-entry.mjs', entrySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const candidateClassifiers: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(entryAst) === 'classifyResult' &&
        ts.isArrowFunction(node.initializer) && node.initializer.getText(entryAst).includes('modelFallbackStopReason')) {
        candidateClassifiers.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(entryAst);
    expect(candidateClassifiers).toHaveLength(1);
    const context = {
      randomBytes,
      SILENT_REPLY_TOKEN: 'NO_REPLY',
      YIELD_DIAGNOSTIC_TEXT: 'yielded without continuation',
      AGENT_LANE_SUBAGENT: 'subagent',
      log$3: { debug: vi.fn(), warn: vi.fn() },
      projectAgentRunAttemptTerminal: () => ({}),
      isEmbeddedRunTerminalAbort: (outcome: { reason: string }) => outcome.reason === 'aborted',
      isEmbeddedRunTerminalTimeout: (outcome: { reason: string }) => outcome.reason === 'timed_out',
      isEmbeddedRunTerminalInterrupted: (outcome: { reason: string }) => ['aborted', 'timed_out'].includes(outcome.reason),
      classifyAgentRunTerminalOutcome: (outcome: { reason: string }) =>
        ({ completed: 'success', timed_out: 'timeout', aborted: 'cancellation', failed: 'failure' })[outcome.reason],
      classifyAssistantTurn: ({ attempt }: { attempt: { currentAttemptAssistant?: object } }) => ({
        assistant: attempt.currentAttemptAssistant, visibleText: [], emptyResponse: true, reasoningOnly: false,
      }),
      isIncompleteTerminalAssistantTurn: () => false,
      hasOnlyAssistantReasoningContent: () => false,
      hasAttemptTerminalState: () => false,
      hasCompletionMessageSessionSpawn: () => false,
      hasAcceptedSessionSpawn: () => false,
      hasAsyncActivity: () => false,
      hasCommittedMessagingToolDeliveryEvidence: () => false,
      renderAgentHarnessPreflightUserMessage: () => undefined,
      isProviderRefusalAssistantError: () => false,
      formatErrorMessage: (error: unknown) => String(error),
      markEmbeddedRunAuthProfileSuccess: vi.fn(),
      reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
      shouldContinueInteractiveAcceptedSessionSpawns: () => false,
      resolveFinalAssistantVisibleText: () => undefined,
      resolveCurrentAttemptAssistant: (attempt: { currentAttemptAssistant?: object }) => attempt.currentAttemptAssistant,
      copyAttemptDeliveryState: () => ({}),
      resolveSourceReplyDelivery: () => 'missing',
      resolveSilentToolResultReplyPayload: () => undefined,
      resolveSettledToolBatchEvidence: () => ({ intentionalTermination: false }),
      shouldTreatEmptyAssistantReplyAsSilent: ({ attempt }: { attempt: { explicitSilentReply?: boolean } }) => attempt.explicitSilentReply === true,
      resolveReplyExpectation: () => 'required',
      resolveReasoningOnlyRetryInstruction: vi.fn(() => { throw new Error('Unexpected reasoning retry'); }),
      resolveEmptyResponseRetryInstruction: vi.fn(() => { throw new Error('Unexpected empty retry'); }),
      resolveSettledToolTerminalContinuationInstruction: vi.fn(() => { throw new Error('Unexpected settled retry'); }),
      asOptionalObjectRecord: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
      hasCommittedOutboundDeliveryEvidence: () => false,
      isReplaySafeEmbeddedOpenAiCyberRefusal: () => false,
      hasVisibleAgentPayload: (result: { payloads?: { text?: string; isError?: boolean; isReasoning?: boolean }[] }) =>
        (result.payloads ?? []).some(payload => Boolean(payload.text?.trim()) && payload.text !== 'NO_REPLY' && !payload.isError && !payload.isReasoning),
      isSilentReplyPayloadText: (text: string) => text === 'NO_REPLY',
      getReplyPayloadMetadata: () => undefined,
      classifyFailoverReason: () => null,
      canFallback: undefined,
    };
    let terminalSource = `async ${extractFunction(nativeSource, 'resolveEmbeddedRunTerminal').body}`;
    if (renameAttempt) {
      const ast = ts.createSourceFile('aliased-terminal.mjs', terminalSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const renamed = ts.transform(ast, [context => {
        const visit: ts.Visitor = node => {
          if (ts.isBindingElement(node) && !node.propertyName && ts.isIdentifier(node.name) && node.name.text === 'attempt')
            return ts.factory.updateBindingElement(node, node.dotDotDotToken, ts.factory.createIdentifier('attempt'), ts.factory.createIdentifier('terminalAttempt'), node.initializer);
          if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'attempt')
            return ts.factory.createPropertyAssignment('attempt', ts.factory.createIdentifier('terminalAttempt'));
          if (ts.isIdentifier(node) && ['attempt', 'input'].includes(node.text) &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
            !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
            !(ts.isBindingElement(node.parent) && node.parent.propertyName === node))
            return ts.factory.createIdentifier(node.text === 'attempt' ? 'terminalAttempt' : 'terminalInput');
          return ts.visitEachChild(node, visit, context);
        };
        return node => ts.visitNode(node, visit) as ts.SourceFile;
      }]);
      terminalSource = ts.createPrinter().printFile(renamed.transformed[0]);
      renamed.dispose();
    }
    const terminal = support.transformRunner(terminalSource, 'native-completion-fixture.mjs');
    support.transformRunner(terminal, 'native-completion-fixture.mjs', { verifyOnly: true });
    const classifierFunctions = [
      'isEmbeddedAgentRunResult', 'hasDeliberateSilentTerminalReply', 'hasDeliverableAssistantPayload',
      'hasNonTextVisiblePayloadContent', 'classifyGenericExternalRunFailurePayload', 'classifyHarnessResult',
      'providerErrorPayloadReason', 'classifyEmbeddedAgentRunResultForModelFallback',
    ].map(name => extractFunction(classifierSource, name).body).join('\n');
    const terminalHelpers = ['resolveIncompleteTurnPayloadText', 'resolveRunLivenessState', 'hasYieldContinuationEvidence']
      .map(name => extractFunction(terminalHelpersSource, name).body).join('\n');
    return vm.runInNewContext(`
      ${terminalHelpers}
      async ${extractFunction(nativeSource, 'completeEmbeddedRun').body}
      ${classifierFunctions}
      ${terminal}
      ({ complete: completeEmbeddedRun, resolve: resolveEmbeddedRunTerminal,
         classify: classifyEmbeddedAgentRunResultForModelFallback,
         candidate: (${candidateClassifiers[0].getText(entryAst)}) })`, context);
  };

  it.each([
    ['rejected draft', 'completed', {}, true],
    ['renamed attempt binding', 'completed', {}, true],
    ['silent rejected draft', 'completed', { explicitSilentReply: true }, true],
    ['cancel', 'aborted', {}, false],
    ['timeout', 'timed_out', {}, false],
    ['approval', 'completed', { didSendDeterministicApprovalPrompt: true }, false],
    ['yield', 'completed', { yieldDetected: true, yieldMessageWaitRegistered: true }, false],
    ['client tools', 'completed', { clientToolCalls: [{ name: 'approval_client', params: {} }] }, false],
  ])('withholds a finalize-rejected draft while preserving the real %s outcome', async (_name, reason, activity, failed) => {
    const native = loadNativeBoundary(_name === 'renamed attempt binding');
    const draft = 'I have started the requested Team.';
    const assistant = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: draft }] };
    const lifecycle = vi.fn();
    const input = {
      toolCallRecoveryHandled: true, startedAtMs: Date.now(), runParams: {},
      attempt: {
        currentAttemptAssistant: assistant, currentAttemptCompletedAssistant: assistant,
        beforeAgentFinalizeRevisionReason: 'The explicitly requested Agent Team has not been started.',
        assistantTexts: [draft], terminal: {}, messagesSnapshot: [{ role: 'user', content: 'Start a Team.' }],
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        replayMetadata: { replaySafe: true, hadPotentialSideEffects: false }, ...activity,
      },
      attemptAssistant: assistant,
      terminalState: { outcome: { reason, ...(reason === 'aborted' ? { stopReason: 'rpc' } : {}) }, signalOwnedInterruption: reason === 'aborted' },
      retryState: { reasoningOnlyAttempts: 0, emptyResponseAttempts: 0, beforeFinalizeRevisionAttempts: 0 },
      replayState: { hadPotentialSideEffects: false }, settledTurnFinalizationOutcome: 'not-attempted',
      payloadsWithToolMedia: [{ text: draft }], recoveredFinalAssistantPayloadsAfterPromptTimeout: [{ text: draft }],
      finalAssistantVisibleText: draft, finalAssistantRawText: draft,
      sessionPromptState: { clearCompactionContinuation: vi.fn(), activateInternalPrompt: vi.fn() },
      resolveReplayInvalid: () => false, setTerminalLifecycleMeta: lifecycle,
      reportedModelRef: { provider: 'fixture', model: 'fixture' }, traceAttempts: [],
      contextRecoveryState: { autoCompactionCount: 0 },
    };

    const { result } = await native.resolve(input);

    expect(JSON.stringify(result)).not.toContain(draft);
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.finalAssistantRawText).toBeUndefined();
    expect(result.meta.modelFallbackStopReason).toBe('tool_call_format_recovery');
    expect(native.candidate({ result: { result, classification: native.classify({ provider: 'fixture', model: 'fixture', result }) } }))
      .toEqual({ stopReason: 'tool_call_format_recovery' });
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    expect(input.retryState.beforeFinalizeRevisionAttempts).toBe(0);
    expect(input.finalAssistantRawText).toBe(draft);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    if (failed) {
      expect(result.meta.error).toMatchObject({ kind: 'incomplete_turn', fallbackSafe: false });
      expect(result.payloads).toEqual([{ text: expect.stringContaining('finalization hook'), isError: true }]);
      expect(result.meta.executionTrace).toBeUndefined();
    } else {
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.aborted).toBe(reason === 'aborted');
      if (reason === 'aborted') expect(result.meta.stopReason).toBe('rpc');
      if (reason === 'aborted' || reason === 'timed_out') expect(result.meta.livenessState).toBe('blocked');
      if (_name === 'yield') expect(result.meta).toMatchObject({ yielded: true, livenessState: 'paused' });
      if (_name === 'client tools') expect(result.meta.pendingToolCalls).toHaveLength(1);
    }
  });

  it.each([
    ['timeout', 'timed_out', {}, false, 'empty_result'],
    ['cancel', 'aborted', {}, false, null],
    ['approval', 'completed', { didSendDeterministicApprovalPrompt: true }, false, 'empty_result'],
    ['yield', 'completed', { yieldDetected: true, yieldMessageWaitRegistered: true }, false, 'empty_result'],
    ['client tools', 'completed', { clientToolCalls: [{ name: 'approval_client', params: { value: 1 } }] }, false, 'empty_result'],
    ['empty success', 'completed', {}, false, null],
    ['deliberate silence', 'completed', { explicitSilentReply: true }, true, null],
  ])('preserves %s semantics and stops the outer candidate after ownership', async (name, reason, activity, silent, expectedClassification) => {
    const native = loadNativeBoundary();
    const terminalState = {
      outcome: { reason, ...(reason === 'aborted' ? { stopReason: 'rpc' } : {}) },
      signalOwnedInterruption: reason === 'aborted',
    };
    const attempt = { assistantTexts: [], terminal: {}, itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 }, replayMetadata: { replaySafe: true, hadPotentialSideEffects: false }, ...activity };
    const lifecycle = vi.fn();
    const input = {
      toolCallRecoveryHandled: true, startedAtMs: Date.now(), runParams: {}, attempt, terminalState,
      retryState: { reasoningOnlyAttempts: 0, emptyResponseAttempts: 0 },
      replayState: { hadPotentialSideEffects: false }, settledTurnFinalizationOutcome: 'not-attempted',
      sessionPromptState: { clearCompactionContinuation: vi.fn() },
      resolveReplayInvalid: () => false, setTerminalLifecycleMeta: lifecycle,
      reportedModelRef: { provider: 'fixture', model: 'fixture' }, traceAttempts: [],
      contextRecoveryState: { autoCompactionCount: 0 },
      ...(silent ? { finalAssistantRawText: 'NO_REPLY' } : {}),
    };

    const completion = await native.resolve(input);
    const result = completion.result;
    const classification = native.classify({ provider: 'fixture', model: 'fixture', result });
    const candidate = native.candidate({ result: { result, classification } });

    expect(completion.action).toBe('complete');
    expect(input.terminalState).toBe(terminalState);
    expect(result.meta.modelFallbackStopReason).toBe('tool_call_format_recovery');
    expect(result.meta.aborted).toBe(reason === 'aborted');
    expect(result.meta.replayInvalid).toBe(false);
    expect(classification?.code ?? null).toBe(expectedClassification);
    expect(candidate).toEqual({ stopReason: 'tool_call_format_recovery' });
    expect(lifecycle).toHaveBeenCalledTimes(1);
    if (name === 'empty success') {
      expect(result.meta.error).toMatchObject({ kind: 'incomplete_turn', fallbackSafe: false });
      expect(result.payloads[0].isError).toBe(true);
    } else {
      expect(result.meta.error).toBeUndefined();
    }
    if (name === 'timeout' || name === 'cancel') expect(result.meta.livenessState).toBe('blocked');
    if (name === 'cancel') expect(result.meta.stopReason).toBe('rpc');
    if (name === 'yield') expect(result.meta).toMatchObject({ yielded: true, livenessState: 'paused', stopReason: 'end_turn' });
    if (name === 'client tools') {
      expect(result.meta.stopReason).toBe('tool_calls');
      expect(result.meta.pendingToolCalls).toEqual([expect.objectContaining({ name: 'approval_client', arguments: '{"value":1}' })]);
    }
    if (silent) {
      expect(result.payloads).toEqual([{ text: 'NO_REPLY' }]);
      expect(result.meta.terminalReplyKind).toBe('silent-empty');
    }
  });

  it('preserves an existing native fallback stop reason and the completion identity', async () => {
    const native = loadNativeBoundary();
    const completion = { action: 'complete', result: { meta: { modelFallbackStopReason: 'agent_run_terminal_timeout' } } };
    const transformed = support.transformRunner(`async ${extractFunction(nativeSource, 'resolveEmbeddedRunTerminal').body}`, 'native-existing-stop-fixture.mjs');
    const resolve = vm.runInNewContext(`${transformed}; resolveEmbeddedRunTerminal`, {
      projectAgentRunAttemptTerminal: () => ({}),
      isEmbeddedRunTerminalAbort: () => false, isEmbeddedRunTerminalTimeout: () => true,
      isEmbeddedRunTerminalInterrupted: () => true, resolveSilentToolResultReplyPayload: () => undefined,
      resolveSettledToolBatchEvidence: () => ({ intentionalTermination: false }),
      shouldTreatEmptyAssistantReplyAsSilent: () => false, resolveReplyExpectation: () => 'required',
      resolveSourceReplyDelivery: () => 'missing', resolveIncompleteTurnPayloadText: () => null,
      completeEmbeddedRun: async () => completion,
    });

    const result = await resolve({
      toolCallRecoveryHandled: true, runParams: {}, attempt: { terminal: {} },
      terminalState: { outcome: { reason: 'timed_out' } }, replayState: {},
      settledTurnFinalizationOutcome: 'not-attempted', sessionPromptState: { clearCompactionContinuation: vi.fn() },
    });

    expect(result).toBe(completion);
    expect(result.result.meta.modelFallbackStopReason).toBe('agent_run_terminal_timeout');
    expect(native.candidate({ result: { result: result.result, classification: { code: 'empty_result' } } }))
      .toEqual({ stopReason: 'agent_run_terminal_timeout' });
  });
});
