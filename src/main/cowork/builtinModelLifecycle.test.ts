import { beforeEach, describe, expect, test, vi } from 'vitest';

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

const createHarness = () => {
  const store = {} as SqliteStore;
  const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true });
  const notifyModelsChanged = vi.fn();
  const lifecycle = new BuiltinModelLifecycle({
    getStore: () => store,
    syncOpenClawConfig,
    notifyModelsChanged,
  });
  return { lifecycle, store, syncOpenClawConfig, notifyModelsChanged };
};

describe('BuiltinModelLifecycle', () => {
  beforeEach(() => {
    syncBuiltinModelProviderMock.mockReset().mockResolvedValue();
  });

  test('refreshes enabled models, syncs OpenClaw, and notifies renderers after login', async () => {
    const harness = createHarness();

    await expect(harness.lifecycle.refreshAfterLogin()).resolves.toEqual({
      applied: true,
      superseded: false,
    });

    expect(syncBuiltinModelProviderMock).toHaveBeenCalledWith(harness.store, {
      access: BuiltinModelAccess.Enabled,
    });
    expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'auth-login' });
    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
  });

  test('removes built-in models, syncs OpenClaw, and notifies renderers after logout', async () => {
    const harness = createHarness();

    await harness.lifecycle.refreshAfterLogout();

    expect(syncBuiltinModelProviderMock).toHaveBeenCalledWith(harness.store, {
      access: BuiltinModelAccess.Disabled,
    });
    expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'auth-logout' });
    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
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

    await expect(login).resolves.toEqual({ applied: false, superseded: true });
    await expect(logout).resolves.toEqual({ applied: true, superseded: false });
    expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(harness.syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'auth-logout' });
    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
  });

  test('serializes OpenClaw config writes so logout is the final write', async () => {
    let releaseLoginSync: (() => void) | undefined;
    const harness = createHarness();
    harness.syncOpenClawConfig
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            releaseLoginSync = () => resolve({ success: true });
          }),
      )
      .mockResolvedValueOnce({ success: true });

    const login = harness.lifecycle.refreshAfterLogin();
    await vi.waitFor(() => expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1));
    const logout = harness.lifecycle.refreshAfterLogout();

    expect(harness.syncOpenClawConfig).toHaveBeenCalledTimes(1);
    releaseLoginSync?.();

    await expect(login).resolves.toEqual({ applied: false, superseded: true });
    await expect(logout).resolves.toEqual({ applied: true, superseded: false });
    expect(harness.syncOpenClawConfig.mock.calls).toEqual([
      [{ reason: 'auth-login' }],
      [{ reason: 'auth-logout' }],
    ]);
    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
  });

  test('notifies renderers before reporting an OpenClaw sync failure', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockResolvedValue({
      success: false,
      error: 'write failed',
    });

    await expect(harness.lifecycle.refreshAfterLogin()).rejects.toThrow('write failed');

    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
  });

  test('notifies renderers when OpenClaw config sync throws', async () => {
    const harness = createHarness();
    harness.syncOpenClawConfig.mockRejectedValue(new Error('unexpected failure'));

    await expect(harness.lifecycle.refreshAfterLogout()).rejects.toThrow('unexpected failure');

    expect(harness.notifyModelsChanged).toHaveBeenCalledOnce();
  });
});
