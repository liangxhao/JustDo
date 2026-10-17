import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const { __testing: { transformProducer, transformCandidate, extractFunction, transformResultTypes } } =
  require('../../../../scripts/patches/v2026.10.4/030-tool-call-format-recovery.cjs');
const { nodes } = require('../../../../scripts/openclaw/native-support-contract.cjs');

type ToolBlock = { type: string; name?: string; partialArgs?: string; arguments?: unknown; text?: string; phase?: string };
type FixtureOutput = {
  stopReason: string;
  content: ToolBlock[];
  errorCode?: string;
  errorMessage?: string;
  diagnostics?: Array<{ type: string; timestamp?: number; details?: { batchRejected: boolean; streamComplete: boolean; dispatchCount: number } }>;
};

// Preserve the locked producer's atomic validation and stream-completion seams.
const finalizer = `function finalizeOpenAICompletionsToolCalls(output, options = {}) {
  const isToolCall = block => block.type === 'toolCall';
  const hasToolCalls = output.content.some(isToolCall);
  if (output.stopReason === 'toolUse' && !hasToolCalls) output.stopReason = 'stop';
  if (output.stopReason === 'stop' && hasToolCalls && options.allowSilentToolCallPromotion !== false && !output.content.some(block => block.type === 'text' && block.text.trim())) output.stopReason = 'toolUse';
  if (output.stopReason !== 'toolUse') { output.content = output.content.filter(block => !isToolCall(block)); return; }
  const toolCalls = output.content.filter(isToolCall);
  const rejectToolCalls = () => {
    output.stopReason = 'error';
    output.errorMessage = 'Provider returned an incomplete or malformed tool call';
    output.content = output.content.filter(block => !isToolCall(block));
  };
  if (toolCalls.some(call => typeof call.name !== 'string' || !call.name.trim() || typeof call.partialArgs !== 'string' || !call.partialArgs.trim())) { rejectToolCalls(); return; }
  try { finalizeTerminalToolCallArguments(toolCalls, call => call.partialArgs); }
  catch { rejectToolCalls(); return; }
  for (let index = 0; index < output.content.length; index++) {
    const block = output.content[index];
    if (!isToolCall(block)) continue;
    delete block.partialArgs;
    options.onConfirmedToolCall?.(block, index);
  }
}`;
const stream = `async function processCompletionsStream(response, output, model, target, options) {
  let finishReason;
  for await (const chunk of response) {
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.block) output.content.push(chunk.block);
  }
  if (!finishReason && (options?.mode === 'direct' || options?.sawStreamDONE?.() === false)) throw new Error('Stream ended without finish_reason');
  finalizeOpenAICompletionsToolCalls(output, {
    allowSilentToolCallPromotion: finishReason === 'stop' || options?.sawStreamDONE?.() === true,
    onConfirmedToolCall(block) { target.push(block); }
  });
}`;
const producer = `${finalizer}\n${stream}`;
const streamingPatch = require('../../../../scripts/patches/v2026.10.4/029-reasoning-completions-streaming.cjs');
const transportPath = path.join(
  process.env.OPENCLAW_RUNTIME_DIR ?? path.resolve(__dirname, '../../../../vendor/openclaw-runtime/current'),
  'node_modules/@openclaw/ai/dist/openai-completions-transport-QYABn8Uz.mjs',
);
const malformed = (name = 'tool_describe', args = '<id>ask-user-question</id>') =>
  ({ type: 'toolCall', name, partialArgs: args });

function runFixture(source = producer) {
  const patched = transformProducer(source, 'fixture.mjs');
  const confirmed = vi.fn();
  const context = vm.createContext({
    finalizeTerminalToolCallArguments(calls: ToolBlock[], read: (call: ToolBlock) => string) {
      const parsed = calls.map(call => {
        const value: unknown = JSON.parse(read(call));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
        return [call, value] as const;
      });
      for (const [call, value] of parsed) call.arguments = value;
    },
  });
  const api = vm.runInContext(`${patched}; ({ finalizeOpenAICompletionsToolCalls, processCompletionsStream })`, context);
  return { api, patched, confirmed };
}

