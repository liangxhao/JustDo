import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import ts from 'typescript';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { registerGoalResultPolicy } from '../../execution/goal-result-policy';

// Execute the locked native producers, middleware, subscription, and finalization
// decisions. Gateway reads and bookkeeping are controlled ports. No model,
// Gateway, user database, or transcript file participates in this conformance test.
const packageRoot = process.env.OPENCLAW_NATIVE_PACKAGE_ROOT;
const requireNative = createRequire(import.meta.url);
type RecordValue = Record<string, unknown>;
type Middleware = Parameters<OpenClawPluginApi['registerAgentToolResultMiddleware']>[0];
type Result = Parameters<Middleware>[0]['result'];
type Tool = { name: string; label?: string; description: string; parameters: unknown;
  execute(id: string, args: RecordValue): Promise<Result> };
type Factory = { contextVersion: number; create(context: RecordValue): Tool | null | undefined };
type Runner = { applyToolResultMiddleware(event: Parameters<Middleware>[0]): Promise<Result> };
type Subscription = { toolMetas: RecordValue[]; getItemLifecycle(): { startedCount: number; completedCount: number; activeCount: number };
  waitForPendingEvents(): Promise<void>; unsubscribe(): void };

function nativeSource(prefix: string, declaration: string) {
  const dist = path.join(packageRoot!, 'dist');
  const files = readdirSync(dist).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))
    .filter(name => readFileSync(path.join(dist, name), 'utf8').includes(`function ${declaration}(`));
  expect(files, declaration).toHaveLength(1);
  const file = path.join(dist, files[0]);
  return { file, tree: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) };
}

function nativeExport<T>(prefix: string, symbol: string): T {
  const owner = nativeSource(prefix, symbol);
  const exported = owner.tree.statements.filter(ts.isExportDeclaration).flatMap(node =>
    node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [])
    .find(item => (item.propertyName ?? item.name).text === symbol);
  expect(exported, symbol).toBeDefined();
  return requireNative(owner.file)[exported!.name.text] as T;
}

/** Preserve complete native function bodies and their native declaration/import closure. */
function nativeClosure<T>(prefix: string, symbols: string[], ports: RecordValue = {}): T {
  const owner = nativeSource(prefix, symbols[0]);
  const declarations = new Map<string, ts.Statement>();
  const imports = new Map<string, { module: string; symbol: string }>();
  for (const node of owner.tree.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declarations.set(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const item of node.declarationList.declarations) if (ts.isIdentifier(item.name)) declarations.set(item.name.text, node);
    }
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) imports.set(item.name.text, { module: node.moduleSpecifier.text, symbol: (item.propertyName ?? item.name).text });
    }
    if (node.importClause?.name) imports.set(node.importClause.name.text, { module: node.moduleSpecifier.text, symbol: 'default' });
  }
  const selected = new Set<ts.Statement>();
  const bindings: RecordValue = { ...ports };
  const pending = [...symbols];
  const seen = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name) || Object.hasOwn(ports, name)) continue;
    seen.add(name);
    const imported = imports.get(name);
    if (imported) {
      bindings[name] = createRequire(owner.file)(imported.module)[imported.symbol];
      continue;
    }
    const node = declarations.get(name);
    if (!node || selected.has(node)) continue;
    selected.add(node);
    const visit = (child: ts.Node) => { if (ts.isIdentifier(child)) pending.push(child.text); ts.forEachChild(child, visit); };
    visit(node);
  }
  for (const name of symbols) expect(seen.has(name), name).toBe(true);
  const source = owner.tree.statements.filter(node => selected.has(node)).map(node => node.getText(owner.tree)).join('\n');
  return vm.runInNewContext(`${source}\n({${symbols.join(',')}})`, {
    ...bindings, Buffer, URL, AbortController, setTimeout, clearTimeout, queueMicrotask, process,
  }) as T;
}

const identity = { runtime: 'openclaw' as const, agentId: 'main', sessionId: 'native-session',
  sessionKey: 'agent:main:goal-finish-fixture', runId: 'native-continuation' };
const goal = { schemaVersion: 1, id: 'goal-fixture', objective: 'Deliver the requested result',
  status: 'complete', createdAt: 1, updatedAt: 3, tokensUsed: 17, continuationTurns: 1,
  lastStatusNote: 'The requested result was delivered.' };
