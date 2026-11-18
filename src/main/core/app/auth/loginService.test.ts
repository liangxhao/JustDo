import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { LOGIN_STORAGE_CONFIG } from '../../../../config/loginStorage';
import type { AuthState } from '../../../../shared/app/auth';
import { AuthErrorCode, AuthLoginPhase, AuthStatus, AuthSyncStatus } from '../../../../shared/app/auth';
import {
  getOutboundHeaderUserInfo,
  publishOutboundHeaderUserInfoCache,
} from '../../network/outboundHeaderPolicyConfig';
import type { AuthenticatedLogin, CredentialUpdate, LoginSdkAdapter, LoginSdkResult } from './loginSdkAdapter';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function setup(
  adapterOverrides: Partial<LoginSdkAdapter> = {},
  publishCommittedHeaders?: (values: Readonly<Record<string, unknown>>) => void,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-login-'));
  directories.push(directory);
  const file = path.join(
    directory,
    LOGIN_STORAGE_CONFIG.directoryName,
    LOGIN_STORAGE_CONFIG.userInfoFileName,
  );
  const store = new LoginUserInfoStore(file);
  const adapter: LoginSdkAdapter = {
    available: true,
    login: vi.fn(async (): Promise<LoginSdkResult> => ({ status: 'authenticated', session })),
    ...adapterOverrides,
  };
  const onLoginCommitted = vi.fn(async () => undefined);
  const onLogoutCommitted = vi.fn(async () => undefined);
  const onHeadersCommitted = vi.fn<() => void>();
  const changes: AuthState[] = [];
  const service = new LoginService({
    store,
    adapter,
    onLoginCommitted,
    onLogoutCommitted,
    ...(publishCommittedHeaders ? { publishCommittedHeaders } : { onHeadersCommitted }),
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
  expect(context.service.getState().loginPhase).toBeNull();
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
  expect(context.changes.map(state => state.loginPhase)).toContain(AuthLoginPhase.Completing);
  expect(JSON.stringify(context.changes)).not.toMatch(/synthetic|mtoken|X-Cookie|X-Tool-Token/);
});

test('a submitted dialog enters completion while the SDK still has to verify the account', async () => {
  let submitDialog!: () => void;
  let authenticate!: (result: LoginSdkResult) => void;
  const context = setup({
    login: ({ onDialogSubmitted }) => {
      submitDialog = onDialogSubmitted;
      return new Promise(resolve => {
        authenticate = resolve;
      });
    },
  });
  context.onLoginCommitted.mockImplementationOnce(async () => {
    expect(context.service.getState()).toMatchObject({
      status: AuthStatus.SignedIn,
      loginPhase: null,
    });
  });

  const login = context.service.login();
  expect(context.service.getState().loginPhase).toBe(AuthLoginPhase.Dialog);
  submitDialog();

  expect(context.service.getState()).toMatchObject({
    status: AuthStatus.SignedOut,
    loginPhase: AuthLoginPhase.Completing,
  });
  expect(context.store.read()).toBeNull();
  expect(context.onLoginCommitted).not.toHaveBeenCalled();

  authenticate({ status: 'authenticated', session });
  expect((await login).success).toBe(true);
});

test('failed model synchronization keeps the committed login and can be retried', async () => {
  const context = setup();
  context.onLoginCommitted.mockRejectedValueOnce(new Error('sensitive-server-detail'));
  expect(await context.service.login()).toEqual({
    success: true,
    state: expect.objectContaining({ status: AuthStatus.SignedIn, syncStatus: AuthSyncStatus.Failed, errorCode: null }),
  });
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
  expect(await context.service.logout()).toEqual({
    success: true,
    state: expect.objectContaining({ status: AuthStatus.SignedOut, syncStatus: AuthSyncStatus.Failed, errorCode: null }),
  });
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
  let submitOldDialog!: () => void;
  const context = setup({
    login: ({ onDialogSubmitted }) => {
      submitOldDialog = onDialogSubmitted;
      return new Promise(resolve => {
        complete = resolve;
      });
    },
  });
  const first = context.service.login();
  await context.service.logout();
  context.adapter.login = async () => ({
    status: 'authenticated',
    session: { account: 'bob', mtoken: 'bob-token' },
  });
  const second = context.service.login();
  submitOldDialog();
  expect(context.service.getState().loginPhase).toBe(AuthLoginPhase.Dialog);
  await second;
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
      })
    ).success,
  ).toBe(true);
  expect(context.store.read()?.values).toMatchObject({
    mtoken: session.mtoken,
    'X-User-Account': 'alice',
    'X-Cookie': 'renewed-cookie',
    'X-Tool-Token': 'synthetic-tool-token',
  });
  expect(context.onHeadersCommitted).toHaveBeenCalledTimes(1);
  expect(context.onHeadersCommitted).toHaveBeenCalledWith();
  expect(context.onLoginCommitted).not.toHaveBeenCalled();
});