describe('tool-call recovery producer', () => {
  it.skipIf(!fs.existsSync(transportPath))('composes with normalized reasoning streaming in both orders without changing current bytes', () => {
    const source = fs.readFileSync(transportPath, 'utf8');
    const streamFirst = transformProducer(streamingPatch.__testing.transform(source, transportPath), transportPath);
    const recoveryFirst = streamingPatch.__testing.transform(transformProducer(source, transportPath), transportPath);
    for (const combined of [streamFirst, recoveryFirst]) {
      expect(combined).toContain('structuredTextStreaming');
      expect(combined).toContain('terminalStreamComplete');
      expect(combined).toContain('tool_call_pre_dispatch_rejection');
      expect(transformProducer(combined, transportPath)).toBe(combined);
      expect(streamingPatch.__testing.transform(combined, transportPath)).toBe(combined);
    }
  });

  it.each([producer, transformSync(producer, { minify: true }).code])('preserves complete-batch rejection in source and worker syntax', source => {
    const { api, confirmed } = runFixture(source);
    const output: FixtureOutput = { stopReason: 'toolUse', content: [malformed('read', '{}'), malformed()] };
    api.finalizeOpenAICompletionsToolCalls(output, { terminalStreamComplete: true, onConfirmedToolCall: confirmed });
    expect(confirmed).not.toHaveBeenCalled();
    expect(output.content).toEqual([]);
    expect(output.errorCode).toBe('malformed_tool_call_arguments');
    expect(output.diagnostics).toEqual([{
      type: 'tool_call_pre_dispatch_rejection', timestamp: expect.any(Number),
      details: { batchRejected: true, streamComplete: true, dispatchCount: 0 },
    }]);
    expect(JSON.stringify(output)).not.toContain('<id>');
  });

  it.each(['<id>private</id>', '{"command":"incomplete', '[]', 'null', '"value"'])('rejects %s without repairing or dispatching it', args => {
    const { api, confirmed } = runFixture();
    const output: FixtureOutput = { stopReason: 'toolUse', content: [malformed('exec', args)] };
    api.finalizeOpenAICompletionsToolCalls(output, { terminalStreamComplete: true, onConfirmedToolCall: confirmed });
    expect(confirmed).not.toHaveBeenCalled();
    expect(output.stopReason).toBe('error');
  });

  it('does not claim stream completion when called by cleanup or without terminal proof', () => {
    const { api } = runFixture();
    const output: FixtureOutput = { stopReason: 'toolUse', content: [malformed()], diagnostics: [{ type: 'existing' }] };
    api.finalizeOpenAICompletionsToolCalls(output);
    expect(output.diagnostics?.[0]).toEqual({ type: 'existing' });
    expect(output.diagnostics?.[1].details?.streamComplete).toBe(false);
    // This is the native projection's Object.assign behavior for a plain Error.
    Object.assign(output, { stopReason: 'error', errorMessage: new Error(output.errorMessage).message });
    api.finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
    expect(output.errorCode).toBe('malformed_tool_call_arguments');
    expect(output.diagnostics).toHaveLength(2);
    Object.assign(output, { stopReason: 'aborted' });
    expect(output.stopReason).toBe('aborted');
  });

  it('sets proof only after a naturally completed stream, preserves commentary, and keeps stop conflict behavior', async () => {
    const { api } = runFixture();
    const text = { type: 'text', text: '正在检查', phase: 'commentary' };
    const output: FixtureOutput = { stopReason: 'toolUse', content: [text] };
    const target: ToolBlock[] = [];
    await api.processCompletionsStream([{ block: malformed() }, { finishReason: 'tool_calls' }], output, {}, target, { mode: 'direct' });
    expect(output.content).toEqual([text]);
    expect(output.diagnostics?.[0].details?.streamComplete).toBe(true);
    expect(target).toEqual([]);
    const conflict: FixtureOutput = { stopReason: 'stop', content: [text, malformed()] };
    api.finalizeOpenAICompletionsToolCalls(conflict, { terminalStreamComplete: true });
    expect(conflict.stopReason).toBe('stop');
    expect(conflict.diagnostics).toBeUndefined();
  });

  it('does not mint proof for missing finish, thrown transport errors, or invalid stream completion callbacks', async () => {
    const { api } = runFixture();
    const output: FixtureOutput = { stopReason: 'toolUse', content: [] };
    await expect(api.processCompletionsStream([{ block: malformed() }], output, {}, [], { mode: 'direct' })).rejects.toThrow('without finish_reason');
    expect(output.diagnostics).toBeUndefined();
    async function* interrupted() { yield { finishReason: 'tool_calls' }; throw new Error('connection reset'); }
    await expect(api.processCompletionsStream(interrupted(), output, {}, [], {})).rejects.toThrow('connection reset');
    expect(output.diagnostics).toBeUndefined();
    const unknown: FixtureOutput = { stopReason: 'toolUse', content: [malformed()] };
    await api.processCompletionsStream([], unknown, {}, [], {});
    expect(unknown.diagnostics?.[0].details?.streamComplete).toBe(false);
  });

  it('keeps ordinary valid calls executable and scratch-free', () => {
    const { api, confirmed } = runFixture();
    const output: FixtureOutput = { stopReason: 'toolUse', content: [malformed('read', '{"path":"file"}')] };
    api.finalizeOpenAICompletionsToolCalls(output, { terminalStreamComplete: true, onConfirmedToolCall: confirmed });
    expect(confirmed).toHaveBeenCalledOnce();
    expect(output.content[0]).toMatchObject({ arguments: { path: 'file' } });
    expect(output.content[0]).not.toHaveProperty('partialArgs');
    expect(output.diagnostics).toBeUndefined();
  });

  it('accepts current source/bundle renaming and rejects pristine, partial, and weakened proof', () => {
    const patched = transformProducer(producer, 'native.mjs');
    expect(transformProducer(patched, 'native.mjs', { verifyOnly: true })).toBe(patched);
    const bundled = transformSync(patched.replaceAll('finalizeOpenAICompletionsToolCalls', 'finalizeOpenAICompletionsToolCalls$2'), { minify: true }).code;
    expect(transformProducer(bundled, 'gateway-bundle.mjs', { verifyOnly: true })).toBe(bundled);
    expect(() => transformProducer(producer, 'native.mjs', { verifyOnly: true })).toThrow('not applied');
    for (const [pattern, replacement] of [
      [/streamComplete:\s*options\.terminalStreamComplete\s*===\s*true/, 'streamComplete: true'],
      [/dispatchCount:\s*0/, 'dispatchCount: 1'],
    ] as const) {
      const weakened = patched.replace(pattern, replacement);
      expect(weakened).not.toBe(patched);
      expect(() => transformProducer(weakened, 'native.mjs')).toThrow('partial');
    }
    expect(() => transformProducer(`${extractFunction(patched, 'finalizeOpenAICompletionsToolCalls').body}\n${stream}`, 'native.mjs')).toThrow('partial');
  });
});

