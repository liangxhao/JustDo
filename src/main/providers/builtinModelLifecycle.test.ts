import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import { BuiltinModelLifecycle } from './builtinModelLifecycle';
import { BuiltinModelAccess, syncBuiltinModelProvider } from './builtinModelProvider';

vi.mock('./builtinModelProvider', async importOriginal => {
  const actual = await importOriginal<typeof import('./builtinModelProvider')>();
  return {
    ...actual,
    syncBuiltinModelProvider: vi.fn(),
  };
});

const syncBuiltinModelProviderMock = vi.mocked(syncBuiltinModelProvider);
afterEach(() => vi.restoreAllMocks());

const createHarness = () => {
  const store = {} as SqliteStore;
  const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true, hostPolicyVerified: true });
  const notifyCatalogChanged = vi.fn();
  const notifyRuntimeModelsChanged = vi.fn();
  const lifecycle = new BuiltinModelLifecycle({
    getStore: () => store,
    syncOpenClawConfig,
    notifyCatalogChanged,
    notifyRuntimeModelsChanged,
  });
  return { lifecycle, store, syncOpenClawConfig, notifyCatalogChanged, notifyRuntimeModelsChanged };
};

describe('BuiltinModelLifecycle', () => {
  beforeEach(() => {
    syncBuiltinModelProviderMock.mockReset().mockResolvedValue();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  test.each([
    ['refreshAfterLogin', BuiltinModelAccess.Enabled, 'auth-login'],
    ['refreshAfterLogout', BuiltinModelAccess.Disabled, 'auth-logout'],
  ] as const)('publishes the local catalog before Gateway finishes %s', async (method, access, reason) => {
    const harness = createHarness();
    const persistCatalog = Promise.withResolvers<void>();
    const applyConfig = Promise.withResolvers<{ success: true; hostPolicyVerified: true }>();
    syncBuiltinModelProviderMock.mockReturnValueOnce(persistCatalog.promise);
    harness.syncOpenClawConfig.mockReturnValueOnce(applyConfig.promise);

    const refresh = harness.lifecycle[method]();
    expect(syncBuiltinModelProviderMock).toHaveBeenCalledWith(harness.store, { access });
    expect(harness.notifyCatalogChanged).not.toHaveBeenCalled();
    persistCatalog.resolve();
    await vi.waitFor(() => expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason }));
    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).not.toHaveBeenCalled();

    applyConfig.resolve({ success: true, hostPolicyVerified: true });
    await refresh;
    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledOnce();
  });

  test('publishes rotated credentials without requesting the model catalog', async () => {
    syncBuiltinModelProviderMock.mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();

    await harness.lifecycle.refreshAfterCredentialRotation();

    expect(syncBuiltinModelProviderMock).not.toHaveBeenCalled();
    expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'auth-login' });
    expect(harness.notifyCatalogChanged).not.toHaveBeenCalled();
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledOnce();
  });

  test('publishes credentials during discovery and then projects the refreshed catalog', async () => {
    let catalog = 'old';
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    syncBuiltinModelProviderMock.mockImplementationOnce(async () => {
      await discovery;
      catalog = 'new';
    });
    const harness = createHarness();
    const projectedCatalogs: string[] = [];
    harness.syncOpenClawConfig.mockImplementation(async () => {
      projectedCatalogs.push(catalog);
      return { success: true, hostPolicyVerified: true };
    });

    const catalogRefresh = harness.lifecycle.refreshAfterLogin();
    await harness.lifecycle.refreshAfterCredentialRotation();

    expect(projectedCatalogs).toEqual(['old']);
    releaseDiscovery();
    await catalogRefresh;

    expect(projectedCatalogs).toEqual(['old', 'new']);
    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])('rejects an unconfirmed rotation even if configSynced is %s', async configSynced => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      configSynced,
      error: 'credential reload pending',
    });

    await expect(harness.lifecycle.refreshAfterCredentialRotation()).rejects.toThrow('credential reload pending');

    expect(harness.notifyRuntimeModelsChanged).not.toHaveBeenCalled();
  });

  test('serializes logout after an in-flight rotation and discards its obsolete notification', async () => {
    const harness = createHarness();
    let releaseRotation!: () => void;
    harness.syncOpenClawConfig.mockImplementationOnce(() => new Promise(resolve => {
      releaseRotation = () => resolve({ success: true, hostPolicyVerified: true });
    }));
    const rotation = harness.lifecycle.refreshAfterCredentialRotation();
    await vi.waitFor(() => expect(harness.syncOpenClawConfig).toHaveBeenCalledOnce());
    const logout = harness.lifecycle.refreshAfterLogout();
    releaseRotation();

    await Promise.all([rotation, logout]);

    expect(harness.syncOpenClawConfig.mock.calls).toEqual([
      [{ reason: 'auth-login' }],
      [{ reason: 'auth-logout' }],
    ]);
    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledOnce();
  });

  test('does not sync or notify from an enabled refresh superseded by logout', async () => {
    let releaseLogin: (() => void) | undefined;
    syncBuiltinModelProviderMock
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseLogin = resolve;
          }),
      )
      .mockResolvedValueOnce();
    const harness = createHarness();

    const login = harness.lifecycle.refreshAfterLogin();
    const logout = harness.lifecycle.refreshAfterLogout();
    releaseLogin?.();

    await expect(login).resolves.toBeUndefined();
    await expect(logout).resolves.toBeUndefined();
    expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'auth-logout' });
    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledOnce();
  });

  test('serializes OpenClaw config writes so logout is the final write', async () => {
    let releaseLoginSync: (() => void) | undefined;
    const harness = createHarness();
    harness.syncOpenClawConfig
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseLoginSync = () => resolve({ success: true, hostPolicyVerified: true });
          }),
      )
      .mockResolvedValueOnce({ success: true, hostPolicyVerified: true });

    const login = harness.lifecycle.refreshAfterLogin();
    await vi.waitFor(() => expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1));
    const logout = harness.lifecycle.refreshAfterLogout();

    expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1);
    releaseLoginSync?.();

    await expect(login).resolves.toBeUndefined();
    await expect(logout).resolves.toBeUndefined();
    expect(harness.syncOpenClawConfig.mock.calls).toEqual([
      [{ reason: 'auth-login' }],
      [{ reason: 'auth-logout' }],
    ]);
    expect(harness.notifyCatalogChanged).toHaveBeenCalledTimes(2);
    expect(harness.notifyRuntimeModelsChanged).toHaveBeenCalledOnce();
  });

  test.each([
    { success: true, configSynced: true },
    { success: true, configSynced: true, hostPolicyVerified: true, gatewayRestartDeferred: true },
  ])('publishes only the catalog when Gateway application remains pending (%j)', async result => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue(result);

    await harness.lifecycle.refreshAfterLogin();

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).not.toHaveBeenCalled();
  });

  test('notifies renderers before reporting an OpenClaw sync failure', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      error: 'write failed',
    });

    await expect(harness.lifecycle.refreshAfterLogin()).rejects.toThrow('write failed');

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).not.toHaveBeenCalled();
  });

  test('completes logout when config was synced but Gateway health check failed', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      configSynced: true,
      error: 'OpenClaw gateway failed to become healthy in time.',
    });

    await expect(harness.lifecycle.refreshAfterLogout()).resolves.toBeUndefined();

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
  });

  test('completes login when config was synced but the required Gateway restart failed', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      configSynced: true,
      error: 'OpenClaw gateway failed to become healthy in time.',
    });

    await expect(harness.lifecycle.refreshAfterLogin()).resolves.toBeUndefined();

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
  });

  test('still rejects logout when OpenClaw config itself was not synced', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      configSynced: false,
      error: 'write failed',
    });

    await expect(harness.lifecycle.refreshAfterLogout()).rejects.toThrow('write failed');

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
  });

  test('notifies renderers when OpenClaw config sync throws', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockRejectedValue(new Error('unexpected failure'));

    await expect(harness.lifecycle.refreshAfterLogout()).rejects.toThrow('unexpected failure');

    expect(harness.notifyCatalogChanged).toHaveBeenCalledOnce();
    expect(harness.notifyRuntimeModelsChanged).not.toHaveBeenCalled();
  });

  test('records configuration rejection without raw multiline error or credentials', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false, configSynced: true,
      error: 'private-auth-fixture\nAuthorization: Bearer private-token-fixture',
    });

    await harness.lifecycle.refreshAfterLogin();

    const lines = vi.mocked(console.warn).mock.calls.map(args => {
      expect(args).toHaveLength(1);
      expect(args[0]).not.toMatch(/[\r\n]|private-.*-fixture|Authorization/);
      return JSON.parse(String(args[0]).slice('[BuiltinModelAuth] '.length));
    });
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'config-sync.failed', configSynced: true,
      reason: 'config-application-failed',
    }));
  });
});