test('drops obsolete Cookie expiry metadata when saving a credential update', async () => {
  const context = setup();
  const login = context.store.writeLogin(session);
  fs.writeFileSync(context.file, JSON.stringify({ ...login.values, cookieExpiresAt: 1_800_000_000_000 }));
  await context.service.restoreFromFile();

  await expect(context.service.updateCredentials(context.service.captureCredentialLease()!, {
    headerValues: { 'X-Cookie': 'replacement-cookie' },
  })).resolves.toMatchObject({ success: true });
  expect(context.store.read()?.values).not.toHaveProperty('cookieExpiresAt');
});

test('backs off on failed renewal, preserves committed headers, and publishes the replacement', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn()
    .mockRejectedValueOnce(new Error('private-renewal-error'))
    .mockResolvedValueOnce({ headerValues: { 'X-Cookie': ' ' } })
    .mockResolvedValueOnce({ headerValues: { 'X-Cookie': 'renewed-cookie' } });
  const context = setup({ refreshCredentials: refresh }, values => {
    publishOutboundHeaderUserInfoCache(values, ['X-Cookie', 'X-Tool-Token']);
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await context.service.login();
  await vi.advanceTimersByTimeAsync(LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(getOutboundHeaderUserInfo(context.file)['X-Cookie']).toBe('synthetic-cookie');

  await vi.advanceTimersByTimeAsync(4_999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(getOutboundHeaderUserInfo(context.file)).toEqual({
    'X-Cookie': 'synthetic-cookie',
    'X-Tool-Token': 'synthetic-tool-token',
  });
  expect(context.service.getState().status).toBe(AuthStatus.SignedIn);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(refresh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(context.store.read()?.values).toMatchObject({
    'X-Cookie': 'renewed-cookie', mtoken: session.mtoken,
  });
  expect(getOutboundHeaderUserInfo(context.file)['X-Cookie']).toBe('renewed-cookie');
  expect(context.onLoginCommitted).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-renewal-error');
  context.service.dispose();
});

test('renews on the configured interval and checks a missed renewal on wake', async () => {
  vi.useFakeTimers();
  const interval = LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs;
  const refresh = vi.fn()
    .mockResolvedValueOnce({ headerValues: { 'X-Cookie': 'first-renewal' } })
    .mockResolvedValueOnce({ headerValues: { 'X-Cookie': 'second-renewal' } });
  const context = setup({ refreshCredentials: refresh });

  await context.service.login();
  await vi.advanceTimersByTimeAsync(interval - 1);
  expect(refresh).not.toHaveBeenCalled();
  await context.service.updateCredentials(context.service.captureCredentialLease()!, {
    headerValues: { 'X-Tool-Token': 'updated-tool-token', 'X-Cookie': ' synthetic-cookie ' },
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(context.store.read()?.values['X-Cookie']).toBe('first-renewal');
  vi.setSystemTime(Date.now() + interval + 1);
  context.service.onSystemResume();
  await vi.advanceTimersByTimeAsync(0);
  expect(context.store.read()?.values['X-Cookie']).toBe('second-renewal');
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(context.onLoginCommitted).toHaveBeenCalledOnce();
  context.service.dispose();
});

test.each([false, true])('only resumes automatic renewal after verified SDK restore (%s)', async confirmed => {
  vi.useFakeTimers();
  const response = Promise.withResolvers<CredentialUpdate>();
  const refresh = vi.fn((_options: { signal: AbortSignal }) => response.promise);
  const context = setup({ restoreSession: async () => confirmed, refreshCredentials: refresh });
  context.store.writeLogin(session);

  await context.service.restoreFromFile();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  context.service.onSystemResume();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refresh).toHaveBeenCalledTimes(confirmed ? 1 : 0);
  expect(context.onLoginCommitted).not.toHaveBeenCalled();

  context.service.dispose();
  expect(refresh.mock.calls[0]?.[0].signal.aborted).toBe(confirmed ? true : undefined);
  response.resolve({ headerValues: { 'X-Cookie': 'too-late' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(context.store.read()?.values['X-Cookie']).toBe('synthetic-cookie');
});

test('aborts a pending Cookie renewal on logout and discards its late result after signing in again', async () => {
  vi.useFakeTimers();
  const interval = LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs;
  const response = Promise.withResolvers<CredentialUpdate>();
  const refresh = vi.fn((_options: { signal: AbortSignal }) => response.promise)
    .mockImplementationOnce(() => response.promise)
    .mockResolvedValueOnce({
      headerValues: { 'X-Cookie': 'bob-renewed-cookie' },
    });
  const context = setup({ refreshCredentials: refresh });

  await context.service.login();
  await vi.advanceTimersByTimeAsync(interval);
  expect(refresh).toHaveBeenCalledOnce();
  await context.service.logout();
  expect(refresh.mock.calls[0][0].signal.aborted).toBe(true);

  context.adapter.login = async () => ({ status: 'authenticated', session: {
    ...session, account: 'bob', mtoken: 'bob-fixture-token', headerValues: { 'X-Cookie': 'bob-cookie' },
  } });
  await context.service.login();
  await vi.advanceTimersByTimeAsync(interval);
  expect(context.store.read()?.values['X-Cookie']).toBe('bob-renewed-cookie');
  expect(refresh).toHaveBeenCalledTimes(2);
  response.resolve({ headerValues: { 'X-Cookie': 'late-cookie' } });
  await vi.advanceTimersByTimeAsync(0);

  expect(context.store.read()?.profile.account).toBe('bob');
  expect(context.store.read()?.values['X-Cookie']).toBe('bob-renewed-cookie');
  expect(context.onHeadersCommitted).toHaveBeenCalledOnce();
  context.service.dispose();
});

test('resumes Cookie renewal when logout cannot clear the signed-in credentials', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => ({ headerValues: { 'X-Cookie': 'renewed-cookie' } }));
  const context = setup({ refreshCredentials: refresh });
  await context.service.login();
  await vi.advanceTimersByTimeAsync(LOGIN_STORAGE_CONFIG.cookieRefreshIntervalMs - 1);
  vi.spyOn(context.store, 'clear').mockImplementationOnce(() => { throw new Error('fixture'); });

  expect((await context.service.logout()).errorCode).toBe(AuthErrorCode.StorageFailed);
  await vi.advanceTimersByTimeAsync(1);

  expect(refresh).toHaveBeenCalledOnce();
  expect(context.service.getState().status).toBe(AuthStatus.SignedIn);
  expect(context.store.read()?.values['X-Cookie']).toBe('renewed-cookie');
  expect(context.onLogoutCommitted).not.toHaveBeenCalled();
  context.service.dispose();
});

test.each([false, true])('Cookie renewal publishes committed values without reopening the login file (mtoken rotated: %s)', async rotateMtoken => {
  const publish = vi.fn((values: Readonly<Record<string, unknown>>) => {
    publishOutboundHeaderUserInfoCache(values, ['X-Cookie']);
  });
  const context = setup({}, publish);
  await context.service.login();
  context.onLoginCommitted.mockClear();
  publish.mockClear();
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  publish.mockImplementationOnce(values => {
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('Login file temporarily unavailable');
    });
    try {
      publishOutboundHeaderUserInfoCache(values, ['X-Cookie']);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  const result = await context.service.updateCredentials(
    context.service.captureCredentialLease()!,
    {
      headerValues: { 'X-Cookie': 'renewed-cookie' },
      ...(rotateMtoken ? { mtoken: 'rotated-mtoken' } : {}),
    },
  );

  expect(result.success).toBe(true);
  expect(context.store.read()?.values['X-Cookie']).toBe('renewed-cookie');
  expect(getOutboundHeaderUserInfo(context.file)).toEqual({ 'X-Cookie': 'renewed-cookie' });
  expect(publish).toHaveBeenCalledOnce();
  expect(context.onLoginCommitted).toHaveBeenCalledTimes(rotateMtoken ? 1 : 0);
  expect(info).toHaveBeenCalledWith(
    '[LoginService] Credential update {"result":"success","cookieProvided":true,"cookieChanged":true}',
  );
});

test('mtoken rotation refreshes model authentication and invalidates old renewal leases', async () => {
  const context = setup();
  await context.service.login();
  const oldLease = context.service.captureCredentialLease()!;
  await context.service.updateCredentials(oldLease, {
    mtoken: 'rotated-mtoken',
    headerValues: { 'X-Cookie': 'rotated-cookie' },
  });
  expect(context.onLoginCommitted).toHaveBeenCalledTimes(2);
  expect(context.onLoginCommitted).toHaveBeenLastCalledWith();
  expect(context.onHeadersCommitted).not.toHaveBeenCalled();
  expect(
    (
      await context.service.updateCredentials(oldLease, {
        headerValues: { 'X-Cookie': 'late-cookie' },
      })
    ).errorCode,
  ).toBe(AuthErrorCode.SessionChanged);
  expect(context.store.read()?.values['X-Cookie']).toBe('rotated-cookie');
});

test('a committed Cookie renewal invalidates older results and allows a fresh renewal lease', async () => {
  const context = setup();
  await context.service.login();
  const oldLease = context.service.captureCredentialLease()!;
  await context.service.updateCredentials(oldLease, {
    headerValues: { 'X-Cookie': 'newer-cookie' },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const lateResult = await context.service.updateCredentials(oldLease, {
    headerValues: { 'X-Cookie': 'older-cookie' },
  });
  expect(lateResult.errorCode).toBe(AuthErrorCode.SessionChanged);
  expect(warn).toHaveBeenCalledWith(
    '[LoginService] Credential update {"result":"session-changed","cookieProvided":true,"cookieChanged":false}',
  );
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

test('restoration publishes the latest committed Cookie for the verified account', async () => {
  const verification = Promise.withResolvers<boolean>();
  const publish = vi.fn();
  const context = setup({ restoreSession: () => verification.promise }, publish);
  context.store.writeLogin(session);
  const restoration = context.service.restoreFromFile();
  context.store.writeLogin({ ...session, headerValues: { 'X-Cookie': 'updated-during-restore' } });

  verification.resolve(true);
  await restoration;

  expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ 'X-Cookie': 'updated-during-restore' }));
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