const args = { goalId: goal.id, reply: 'none' };
const finishName = 'finish_goal_turn';
const finishId = 'openclaw:runtime-services:finish_goal_turn';

describe.skipIf(!packageRoot)('native explicit Goal turn finish and required-answer finalization', () => {
  let createTools: (ctx: RecordValue) => Tool[];
  let createCatalog: () => { current?: { entries: RecordValue[] } };
  let registerCatalog: (input: RecordValue) => void;
  let setPluginMetadata: (tool: Tool, metadata: RecordValue) => void;
  let createRunner: (ctx: typeof identity, handlers: Middleware[]) => Runner;
  let subscribe: (input: RecordValue) => Subscription;
  let batchEvidence: (attempt: RecordValue) => { intentionalTermination: boolean };
  let terminalState: (input: RecordValue) => RecordValue;
  let finalization: {
    resolveSettledTurnFinalizationRequest(input: RecordValue): string | null;
    resolveEmbeddedRunTerminal(input: RecordValue): Promise<{ action: string; result: { meta: RecordValue; payloads?: unknown[] } }>;
    createEmbeddedRunTerminalRetryState(): RecordValue;
  };
  let classifyFallback: (input: RecordValue) => unknown;
  let isNativeToolError: (result: Result) => boolean;
  let entryTerminal: { resolveRunEntryTerminalOutcome(input: RecordValue): RecordValue; buildRunEntryTerminal(input: RecordValue): RecordValue };
  let createLifecycle: (input: RecordValue) => { emitEnd(terminal: RecordValue): void };
  const lifecycleEvents: RecordValue[] = [];

  beforeAll(() => {
    const metadata = JSON.parse(readFileSync(path.join(packageRoot!, 'package.json'), 'utf8'));
    const repository = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
    expect(metadata.version).toBe(repository.openclaw.version.replace(/^v/u, ''));
    createTools = nativeExport('tool-search-', 'createToolSearchTools');
    createCatalog = nativeExport('tool-search-', 'createToolSearchCatalogRef');
    registerCatalog = nativeExport('tool-search-', 'registerHeadlessToolSearchCatalog');
    setPluginMetadata = nativeExport('tool-metadata-', 'setPluginToolMeta');
    createRunner = nativeExport('tool-result-middleware-', 'createAgentToolResultMiddlewareRunner');
    batchEvidence = nativeExport('builtin-openclaw-', 'resolveSettledToolBatchEvidence');
    terminalState = nativeExport('builtin-openclaw-', 'resolveEmbeddedRunAttemptTerminalState');
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    ({ subscribeEmbeddedAgentSession: subscribe } = nativeClosure('builtin-openclaw-', ['subscribeEmbeddedAgentSession'], {
      embeddedLog: logger, createSubsystemLogger: () => logger,
    }));
    finalization = nativeClosure('embedded-agent-', ['resolveSettledTurnFinalizationRequest', 'resolveEmbeddedRunTerminal', 'createEmbeddedRunTerminalRetryState'], {
      'log$3': logger, markEmbeddedRunAuthProfileSuccess: vi.fn(), reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
    });
    classifyFallback = nativeExport('result-fallback-classifier-', 'classifyEmbeddedAgentRunResultForModelFallback');
    isNativeToolError = nativeExport('tool-result-error-', 'isToolResultError');
    entryTerminal = nativeClosure('run-entry-', ['resolveRunEntryTerminalOutcome', 'buildRunEntryTerminal']);
    ({ createAgentCommandLifecycle: createLifecycle } = nativeClosure('agent-command-', ['createAgentCommandLifecycle'], {
      createSubsystemLogger: () => logger, emitAgentEvent: (event: RecordValue) => { lifecycleEvents.push(event); },
    }));
  });

  function fixture(after: Middleware[] = []) {
    const lifecycle = new AbortController();
    const handlers: Middleware[] = [];
    let factory!: Factory;
    let entry: RecordValue | undefined = { sessionId: identity.sessionId, goal: { ...goal, status: 'active' } };
    const getSessionEntry = vi.fn(() => entry);
    const resolveStorePath = vi.fn(() => '/controlled/store');
    const request = vi.fn().mockResolvedValue({ session: {
      key: identity.sessionKey, agentId: identity.agentId, sessionId: identity.sessionId,
      lifecycleRevision: 'native-revision', goal: structuredClone(goal),
      goalContinuation: { continuationTurns: 1, lastAccepted: { runId: identity.runId,
        goalId: goal.id, predecessorRunId: 'native-predecessor', continuationTurns: 1, acceptedAt: 2 } },
    } });
    registerGoalResultPolicy({
      lifecycle: { signal: lifecycle.signal, runInBackgroundContext: (run: () => unknown) => run() },
      runtime: { gateway: { request }, agent: { session: { getSessionEntry, resolveStorePath } } },
      registerTool: (value: Factory) => { factory = value; },
      registerAgentToolResultMiddleware: (handler: Middleware) => { handlers.push(handler); },
    } as unknown as OpenClawPluginApi);
    expect(factory.contextVersion).toBe(2);
    // The public factory has no current runId; only the middleware receives it.
    const factoryContext = { agentId: identity.agentId, sessionKey: identity.sessionKey, sessionId: identity.sessionId,
      config: { session: { store: 'controlled-store' } }, assertInvocationCurrent: vi.fn() };
    const tool = factory.create(factoryContext);
    if (!tool) throw new Error('An active Goal should expose its finish tool');
    expect(tool.name).toBe(finishName);
    // These are the same ownership metadata and catalog producers used when the
    // native plugin registry adopts a concrete plugin-owned tool instance.
    setPluginMetadata(tool, { pluginId: 'runtime-services', optional: false });
    return { request, tool, getSessionEntry, resolveStorePath, factory, factoryContext,
      setEntry: (next: RecordValue | undefined) => { entry = next; },
      runner: createRunner(identity, [...handlers, ...after]) };
  }

  async function execute(f: ReturnType<typeof fixture>, name: 'direct' | 'tool_call') {
    const invocationArgs = name === 'direct' ? args : { id: finishId, args };
    const catalogRef = createCatalog();
    registerCatalog({ catalogRef, tools: [f.tool] });
    expect(catalogRef.current?.entries).toEqual([expect.objectContaining({ id: finishId,
      source: 'openclaw', sourceName: 'runtime-services', name: finishName })]);
    const tool = name === 'direct' ? f.tool : createTools({ ...identity, catalogRef }).find(item => item.name === 'tool_call')!;
    // The successful native update changes the Goal between model tool batches.
    // Existing same-attempt definitions stay callable without rediscovery.
    f.setEntry({ sessionId: identity.sessionId, goal: { ...goal } });
    const raw = await tool.execute('native-finish-call', invocationArgs);
    expect(raw.terminate).not.toBe(true);
    const before = structuredClone(raw);
    const result = await f.runner.applyToolResultMiddleware({ toolName: tool.name,
      toolCallId: 'native-finish-call', args: invocationArgs, result: raw });
    expect(raw).toEqual(before);
    return { tool, raw, result };
  }

  async function attemptFor(results: { toolName: string; result: Result }[]) {
    let listener: (event: unknown) => void = () => undefined;
    const subscription = subscribe({ ...identity,
      session: { sessionManager: {}, subscribe: (next: typeof listener) => { listener = next; return () => undefined; } },
    });
    const calls = results.map(({ toolName }, index) => ({ type: 'toolCall', id: `native-call-${index}`, name: toolName, arguments: args }));
    const assistant = { role: 'assistant', content: calls, stopReason: 'toolUse', api: 'openai-responses',
      provider: 'openai', model: 'mock-1', timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const recorded = results.map(({ toolName, result }, index) => ({ role: 'toolResult', toolCallId: calls[index].id,
      toolName, content: result.content, details: result.details, isError: result.isError === true || isNativeToolError(result), timestamp: 4 }));
    try {
      for (let index = 0; index < results.length; index++) {
        listener({ type: 'tool_execution_start', toolName: calls[index].name, toolCallId: calls[index].id, args });
        listener({ type: 'tool_execution_end', toolName: calls[index].name, toolCallId: calls[index].id,
          isError: results[index].result.isError === true || isNativeToolError(results[index].result), result: results[index].result });
      }
      await subscription.waitForPendingEvents();
      return { terminal: { kind: 'ok' }, assistantTexts: [], toolMetas: structuredClone(subscription.toolMetas),
        lastAssistant: assistant, currentAttemptAssistant: assistant, currentAttemptCompletedAssistant: assistant,
        messagesSnapshot: [{ role: 'user', content: 'Verify the existing Goal.', timestamp: 1 }, assistant, ...recorded],
        itemLifecycle: subscription.getItemLifecycle(),
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false }, currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [], didSendViaMessagingTool: false };
    } finally { subscription.unsubscribe(); }
  }

  function terminalInput(attempt: Awaited<ReturnType<typeof attemptFor>>) {
    const agentMeta = { sessionId: identity.sessionId, provider: 'openai', model: 'mock-1' };
    return { runParams: { ...identity, terminalReplyExpectation: 'required', trigger: 'user',
      prompt: 'Verify the existing Goal.', timeoutMs: 1000 }, attempt, attemptAssistant: attempt.currentAttemptAssistant,
      terminalState: terminalState({ attempt, assistant: attempt.currentAttemptAssistant }),
      activeErrorContext: { provider: 'openai', model: 'mock-1' }, modelApi: 'openai-responses',
      prepared: { payloads: [], payloadsWithToolMedia: [], replyDeliveryState: 'missing', reportedModelRef: { provider: 'openai', model: 'mock-1' }, agentMeta },
      replayState: { hadPotentialSideEffects: true, replayInvalid: true }, attemptCompactionCount: 0,
      retryState: finalization.createEmbeddedRunTerminalRetryState(), settledTurnFinalizationOutcome: 'not-attempted',
      sessionPromptState: { activePrompt: { persisted: true, internal: false }, activateInternalPrompt: vi.fn(),
        markOwnedTranscriptRetry: vi.fn(), activateCompactionContinuation: vi.fn(), clearCompactionContinuation: vi.fn() },
      armPostCompactionGuard: vi.fn(), readTerminalToolPresentation: () => undefined, resolveReplayInvalid: () => false,
      setTerminalLifecycleMeta: vi.fn(), maybeMarkAuthProfileFailure: vi.fn(), profileFailureStore: { version: 1, profiles: {} },
      assistantProfileFailureReason: null, startedAtMs: Date.now(), provider: 'openai', modelId: 'mock-1',
      modelTransportId: 'mock-1', modelTransportApi: 'openai-responses', traceAttempts: [], thinkLevel: 'off',
      contextRecoveryState: {}, agentHarnessId: 'builtin-openclaw' };
  }

  function finalizationRequest(input: ReturnType<typeof terminalInput>) {
    return finalization.resolveSettledTurnFinalizationRequest({ ...input, payloadsWithToolMedia: [],
      hasTerminalToolPresentation: false, settledTurnFinalizationAvailable: true });
  }

  test.each(['direct', 'tool_call'] as const)('honors an explicitly authorized %s finish through real native terminal finalization', async name => {
    const f = fixture();
    const { tool, result } = await execute(f, name);
    expect(result.terminate).toBe(true);
    expect(result.isError).not.toBe(true);
    const target = name === 'direct' ? result : (result.details as { result: Result }).result;
    expect(target.details).toMatchObject({ status: 'finished', goalId: goal.id, reply: 'none' });
    expect(target.terminate).toBe(true);
    expect(JSON.parse((target.content[0] as { text: string }).text)).toEqual(target.details);
    if (name === 'tool_call') {
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ result: target });
    }
    expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe',
      { key: identity.sessionKey, agentId: identity.agentId }, { scopes: ['operator.read'], timeoutMs: 1500 });
    expect(f.getSessionEntry).toHaveBeenCalledExactlyOnceWith({ agentId: identity.agentId,
      sessionKey: identity.sessionKey, storePath: '/controlled/store', readConsistency: 'latest' });
    expect(f.resolveStorePath).toHaveBeenCalledExactlyOnceWith('controlled-store', { agentId: identity.agentId });
    const attempt = await attemptFor([{ toolName: tool.name, result }]);
    expect(attempt.toolMetas).toEqual([expect.objectContaining({ toolName: tool.name, terminate: true, isError: false })]);
    expect(attempt.itemLifecycle).toEqual({ startedCount: 1, completedCount: 1, activeCount: 0 });
    expect(batchEvidence(attempt).intentionalTermination).toBe(true);
    const input = terminalInput(attempt);
    expect(finalizationRequest(input)).toBeNull();
    const resolved = await finalization.resolveEmbeddedRunTerminal(input);
    expect(resolved.action).toBe('complete');
    expect(resolved.result.meta.intentionalTerminalCompletion).toBe('tool-batch');
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.payloads).toBeUndefined();
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    expect(classifyFallback({ provider: 'openai', model: 'mock-1', result: resolved.result })).toBeNull();
    const outcome = entryTerminal.resolveRunEntryTerminalOutcome({ result: resolved.result, fallbackExhausted: false });
    expect(outcome.status).toBe('ok');
    const terminal = entryTerminal.buildRunEntryTerminal({ result: resolved.result, outcome, runId: identity.runId,
      sessionId: identity.sessionId, requested: { provider: 'openai', model: 'mock-1' },
      behavior: { kind: 'command-rpc', hasCommittedSideEffect: () => false } });
    lifecycleEvents.length = 0;
    createLifecycle({ runId: identity.runId, lifecycleGeneration: () => 'native-generation', startedAt: 1,
      state: { lifecycleEnded: false, lifecycleFinishing: false } }).emitEnd(terminal);
    expect(lifecycleEvents).toEqual([expect.objectContaining({ runId: identity.runId,
      data: expect.objectContaining({ phase: 'end', executionSettled: true }) })]);
  });

  test.each(['unconfirmed', 'failed', 'mixed'] as const)('retains the required final answer for a %s terminal batch', async scenario => {
    const f = fixture();
    const { tool, raw, result } = await execute(f, 'direct');
    const results = scenario === 'unconfirmed' ? [{ toolName: tool.name, result: raw }]
      : scenario === 'failed' ? [{ toolName: tool.name, result: { ...result, isError: true } }]
        : [{ toolName: tool.name, result }, { toolName: 'read', result: { content: [{ type: 'text' as const, text: 'New result' }], details: {} } }];
    const attempt = await attemptFor(results);
    expect(batchEvidence(attempt).intentionalTermination).toBe(false);
    expect(finalizationRequest(terminalInput(attempt))).toContain('user-visible answer');
  });

  test('retains a later middleware failure instead of accepting the earlier finish', async () => {
    const f = fixture([() => { throw new Error('Middleware rejected the result'); }]);
    const { tool, result } = await execute(f, 'tool_call');
    expect(result.terminate).not.toBe(true);
    expect(isNativeToolError(result)).toBe(true);
    const attempt = await attemptFor([{ toolName: tool.name, result }]);
    expect(batchEvidence(attempt).intentionalTermination).toBe(false);
    expect(finalizationRequest(terminalInput(attempt))).toContain('user-visible answer');
  });

  test('preserves an external abort after an authorized finish result', async () => {
    const { tool, result } = await execute(fixture(), 'direct');
    const settled = await attemptFor([{ toolName: tool.name, result }]);
    const attempt = { ...settled, terminal: { kind: 'aborted', source: 'external' } };
    const input = terminalInput(attempt);
    expect(finalizationRequest(input)).toBeNull();
    const resolved = await finalization.resolveEmbeddedRunTerminal(input);
    expect(resolved.action).toBe('complete');
    expect(resolved.result.meta.aborted).toBe(true);
    expect(resolved.result.meta.intentionalTerminalCompletion).toBeUndefined();
    expect(entryTerminal.resolveRunEntryTerminalOutcome({ result: resolved.result, fallbackExhausted: false }).status).not.toBe('ok');
  });

  test.each(['no-goal', 'historical-complete'] as const)('omits a %s finish from direct tools and the real native Tool Search catalog', async state => {
    const f = fixture();
    f.setEntry({ sessionId: identity.sessionId, ...(state === 'historical-complete' ? { goal: { ...goal } } : {}) });
    const selected = f.factory.create(f.factoryContext);
    expect(selected).toBeNull();
    const directTools = selected ? [selected] : [];
    expect(directTools.map(tool => tool.name)).not.toContain(finishName);
    const catalogRef = createCatalog();
    registerCatalog({ catalogRef, tools: directTools });
    expect(catalogRef.current?.entries).toEqual([]);
    const call = createTools({ ...identity, catalogRef }).find(tool => tool.name === 'tool_call')!;
    await expect(call.execute('hidden-finish-call', { id: finishId, args })).rejects.toThrow(/Unknown tool/iu);
    expect(f.request).not.toHaveBeenCalled();
  });
});
