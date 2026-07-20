import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ProxyMode, ProxyProtocol } from '../../shared/proxy';

const mocks = vi.hoisted(() => ({
  applySystemProxyEnv: vi.fn(),
  closeAllConnections: vi.fn(),
  resolveSystemProxyUrl: vi.fn(),
  restoreOriginalProxyEnv: vi.fn(),
  setFixedProxyUrl: vi.fn(),
  setProxy: vi.fn(),
  setSystemProxyEnabled: vi.fn(),
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setProxy: mocks.setProxy,
      closeAllConnections: mocks.closeAllConnections,
    },
  },
}));

vi.mock('./systemProxy', () => ({
  applySystemProxyEnv: mocks.applySystemProxyEnv,
  resolveSystemProxyUrl: mocks.resolveSystemProxyUrl,
  restoreOriginalProxyEnv: mocks.restoreOriginalProxyEnv,
  setFixedProxyUrl: mocks.setFixedProxyUrl,
  setSystemProxyEnabled: mocks.setSystemProxyEnabled,
}));

import { applySystemProxyPreference, isSystemProxyEnabled } from './systemProxyPreference';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setProxy.mockResolvedValue(undefined);
  mocks.closeAllConnections.mockResolvedValue(undefined);
  mocks.resolveSystemProxyUrl.mockResolvedValue('http://system-proxy:8080');
});

describe('isSystemProxyEnabled', () => {
  test('returns true only when system proxy is explicitly enabled', () => {
    expect(isSystemProxyEnabled({ useSystemProxy: true })).toBe(true);
    expect(isSystemProxyEnabled({ useSystemProxy: false })).toBe(false);
    expect(isSystemProxyEnabled({ proxy: { mode: ProxyMode.SYSTEM } })).toBe(true);
    expect(isSystemProxyEnabled({ proxy: { mode: ProxyMode.CUSTOM } })).toBe(false);
    expect(isSystemProxyEnabled({})).toBe(false);
    expect(isSystemProxyEnabled()).toBe(false);
  });
});

describe('applySystemProxyPreference', () => {
  test('leaves the latest custom preference active during a rapid mode switch', async () => {
    let releaseSystemProxyResolution: (() => void) | undefined;
    mocks.resolveSystemProxyUrl.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          releaseSystemProxyResolution = () => resolve('http://system-proxy:8080');
        }),
    );

    const systemApply = applySystemProxyPreference({ proxy: { mode: ProxyMode.SYSTEM } });
    await vi.waitFor(() => expect(releaseSystemProxyResolution).toBeTypeOf('function'));

    const customApply = applySystemProxyPreference({
      proxy: {
        mode: ProxyMode.CUSTOM,
        custom: { protocol: ProxyProtocol.HTTP, host: '127.0.0.1', port: '9000' },
      },
    });
    releaseSystemProxyResolution?.();

    await expect(systemApply).resolves.toBe(false);
    await expect(customApply).resolves.toBe(true);
    expect(mocks.applySystemProxyEnv).toHaveBeenLastCalledWith('http://127.0.0.1:9000');
    expect(mocks.setProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'fixed_servers' }),
    );
    expect(mocks.closeAllConnections).toHaveBeenCalledTimes(2);
  });
});
