import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SHUTDOWN_BUDGET_MS } from '../../../shared/app/shutdownPolicy';
import { runApplicationCleanup, settleCleanupTasks } from './cleanupPhases';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const stages = () => ({
  retireStartup: vi.fn(async () => undefined),
  retireServices: vi.fn(async () => undefined),
  retireGateway: vi.fn(async () => undefined),
  retireRemainingServices: vi.fn(async () => undefined),
  closeStore: vi.fn(async () => undefined),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('closes the existing Store only after every retirement actually joins', async () => {
  const owners = stages();
  const gateway = deferred();
  owners.retireGateway.mockImplementation(() => gateway.promise);
  const cleanup = runApplicationCleanup(owners);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(owners.retireStartup).toHaveBeenCalledOnce();
  expect(owners.retireServices).toHaveBeenCalledOnce();
  expect(owners.closeStore).not.toHaveBeenCalled();
  gateway.resolve();
  await cleanup;
  expect(owners.retireRemainingServices).toHaveBeenCalledOnce();
  expect(owners.closeStore).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['retireStartup', 'retireServices', 'retireGateway', 'retireRemainingServices'] as const)(
  'a synchronous %s failure still attempts every runtime retirement and never closes the Store',
  async phase => {
    const owners = stages();
    owners[phase].mockImplementation(() => { throw new Error('retirement failed'); });
    await expect(runApplicationCleanup(owners)).rejects.toThrow('did not confirm');
    expect(owners.retireGateway).toHaveBeenCalledOnce();
    expect(owners.retireRemainingServices).toHaveBeenCalledOnce();
    expect(owners.closeStore).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  ['retireStartup', SHUTDOWN_BUDGET_MS.startupRetirement],
  ['retireServices', SHUTDOWN_BUDGET_MS.otherAppCleanup],
  ['retireGateway', SHUTDOWN_BUDGET_MS.gatewayStop],
] as const)('a pending %s is not a successful join', async (phase, deadline) => {
  const owners = stages();
  owners[phase].mockImplementation(() => new Promise(() => {}));
  const observed = runApplicationCleanup(owners).catch(error => error);
  await vi.advanceTimersByTimeAsync(deadline + 1);
  expect(await observed).toBeInstanceOf(AggregateError);
  expect(owners.retireGateway).toHaveBeenCalledOnce();
  expect(owners.retireRemainingServices).toHaveBeenCalledOnce();
  expect(owners.closeStore).not.toHaveBeenCalled();
});

test('late service completion cannot erase its timeout or close a Store underneath another owner', async () => {
  const owners = stages();
  const service = deferred();
  const gateway = deferred();
  owners.retireServices.mockImplementation(() => service.promise);
  owners.retireGateway.mockImplementation(() => gateway.promise);
  const observed = runApplicationCleanup(owners).catch(error => error);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_BUDGET_MS.otherAppCleanup);
  expect(owners.retireGateway).toHaveBeenCalledOnce();
  service.resolve();
  gateway.resolve();
  expect(await observed).toBeInstanceOf(AggregateError);
  expect(owners.closeStore).not.toHaveBeenCalled();
});

test('service phases share thirty seconds without charging the native Gateway wait', async () => {
  const owners = stages();
  owners.retireServices.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 25_000)));
  owners.retireGateway.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 300_000)));
  owners.retireRemainingServices.mockImplementation(() => new Promise(() => {}));
  let finished = false;
  const observed = runApplicationCleanup(owners).catch(error => { finished = true; return error; });
  await vi.advanceTimersByTimeAsync(325_000 + 4_999);
  expect(owners.retireRemainingServices).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await observed).toBeInstanceOf(AggregateError);
  expect(owners.closeStore).not.toHaveBeenCalled();
});

test('all independent cleanup tasks start and rejection waits for the other real join', async () => {
  const pending = deferred();
  const other = vi.fn(() => pending.promise);
  let finished = false;
  const observed = settleCleanupTasks([
    () => { throw new Error('first failed'); }, other,
  ]).catch(error => { finished = true; return error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(other).toHaveBeenCalledOnce();
  expect(finished).toBe(false);
  pending.resolve();
  expect(await observed).toBeInstanceOf(AggregateError);
});
