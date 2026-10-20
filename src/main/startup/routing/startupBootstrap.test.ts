import fs from 'node:fs';

import ts from 'typescript';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  AppInitializationActivity, AppInitializationIpc, AppInitializationPhase,
  type AppInitializationState, AppInitializationTask, AppInitializationTaskStatus,
} from '../../../shared/app/initialization';
import { StartupRoute } from '../../../shared/app/startup/routing';
import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import { AppInitialization } from '../initialization/appInitialization';
import { registerAppInitializationHandlers } from '../initialization/initializationIpc';
import { StartupEnginePreparation } from '../initialization/startupEnginePreparation';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));
beforeEach(() => handlers.clear());

// Exercise the actual pre-Store composition and its guarded getter in one scope.
// Stubbing prepareStartup or the getter would conceal an eager engine dependency.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const declarations = new Map<string, ts.VariableDeclaration>();
let failure: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' && node.expression.expression.getText(source).startsWith('initApp()'))
    failure = node.arguments[0];
  ts.forEachChild(node, visit);
};
visit(source);
const initApp = declarations.get('initApp')!.initializer as ts.ArrowFunction;
const statements = (initApp.body as ts.Block).statements;
const windowIndex = statements.findIndex(node => node.getText(source) === 'createWindow();');
if (windowIndex < 0 || !failure) throw new Error('Startup composition must retain its window and failure boundaries.');
const composition = ts.transpileModule(`
  let store = null;
  let storeInitPromise = null;
  let openClawEngineManager = null;
  let startupCoordinator;
  let initialization;
  let startupEnginePreparationController;
  let mainWindow = null;
  ${['initStore', 'getStore', 'getOpenClawEngineManager', 'prepareStartup']
    .map(name => `const ${declarations.get(name)!.getText(source)};`).join('\n')}
  const opening = (async () => {
    ${statements.slice(0, windowIndex + 1).map(node => node.getText(source)).join('\n')}
  })().catch(${failure.getText(source)});
  return { opening, preparation: () => startupEnginePreparationController,
    readStore: () => getStore(), readManager: () => getOpenClawEngineManager() };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture() {
  const calls: string[] = [];
  const state = { quitting: false };
  let resolveStore!: (store: object) => void;
  let rejectStore!: (error: Error) => void;
  const data = new Promise<object>((resolve, reject) => { resolveStore = resolve; rejectStore = reject; });
  const createStore = vi.fn(() => { calls.push('store'); return data; });
  const database = {};
  const productStore = { getDatabase: () => database };
  let readStore!: () => object;
  let readManager!: () => unknown;
  const engine = { getStatus: () => ({ phase: EnginePhase.Ready, version: 'test', canRetry: false }),
    getGatewayProcessGeneration: () => 0, getGatewayLifecycleGeneration: () => 0 };
  const createManager = vi.fn(function () { calls.push('engine'); return engine; });
  const plugins = {
    prepare: vi.fn(async () => {
      expect(readStore()).toBe(productStore);
      calls.push('plugins');
      // Discovery reads runtime metadata through the actual guarded getter.
      readManager();
    }),
    initializeDatabase: vi.fn((value: object) => {
      expect(value).toBe(database);
      calls.push('plugin-schema');
    }),
  };
  const context = {
    AppInitializationActivity, AppInitializationIpc, AppInitializationPhase, AppInitializationTask, AppInitializationTaskStatus,
    StartupRoute, StartupEnginePreparation,
    AppInitialization: class extends AppInitialization {
      override async prepareUserData() { calls.push('user-data'); }
    },
    registerAppInitializationHandlers,
    registerStartupSupportHandlers: vi.fn(), registerHistoryRecoveryHandlers: vi.fn(),
    StartupCoordinator: { prepare: async () => ({ route: StartupRoute.Normal, startedAt: 1,
      getDowngradeConfirmation: () => undefined, getHistoryBackupDirectory: () => undefined,
      confirmDowngrade: () => false, prepareBeforeStore: async () => { calls.push('admission'); } }) },
    startupStartedAt: 1, startupDatabaseRuntime: {}, startupHistoryAdmissionReady: false,
    packageJson: { version: '1.0.0', devServer: { port: 43127 } },
    SqliteStore: { create: createStore }, OpenClawEngineManager: createManager,
    getAppPlugins: () => plugins,
    app: { whenReady: async () => {}, isReady: () => true, getPath: () => 'unused-startup-profile' },
    appShutdown: { isQuitting: () => state.quitting },
    prepareOpenClawExecution: vi.fn(), prepareOutboundHeaderNetworkGeneration: vi.fn(),
    getLogFilePath: () => 'unused-startup-log', getCoworkStore: vi.fn(),
    registerLocalFileScheme: vi.fn(), registerContentSecurityPolicy: vi.fn(),
    createStartupBootstrapWindow: () => ({ window: {} }),
    startupWindowHandoff: { setBootstrap: vi.fn(), showBootstrap: vi.fn() },
    createStartupWindow: () => { calls.push('failure-window'); return { loaded: Promise.resolve() }; },
    createWindow: () => { calls.push('main-window'); },
    startupPreparationError: undefined,
    APP_NAME: 'TestApp', isDev: false, isWindows: true, devServerUrl: '',
  };
  const execute = new Function(...Object.keys(context), composition);
  const owner = execute(...Object.values(context)) as {
    opening: Promise<void>; preparation: () => StartupEnginePreparation | undefined;
    readStore: () => object; readManager: () => unknown;
  };
  readStore = owner.readStore;
  readManager = owner.readManager;
  const snapshot = () => handlers.get(AppInitializationIpc.GetState)?.() as AppInitializationState | undefined;
  return { calls, state, owner, createStore, createManager,
    resolveStore: () => resolveStore(productStore), rejectStore, snapshot };
}

test.each([false, true])('startup state is readable before Store opens and engine creation respects quitting=%s', async quitting => {
  const f = fixture();
  await vi.waitFor(() => expect(f.createStore).toHaveBeenCalledOnce());
  expect(f.snapshot()).toMatchObject({ route: StartupRoute.Normal, phase: AppInitializationPhase.Preparing });
  expect(f.createManager).not.toHaveBeenCalled();
  expect(f.owner.preparation()).toBeUndefined();
  f.state.quitting = quitting;
  f.resolveStore();
  await f.owner.opening;
  if (quitting) {
    expect(f.createManager).not.toHaveBeenCalled();
    expect(f.owner.preparation()).toBeUndefined();
    expect(f.calls).not.toContain('main-window');
  } else {
    expect(f.owner.preparation()).toBeInstanceOf(StartupEnginePreparation);
    expect(f.calls).toEqual(['admission', 'user-data', 'store', 'plugins', 'engine',
      'plugin-schema', 'main-window']);
  }
});

test('Store failure retains the registered initialization endpoint and original failure without creating an engine', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = fixture();
    await vi.waitFor(() => expect(f.createStore).toHaveBeenCalledOnce());
    f.rejectStore(new Error('Product data could not be opened'));
    await f.owner.opening;
    expect(f.snapshot()).toMatchObject({ phase: AppInitializationPhase.Failed,
      error: 'Product data could not be opened' });
    expect(f.createManager).not.toHaveBeenCalled();
    expect(f.calls.at(-1)).toBe('failure-window');
  } finally { log.mockRestore(); }
});