const root = path.resolve(__dirname, '../../../..');
const candidateDist = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? path.join(root, 'vendor/openclaw-runtime/current'), 'dist');
const candidateFile = fs.existsSync(candidateDist) && fs.readdirSync(candidateDist).find(name =>
  /^agent-runner\.runtime-.*\.mjs$/.test(name) && fs.readFileSync(path.join(candidateDist, name), 'utf8').includes('function runAgentFallbackCandidates('));
const nativeCandidates = candidateFile ? fs.readFileSync(path.join(candidateDist, candidateFile), 'utf8') : '';
const candidateBodies = nativeCandidates ? ['runAgentFallbackCandidates', 'runEmbeddedFallbackCandidate']
  .map(name => 'async ' + extractFunction(nativeCandidates, name).body).join('\n') : '';
function candidateObjects(source: string) {
  const outer = extractFunction(source, 'runAgentFallbackCandidates');
  const inner = extractFunction(source, 'runEmbeddedFallbackCandidate');
  const callback = nodes(outer.fn, (node: ts.Node) => ts.isPropertyAssignment(node) && node.name.getText() === 'runCandidate')[0].initializer;
  const common = nodes(callback.body, (node: ts.Node) => ts.isVariableDeclaration(node) && node.name.getText() === 'common')[0];
  const argument = nodes(callback.body, (node: ts.Node) => ts.isCallExpression(node) && /^runEmbeddedFallbackCandidate(?:\$\d+|\d+)?$/.test(node.expression.getText()))[0].arguments[0];
  const embedded = nodes(inner.fn, (node: ts.Node) => ts.isObjectLiteralExpression(node) && node.properties.some(property => property.name?.getText() === 'isFinalFallbackAttempt'))[0];
  return { outer, inner, callback, common, argument, embedded };
}
function replaceCandidateNode(source: string, part: { start: number }, node: ts.Node, replacement: string) {
  return source.slice(0, part.start + node.getStart()) + replacement + source.slice(part.start + node.end);
}
function removeCandidateProvenance(source: string) {
  const { inner, embedded } = candidateObjects(source);
  const property = embedded.properties.find((node: ts.Node & { name?: ts.Node }) => node.name?.getText() === 'modelRoutingProvenance');
  if (!property) return source;
  const end = inner.start + property.end;
  return source.slice(0, inner.start + property.getStart()) + source.slice(end + Number(source[end] === ','));
}
const candidates = candidateBodies ? removeCandidateProvenance(candidateBodies) : '';
function evaluateCandidateObjects(source: string, provenance: object) {
  const { callback, common, argument, embedded } = candidateObjects(source);
  const defaults = (node: ts.Node) => Object.fromEntries(nodes(node, ts.isIdentifier).map((item: ts.Identifier) => [item.text, undefined]));
  const turn = { opts: {}, sessionCtx: {}, typingSignals: {}, followupRun: { run: {}, media: [] }, getActiveSessionEntry: () => ({}) };
  const params = { state: { deferredLifecycle: {}, bootstrapPromptWarningSignaturesSeen: [] }, presentation: {}, currentTurnImages: { images: [], imageOrder: [] } };
  const commonScope = { ...defaults(common.initializer), params, turn, queuedUserMessagePersistedAcrossFallback: false,
    [callback.parameters[2].name.getText()]: { modelRoutingProvenance: provenance } };
  const actualCommon = vm.runInNewContext('(' + common.initializer.getText() + ')', commonScope);
  const actualParams = vm.runInNewContext('(' + argument.getText() + ')', { ...defaults(argument), params, turn, common: actualCommon });
  const spoof = { modelRoutingProvenance: { stage: (provenance as { stage?: string }).stage === 'initial' ? 'fallback' : 'initial' } };
  const result = vm.runInNewContext('(' + embedded.getText() + ')', {
    ...defaults(embedded), params: actualParams, turn, embeddedContext: spoof, senderContext: spoof, runBaseParams: spoof,
    agentHarnessPolicy: { runtimeSource: 'implicit' }, lifecycleBackstop: { beginAttempt: () => {} },
    resolveSessionPinnedHarnessId: () => undefined,
    resolveGroupSessionKey: () => undefined, normalizeOptionalString: (value: unknown) => value,
    resolveMessageChannel: () => undefined,
  });
  return { actualCommon, actualParams, result };
}

