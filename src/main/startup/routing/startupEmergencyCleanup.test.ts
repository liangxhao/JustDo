import fs from 'node:fs';

import ts from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SHUTDOWN_BUDGET_MS } from '../../../shared/app/shutdownPolicy';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { preventDefault: () => void }) => void>(),
  exit: vi.fn(),
}));
vi.mock('electron', () => ({ app: { exit: electronMocks.exit,
  on: (name: string, handler: (event: { preventDefault: () => void }) => void) =>
    electronMocks.handlers.set(name, handler) } }));

import { registerAppShutdown } from '../../core/app/appShutdown';
import { runApplicationCleanup } from '../../core/app/cleanupPhases';

// Execute Main's actual supervisor options with real cleanup/controller owners.
// No Electron process, user database, Gateway or child process is created.
const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const registrations: ts.ObjectLiteralExpression[] = [];
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerAppShutdown' &&
    node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) registrations.push(node.arguments[0]);
  ts.forEachChild(node, visit);
};
visit(source);
if (registrations.length !== 1) throw new Error('The Main shutdown registration must remain unique.');
const javascript = ts.transpileModule('const options = ' + registrations[0].getText(source) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const options = (cleanup: () => Promise<void>) =>
  new Function('runAppCleanup', 'SHUTDOWN_BUDGET_MS', javascript + '\nreturn options;')(cleanup, SHUTDOWN_BUDGET_MS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  electronMocks.handlers.clear();
  electronMocks.exit.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const quit = () => electronMocks.handlers.get('before-quit')!({ preventDefault: vi.fn() });

test('an unjoined startup owner is observed once and can never become a successful exit later', async () => {
  let finish!: () => void;
  const retiring = new Promise<void>(resolve => { finish = resolve; });
  const stop = vi.fn(() => retiring);
  const gateway = vi.fn(async () => undefined);
  const closeStore = vi.fn();
  registerAppShutdown(options(() => runApplicationCleanup({
    retireStartup: stop, retireServices: async () => undefined, retireGateway: gateway,
    retireRemainingServices: async () => undefined, closeStore,
  })));
  quit();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(stop).toHaveBeenCalledOnce();
  expect(electronMocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET_MS.startupRetirement - 30_000);
  expect(gateway).toHaveBeenCalledOnce();
  expect(electronMocks.exit).toHaveBeenCalledExactlyOnceWith(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(stop).toHaveBeenCalledOnce();
  expect(closeStore).not.toHaveBeenCalled();
  expect(electronMocks.exit).toHaveBeenCalledOnce();
});

test('the actual Main outer deadline cannot open another native stop window', async () => {
  const cleanup = vi.fn(() => new Promise<void>(() => {}));
  const registration = options(cleanup);
  expect(registration.cleanupTimeoutMs).toBe(SHUTDOWN_BUDGET_MS.applicationExit);
  expect(registration).not.toHaveProperty('onCleanupTimeout');
  registerAppShutdown(registration);
  quit();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET_MS.applicationExit - 1);
  expect(electronMocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(electronMocks.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(cleanup).toHaveBeenCalledOnce();
});

test('native cleanup beyond the former outer deadline still finishes normally within the shared budget', async () => {
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const closeStore = vi.fn();
  registerAppShutdown(options(() => runApplicationCleanup({
    retireStartup: async () => undefined, retireServices: () => wait(25_000),
    retireGateway: () => wait(310_000), retireRemainingServices: () => wait(4_000), closeStore,
  })));
  quit();
  await vi.advanceTimersByTimeAsync(47_000);
  expect(electronMocks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(339_000 - 47_000);
  expect(closeStore).toHaveBeenCalledOnce();
  expect(electronMocks.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});
