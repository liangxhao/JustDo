import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ProxyMode, ProxyProtocol } from '../../../shared/network/proxy';

const mocks = vi.hoisted(() => ({
  applySystemProxyEnv: vi.fn(),
  closeAllConnections: vi.fn(),
  resolveSystemProxyUrl: vi.fn(),
  restoreOriginalProxyEnv: vi.fn(),
  setFixedProxyUrl: vi.fn(),
  setProxy: vi.fn(),
  setSystemProxyEnabled: vi.fn(),
  browserCloseAllConnections: vi.fn(),
  browserSetProxy: vi.fn(),
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setProxy: mocks.setProxy,
      closeAllConnections: mocks.closeAllConnections,
    },
    fromPartition: vi.fn(() => ({
      setProxy: mocks.browserSetProxy,
      closeAllConnections: mocks.browserCloseAllConnections,
    })),
  },
}));

vi.mock('./systemProxy', () => ({
  applySystemProxyEnv: mocks.applySystemProxyEnv,
  resolveSystemProxyUrl: mocks.resolveSystemProxyUrl,
  restoreOriginalProxyEnv: mocks.restoreOriginalProxyEnv,
  setFixedProxyUrl: mocks.setFixedProxyUrl,
  setSystemProxyEnabled: mocks.setSystemProxyEnabled,
}));

import {
  applyBrowserProxyPreference,
  applySystemProxyPreference,
  getBrowserProxyCredentials,
  getBrowserProxyPreferenceSignature,
  getProxyPreferenceSignature,
  isSystemProxyEnabled,
  onBrowserProxyWillChange,
  registerBrowserProxySession,
  unregisterBrowserProxySession,
} from './systemProxyPreference';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setProxy.mockResolvedValue(undefined);
  mocks.closeAllConnections.mockResolvedValue(undefined);
  mocks.browserSetProxy.mockResolvedValue(undefined);
  mocks.browserCloseAllConnections.mockResolvedValue(undefined);
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
    expect(mocks.browserCloseAllConnections).not.toHaveBeenCalled();
  });

  test.each([
    [ProxyProtocol.HTTP, '80', 'http://proxy.example'],
    [ProxyProtocol.HTTPS, '443', 'https://proxy.example'],
  ])('accepts the default %s proxy port', async (protocol, port, expectedRule) => {
    await applySystemProxyPreference({
      proxy: { mode: ProxyMode.CUSTOM, custom: { protocol, host: 'proxy.example', port } },
    });

    expect(mocks.setProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'fixed_servers', proxyRules: expectedRule }),
    );
    expect(mocks.browserSetProxy).not.toHaveBeenCalled();
  });
});

