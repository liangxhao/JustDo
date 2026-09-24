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
