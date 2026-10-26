import fs from 'node:fs';

import ts from 'typescript';
import { afterEach, expect, test, vi } from 'vitest';

import { runApplicationCleanup, settleCleanupTasks } from '../../core/app/cleanupPhases';

// Execute the actual composition-root cleanup, without booting Electron or any service.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const matches: ts.VariableDeclaration[] = [];
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'runAppCleanup')
    matches.push(node);
  ts.forEachChild(node, visit);
};
visit(source);
if (matches.length !== 1) throw new Error('The Main cleanup owner must remain unique.');
const javascript = ts.transpileModule('const ' + matches[0].getText(source) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
afterEach(() => vi.restoreAllMocks());

test.each([false, true, 'admission', 'integrations'] as const)('Main attempts every retirement when shutdown failure is %s', async rejects => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const calls: string[] = [];
  const retired = new Error('Native child retirement remains unconfirmed');
  const context = {
    startupHistoryAdmissionReady: true,
    startupIntegrationPreparation: rejects === 'integrations' ? Promise.reject(retired) : undefined,
    runApplicationCleanup, settleCleanupTasks,
    startupCoordinator: { stop: () => { calls.push('startup-confirmation'); } },
    appServerIntegrationService: { stop: async () => { calls.push('app-server'); } },
    startupHistoryRuntime: { stop: async () => { calls.push('history'); } },
    startupDatabaseRuntime: { stop: async () => { calls.push('native'); if (rejects === true) throw retired; } },
    disposeComputerOverlay: undefined,
    openClawEngineManager: {
      beginApplicationShutdown: () => { calls.push('block-gateway'); if (rejects === 'admission') throw retired; },
      stopGateway: async () => { calls.push('stop-gateway'); },
    },
    devSessionLifecycle: undefined, detachDevelopmentParent: undefined,
    store: { close: () => { calls.push('product-db'); } },
    getTeamDiscussionCoordinator: () => ({ dispose: () => { calls.push('team'); } }),
    builtinModelCredentialMonitor: undefined, loginService: undefined,
    customerRegistrationService: undefined, builtinModelTokenExchange: undefined,
    builtinModelAuthCoordinator: undefined,
    clearActiveBuiltinModelCredential: () => { calls.push('credentials'); },
    clearBrowserExtensionAppServer: async () => {}, app: { getPath: () => '/unused-fixture' },
    browserExtensionChatServer: undefined, waitForAppServerShutdown: async () => true,
    destroyTray: () => { calls.push('tray'); }, agentBridgeServer: undefined,
    getCronJobService: () => ({ stopPolling: () => { calls.push('scheduler'); } }),
    coworkEngineService: undefined,
    browserAgentBridge: { stop: async () => { calls.push('browser-bridge'); } },
    embeddedBrowserGatewayBridge: { revoke: () => { calls.push('browser-routing'); } },
    outboundHeaderProxy: undefined,
    getStore: () => { throw new Error('Cleanup must never initialize a Store'); },
  };
  const owner = new Function(...Object.keys(context), javascript +
    '\nreturn { cleanup: runAppCleanup, admitted: () => startupHistoryAdmissionReady };')(...Object.values(context));
  if (rejects) await expect(owner.cleanup()).rejects.toThrow('did not confirm');
  else await expect(owner.cleanup()).resolves.toBeUndefined();
  expect(owner.admitted()).toBe(false);
  expect(calls[0]).toBe('block-gateway');
  expect(calls).toEqual(['block-gateway', 'startup-confirmation', 'app-server', 'history', 'native', 'team',
    'credentials', 'tray', 'scheduler', 'stop-gateway', 'browser-routing', 'browser-bridge', ...(rejects ? [] : ['product-db'])]);
  if (rejects) expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('retirement remains unconfirmed'), 'startup',
    expect.any(AggregateError),
  );
});
