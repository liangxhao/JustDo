import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

const root = process.cwd();
const runtime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
const source = process.env.OPENCLAW_SOURCE ?? process.env.OPENCLAW_TEST_UPSTREAM_ROOT;
const required = process.env.OPENCLAW_REQUIRE_MANAGED_CONFIG_CONTRACTS === '1';
const executable = runtime ? path.join(runtime, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node') : '';
const available = Boolean(runtime && source && fs.existsSync(executable) &&
  fs.existsSync(path.join(source, 'src/gateway/server-methods/request-authorization.ts')));
if ((required || runtime || source) && !available) throw new Error('The required workspace native contract runtime/source is unavailable.');

function functionSource(file: string, names: string[]): string {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const found = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    expect(found, `one current native ${name}`).toHaveLength(1);
    return found[0].getText(tree).replace(/^export\s+/, '');
  }).join('\n');
}

test.skipIf(!available)('the target pre-dispatch function really waits for describe preparation before a new authorization iteration', async () => {
  const file = path.join(source!, 'src/gateway/server-methods/request-authorization.ts');
  const text = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.filter(ts.isVariableStatement).filter(statement =>
    statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && ['STARTUP_READ_WAIT_MS', 'startupReadMethods'].includes(declaration.name.text)));
  expect(declarations).toHaveLength(2);
  const code = declarations.map(node => node.getText(tree)).join('\n') + '\n' + functionSource(file,
    ['startupReadAgents', 'prepareStartupReadAgents', 'authorizeGatewayRequestPreDispatch']);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let prepared = false;
  const wait = vi.fn(async () => { await held; prepared = true; });
  const stop = { code: 'CONTROLLED_NEXT_AUTHORIZATION', message: 'stop after actual readiness wait' };
  const dependencies: Record<string, unknown> = {
    getAsyncWorkSignal: () => undefined,
    withPluginRuntimeRegistryScope: (_registry: unknown, operation: () => unknown) => operation(),
    authorizeGatewayMethod: () => ({ error: prepared ? stop : null }),
    gatewayRouterUploadPolicyError: () => null,
    authorizeAuthenticatedProfileForMethod: async () => null,
    listAgentDatabaseAdmissionRefusals: () => [],
    resolveDirectSessionTargets: () => [{ sessionKey: 'agent:main:controlled', agentId: 'main' }],
    resolveRequestedSessionAgentId: () => ({ ok: true, agentId: 'main' }),
    resolveSessionStorePathCore: () => 'controlled-store',
    isPerAgentSessionStoreConfig: () => false,
    resolveSessionStoreCompatibilityAgentId: () => 'main',
    prepareSqliteTargetFromSessionStorePath: async () => ({ agentId: 'main' }),
    raceWithTimeout: (operation: () => Promise<unknown>) => operation(),
  };
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const authorize = new Function(...Object.keys(dependencies), compiled + '\nreturn authorizeGatewayRequestPreDispatch;')(...Object.values(dependencies));
  const cfg = {};
  let settled = false;
  const request = authorize({ method: 'sessions.describe', requestParams: { key: 'agent:main:controlled', agentId: 'main' },
    client: null, methodRegistry: { isObservation: () => true },
    context: { getRuntimeConfig: () => cfg, agentDatabaseStartup: { hasPendingAgents: true, waitForAgentPreparation: wait } },
  }).then((value: unknown) => { settled = true; return value; });
  await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(wait).toHaveBeenCalledWith('main', { signal: expect.any(AbortSignal) });
  release();
  await expect(request).resolves.toMatchObject({ error: stop });
});

