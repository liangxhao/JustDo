import { expect, test, vi } from 'vitest';

import { BuiltinModelAuthCoordinator } from './builtinModelAuthCoordinator';
import type { BuiltinModelCredential } from './builtinModelCredential';
import { BuiltinModelCredentialMonitor } from './builtinModelCredentialMonitor';

const credential: BuiltinModelCredential = { accessToken: 'fixture', userAccount: 'user', expiresAt: 2_000_000_000 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = () => {
  const dependencies = {
    getActive: vi.fn((): BuiltinModelCredential | null => credential),
    getAuthSessionId: vi.fn((): string | null => 'session-1'),
    getActiveBinding() {
      const active = this.getActive();
      const authSessionId = this.getAuthSessionId();
      return active && authSessionId ? { credential: active, authSessionId } : null;
    },
    exchange: vi.fn(async (): Promise<BuiltinModelCredential | null> => credential),
    login: vi.fn(async () => true),
    rotate: vi.fn(async () => true),
    invalidate: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
  return { dependencies, coordinator: new BuiltinModelAuthCoordinator(dependencies) };
};

test('background renewal publishes across multiple token lifetimes while configuration confirmation is pending', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    let sequence = 0;
    const issue = (): BuiltinModelCredential => {
      const now = Math.floor(Date.now() / 1000);
      return {
        accessToken: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ iat: now, exp: now + 120, sequence: sequence++ })).toString('base64url')}.fixture`,
        userAccount: 'user', expiresAt: now + 120,
      };
    };
    let active = issue();
    const confirmation = deferred<boolean>();
    const dependencies = {
      exchange: vi.fn(async () => { active = issue(); return active; }),
      getActiveBinding: () => ({ credential: active, authSessionId: 'session-1' }),
      publishCredential: vi.fn(),
      login: vi.fn(async () => true),
      rotate: vi.fn(async () => true),
      logout: vi.fn(async () => undefined),
    };
    dependencies.rotate.mockImplementationOnce(() => confirmation.promise);
    const coordinator = new BuiltinModelAuthCoordinator(dependencies);
    coordinator.initialize(active);
    const monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: 'fixture', refresh: () => coordinator.refreshInBackground(),
      watchFile: vi.fn(), unwatchFile: vi.fn(),
    });
    monitor.start(active);

    await vi.advanceTimersByTimeAsync(300_000);

    expect(dependencies.exchange).toHaveBeenCalledTimes(5);
    expect(dependencies.publishCredential).toHaveBeenCalledTimes(5);
    expect(dependencies.publishCredential).toHaveBeenLastCalledWith({ credential: active, authSessionId: 'session-1' });
    expect(dependencies.rotate).toHaveBeenCalledTimes(1);
    confirmation.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(dependencies.rotate).toHaveBeenCalledTimes(2);
    dependencies.exchange.mockResolvedValue(active);
    await coordinator.refresh();
    expect(dependencies.rotate).toHaveBeenCalledTimes(2);
    monitor.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('a late background confirmation cannot confirm a newer token or restore a logged-out session', async () => {
  const { dependencies } = setup();
  const publishCredential = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(credential);
  const first = { ...credential, accessToken: 'first-renewal' };
  const latest = { ...credential, accessToken: 'latest-renewal' };
  const confirmation = deferred<boolean>();
  dependencies.exchange.mockImplementationOnce(async () => {
    dependencies.getActive.mockReturnValue(first);
    return first;
  }).mockImplementation(async () => {
    dependencies.getActive.mockReturnValue(latest);
    return latest;
  });
  dependencies.rotate.mockImplementationOnce(() => confirmation.promise);

  expect(await coordinator.refreshInBackground()).toEqual(first);
  expect(await coordinator.refreshInBackground()).toEqual(latest);
  expect(publishCredential.mock.calls).toEqual([
    [{ credential: first, authSessionId: 'session-1' }],
    [{ credential: latest, authSessionId: 'session-1' }],
  ]);
  dependencies.getAuthSessionId.mockReturnValue(null);
  dependencies.getActive.mockReturnValue(null);
  const logout = coordinator.logout();
  confirmation.resolve(true);
  await logout;

  expect(dependencies.rotate).toHaveBeenCalledTimes(1);
  expect(dependencies.logout).toHaveBeenCalledTimes(1);
  dependencies.getAuthSessionId.mockReturnValue('session-2');
  dependencies.getActive.mockReturnValue(latest);
  await coordinator.refresh();
  expect(dependencies.login).toHaveBeenCalledTimes(1);
});

test('background application failures request a retry and never confirm the published token', async () => {
  const { dependencies } = setup();
  const publishCredential = vi.fn();
  const onBackgroundError = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential, onBackgroundError });
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);
  const failure = new Error('native confirmation unavailable');
  dependencies.rotate.mockRejectedValueOnce(failure);

  expect(await coordinator.refreshInBackground()).toEqual(renewed);
  await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledWith(failure));
  await coordinator.refresh();

  expect(dependencies.rotate).toHaveBeenCalledTimes(2);
  expect(publishCredential).toHaveBeenCalledTimes(2);
});

test('a failed synchronous publication starts no configuration work and remains retryable', async () => {
  const { dependencies } = setup();
  const failure = new Error('snapshot publication failed');
  const publishCredential = vi.fn().mockImplementationOnce(() => { throw failure; });
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed' };
  dependencies.getActive.mockReturnValue(renewed);
  dependencies.exchange.mockResolvedValue(renewed);

  await expect(coordinator.refreshInBackground()).rejects.toBe(failure);
  expect(dependencies.rotate).not.toHaveBeenCalled();
  await coordinator.refresh();

  expect(publishCredential).toHaveBeenCalledTimes(2);
  expect(dependencies.rotate).toHaveBeenCalledOnce();
});

test('expired exchange failures do not hold subsequent background exchanges behind cleanup confirmation', async () => {
  const { dependencies } = setup();
  const coordinator = new BuiltinModelAuthCoordinator(dependencies);
  coordinator.initialize(credential);
  const cleanup = deferred<undefined>();
  dependencies.logout.mockImplementationOnce(() => cleanup.promise);
  dependencies.getActive.mockReturnValue(null);
  dependencies.getAuthSessionId.mockReturnValue(null);
  dependencies.exchange.mockRejectedValueOnce(new Error('exchange unavailable'));

  await expect(coordinator.refreshInBackground()).rejects.toThrow('exchange unavailable');
  expect(dependencies.logout).toHaveBeenCalledOnce();
  dependencies.getActive.mockReturnValue(credential);
  dependencies.getAuthSessionId.mockReturnValue('session-1');
  expect(await coordinator.refreshInBackground()).toEqual(credential);
  expect(dependencies.exchange).toHaveBeenCalledTimes(2);
  expect(dependencies.login).not.toHaveBeenCalled();
  cleanup.resolve(undefined);
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
});

test('background renewal preserves foreground login and coalesces its latest pending rotation', async () => {
  const { dependencies } = setup();
  const publishCredential = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(null);
  const confirmation = deferred<boolean>();
  dependencies.login.mockImplementationOnce(() => confirmation.promise);
  const foreground = coordinator.refresh(true);
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  const renewed = { ...credential, accessToken: 'first-renewal' };
  const latest = { ...credential, accessToken: 'latest-renewal' };

  dependencies.exchange.mockImplementationOnce(async () => {
    dependencies.getActive.mockReturnValue(renewed);
    return renewed;
  }).mockImplementation(async () => {
    dependencies.getActive.mockReturnValue(latest);
    return latest;
  });
  expect(await coordinator.refreshInBackground()).toEqual(renewed);
  expect(await coordinator.refreshInBackground()).toEqual(latest);
  expect(publishCredential).toHaveBeenLastCalledWith({ credential: latest, authSessionId: 'session-1' });
  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();

  confirmation.resolve(true);
  await foreground;
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());
  expect(dependencies.login).toHaveBeenCalledOnce();
  await coordinator.refresh();
  expect(dependencies.rotate).toHaveBeenCalledOnce();
});

test('background renewal does not cancel foreground catalog refresh during exchange', async () => {
  const { dependencies } = setup();
  const coordinator = new BuiltinModelAuthCoordinator(dependencies);
  coordinator.initialize(credential);
  const pending = deferred<BuiltinModelCredential | null>();
  dependencies.exchange.mockImplementationOnce(() => pending.promise);
  const foreground = coordinator.refresh(true);

  await coordinator.refreshInBackground();
  pending.resolve(credential);
  await foreground;

  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('background expiry cleanup waits for foreground work while explicit logout remains immediate', async () => {
  const { dependencies, coordinator } = setup();
  const confirmation = deferred<boolean>();
  dependencies.login.mockImplementationOnce(() => confirmation.promise);
  const foreground = coordinator.refresh(true);
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  dependencies.exchange.mockRejectedValueOnce(new Error('exchange unavailable'));
  dependencies.getActive.mockReturnValue(null);
  dependencies.getAuthSessionId.mockReturnValue(null);

  await expect(coordinator.refreshInBackground()).rejects.toThrow('exchange unavailable');
  expect(dependencies.logout).not.toHaveBeenCalled();
  await coordinator.logout();
  expect(dependencies.logout).toHaveBeenCalledOnce();
  confirmation.resolve(true);
  await foreground;
  expect(dependencies.logout).toHaveBeenCalledOnce();
});

test.each(['foreground', 'logout'] as const)('late background exchange cannot publish after %s supersedes it', async superseding => {
  const { dependencies } = setup();
  const publishCredential = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(credential);
  const pending = deferred<BuiltinModelCredential | null>();
  dependencies.exchange.mockImplementationOnce(() => pending.promise);
  const background = coordinator.refreshInBackground();
  if (superseding === 'foreground') await coordinator.refresh();
  else await coordinator.logout();
  const publications = publishCredential.mock.calls.length;

  pending.resolve({ ...credential, accessToken: 'obsolete-renewal' });
  await background;

  expect(publishCredential).toHaveBeenCalledTimes(publications);
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

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
  const pending = deferred<boolean>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  const refresh = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  await coordinator.logout();
  pending.resolve(true);
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
  await expect(refresh).resolves.toBeNull();
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

test('renews an established login without waiting for model discovery', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);

  await expect(coordinator.refresh()).resolves.toEqual(renewed);
  await coordinator.refresh();

  expect(dependencies.rotate).toHaveBeenCalledOnce();
  expect(dependencies.login).not.toHaveBeenCalled();
});

test('first login and explicit catalog refresh still discover models', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(null);
  await coordinator.refresh();
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.getActive.mockReturnValue(renewed);
  dependencies.exchange.mockResolvedValue(renewed);
  await coordinator.refresh(true);

  expect(dependencies.login).toHaveBeenCalledTimes(2);
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('retries an unconfirmed rotation without rediscovering models or treating the token as applied', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);
  dependencies.rotate.mockRejectedValueOnce(new Error('credential reload pending'));

  await expect(coordinator.refresh()).rejects.toThrow('credential reload pending');
  await coordinator.refresh();
  await coordinator.refresh();

  expect(dependencies.rotate).toHaveBeenCalledTimes(2);
  expect(dependencies.login).not.toHaveBeenCalled();
});

test('failed initial login retries model discovery before establishing the rotation path', async () => {
  const { dependencies, coordinator } = setup();
  dependencies.login.mockRejectedValueOnce(new Error('initial application failed'));

  await expect(coordinator.refresh()).rejects.toThrow('initial application failed');
  await coordinator.refresh();

  expect(dependencies.login).toHaveBeenCalledTimes(2);
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('same token from a new auth session cannot reuse the previous confirmation', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.getAuthSessionId.mockReturnValue('session-2');

  await coordinator.refresh();

  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test.each([null, true])('withdraws access when the binding expires during snapshot publication (%s)', async published => {
  const { dependencies } = setup();
  const publishCredential = vi.fn().mockImplementation(() => {
    dependencies.getActive.mockReturnValue(null);
    return published;
  });
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(credential);

  await expect(coordinator.refresh()).resolves.toBeNull();

  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(dependencies.login).not.toHaveBeenCalled();
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('foreground refresh waits for confirmation evidence before reporting built-in access', async () => {
  const { dependencies } = setup();
  const onApplicationUnconfirmed = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, onApplicationUnconfirmed });
  dependencies.login.mockResolvedValueOnce(false);

  await expect(coordinator.refresh(true)).resolves.toBeNull();
  expect(onApplicationUnconfirmed).toHaveBeenCalledOnce();
  await expect(coordinator.refresh()).resolves.toBe(credential);
  expect(dependencies.login).toHaveBeenCalledTimes(2);
});

test('a cleanup failure cannot hide an exchange rejection', async () => {
  const { dependencies } = setup();
  const exchangeFailure = new Error('exchange rejected');
  const cleanupFailure = new Error('native cleanup unavailable');
  const onBackgroundError = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, onBackgroundError });
  dependencies.getActive.mockReturnValue(null);
  dependencies.exchange.mockRejectedValueOnce(exchangeFailure);
  dependencies.logout.mockRejectedValueOnce(cleanupFailure);

  await expect(coordinator.refresh()).rejects.toBe(exchangeFailure);
  await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledWith(cleanupFailure));
});

test('an obsolete exchange cannot publish its token under the active replacement session', async () => {
  const { dependencies } = setup();
  const publishCredential = vi.fn();
  const coordinator = new BuiltinModelAuthCoordinator({ ...dependencies, publishCredential });
  coordinator.initialize(credential);
  const replacement = { ...credential, accessToken: 'replacement' };
  dependencies.getActive.mockReturnValue(replacement);
  dependencies.getAuthSessionId.mockReturnValue('session-2');

  await expect(coordinator.refresh()).resolves.toBeNull();

  expect(publishCredential).not.toHaveBeenCalled();
  expect(dependencies.login).not.toHaveBeenCalled();
  expect(dependencies.logout).not.toHaveBeenCalled();
});

test('withdraws built-in access when a pending Gateway application fails after expiry', async () => {
  const { dependencies, coordinator } = setup();
  const confirmation = deferred<boolean>();
  dependencies.login.mockImplementationOnce(() => confirmation.promise);
  const refresh = coordinator.refresh(true);
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  dependencies.getActive.mockReturnValue(null);
  confirmation.reject(new Error('Gateway application was superseded'));

  await expect(refresh).resolves.toBeNull();
  expect(dependencies.logout).toHaveBeenCalledOnce();
});

test('late rotation acknowledgement cannot confirm a replacement login session', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);
  const pending = deferred<boolean>();
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  const rotation = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());

  dependencies.getAuthSessionId.mockReturnValue('session-2');
  pending.resolve(true);
  await rotation;
  await coordinator.refresh();

  expect(dependencies.rotate).toHaveBeenCalledOnce();
  expect(dependencies.login).toHaveBeenCalledOnce();
});

test('logout revokes a pending rotation before a same-account login is confirmed', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);
  const pending = deferred<boolean>();
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  const rotation = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());

  await coordinator.logout();
  dependencies.getAuthSessionId.mockReturnValue('session-2');
  await coordinator.refresh();
  pending.resolve(true);
  await rotation;
  await coordinator.refresh();

  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(dependencies.rotate).toHaveBeenCalledOnce();
  expect(dependencies.login).toHaveBeenCalledOnce();
});

test('provider removal after temporary expiry requires a full login even when the auth session resumes', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.getActive.mockReturnValue(null);
  dependencies.exchange.mockRejectedValueOnce(new Error('exchange unavailable'));

  await expect(coordinator.refresh()).rejects.toThrow('exchange unavailable');
  dependencies.getActive.mockReturnValue(credential);
  await coordinator.refresh();

  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('shares in-flight explicit cleanup when the login file watcher observes its deletion', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.exchange.mockResolvedValue(null);
  dependencies.getActive.mockReturnValue(null);
  const cleanup = deferred<undefined>();
  dependencies.logout.mockReturnValueOnce(cleanup.promise);

  const logout = coordinator.logout();
  await coordinator.refreshInBackground();
  expect(coordinator.logout()).toBe(logout);
  expect(dependencies.logout).toHaveBeenCalledOnce();

  cleanup.resolve(undefined);
  await logout;
  await coordinator.refreshInBackground();
  expect(dependencies.logout).toHaveBeenCalledOnce();
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
  const pending = deferred<boolean>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  const login = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  dependencies.exchange.mockResolvedValue(null);
  dependencies.getActive.mockReturnValue(null);
  await coordinator.refresh();
  expect(dependencies.logout).toHaveBeenCalledTimes(1);
  pending.resolve(true);
  await login;
});

test('previous token is reapplied when a different token synchronization is pending', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const pending = deferred<boolean>();
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  dependencies.exchange.mockImplementationOnce(async () => {
    const renewed = { ...credential, accessToken: 'new-fixture' };
    dependencies.getActive.mockReturnValue(renewed);
    return renewed;
  });
  const login = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());
  dependencies.getActive.mockReturnValue(credential);
  await coordinator.refresh();
  expect(dependencies.rotate).toHaveBeenCalledTimes(2);
  pending.resolve(true);
  await login;
});
