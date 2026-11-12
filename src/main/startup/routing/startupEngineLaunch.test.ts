import fs from 'node:fs';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import { AppInitializationActivity, AppInitializationPhase, AppInitializationStep, AppInitializationTask, AppInitializationTaskStatus } from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';

// Execute Main's real launch/ingress composition without starting Electron or a Gateway.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../../application.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);

test('releases inherited profile cwd after path selection and before logging or startup windows', () => {
  const calls = new Map<string, number>();
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (['configureUserDataPath', 'releaseStartupProfileWorkingDirectory', 'initLogger',
        'createStartupBootstrapWindow'].includes(name)) calls.set(name, node.getStart(source));
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const release = calls.get('releaseStartupProfileWorkingDirectory')!;
  expect(release).toBeGreaterThan(calls.get('configureUserDataPath')!);
  expect(release).toBeLessThan(calls.get('initLogger')!);
  expect(release).toBeLessThan(calls.get('createStartupBootstrapWindow')!);
});

let statements: readonly ts.Statement[] = [];
let prepareNetworkGeneration: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === 'prepareOutboundHeaderNetworkGeneration')
    prepareNetworkGeneration = node.initializer;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'initApp' &&
      node.initializer && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body))
    statements = node.initializer.body.statements;
  ts.forEachChild(node, visit);
};
visit(source);
const first = statements.findIndex(node => node.getText(source).startsWith('initialization.advance(AppInitializationStep.Engine,'));
const last = statements.findIndex(node => node.getText(source).startsWith('if (!normalStartup) await startStartupEngine()'));
if (first < 0 || last < first) throw new Error('The Main engine startup composition must remain identifiable.');
const javascript = ts.transpileModule(statements.slice(first, last + 1).map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('starts the proxy when a failed policy change rolls back to the previous digest', async () => {
  if (!prepareNetworkGeneration) throw new Error('Main network preparation unavailable');
  const callback = ts.transpileModule(`const prepare = ${prepareNetworkGeneration.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const proxy = {
    stop: vi.fn(),
    start: vi.fn().mockRejectedValueOnce(new Error('Proxy start failed')).mockResolvedValue(undefined),
  };
  const reconcile = vi.fn()
    .mockReturnValueOnce({ digest: 'new' })
    .mockReturnValueOnce({ digest: 'previous' });
  const prepare = new Function('getOutboundHeaderPolicyService', 'getOutboundHeaderProxy',
    `let activeOutboundHeaderPolicyDigest = 'previous'; ${callback} return prepare;`)(
    () => ({ reconcile }), () => proxy,
  ) as () => Promise<void>;

  await expect(prepare()).rejects.toThrow('Proxy start failed');
  await expect(prepare()).resolves.toBeUndefined();

  expect(proxy.stop).toHaveBeenCalledOnce();
  expect(proxy.start).toHaveBeenCalledTimes(2);
});

test('history isolation finishes before the persistent main window can open its profile stores', async () => {
  const isolation = statements.findIndex(node => node.getText(source).startsWith('await startupCoordinator.prepareBeforeStore('));
  expect(isolation).toBeGreaterThan(0);
  const calls: string[] = [];
  const context = {
    AppInitializationTask, AppInitializationTaskStatus,
    app: { whenReady: async () => {} },
    appShutdown: { isQuitting: () => false },
    registerLocalFileScheme: vi.fn(),
    APP_NAME: 'TestApp', isDev: false, isWindows: true, devServerUrl: '',
    createStartupBootstrapWindow: () => { calls.push('memory-bootstrap'); return { window: {} }; },
    startupWindowHandoff: { setBootstrap: vi.fn(), showBootstrap: vi.fn() },
    prepareStartup: async () => {},
    initialization: { getState: () => ({ firstLaunch: true }), setTaskStatus: vi.fn() },
    createStartupWindow: () => { calls.push('memory-initialization'); return { loaded: Promise.resolve() }; },
    startupPreparationError: undefined,
    startupCoordinator: { prepareBeforeStore: async () => { calls.push('isolate'); } },
    createWindow: () => { throw new Error('persistent window opened before isolation'); },
  };
  const prefix = ts.transpileModule(statements.slice(0, isolation + 1).map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  await new Function(...Object.keys(context), `return (async () => { ${prefix} })();`)(...Object.values(context));
  expect(calls).toEqual(['memory-bootstrap', 'memory-initialization', 'isolate']);
});

test('product Store and network policy, certificates and proxy activation follow required profile isolation', () => {
  const position = (prefix: string) => statements.findIndex(node => node.getText(source).startsWith(prefix));
  const isolation = position('await startupCoordinator.prepareBeforeStore(');
  const store = position('store = await initStore(');
  expect(isolation).toBeGreaterThan(0);
  expect(store).toBeGreaterThan(isolation);
  for (const prefix of ['const initialOutboundHeaderPolicy =', 'await getOutboundHeaderProxy().start(',
    'await applySystemProxyPreference(', 'await applyBrowserProxyPreference('])
    expect(position(prefix)).toBeGreaterThan(store);
});

function fixture(route: StartupRoute, configReady = true, delayServices = false) {
  const calls: string[] = [];
  let finish!: (status: { phase: string }) => void;
  const engine = new Promise<{ phase: string }>(resolve => { finish = resolve; });
  const pending = vi.fn();
  let finishServices!: (ready: boolean) => void;
  const ingress = new Promise<boolean>(resolve => { finishServices = resolve; });
  const context = {
    AppInitializationActivity, AppInitializationPhase, AppInitializationStep, AppInitializationTask, AppInitializationTaskStatus, StartupRoute,
    initialization: {
      advance: vi.fn(), reportActivity: vi.fn(), setEnginePreparationPending: pending, setTaskStatus: vi.fn(),
      failEnginePreparation: vi.fn(),
      getState: () => ({ phase: AppInitializationPhase.Preparing }),
      fail: vi.fn(),
      runOptionalTask: async (_label: string, run: () => Promise<void>) => { await run(); },
    },
    startupCoordinator: { route, verifyNativeReady: async () => true },
    startupSync: { success: configReady }, appShutdown: { isQuitting: () => false },
    ensureOpenClawRunningForCowork: () => { calls.push('gateway'); return engine; },
    getOpenClawEngineManager: () => ({ getGatewayProcessGeneration: () => 7 }),
    getCronJobService: () => ({ startPolling: () => { calls.push('poll'); } }),
    startChromeExtensionIngress: async () => { calls.push('browser'); return delayServices ? ingress : true; },
    getAgentCliIntegrationService: () => ({ prepare: () => { calls.push('cli'); } }),
    ensureAgentBridgeRunning: async () => { calls.push('bridge'); },
    getAppServerIntegrationService: () => ({ start: async () => { calls.push('server'); } }),
    waitForAppServerShutdown: async () => {},
    appServerIntegrationService: undefined, agentBridgeServer: undefined,
    t: (key: string) => key,
  };
  const execute = new Function(...Object.keys(context), `return (async () => {
    let startupHistoryAdmissionReady = false;
    let startupEnginePreparation;
    let startupExecutionGeneration;
    let startupIntegrationPreparation;
    ${javascript}
    return { engine: startupEnginePreparation, integrations: startupIntegrationPreparation,
      generation: () => startupExecutionGeneration };
  })();`);
  return { calls, finish, finishServices, pending, context, run: () => execute(...Object.values(context)) };
}

test('ordinary startup launches Gateway before local integrations without waiting for engine completion', async () => {
  const f = fixture(StartupRoute.Normal, true, true);
  const owner = await f.run();
  expect(f.calls).toEqual(['gateway', 'browser']);
  expect(owner.generation()).toBeUndefined();
  f.finish({ phase: 'running' });
  await owner.engine;
  expect(owner.generation()).toBe(7);
  expect(f.calls.at(-1)).toBe('poll');
  f.finishServices(true);
  await owner.integrations;
  expect(f.calls).toEqual(['gateway', 'browser', 'poll', 'cli', 'bridge', 'server']);
  expect(f.context.initialization.setTaskStatus).toHaveBeenLastCalledWith(
    AppInitializationTask.Integrations, AppInitializationTaskStatus.Complete);
});

test('upgrade startup retains integration ordering and waits for its same engine preparation', async () => {
  const f = fixture(StartupRoute.Upgrade);
  let settled = false;
  const opening = f.run().then((owner: unknown) => { settled = true; return owner; });
  await vi.waitFor(() => expect(f.calls).toContain('gateway'));
  expect(f.calls).toEqual(['browser', 'cli', 'bridge', 'server', 'gateway']);
  expect(f.pending).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  f.finish({ phase: 'running' });
  await opening;
});

test('ordinary startup does not launch an engine using failed configuration', async () => {
  const f = fixture(StartupRoute.Normal, false);
  const owner = await f.run();
  await owner.integrations;
  expect(f.calls).toEqual(['browser', 'cli', 'bridge', 'server']);
  expect(owner.engine).toBeUndefined();
  expect(f.pending).not.toHaveBeenCalled();
  expect(f.context.initialization.failEnginePreparation).toHaveBeenCalledWith(expect.any(Error));
});

test('an unexpected ordinary integration failure does not invalidate the usable shell', async () => {
  const f = fixture(StartupRoute.Normal);
  f.context.startChromeExtensionIngress = async () => { throw new Error('integration initialization failed'); };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const owner = await f.run();
    await expect(owner.integrations).rejects.toThrow('integration initialization failed');
    expect(f.context.initialization.fail).not.toHaveBeenCalled();
    f.finish({ phase: 'running' });
    await owner.engine;
  } finally { error.mockRestore(); }
});

test('failed local integration setup remains separate from the running engine', async () => {
  const f = fixture(StartupRoute.Normal);
  f.context.getAgentCliIntegrationService = () => ({ prepare: () => { throw new Error('launcher unavailable'); } });
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const owner = await f.run();
    await owner.integrations;
    expect(f.context.initialization.setTaskStatus).toHaveBeenLastCalledWith(
      AppInitializationTask.Integrations, AppInitializationTaskStatus.Failed);
    expect(f.context.initialization.fail).not.toHaveBeenCalled();
    f.finish({ phase: 'running' });
    await owner.engine;
    expect(owner.generation()).toBe(7);
  } finally { log.mockRestore(); }
});