describe('independent browser proxy preferences', () => {
  test('defaults non-browser requests to direct and browser requests to the system proxy', async () => {
    await applySystemProxyPreference();
    await applyBrowserProxyPreference();

    expect(mocks.setProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.DIRECT });
    expect(mocks.restoreOriginalProxyEnv).toHaveBeenCalledOnce();
    expect(mocks.browserSetProxy).toHaveBeenCalledTimes(2);
    expect(mocks.browserSetProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.SYSTEM });
    expect(mocks.resolveSystemProxyUrl).not.toHaveBeenCalled();
  });

  test('keeps browser requests on the system proxy while non-browser requests use a debugging proxy', async () => {
    const config = {
      proxy: {
        mode: ProxyMode.CUSTOM,
        custom: { protocol: ProxyProtocol.HTTP, host: '127.0.0.1', port: '9000' },
      },
    };
    await applySystemProxyPreference(config);
    await applyBrowserProxyPreference(config);

    expect(mocks.setProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9000' }),
    );
    expect(mocks.applySystemProxyEnv).toHaveBeenLastCalledWith('http://127.0.0.1:9000');
    expect(mocks.browserSetProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.SYSTEM });
  });

  test('allows browser direct mode without changing the model proxy or process environment', async () => {
    await applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.DIRECT } });

    expect(mocks.browserSetProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.DIRECT });
    expect(mocks.setProxy).not.toHaveBeenCalled();
    expect(mocks.closeAllConnections).not.toHaveBeenCalled();
    expect(mocks.setSystemProxyEnabled).not.toHaveBeenCalled();
    expect(mocks.setFixedProxyUrl).not.toHaveBeenCalled();
    expect(mocks.applySystemProxyEnv).not.toHaveBeenCalled();
    expect(mocks.restoreOriginalProxyEnv).not.toHaveBeenCalled();
    expect(getBrowserProxyCredentials()).toBeNull();
  });

  test('uses only browser credentials for a custom browser session', async () => {
    await applyBrowserProxyPreference({
      proxy: { mode: ProxyMode.SYSTEM },
      browserProxy: {
        mode: ProxyMode.CUSTOM,
        custom: {
          protocol: ProxyProtocol.HTTP,
          host: 'browser-proxy.example',
          port: '8080',
          username: 'browser-user',
          password: 'test-password',
        },
      },
    });

    expect(mocks.browserSetProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://browser-proxy.example:8080',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
    });
    expect(mocks.applySystemProxyEnv).not.toHaveBeenCalled();
    expect(mocks.setProxy).not.toHaveBeenCalled();
    expect(getBrowserProxyCredentials()).toEqual({
      host: 'browser-proxy.example',
      port: 8080,
      username: 'browser-user',
      password: 'test-password',
    });
  });

  test('does not mark non-browser preferences changed after a browser-only edit', () => {
    const original = { proxy: { mode: ProxyMode.DIRECT } };
    const changed = { ...original, browserProxy: { mode: ProxyMode.DIRECT } };

    expect(getProxyPreferenceSignature(changed)).toBe(getProxyPreferenceSignature(original));
    expect(getBrowserProxyPreferenceSignature(changed)).not.toBe(
      getBrowserProxyPreferenceSignature(original),
    );
  });

  test('registers new profiles with the latest browser preference during an in-flight change', async () => {
    let releaseBrowserApply: (() => void) | undefined;
    mocks.browserSetProxy.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseBrowserApply = resolve;
        }),
    );
    const first = applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.SYSTEM } });
    await vi.waitFor(() => expect(releaseBrowserApply).toBeTypeOf('function'));
    const latest = applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.DIRECT } });
    const targetSession = {
      storagePath: 'new-profile',
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
    } as unknown as Electron.Session;
    const register = registerBrowserProxySession(targetSession);
    releaseBrowserApply?.();

    await expect(first).resolves.toBe(false);
    await expect(latest).resolves.toBe(true);
    await register;
    expect(targetSession.setProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.DIRECT });
    expect(mocks.setProxy).not.toHaveBeenCalled();
  });

  test('retries a failed memory session registration without retaining its rejected attempt', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const widget = {
        storagePath: null,
        setProxy: vi
          .fn()
          .mockRejectedValueOnce(new Error('Proxy failed'))
          .mockResolvedValue(undefined),
        closeAllConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as Electron.Session;
      await expect(registerBrowserProxySession(widget)).rejects.toThrow('Proxy failed');
      await expect(registerBrowserProxySession(widget)).resolves.toBeUndefined();
      expect(widget.setProxy).toHaveBeenCalledTimes(2);
      expect(widget.closeAllConnections).toHaveBeenCalledOnce();
      expect(mocks.setProxy).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test('applies browser proxy changes to a distinct memory-only widget session', async () => {
    const widget = {
      storagePath: null,
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
    } as unknown as Electron.Session;
    await registerBrowserProxySession(widget);
    await registerBrowserProxySession(widget);
    expect(widget.setProxy).toHaveBeenCalledOnce();
    await applyBrowserProxyPreference({
      browserProxy: {
        mode: ProxyMode.CUSTOM,
        custom: { protocol: ProxyProtocol.HTTP, host: '127.0.0.1', port: '8181' },
      },
    });
    expect(widget.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:8181',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
    });
    expect(mocks.setProxy).not.toHaveBeenCalled();
    expect(mocks.applySystemProxyEnv).not.toHaveBeenCalled();
    await applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.DIRECT } });
    expect(widget.setProxy).toHaveBeenLastCalledWith({ mode: ProxyMode.DIRECT });
  });

  test('removes a retired widget session before proxy updates and unsubscribes its observer', async () => {
    const widget = {
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
    } as unknown as Electron.Session;
    await registerBrowserProxySession(widget);
    const changed = vi.fn(() => unregisterBrowserProxySession(widget));
    const unsubscribe = onBrowserProxyWillChange(changed);
    await applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.SYSTEM } });
    expect(changed).toHaveBeenCalledOnce();
    expect(widget.setProxy).toHaveBeenCalledOnce();
    unsubscribe();
    await applyBrowserProxyPreference({ browserProxy: { mode: ProxyMode.DIRECT } });
    expect(changed).toHaveBeenCalledOnce();
    expect(widget.setProxy).toHaveBeenCalledOnce();
  });
});
