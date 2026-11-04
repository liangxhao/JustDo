import { readdirSync,readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import ts from 'typescript';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { registerGoalResultPolicy } from '../../execution/goal-result-policy';

// Opt-in conformance against the locked published producers and middleware.
// Only the Goal storage and Gateway reads are controlled ports: no Gateway,
// model, user database or transcript is opened by this suite.
const packageRoot = process.env.OPENCLAW_NATIVE_PACKAGE_ROOT;
const requireNative = createRequire(import.meta.url);
type Middleware = Parameters<OpenClawPluginApi['registerAgentToolResultMiddleware']>[0];
type Result = Parameters<Middleware>[0]['result'];
type Tool = { name: string; label?: string; description: string; parameters: unknown;
  execute(id: string, args: Record<string, unknown>): Promise<Result> };
type Runner = { applyToolResultMiddleware(event: Parameters<Middleware>[0]): Promise<Result> };

function nativeSource(prefix: string, declaration?: string) {
  const dist = path.join(packageRoot!, 'dist');
  const files = readdirSync(dist).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))
    .filter(name => !declaration || readFileSync(path.join(dist, name), 'utf8').includes(`function ${declaration}(`));
  expect(files).toHaveLength(1);
  const file = path.join(dist, files[0]);
  const source = readFileSync(file, 'utf8');
  return { file, tree: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) };
}

function nativeExport<T>(prefix: string, symbol: string): T {
  const owner = nativeSource(prefix, symbol);
  const exported = owner.tree.statements.filter(ts.isExportDeclaration).flatMap(node =>
    node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : [])
    .find(item => (item.propertyName ?? item.name).text === symbol);
  expect(exported, symbol).toBeDefined();
  return requireNative(owner.file)[exported!.name.text] as T;
}

function nativeGoalTool(update: (params: Record<string, unknown>) => Promise<unknown>): Tool {
  const owner = nativeSource('openclaw-tools-', 'createUpdateGoalTool');
  const names = ['UpdateGoalToolSchema', 'createUpdateGoalTool'];
  const declarations = names.map(name => {
    const nodes = owner.tree.statements.filter(node =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(owner.tree) === name)));
    expect(nodes, name).toHaveLength(1);
    return nodes[0].getText(owner.tree);
  });
  const dependencies = new Set(['Type', 'stringEnum', 'MODEL_UPDATABLE_SESSION_GOAL_STATUSES',
    'readToolStringParam', 'ToolInputError', 'jsonResult', 'SessionGoalTransitionError']);
  const bindings: Record<string, unknown> = {};
  for (const node of owner.tree.statements.filter(ts.isImportDeclaration)) {
    const imports = node.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    for (const item of imports.elements) {
      if (!dependencies.has(item.name.text)) continue;
      const imported = createRequire(owner.file)(node.moduleSpecifier.text);
      bindings[item.name.text] = imported[(item.propertyName ?? item.name).text];
    }
  }
  expect(Object.keys(bindings).sort()).toEqual([...dependencies].sort());
  return vm.runInNewContext(`${declarations.join('\n')}\ncreateUpdateGoalTool({})`, {
    ...bindings, updateSessionGoalStatus: update,
    resolveGoalSessionScope: () => ({ agentId: 'main', sessionKey: 'agent:main:goal-result-fixture' }),
  }) as Tool;
}

const identity = { runtime: 'openclaw' as const, agentId: 'main', sessionId: 'native-session',
  sessionKey: 'agent:main:goal-result-fixture', runId: 'native-continuation' };
const goal = { schemaVersion: 1, id: 'goal-fixture', objective: 'Deliver the requested result',
  status: 'complete', note: 'The requested result was delivered.', createdAt: 1, updatedAt: 3,
  tokensUsed: 17, continuationTurns: 1 };
const args = { status: 'complete', note: goal.note };

function modelPayload(result: Result) {
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  if (block.type !== 'text') throw new Error('Expected the native JSON text result');
  return JSON.parse(block.text);
}

