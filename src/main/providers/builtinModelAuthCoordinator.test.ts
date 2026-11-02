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
    exchange: vi.fn(async (): Promise<BuiltinModelCredential | null> => credential),
    getActive: vi.fn((): BuiltinModelCredential | null => credential),
    getAuthSessionId: vi.fn((): string | null => 'session-1'),
    login: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
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
    const confirmation = deferred<undefined>();
    const dependencies = {
      exchange: vi.fn(async () => { active = issue(); return active; }),
      getActive: () => active,
      getAuthSessionId: () => 'session-1',
      publishCredential: vi.fn(),
      login: vi.fn(async () => undefined),
      rotate: vi.fn(async () => undefined),
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
    expect(dependencies.publishCredential).toHaveBeenLastCalledWith(active, 'session-1');
    expect(dependencies.rotate).toHaveBeenCalledTimes(1);
    confirmation.resolve(undefined);
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
  const confirmation = deferred<undefined>();
  dependencies.exchange.mockResolvedValueOnce(first).mockResolvedValue(latest);
  dependencies.getActive.mockReturnValue(latest);
  dependencies.rotate.mockImplementationOnce(() => confirmation.promise);

  expect(await coordinator.refreshInBackground()).toEqual(first);
  expect(await coordinator.refreshInBackground()).toEqual(latest);
  expect(publishCredential.mock.calls).toEqual([[first, 'session-1'], [latest, 'session-1']]);
  dependencies.getAuthSessionId.mockReturnValue(null);
  dependencies.getActive.mockReturnValue(null);
  const logout = coordinator.logout();
  confirmation.resolve(undefined);
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
  dependencies.exchange.mockResolvedValue({ ...credential, accessToken: 'renewed' });

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
  const confirmation = deferred<undefined>();
  dependencies.login.mockImplementationOnce(() => confirmation.promise);
  const foreground = coordinator.refresh(true);
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
  const renewed = { ...credential, accessToken: 'first-renewal' };
  const latest = { ...credential, accessToken: 'latest-renewal' };

  dependencies.exchange.mockResolvedValueOnce(renewed).mockResolvedValue(latest);
  expect(await coordinator.refreshInBackground()).toEqual(renewed);
  expect(await coordinator.refreshInBackground()).toEqual(latest);
  expect(publishCredential).toHaveBeenLastCalledWith(latest, 'session-1');
  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();

  confirmation.resolve(undefined);
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
  const confirmation = deferred<undefined>();
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
  confirmation.resolve(undefined);
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
  const pending = deferred<undefined>();
  dependencies.login.mockImplementationOnce(() => pending.promise);
  const refresh = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
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
  dependencies.exchange.mockResolvedValue({ ...credential, accessToken: 'renewed-fixture' });
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

test.each([null, 'session-2'])('same token with auth session %s cannot reuse the previous confirmation', async authSessionId => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.getAuthSessionId.mockReturnValue(authSessionId);

  await coordinator.refresh();

  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();
});

test('late rotation acknowledgement cannot confirm a replacement login session', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  const renewed = { ...credential, accessToken: 'renewed-fixture' };
  dependencies.exchange.mockResolvedValue(renewed);
  dependencies.getActive.mockReturnValue(renewed);
  const pending = deferred<undefined>();
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  const rotation = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());

  dependencies.getAuthSessionId.mockReturnValue('session-2');
  pending.resolve(undefined);
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
  const pending = deferred<undefined>();
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  const rotation = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());

  await coordinator.logout();
  dependencies.getAuthSessionId.mockReturnValue('session-2');
  await coordinator.refresh();
  pending.resolve(undefined);
  await rotation;
  await coordinator.refresh();

  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(dependencies.rotate).toHaveBeenCalledOnce();
  expect(dependencies.login).toHaveBeenCalledOnce();
});

test('provider removal after temporary expiry requires a full login even when the auth session resumes', async () => {
  const { dependencies, coordinator } = setup();
  coordinator.initialize(credential);
  dependencies.getActive.mockReturnValueOnce(null);
  dependencies.exchange.mockRejectedValueOnce(new Error('exchange unavailable'));

  await expect(coordinator.refresh()).rejects.toThrow('exchange unavailable');
  await coordinator.refresh();

  expect(dependencies.logout).toHaveBeenCalledOnce();
  expect(dependencies.login).toHaveBeenCalledOnce();
  expect(dependencies.rotate).not.toHaveBeenCalled();
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
  await vi.waitFor(() => expect(dependencies.login).toHaveBeenCalledOnce());
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
  dependencies.rotate.mockImplementationOnce(() => pending.promise);
  dependencies.exchange.mockResolvedValueOnce({ ...credential, accessToken: 'new-fixture' });
  const login = coordinator.refresh();
  await vi.waitFor(() => expect(dependencies.rotate).toHaveBeenCalledOnce());
  await coordinator.refresh();
  expect(dependencies.rotate).toHaveBeenCalledTimes(2);
  pending.resolve(undefined);
  await login;
});
