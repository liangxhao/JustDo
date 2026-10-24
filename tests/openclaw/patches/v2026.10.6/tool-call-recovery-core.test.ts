/* eslint-disable @typescript-eslint/no-explicit-any -- Execute locked native owners with explicit integration seams. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

import * as facts from '../../../../plugins/extensions/runtime-services/tool-call-recovery/facts.mjs';
import * as loop from '../../../../plugins/extensions/runtime-services/tool-call-recovery/loop.mjs';
import { resolveToolCallRecovery } from '../../../../plugins/extensions/runtime-services/tool-call-recovery/policy.mjs';

const { __testing: patch } = require('../../../../scripts/patches/v2026.10.6/029-tool-call-format-recovery.cjs');
const root = path.resolve(__dirname, '../../../..');
const dist = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? path.join(root, 'build/runtimes/openclaw/win-x64'), 'dist');
const file = fs.existsSync(dist) && fs.readdirSync(dist).find(name => /^agent-core-.*\.mjs$/.test(name) &&
  fs.readFileSync(path.join(dist, name), 'utf8').includes('function streamAgentResponse('));
const source = file ? patch.transformCore(fs.readFileSync(path.join(dist, file), 'utf8'), file) : '';
const sdkRoot = path.join(process.env.OPENCLAW_RUNTIME_DIR ?? path.join(root, 'build/runtimes/openclaw/win-x64'), 'node_modules/@openclaw/ai');
const sdkDist = path.join(sdkRoot, 'dist');
const completionsFile = path.join(sdkDist, 'openai-completions-transport-BRjxCG1C.mjs');
const model = { api: 'openai-completions', provider: 'fixture', id: 'model' };
// Keep published package imports in Node's loader, including relative module URLs.
const nativeImport = vm.compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (url: string) => Promise<any>;
const rejected = () => ({ role: 'assistant', stopReason: 'error', errorCode: 'malformed_tool_call_arguments',
  errorMessage: 'Provider returned an incomplete or malformed tool call', content: [], responseId: 'response',
  usage: { totalTokens: 17 }, diagnostics: [{ type: 'tool_call_pre_dispatch_rejection', timestamp: 1,
    details: { batchRejected: true, streamComplete: true, dispatchCount: 0 } }] });
const feedback = { role: 'custom', customType: 'runtime-services.tool-call-validation', content: 'Correct the rejected JSON object.',
  display: false, timestamp: 1 };
const owner = () => ({ state: { attempts: 0, claimed: false }, observe: facts.observeToolCallRecoveryResponse,
  resolve: resolveToolCallRecovery, isInitialModel: () => true, isAborted: () => false, hasBudget: () => true,
  assertActive: vi.fn(), consumeBudget: vi.fn(), onDecision: vi.fn(), onRetry: vi.fn() });

function findNativeOwner(name: string, prefix: string) {
  const nativeFile = fs.readdirSync(dist).find(candidate => candidate.startsWith(prefix) && candidate.endsWith('.mjs') &&
    fs.readFileSync(path.join(dist, candidate), 'utf8').includes(`function ${name}(`));
  expect(nativeFile, name).toBeDefined();
  return fs.readFileSync(path.join(dist, nativeFile!), 'utf8');
}

function streamFixture(options: { hook?: boolean; prefix?: boolean; delayed?: boolean; resultFailure?: Error } = {}) {
  const original = rejected();
  const runOwner = owner();
  const events: any[] = [];
  const messages = [{ role: 'user', content: 'Inspect' }];
  const newMessages: any[] = [];
  let executionSignal: AbortSignal;
  let release: () => void;
  let resultRead = false;
  const gate = options.delayed ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const response = {
    async *[Symbol.asyncIterator]() {
      if (options.prefix) {
        const call = { type: 'toolCall', id: 'earlier', name: 'fixture', arguments: {}, async: true };
        const partial = { ...original, stopReason: 'toolUse', content: [call] };
        yield { type: 'start', partial };
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial };
      } else yield { type: 'start', partial: original };
      yield { type: 'error', error: original };
    },
    async result() {
      resultRead = true;
      await gate;
      if (options.resultFailure) throw options.resultFailure;
      return original;
    },
  };
  const streamFn = vi.fn((_model, _context, settings) => { executionSignal = settings.signal; return response; });
  const execute = vi.fn(async () => ({ messages: [], steeringMessages: [], terminate: false }));
  const context = { messages, tools: [] };
  const code = ['removeNonExecutableToolCalls', 'ensureToolTurnIdentity', 'resolveAssistantMessageUpdate', 'streamAgentResponse']
    .map(name => (name === 'streamAgentResponse' ? 'async ' : '') + patch.extractFunction(source, name).body).join('\n');
  const native = vm.runInNewContext(code + '; streamAgentResponse', {
    ...facts, ...loop, AbortController, AbortSignal, Error, Set, Promise,
    normalizeCoreContextMessages: (value: any) => value,
    resolveAgentCoreStreamFn: (_runtime: any, fn: any) => fn,
    createStreamSteering: () => ({ onActiveResponse: vi.fn(), finish: async () => false }),
    runAgentCoreStream: (_stream: any, run: any) => run(),
    isResponsesOutputLimitToolCallError: () => false, uuidv7: () => 'native-turn',
    createEmptyTransportUsage: () => ({ totalTokens: 0 }),
    replaceCompactionReplayOwnerContent: (message: any, content: any) => ({ ...message, content }),
  });
  const config = { model, convertToLlm: (value: any) => value,
    ...(options.hook === false ? {} : { toolCallRecovery: loop.createToolCallValidationRecovery(runOwner) }) };
  return { original, runOwner, events, newMessages, execute, streamFn,
    get signal() { return executionSignal!; }, get resultRead() { return resultRead; },
    release: () => release!(),
    start: () => native(context, config, undefined, (event: any) => events.push(event), newMessages, execute, (value: any) => value, streamFn),
  };
}

function loopFixture(options: { prepareStop?: boolean; policyStop?: boolean; abort?: boolean; modelSwitch?: boolean } = {}) {
  const controller = new AbortController();
  const events: any[] = [];
  const context = { messages: [{ role: 'user', content: 'Inspect' }], tools: [] };
  const state = { context };
  const newMessages: any[] = [];
  const first = { ...rejected(), stopReason: 'stop', endTurn: false };
  const second = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] };
  const stream = vi.fn(async (current: any) => {
    const message = stream.mock.calls.length === 1 ? first : second;
    if (message === second) expect(current.messages).toContain(feedback);
    current.messages.push(message); newMessages.push(message);
    return { message, executedIds: new Set(), batches: [], continuationRequired: false,
      ...(message === first ? { toolCallRecoveryFeedback: feedback, toolCallRecoveryModel: { ...model } } : {}) };
  });
  const prepare = vi.fn(async () => {
    if (stream.mock.calls.length === 1) expect(context.messages).not.toContain(feedback);
    if (options.abort) controller.abort(new Error('Stopped'));
    return { stop: options.prepareStop, ...(options.modelSwitch ? { model: { ...model, id: 'switched' } } : {}) };
  });
  const policy = vi.fn(async () => {
    if (stream.mock.calls.length === 1) expect(context.messages).not.toContain(feedback);
    return options.policyStop === true;
  });
  const config = { model, prepareNextTurn: prepare, shouldStopAfterTurn: policy, getFollowUpMessages: async () => [] };
  const code = 'async ' + patch.extractFunction(source, 'runLoop').body;
  const run = vm.runInNewContext(code + '; runLoop', {
    ...loop, Error, Set, Object, Array, isActiveTurnTainted: () => false, getSteeringAtCheckpoint: () => [],
    orderSystemUpdateMessages: (value: any) => value, withAssistantTurnTaint: (value: any) => value,
    getInternalSteeringQueueObserver: () => undefined, createToolPlanState: () => ({}),
    createStreamedSteeringConfig: () => ({ config, getTerminalConfig: () => config }),
    streamAgentResponse: stream, toolResultTaintsTurn: () => false,
    executeToolCalls: vi.fn(() => { throw new Error('Unexpected tool execution'); }),
    createFailureMessage: (_model: any, error: Error, aborted: boolean) => ({ role: 'assistant',
      stopReason: aborted ? 'aborted' : 'error', errorMessage: error.message, content: [] }),
    isTurnHandoffAbort: () => false, appendInterruptedTurnMessage: vi.fn(),
  });
  return { stream, prepare, policy, events, context, start: () => run(state, newMessages, config, controller.signal, (event: any) => events.push(event)) };
}

describe.skipIf(!file)('format validation in the actual native stream and loop', () => {
  it('delivers plugin feedback through native historical-context filtering and LLM conversion', async () => {
    const contextSource = findNativeOwner('stripHistoricalRuntimeContextCustomMessages', 'internal-runtime-context-');
    const messageSource = findNativeOwner('convertToLlm', 'messages-');
    const functions = [
      ...['getOpenClawSystemUpdateKind', 'isRuntimeContextCarrier', 'convertToLlm']
        .map(name => patch.extractFunction(messageSource, name).body),
      ...['isOpenClawRuntimeContextCustomMessage', 'isUserMessage', 'isRetainedRuntimeContextMessage',
        'steeringRuntimeContextToken', 'isSteeringRuntimeContextPair', 'stripHistoricalRuntimeContextCustomMessages']
        .map(name => patch.extractFunction(contextSource, name).body),
    ];
    const native = vm.runInNewContext(functions.join('\n') + '; ({ stripHistoricalRuntimeContextCustomMessages, convertToLlm })', {
      retainedRuntimeContextMessages: new WeakMap(), STEERING_RUNTIME_CONTEXT: Symbol.for('openclaw.steeringRuntimeContext'),
      OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE: 'openclaw.runtime-context',
      asOptionalRecord: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
    });
    const correction = await loop.createToolCallValidationRecovery(owner())(rejected(), {
      model, executedCount: 0, committedCount: 0, batchCount: 0, aborted: false,
    });
    const prefix = [{ role: 'user', content: 'Inspect', timestamp: 1 }, { role: 'assistant', content: [], stopReason: 'stop', timestamp: 2 }];
    // The failed real Gateway candidate used an unretained runtime-context carrier.
    const filtered = native.stripHistoricalRuntimeContextCustomMessages([...prefix, {
      ...correction, customType: 'openclaw.system-update', details: { kind: 'runtime-context', turnScoped: true },
    }]);
    expect(filtered).toHaveLength(prefix.length);
    for (const value of [correction, structuredClone(correction)]) {
      const projected = native.convertToLlm(native.stripHistoricalRuntimeContextCustomMessages([...prefix, value]));
      expect(projected.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: correction.content }], timestamp: correction.timestamp });
      expect(projected.slice(0, -1)).toEqual(prefix);
      expect(value).toMatchObject({ role: 'custom', display: false });
    }
    const historyOnly = await loop.createToolCallValidationRecovery(owner())({ ...rejected(), diagnostics: [] }, {
      model, executedCount: 0, committedCount: 0, batchCount: 0, aborted: false,
    });
    expect(historyOnly).toBeUndefined();
  });

  it.skipIf(!fs.existsSync(completionsFile)).each([
    { sessionVersion: 3, inHistorySystemUpdates: false },
    { sessionVersion: 3, inHistorySystemUpdates: true },
    { sessionVersion: 4, inHistorySystemUpdates: false },
    { sessionVersion: 4, inHistorySystemUpdates: true },
  ])('preserves hidden feedback through the real boundary and Completions conversion: %j', async options => {
    expect(JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version).toBe('2026.10.6');
    const contextSource = findNativeOwner('stripHistoricalRuntimeContextCustomMessages', 'internal-runtime-context-');
    const messageSource = findNativeOwner('convertToLlm', 'messages-');
    const boundarySource = findNativeOwner('normalizeMessagesForLlmBoundary', 'attempt-system-prompt-prepare-');
    const declarations = [
      ...['getOpenClawSystemUpdateKind', 'isOpenClawSystemUpdateMessage', 'isRuntimeContextCarrier', 'convertToLlm']
        .map(name => patch.extractFunction(messageSource, name).body),
      ...['isOpenClawRuntimeContextCustomMessage', 'isUserMessage', 'isRetainedRuntimeContextMessage',
        'steeringRuntimeContextToken', 'isSteeringRuntimeContextPair', 'stripHistoricalRuntimeContextCustomMessages',
        'escapeInternalRuntimeContextDelimiters'].map(name => patch.extractFunction(contextSource, name).body),
      ...['usesEscapedRuntimeContext', 'projectRuntimeContextMessages', 'normalizeMessagesForLlmBoundary',
        'stripUnsafeBlockedRunMetadata'].map(name => patch.extractFunction(boundarySource, name).body),
    ];
    const native = vm.runInNewContext(declarations.join('\n') + '; ({ normalizeMessagesForLlmBoundary, convertToLlm })', {
      retainedRuntimeContextMessages: new WeakMap(), STEERING_RUNTIME_CONTEXT: Symbol.for('openclaw.steeringRuntimeContext'),
      OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE: 'openclaw.runtime-context',
      INTERNAL_RUNTIME_CONTEXT_BEGIN: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
      INTERNAL_RUNTIME_CONTEXT_END: '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN: '[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]',
      ESCAPED_INTERNAL_RUNTIME_CONTEXT_END: '[[OPENCLAW_INTERNAL_CONTEXT_END]]',
      asOptionalRecord: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
      asOptionalObjectRecord: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
      // Unrelated replay, media and persisted-user projection are explicit seams.
      // The actual boundary owns carrier filtering, versioning and projection.
      materializeSteeringRuntimeContext: (messages: unknown[]) => messages,
      normalizeAssistantReplayContent: (messages: unknown[]) => messages,
      stripToolResultDetails: (messages: unknown[]) => messages,
      resolveUserTranscriptMessages: () => undefined,
      projectRecordedModelPrompt: (message: unknown) => message,
      normalizeUserMessagesForLlmBoundary: (messages: unknown[]) => messages,
    });
    const [provider, runtimeTypes, transport, simpleOptions, host] = await Promise.all([
      'assistant-output-DDZq4a3j.mjs', 'types-CQc6JNG4.mjs', 'transport-stream-shared-Dr_GBa9K.mjs',
      'simple-options-CmtE6whA.mjs', 'host-CIzdzpBn.mjs',
    ].map(name => nativeImport(pathToFileURL(path.join(sdkDist, name)).href)));
    const convert = vm.runInNewContext(patch.extractFunction(fs.readFileSync(completionsFile, 'utf8'), 'convertMessages').body + '; convertMessages', {
      // Preserve the real SDK transcript transform and user/runtime classification.
      transformProviderMessages: provider.n, isRuntimeContextMessage: runtimeTypes.p,
      hasRuntimeContextMarker: runtimeTypes.f, runtimeContextContentToText: runtimeTypes._,
      sanitizeSurrogates: transport.P, sanitizeNonEmptyTransportPayloadText: transport._,
      extractToolResultText: simpleOptions.m, describeToolResultMediaPlaceholder: simpleOptions.d,
      isImageWithMediaPayload: host.N,
    });
    const correction = await loop.createToolCallValidationRecovery(owner())(rejected(), {
      model, executedCount: 0, committedCount: 0, batchCount: 0, aborted: false,
    });
    expect(Object.keys(correction).sort()).toEqual(['content', 'customType', 'display', 'role', 'timestamp']);
    expect(correction).toMatchObject({ role: 'custom', customType: 'runtime-services.tool-call-validation', display: false });
    const previousCall = { type: 'toolCall', id: 'completed-write', name: 'exec', arguments: { command: 'write A' } };
    const prefix = [
      { role: 'user', content: 'Inspect', timestamp: 1 },
      { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [previousCall], stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: previousCall.id, toolName: 'exec', content: [{ type: 'text', text: 'A' }], isError: false, timestamp: 3 },
      { role: 'assistant', content: [], stopReason: 'stop', endTurn: false, timestamp: 4 },
    ];
    for (const value of [correction, structuredClone(correction)]) {
      const original = structuredClone(value);
      // appendOnlyRuntimeContext is deliberately absent: exercise native defaults.
      const boundaryOptions = { ...options, projectPersistedSenderContext: false };
      expect(boundaryOptions).not.toHaveProperty('appendOnlyRuntimeContext');
      const normalized = native.normalizeMessagesForLlmBoundary([...prefix, value], boundaryOptions);
      expect(normalized.at(-1)).toEqual(original);
      const projected = native.convertToLlm(normalized);
      expect(projected.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: correction.content }], timestamp: correction.timestamp });
      const wire = convert({ ...model, input: ['text'] }, { messages: projected }, { supportsDeveloperRole: true });
      expect(wire).toEqual([
        { role: 'user', content: 'Inspect' },
        { role: 'assistant', content: null, tool_calls: [{ id: previousCall.id, type: 'function',
          function: { name: 'exec', arguments: JSON.stringify(previousCall.arguments) } }] },
        { role: 'tool', content: 'A', tool_call_id: previousCall.id },
        { role: 'user', content: [{ type: 'text', text: correction.content }] },
      ]);
      expect(value).toEqual(original);
    }
  });

  it('keeps complete current source byte-preserving and rejects a partial early abort fence', () => {
    expect(patch.transformCore(source, file, { verifyOnly: true })).toBe(source);
    expect(patch.transformCore(source, file)).toBe(source);
    const changed = source.replace('executedIds.size === 0', 'executedIds.size >= 0');
    expect(changed).not.toBe(source);
    expect(() => patch.transformCore(changed, file, { verifyOnly: true })).toThrow(/partial/);
  });

  it('binds renamed native owners produced by a real esbuild collision graph', async () => {
    const native = fs.readFileSync(path.join(dist, file!), 'utf8');
    const collisionNames = ['config', 'result', 'terminal', 'executedIds', 'batches', 'executionSignal',
      'committedContentCount', 'streamed', 'pendingMessages', 'nextTurnSnapshot'];
    const graph = await build({
      stdin: { contents: 'export * from "collision"; export * from "native-core";' },
      bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{ name: 'native-core-aliases', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => ['collision', 'native-core'].includes(args.path)
          ? { path: args.path, namespace: 'core-fixture' } : { path: args.path, external: true });
        builder.onLoad({ filter: /.*/, namespace: 'core-fixture' }, args => ({
          contents: args.path === 'collision' ? `export const ${collisionNames.map(name => name + '=1').join(',')};`
            : native + '\nexport { streamAgentResponse, runLoop };', loader: 'js',
        }));
      } }],
    });
    const bundled = graph.outputFiles[0].text;
    expect(bundled).toMatch(/function streamAgentResponse\(\w+, config2,/);
    expect(bundled).toMatch(/const result2 = await/);
    const patched = patch.transformCore(bundled, 'gateway-bundle.mjs');
    expect(patched).toContain('prepareToolCallValidationHandoff(config2, result2,');
    expect(patch.transformCore(patched, 'gateway-bundle.mjs', { verifyOnly: true })).toBe(patched);
  });

  it('commits a nonterminal copy and returns native runtime feedback without fake calls/results', async () => {
    const h = streamFixture();
    const result = await h.start();
    expect(h.original.stopReason).toBe('error');
    expect(result.message).toMatchObject({ stopReason: 'stop', endTurn: false, usage: h.original.usage });
    expect(result.toolCallRecoveryFeedback).toMatchObject({ role: 'custom', customType: 'runtime-services.tool-call-validation' });
    expect(h.events.filter(event => event.type === 'message_end').map(event => event.message.stopReason)).toEqual(['stop']);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.runOwner.state.attempts).toBe(1);
  });

  it.each([{ hook: false }, { prefix: true }])('retains early native cancellation before delayed result: %j', async options => {
    const h = streamFixture({ ...options, delayed: true });
    const pending = h.start();
    for (let i = 0; i < 30 && !h.resultRead; i++) await Promise.resolve();
    expect(h.resultRead).toBe(true);
    expect(h.signal.aborted).toBe(true);
    h.release();
    expect((await pending).message.stopReason).toBe('error');
    expect(h.runOwner.consumeBudget).not.toHaveBeenCalled();
  });

  it('passes a result failure through unchanged after fencing a committed async prefix', async () => {
    const failed = new Error('Provider result disconnected');
    const h = streamFixture({ prefix: true, delayed: true, resultFailure: failed });
    const pending = h.start();
    for (let i = 0; i < 30 && !h.resultRead; i++) await Promise.resolve();
    expect(h.signal.aborted).toBe(true);
    h.release();
    await expect(pending).rejects.toBe(failed);
    expect(h.runOwner.consumeBudget).not.toHaveBeenCalled();
  });

  it('runs native preparation and stop policy before committing correction feedback', async () => {
    const h = loopFixture();
    await h.start();
    expect(h.stream).toHaveBeenCalledTimes(2);
    expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.policy).toHaveBeenCalledTimes(2);
    expect(h.events.filter(event => event.type === 'agent_end')).toHaveLength(1);
  });

  it.each([{ prepareStop: true }, { policyStop: true }])('surfaces a native policy stop without sending/committing the correction: %j', async options => {
    const h = loopFixture(options);
    await expect(h.start()).rejects.toThrow('stopped by native turn policy');
    expect(h.context.messages).not.toContain(feedback);
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('does not transfer a correction to a model selected by native preparation', async () => {
    const h = loopFixture({ modelSwitch: true });
    await expect(h.start()).rejects.toThrow('model changed before continuation');
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.context.messages).not.toContain(feedback);
  });

  it('honors cancellation during native preparation and retains aborted terminal evidence', async () => {
    const h = loopFixture({ abort: true });
    await h.start();
    expect(h.context.messages).not.toContain(feedback);
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.events.filter(event => event.type === 'message_end').at(-1).message.stopReason).toBe('aborted');
  });
});