describe.skipIf(!candidateFile)('candidate routing through locked native functions', () => {
  it.each(['initial', 'fallback'])('retains native first-hop spread and overrides conflicting earlier spreads (%s)', stage => {
    const patched = transformCandidate(candidates, 'native-candidate.mjs');
    expect(extractFunction(patched, 'runAgentFallbackCandidates').body)
      .toBe(extractFunction(candidates, 'runAgentFallbackCandidates').body);
    const provenance = { stage, requestedProvider: 'provider', requestedModel: 'model' };
    const { actualCommon, actualParams, result } = evaluateCandidateObjects(patched, provenance);
    expect(actualCommon.modelRoutingProvenance).toBe(provenance);
    expect(actualParams.modelRoutingProvenance).toBe(provenance);
    expect(result.modelRoutingProvenance).toBe(provenance);
    expect(candidateObjects(patched).embedded.properties.at(-1).name.getText()).toBe('modelRoutingProvenance');
    expect(transformCandidate(patched, 'native-candidate.mjs', { verifyOnly: true })).toBe(patched);
    expect(() => transformCandidate(candidates, 'native-candidate.mjs', { verifyOnly: true })).toThrow('not applied');
  });

  it.each([false, true])('appends after every native spread with trailing comma %s', trailing => {
    const { inner, embedded } = candidateObjects(candidates);
    const original = embedded.getText();
    const end = embedded.properties.at(-1).end - embedded.getStart();
    const text = original.slice(0, end) + (trailing ? ',' : '') + original.slice(end).replace(/^(\s*),/, '$1');
    const source = replaceCandidateNode(candidates, inner, embedded, text);
    expect(Boolean(candidateObjects(source).embedded.properties.hasTrailingComma)).toBe(trailing);
    const patched = transformCandidate(source, 'native-candidate.mjs');
    const provenance = { stage: 'initial' };
    expect(evaluateCandidateObjects(patched, provenance).result.modelRoutingProvenance).toBe(provenance);
    expect(transformCandidate(patched, 'native-candidate.mjs', { verifyOnly: true })).toBe(patched);
  });

  it.each([
    ['common', 'modelRoutingProvenance: {},'],
    ['common', '"modelRoutingProvenance": {},'],
    ['common', '["modelRoutingProvenance"]: {},'],
    ['common', '...untrusted,'],
    ['argument', 'modelRoutingProvenance: {},'],
    ['argument', '["modelRoutingProvenance"]: {},'],
    ['argument', '...untrusted,'],
  ] as const)('rejects native %s provenance override %s', (target, injected) => {
    const { outer, common, argument } = candidateObjects(candidates);
    const object = target === 'common' ? common.initializer : argument;
    const spread = object.properties[0];
    const source = candidates.slice(0, outer.start + spread.end + 1) + injected + candidates.slice(outer.start + spread.end + 1);
    expect(() => transformCandidate(source, 'native-candidate.mjs')).toThrow();
  });

  it('requires the third callback argument and exact common spread into the embedded call', () => {
    const { outer, callback, argument, common } = candidateObjects(candidates);
    for (const [node, replacement] of [
      [callback.parameters[2].name, 'untrustedOptions'],
      [argument.properties[0].expression, 'untrustedCommon'],
    ] as const) {
      const source = replaceCandidateNode(candidates, outer, node, replacement);
      expect(() => transformCandidate(source, 'native-candidate.mjs')).toThrow();
    }
    const statement = common.parent.parent;
    const at = outer.start + statement.end;
    const escaped = candidates.slice(0, at) + ';common.modelRoutingProvenance = {};' + candidates.slice(at);
    expect(() => transformCandidate(escaped, 'native-candidate.mjs')).toThrow('custody');
  });

  it('rejects reordered, duplicated, weakened, or partial current provenance', () => {
    const patched = transformCandidate(candidates, 'native-candidate.mjs');
    const { inner, embedded } = candidateObjects(patched);
    const current = embedded.properties.at(-1);
    const source = replaceCandidateNode(patched, inner, current.initializer, '{}');
    expect(() => transformCandidate(source, 'native-candidate.mjs')).toThrow('partial');
    const pristine = removeCandidateProvenance(patched);
    const original = candidateObjects(pristine);
    const at = original.inner.start + original.embedded.properties.pos;
    const misplaced = pristine.slice(0, at) + current.getText() + ',' + pristine.slice(at);
    expect(() => transformCandidate(misplaced, 'native-candidate.mjs')).toThrow('partial');
    const duplicate = patched.slice(0, inner.start + embedded.properties.end) + ',' + current.getText() + patched.slice(inner.start + embedded.properties.end);
    expect(() => transformCandidate(duplicate, 'native-candidate.mjs')).toThrow();
    expect(() => transformCandidate('async ' + extractFunction(candidates, 'runEmbeddedFallbackCandidate').body, 'native-candidate.mjs')).toThrow('partial');
  });

  it('verifies real functions after ordinary esbuild bundle formatting and renaming', () => {
    const bundle = transformSync(candidates, { format: 'esm', target: 'node24' }).code;
    const patched = transformCandidate(bundle, 'gateway-bundle.mjs');
    expect(transformCandidate(patched, 'gateway-bundle.mjs', { verifyOnly: true })).toBe(patched);
    expect(evaluateCandidateObjects(patched, { stage: 'initial' }).result.modelRoutingProvenance.stage).toBe('initial');
  });
});

describe('native recovery result declarations', () => {
  const declaration = 'interface ResultMeta { modelFallbackStopReason?: "agent_run_terminal_timeout" | "idle_timeout_circuit_breaker" | "provider_review_continuation"; }';

  it('adds one truthful chain-stop reason while preserving native reasons', () => {
    const current = transformResultTypes(declaration);
    expect(current).toBe(declaration.replace(';', ' | "tool_call_format_recovery";'));
    expect(transformResultTypes(current, true)).toBe(current);
    expect(transformResultTypes(current)).toBe(current);
  });

  it('rejects pristine declarations during verification without repairing them', () => {
    expect(() => transformResultTypes(declaration, true)).toThrow();
  });

  it.each([
    '',
    declaration + declaration,
    declaration.replace('"provider_review_continuation"', '"unknown_native_reason"'),
    declaration + '\n// "tool_call_format_recovery"',
    transformResultTypes(declaration) + '\n// "tool_call_format_recovery"',
  ])('rejects missing, duplicate or partial declarations', source => {
    expect(() => transformResultTypes(source)).toThrow();
  });
});