test.skipIf(!available)('the actual target describe handler distinguishes an absent reservation from an existing native row', async () => {
  const file = path.join(source!, 'src/gateway/server-methods/sessions-read-by-key.ts');
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(node => node.name.getText(tree) === 'sessionByKeyReadHandlers');
  expect(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer)).toBe(true);
  const object = declaration!.initializer as ts.ObjectLiteralExpression;
  const handler = object.properties.find(node => ts.isPropertyAssignment(node) &&
    ts.isStringLiteral(node.name) && node.name.text === 'sessions.describe') as ts.PropertyAssignment;
  expect(ts.isArrowFunction(handler.initializer)).toBe(true);
  let record: { key: string; entry: Record<string, unknown> } | undefined;
  const key = 'agent:main:controlled-reservation';
  const dependencies: Record<string, unknown> = {
    validateSessionsDescribeParams: () => true,
    assertValidParams: () => true,
    requireSessionKey: (value: string) => value,
    requireSessionRowProjection: () => ({}),
    resolveRequestedSessionAgentId: () => ({ ok: true, agentId: 'main' }),
    authorizeIncognitoSessionTarget: () => null,
    createVisibleActiveSessionRunProjector: () => ({}),
    hasOperatorBoundary: () => false,
    prepareProjectedSessionPresentation: () => ({ authorizeDescription: () => null,
      sharing: {}, present: (value: { entry: unknown }) => value.entry }),
    withReadySessionRows: async (_projection: unknown, select: (cfg: unknown) => unknown, read: (value: unknown) => unknown) => {
      expect(select({})).toEqual([{ key, agentId: 'main' }]);
      return read({ state: { cfg: {}, rowContext: { projectedAgentRuns: {} } }, describe: () => record });
    },
  };
  const code = ts.transpileModule('const handler=' + handler.initializer.getText(tree),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const describe = new Function(...Object.keys(dependencies), code + '\nreturn handler;')(...Object.values(dependencies));
  const respond = vi.fn();
  await describe({ params: { key, agentId: 'main' }, respond, context: {}, client: null });
  expect(respond).toHaveBeenLastCalledWith(true, { session: null });
  record = { key, entry: { sessionId: 'existing-native-id' } };
  await describe({ params: { key, agentId: 'main' }, respond, context: {}, client: null });
  expect(respond).toHaveBeenLastCalledWith(true, { session: record.entry });
});

test('actual Main workspace DI waits for its connected owner and fences service/router/adapter/manager replacement', async () => {
  const file = path.join(root, 'src/main/main.ts');
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const matches: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'workspaceAppSessions' &&
      node.initializer && ts.isNewExpression(node.initializer)) {
      const options = node.initializer.arguments?.[0];
      if (options && ts.isObjectLiteralExpression(options)) for (const property of options.properties)
        if (ts.isPropertyAssignment(property) && property.name.getText(tree) === 'captureResponseContext' && ts.isArrowFunction(property.initializer))
          matches.push(property.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(matches).toHaveLength(1);
  const arrow = ts.transpileModule('const capture=' + matches[0].getText(tree),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let ready!: () => void;
  const connection = new Promise<void>(resolve => { ready = resolve; });
  const native = { isCurrent: () => true, isResponseError: () => true };
  let router = {};
  let adapter = { captureGatewayResponseContext: vi.fn(() => native) };
  const service = { connectGatewayClient: () => connection, getCurrentRouter: () => router, getRuntimeAdapter: () => adapter };
  const manager = {};
  const fixture = new Function('service', 'manager', `let coworkEngineService=service,openClawEngineManager=manager,quitting=false;
    const getCoworkEngineService=()=>coworkEngineService,appShutdown={isQuitting:()=>quitting};
    ${arrow}
    return {capture, service:value=>coworkEngineService=value, manager:value=>openClawEngineManager=value, quit:()=>quitting=true};`)(service, manager);
  const pending = fixture.capture();
  expect(adapter.captureGatewayResponseContext).not.toHaveBeenCalled();
  ready();
  const captured = await pending;
  expect(captured.isCurrent()).toBe(true);
  const originalRouter = router; router = {};
  expect(captured.isCurrent()).toBe(false); router = originalRouter;
  const originalAdapter = adapter; adapter = { ...adapter };
  expect(captured.isCurrent()).toBe(false); adapter = originalAdapter;
  fixture.service({}); expect(captured.isCurrent()).toBe(false); fixture.service(service);
  fixture.manager({}); expect(captured.isCurrent()).toBe(false); fixture.manager(manager);
  fixture.quit(); expect(captured.isCurrent()).toBe(false);
});
