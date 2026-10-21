import { expect, test, vi } from 'vitest';

import { BuiltinModelAuthCoordinator } from './builtinModelAuthCoordinator';
import type { BuiltinModelCredential } from './builtinModelCredential';

const credential: BuiltinModelCredential = { accessToken: 'fixture', userAccount: 'user', expiresAt: 2_000_000_000 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = () => {
  const dependencies = {
    exchange: vi.fn(async (): Promise<BuiltinModelCredential | null> => credential),
    getActive: vi.fn((): BuiltinModelCredential | null => credential),
    login: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
  return { dependencies, coordinator: new BuiltinModelAuthCoordinator(dependencies) };
};

test('obsolete exchange cannot log out a newer successful login', async () => {
  const { dependencies, coordinator } = setup();
  const old = deferred<BuiltinModelCredential | null>();
  dependencies.exchange.mockImplementationOnce(() => old.promise);
  const first = coordinator.refresh();
  await coordinator.refresh();
  old.resolve(null);
  await first;
  expect(dependencies.login).toHaveBeenCalledTimes(1);
  expect(dependencies.logout).not.toHaveBeenCalled();
});

test('late exchange cannot restore credentials after explicit logout', async () => {
  const { dependencies, coordinator } = setup();
  const pending = deferred<BuiltinModelCredential | null>();
  dependencies.exchange.mockImplementationOnce(() => pending.promise);
  const refresh = coordinator.refresh();
  dependencies.getActive.mockReturnValue(null);
  await coordinator.logout();
  pending.resolve(credential);
  expect(await refresh).toBeNull();
  expect(dependencies.login).not.toHaveBeenCalled();
});

test('obsolete lifecycle completion cannot mark a logged-out token as applied', async () => {
  const { dependencies, coordinator } = setup();
  const pending = deferred<undefined>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  const refresh = coordinator.refresh();
  await Promise.resolve();
  await coordinator.logout();
  pending.resolve(undefined);
  await refresh;
  await coordinator.refresh();
  expect(dependencies.login).toHaveBeenCalledTimes(2);
});

test('obsolete failure cannot clear a newer authentication decision', async () => {
  const { dependencies, coordinator } = setup();
  const pending = deferred<BuiltinModelCredential | null>();
  dependencies.exchange.mockImplementationOnce(() => pending.promise);
  const refresh = coordinator.refresh();
  await coordinator.refresh();
  pending.reject(new Error('offline'));
  await expect(refresh).resolves.toEqual(credential);
  expect(dependencies.logout).not.toHaveBeenCalled();
});

test('cached token skips catalog refresh unless explicitly requested', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  await coordinator.refresh();
  expect(dependencies.login).not.toHaveBeenCalled();
  await coordinator.refresh(true);
  expect(dependencies.login).toHaveBeenCalledTimes(1);
});

test('retries credential removal after a failed logout synchronization', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.exchange.mockResolvedValue(null);
  dependencies.getActive.mockReturnValue(null);
  dependencies.logout.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(coordinator.logout()).rejects.toThrow('disk unavailable');
  await coordinator.refresh();
  expect(dependencies.logout).toHaveBeenCalledTimes(2);
});

test('awaits native cleanup even when synchronous snapshot revocation fails', async () => {
  const { dependencies, coordinator } = setup();
  const cleanup = deferred<undefined>();
  const failure = new Error('snapshot locked');
  dependencies.invalidate.mockImplementationOnce(() => { throw failure; });
  dependencies.logout.mockImplementationOnce(() => cleanup.promise);
  let settled = false;
  const logout = coordinator.logout();
  const observed = logout.catch(error => { settled = true; return error; });
  await Promise.resolve();
  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  cleanup.resolve(undefined);
  expect(await observed).toBe(failure);
  dependencies.getActive.mockReturnValue(null);
  dependencies.exchange.mockResolvedValue(null);
  await coordinator.refresh();
  expect(dependencies.logout).toHaveBeenCalledOnce();
});

test('retains the native cleanup failure when snapshot revocation also fails', async () => {
  const { dependencies, coordinator } = setup();
  dependencies.invalidate.mockImplementationOnce(() => { throw new Error('snapshot locked'); });
  dependencies.logout.mockRejectedValueOnce(new Error('Gateway cleanup failed'));
  await expect(coordinator.logout()).rejects.toThrow('Gateway cleanup failed');
  expect(dependencies.logout).toHaveBeenCalledOnce();
  dependencies.getActive.mockReturnValue(null);
  dependencies.exchange.mockResolvedValue(null);
  await coordinator.refresh();
  expect(dependencies.logout).toHaveBeenCalledTimes(2);
});

test('null refresh cancels a pending login even when initially logged out', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(null);
  const pending = deferred<undefined>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  const login = coordinator.refresh();
  await Promise.resolve();
  dependencies.exchange.mockResolvedValue(null);
  dependencies.getActive.mockReturnValue(null);
  await coordinator.refresh();
  expect(dependencies.logout).toHaveBeenCalledTimes(1);
  pending.resolve(undefined);
  await login;
});

test('previous token is reapplied when a different token synchronization is pending', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const pending = deferred<undefined>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  dependencies.exchange.mockResolvedValueOnce({ ...credential, accessToken: 'new-fixture' });
  const login = coordinator.refresh();
  await Promise.resolve();
  await coordinator.refresh();
  expect(dependencies.login).toHaveBeenCalledTimes(2);
  pending.resolve(undefined);
  await login;
});
