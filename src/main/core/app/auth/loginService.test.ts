import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { AuthState } from '../../../../shared/app/auth';
import { AuthErrorCode, AuthStatus, AuthSyncStatus } from '../../../../shared/app/auth';
import type { AuthenticatedLogin, LoginSdkAdapter, LoginSdkResult } from './loginSdkAdapter';
import { LoginService } from './loginService';
import { LoginUserInfoStore } from './loginUserInfoStore';

const directories: string[] = [];
const session: AuthenticatedLogin = {
  account: 'alice',
  mtoken: 'synthetic-long-mtoken',
  displayName: 'Alice',
  headerValues: { 'X-Cookie': 'synthetic-cookie', 'X-Tool-Token': 'synthetic-tool-token' },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function setup(adapterOverrides: Partial<LoginSdkAdapter> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-login-'));
  directories.push(directory);
  const file = path.join(directory, 'huawei', 'user_info.json');
  const store = new LoginUserInfoStore(file);
  const adapter: LoginSdkAdapter = {
    available: true,
    login: vi.fn(async (): Promise<LoginSdkResult> => ({ status: 'authenticated', session })),
    ...adapterOverrides,
  };
  const onLoginCommitted = vi.fn(async () => undefined);
  const onLogoutCommitted = vi.fn(async () => undefined);
  const onHeadersCommitted = vi.fn();
  const changes: AuthState[] = [];
  const service = new LoginService({
    store,
    adapter,
    onLoginCommitted,
    onLogoutCommitted,
    onHeadersCommitted,
    onStateChanged: state => changes.push(state),
  });
  return {
    file,
    store,
    adapter,
    service,
    onLoginCommitted,
    onLogoutCommitted,
    onHeadersCommitted,
    changes,
  };
}

test('an unavailable SDK cannot simulate a login or enable models', async () => {
  const context = setup({ available: false });
  expect((await context.service.login()).errorCode).toBe(AuthErrorCode.SdkUnavailable);
  expect(context.adapter.login).not.toHaveBeenCalled();
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
  expect(fs.existsSync(context.file)).toBe(false);
});

test('manual file import restores display state without repeating model startup or requiring the SDK', async () => {
  const context = setup({ available: false });
  context.store.writeLogin(session);
  await context.service.restoreFromFile();
  expect(context.service.getState().status).toBe(AuthStatus.LocalCredentials);
  expect(context.service.getState().profile?.displayName).toBe('Alice');
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
  expect(context.onHeadersCommitted).not.toHaveBeenCalled();
  expect(JSON.stringify(context.service.getState())).not.toMatch(
    /synthetic|mtoken|X-Cookie|X-Tool-Token/,
  );
});

test('a canceled popup leaves imported credentials intact and does not refresh services', async () => {
  const context = setup({ login: vi.fn(async () => ({ status: 'canceled' })) });
  context.store.writeLogin(session);
  await context.service.restoreFromFile();
  expect((await context.service.login()).canceled).toBe(true);
  expect(context.store.read()?.values.mtoken).toBe(session.mtoken);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
  expect(context.onLogoutCommitted).not.toHaveBeenCalled();
});

test('login commits mtoken and headers before the single combined model and header refresh', async () => {
  const context = setup();
  context.onLoginCommitted.mockImplementation(async () => {
    expect(context.store.read()?.values.mtoken).toBe(session.mtoken);
    expect(context.store.read()?.values['X-Cookie']).toBe('synthetic-cookie');
    expect(context.service.getState().status).toBe(AuthStatus.SignedIn);
  });
  expect((await context.service.login()).success).toBe(true);
  expect(context.onLoginCommitted).toHaveBeenCalledTimes(1);
  expect(context.onHeadersCommitted).not.toHaveBeenCalled();
  expect(context.service.getState().syncStatus).toBe(AuthSyncStatus.Completed);
  expect(JSON.stringify(context.changes)).not.toMatch(/synthetic|mtoken|X-Cookie|X-Tool-Token/);
});

test('failed model synchronization keeps the committed login and can be retried', async () => {
  const context = setup();
  context.onLoginCommitted.mockRejectedValueOnce(new Error('sensitive-server-detail'));
  expect((await context.service.login()).errorCode).toBe(AuthErrorCode.SyncFailed);
  expect(context.service.getState().status).toBe(AuthStatus.SignedIn);
  expect(context.service.getState().syncStatus).toBe(AuthSyncStatus.Failed);
  expect(context.store.read()?.values.mtoken).toBe(session.mtoken);
  expect((await context.service.retrySync()).success).toBe(true);
  expect(context.service.getState().syncStatus).toBe(AuthSyncStatus.Completed);
  expect(JSON.stringify(context.changes)).not.toContain('sensitive-server-detail');
});

test('logout deletes all login fields before cleanup and stays signed out if runtime cleanup fails', async () => {
  const context = setup();
  await context.service.login();
  context.onLogoutCommitted.mockImplementationOnce(async () => {
    expect(fs.existsSync(context.file)).toBe(false);
    throw new Error('runtime failure');
  });
  expect((await context.service.logout()).errorCode).toBe(AuthErrorCode.SyncFailed);
  expect(context.service.getState().status).toBe(AuthStatus.SignedOut);
  expect(context.service.getState().profile).toBeNull();
  expect((await context.service.retrySync()).success).toBe(true);
  expect(context.onLogoutCommitted).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(context.file)).toBe(false);
});