describe.skipIf(!packageRoot)('native Goal result producer and automatic completion guidance', () => {
  let createToolSearchTools: (ctx: Record<string, unknown>) => Tool[];
  let createRunner: (ctx: typeof identity, handlers: Middleware[]) => Runner;

  beforeAll(() => {
    const metadata = JSON.parse(readFileSync(path.join(packageRoot!, 'package.json'), 'utf8'));
    const repository = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
    expect(metadata.name).toBe('openclaw');
    expect(metadata.version).toBe(repository.openclaw.version.replace(/^v/u, ''));
    createToolSearchTools = nativeExport('tool-search-', 'createToolSearchTools');
    createRunner = nativeExport('tool-result-middleware-', 'createAgentToolResultMiddlewareRunner');
  });

  function fixture() {
    const lifecycle = new AbortController();
    let middleware!: Middleware;
    const request = vi.fn().mockResolvedValue({ session: {
      key: identity.sessionKey, agentId: identity.agentId, sessionId: identity.sessionId,
      lifecycleRevision: 'native-revision', goal: structuredClone(goal),
      goalContinuation: { continuationTurns: 1, lastAccepted: {
        runId: identity.runId, goalId: goal.id, predecessorRunId: 'native-predecessor',
        continuationTurns: 1, acceptedAt: 2,
      } },
    } });
    registerGoalResultPolicy({
      lifecycle: { signal: lifecycle.signal, runInBackgroundContext: (run: () => unknown) => run() },
      runtime: { gateway: { request } },
      registerTool: () => undefined,
      registerAgentToolResultMiddleware: (handler: Middleware) => { middleware = handler; },
    } as unknown as OpenClawPluginApi);
    const update = vi.fn().mockResolvedValue(structuredClone(goal));
    return { runner: createRunner(identity, [middleware]), tool: nativeGoalTool(update), update, request };
  }

  test.each(['update_goal', 'tool_call'] as const)(
    'reconciles the real native %s result without changing Goal evidence or source identities', async name => {
      const f = fixture();
      const toolId = 'openclaw:core:update_goal';
      const invocationArgs = name === 'update_goal' ? args : { id: toolId, args };
      // Execute the actual native wrapper producer, including its full discovery
      // descriptor in details and compact identity in model-visible JSON.
      const tool = name === 'update_goal' ? f.tool : createToolSearchTools({
        ...identity,
        catalogRef: { current: { entries: [{ id: toolId, source: 'openclaw', sourceName: 'core',
          name: f.tool.name, label: f.tool.label, description: f.tool.description,
          parameters: f.tool.parameters, tool: f.tool }],
        counterScope: 'goal-result-fixture', searchCount: 0, describeCount: 0, callCount: 0 } },
      }).find(item => item.name === 'tool_call')!;
      const produced = await tool.execute('native-call', invocationArgs);
      expect(f.update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionKey: identity.sessionKey, status: 'complete', note: goal.note,
      }));
      const before = structuredClone(produced);
      const oldGuidance = 'Continue this turn and provide the requested visible final response.';
      expect(JSON.stringify(before)).toContain(oldGuidance);
      const revised = await f.runner.applyToolResultMiddleware({
        toolName: name, toolCallId: 'native-call', args: invocationArgs, result: produced,
      });
      expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe',
        { key: identity.sessionKey, agentId: identity.agentId }, { scopes: ['operator.read'], timeoutMs: 1500 });
      expect(produced).toEqual(before);
      expect(JSON.stringify(revised)).not.toContain(oldGuidance);
      const target = name === 'update_goal' ? revised : (revised.details as { result: Result }).result;
      expect(target.details).toMatchObject({ status: 'updated', goal });
      expect((target.details as { nextAction: string }).nextAction).toContain('finish_goal_turn');
      expect(modelPayload(target)).toEqual(target.details);
      if (name === 'tool_call') {
        expect((revised.details as { tool: unknown }).tool).toEqual((before.details as { tool: unknown }).tool);
        const model = modelPayload(revised);
        const originalModel = modelPayload(before);
        expect(model.tool).toEqual(originalModel.tool);
        expect(model.result).toEqual(target);
      }
    },
  );
});