test('replacing an account finishes logout before persisting the new identity', async () => {
  const context = setup();
  await context.service.login();
  const order: string[] = [];
  context.adapter.login = async () => ({
    status: 'authenticated',
    session: { account: 'bob', mtoken: 'bob-token' },
  });
  context.onLogoutCommitted.mockImplementationOnce(async () => {
    expect(context.store.read()).toBeNull();
    order.push('logout');
  });
  context.onLoginCommitted.mockImplementationOnce(async () => {
    expect(context.store.read()?.profile.account).toBe('bob');
    expect(context.store.read()?.values['X-Tool-Token']).toBeUndefined();
    order.push('login');
  });
  expect((await context.service.login()).success).toBe(true);
  expect(order).toEqual(['logout', 'login']);
});

test('duplicate login clicks share a popup and a late old result cannot restore a signed-out account', async () => {
  let complete!: (value: LoginSdkResult) => void;
  const context = setup({
    login: vi.fn(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    ),
  });
  const first = context.service.login();
  expect(context.service.login()).toBe(first);
  await context.service.logout();
  complete({ status: 'authenticated', session });
  expect((await first).errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(context.service.getState().status).toBe(AuthStatus.SignedOut);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
  expect(context.store.read()).toBeNull();
});

test('a newer login can complete even if an aborted older SDK popup ignores its signal', async () => {
  let complete!: (value: LoginSdkResult) => void;
  const context = setup({
    login: () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  });
  const first = context.service.login();
  await context.service.logout();
  context.adapter.login = async () => ({
    status: 'authenticated',
    session: { account: 'bob', mtoken: 'bob-token' },
  });
  await context.service.login();
  complete({ status: 'authenticated', session });
  await first;
  expect(context.store.read()?.profile.account).toBe('bob');
  expect(context.service.getState().profile?.account).toBe('bob');
});

test('Cookie renewal preserves long-lived mtoken and other tool fields and refreshes only header values', async () => {
  const context = setup();
  await context.service.login();
  context.onLoginCommitted.mockClear();
  const lease = context.service.captureCredentialLease()!;
  expect(
    (
      await context.service.updateCredentials(lease, {
        headerValues: { 'X-Cookie': 'renewed-cookie' },
        cookieExpiresAt: 1_800_000_000_000,
      })
    ).success,
  ).toBe(true);
  expect(context.store.read()?.values).toMatchObject({
    mtoken: session.mtoken,
    'X-User-Account': 'alice',
    'X-Cookie': 'renewed-cookie',
    'X-Tool-Token': 'synthetic-tool-token',
    cookieExpiresAt: 1_800_000_000_000,
  });
  expect(context.onHeadersCommitted).toHaveBeenCalledTimes(1);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
});

test('mtoken rotation refreshes model authentication and invalidates old renewal leases', async () => {
  const context = setup();
  await context.service.login();
  const oldLease = context.service.captureCredentialLease()!;
  await context.service.updateCredentials(oldLease, { mtoken: 'rotated-mtoken' });
  expect(context.onLoginCommitted).toHaveBeenCalledTimes(2);
  expect(context.onHeadersCommitted).not.toHaveBeenCalled();
  expect(
    (
      await context.service.updateCredentials(oldLease, {
        headerValues: { 'X-Cookie': 'late-cookie' },
      })
    ).errorCode,
  ).toBe(AuthErrorCode.SessionChanged);
  expect(context.store.read()?.values['X-Cookie']).toBe('synthetic-cookie');
});

test('a committed Cookie renewal invalidates older results and allows a fresh renewal lease', async () => {
  const context = setup();
  await context.service.login();
  const oldLease = context.service.captureCredentialLease()!;
  await context.service.updateCredentials(oldLease, {
    headerValues: { 'X-Cookie': 'newer-cookie' },
  });
  const lateResult = await context.service.updateCredentials(oldLease, {
    headerValues: { 'X-Cookie': 'older-cookie' },
  });
  expect(lateResult.errorCode).toBe(AuthErrorCode.SessionChanged);
  expect((await context.service.expireSession(oldLease)).errorCode).toBe(
    AuthErrorCode.SessionChanged,
  );
  expect(context.store.read()?.values['X-Cookie']).toBe('newer-cookie');
  expect(context.onHeadersCommitted).toHaveBeenCalledTimes(1);
  const freshResult = await context.service.updateCredentials(
    context.service.captureCredentialLease()!,
    { headerValues: { 'X-Cookie': 'fresh-cookie' } },
  );
  expect(freshResult.success).toBe(true);
  expect(context.store.read()?.values['X-Cookie']).toBe('fresh-cookie');
});

test('an external Cookie replacement invalidates leases even with the same account and mtoken', async () => {
  const context = setup();
  await context.service.login();
  const lease = context.service.captureCredentialLease()!;
  context.store.writeLogin({ ...session, headerValues: { 'X-Cookie': 'external-cookie' } });
  expect(
    (
      await context.service.updateCredentials(lease, {
        headerValues: { 'X-Cookie': 'late-cookie' },
      })
    ).errorCode,
  ).toBe(AuthErrorCode.SessionChanged);
  expect((await context.service.expireSession(lease)).errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(context.store.read()?.values['X-Cookie']).toBe('external-cookie');
  expect(context.onHeadersCommitted).not.toHaveBeenCalled();
  expect(context.onLogoutCommitted).not.toHaveBeenCalled();
});

test('queued expiry rechecks the file before deleting credentials replaced after the request', async () => {
  const context = setup();
  await context.service.login();
  const expiry = context.service.expireSession(context.service.captureCredentialLease()!);
  context.store.writeLogin({ account: 'bob', mtoken: 'bob-token' });
  expect((await expiry).errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(context.store.read()?.profile.account).toBe('bob');
  expect(context.onLogoutCommitted).not.toHaveBeenCalled();
});

test('a current verified expiry clears credentials and applies logout exactly once', async () => {
  const context = setup();
  await context.service.login();
  const lease = context.service.captureCredentialLease()!;
  expect((await context.service.expireSession(lease)).success).toBe(true);
  expect(context.store.read()).toBeNull();
  expect(context.service.getState().status).toBe(AuthStatus.SignedOut);
  expect(context.onLogoutCommitted).toHaveBeenCalledTimes(1);
  expect((await context.service.expireSession(lease)).errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(context.onLogoutCommitted).toHaveBeenCalledTimes(1);
});

test('late renewal and expiry cannot overwrite or remove manually replaced credentials', async () => {
  const context = setup();
  await context.service.login();
  const lease = context.service.captureCredentialLease()!;
  context.store.writeLogin({ account: 'bob', mtoken: 'bob-token' });
  expect((await context.service.updateCredentials(lease, { mtoken: 'late-token' })).errorCode).toBe(
    AuthErrorCode.SessionChanged,
  );
  expect((await context.service.expireSession(lease)).errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(context.store.read()?.profile.account).toBe('bob');
});

test('an atomic write failure does not publish login or call the refresh hook', async () => {
  const context = setup();
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('write failed');
  });
  expect((await context.service.login()).errorCode).toBe(AuthErrorCode.StorageFailed);
  expect(context.store.read()).toBeNull();
  expect(context.service.getState().status).toBe(AuthStatus.SignedOut);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.dirname(context.file))).toEqual([]);
});

test('invalid SDK credentials cannot clear an existing identity or write a derived JWT', async () => {
  const context = setup();
  context.store.writeLogin(session);
  await context.service.restoreFromFile();
  for (const name of ['X-ACCESS-JWT', 'userName', 'avatarUrl', 'loginTime', 'cookieExpiresAt']) {
    context.adapter.login = async () => ({
      status: 'authenticated',
      session: { ...session, headerValues: { [name]: 'forbidden-header-value' } },
    });
    expect((await context.service.login()).errorCode).toBe(AuthErrorCode.StorageFailed);
    expect(context.store.read()?.values.mtoken).toBe(session.mtoken);
    expect(context.service.getState().profile?.displayName).toBe('Alice');
  }
  expect(context.onLogoutCommitted).not.toHaveBeenCalled();
});

test('restoring a verified SDK session does not create a second model refresh', async () => {
  const context = setup({ restoreSession: async () => true });
  context.store.writeLogin(session);
  await context.service.restoreFromFile();
  expect(context.service.getState().status).toBe(AuthStatus.SignedIn);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
});

test('disposal prevents late SDK success from writing credentials', async () => {
  let complete!: (value: LoginSdkResult) => void;
  const context = setup({
    login: () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  });
  const pending = context.service.login();
  context.service.dispose();
  complete({ status: 'authenticated', session });
  expect((await pending).success).toBe(false);
  expect(context.store.read()).toBeNull();
});

test('disposal aborts SDK restoration and releases SDK listeners only once', async () => {
  let signal!: AbortSignal;
  let complete!: (confirmed: boolean) => void;
  const dispose = vi.fn();
  const context = setup({
    dispose,
    restoreSession: options => {
      signal = options.signal;
      return new Promise(resolve => {
        complete = resolve;
      });
    },
  });
  context.store.writeLogin(session);
  const restoration = context.service.restoreFromFile();
  context.service.dispose();
  context.service.dispose();
  expect(signal.aborted).toBe(true);
  expect(dispose).toHaveBeenCalledTimes(1);
  complete(true);
  await restoration;
  expect(context.service.getState().status).toBe(AuthStatus.LocalCredentials);
});

test('a Cookie cache refresh failure preserves the file update and offers synchronization retry', async () => {
  const context = setup();
  await context.service.login();
  context.onHeadersCommitted.mockImplementationOnce(() => {
    throw new Error('cache error');
  });
  const result = await context.service.updateCredentials(
    context.service.captureCredentialLease()!,
    {
      headerValues: { 'X-Cookie': 'renewed-cookie' },
    },
  );
  expect(result.errorCode).toBe(AuthErrorCode.SyncFailed);
  expect(context.store.read()?.values['X-Cookie']).toBe('renewed-cookie');
  expect(context.service.getState().syncStatus).toBe(AuthSyncStatus.Failed);
  expect((await context.service.retrySync()).success).toBe(true);
});
