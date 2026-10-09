import { defaultCustomProxyConfig, ProxyMode } from '@shared/network/proxy';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  patchAppConfig: vi.fn(),
}));

vi.mock('@/services/store', () => ({
  localStore: { getItem: mocks.getItem, setItem: mocks.setItem },
}));

import { ConfigService } from './config';

beforeEach(() => {
  vi.clearAllMocks();
  let persisted = structuredClone(defaultConfig);
  mocks.patchAppConfig.mockImplementation(async patch => {
    persisted = { ...persisted, ...patch };
    return persisted;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: { store: { patchAppConfig: mocks.patchAppConfig } },
  });
});

afterEach(() => vi.unstubAllGlobals());

test('loads independent proxy defaults when no settings are stored', async () => {
  mocks.getItem.mockResolvedValue(null);
  const service = new ConfigService();
  await service.init();

  expect(service.getConfig().proxy.mode).toBe(ProxyMode.DIRECT);
  expect(service.getConfig().browserProxy.mode).toBe(ProxyMode.SYSTEM);
});

test('defaults missing browser settings to system while retaining an existing model debugging proxy', async () => {
  const proxy = {
    mode: ProxyMode.CUSTOM,
    custom: { ...defaultCustomProxyConfig, host: '127.0.0.1', port: '9000' },
  };
  mocks.getItem.mockResolvedValue({ proxy });
  const service = new ConfigService();
  await service.init();

  expect(service.getConfig().proxy).toEqual(proxy);
  expect(service.getConfig().browserProxy.mode).toBe(ProxyMode.SYSTEM);
  await service.reloadFromStore();
  expect(service.getConfig().proxy).toEqual(proxy);
  expect(service.getConfig().browserProxy.mode).toBe(ProxyMode.SYSTEM);
});

test('persists a browser-only change without rewriting the non-browser proxy', async () => {
  mocks.getItem.mockResolvedValue(null);
  const service = new ConfigService();
  await service.init();
  const browserProxy = { mode: ProxyMode.DIRECT, custom: defaultCustomProxyConfig };

  await service.updateConfig({ browserProxy });

  expect(mocks.patchAppConfig).toHaveBeenCalledWith({ browserProxy });
  expect(service.getConfig().proxy).toEqual(defaultConfig.proxy);
  expect(service.getConfig().browserProxy).toEqual(browserProxy);
});

test('normalizes custom browser fields independently on reload and update', async () => {
  const browserProxy = {
    mode: ProxyMode.CUSTOM,
    custom: {
      ...defaultCustomProxyConfig,
      host: ' browser-proxy ',
      port: ' 8080 ',
      password: ' secret ',
    },
  };
  mocks.getItem.mockResolvedValue({ browserProxy });
  const service = new ConfigService();
  await service.init();
  await service.reloadFromStore();

  expect(service.getConfig().browserProxy.custom).toEqual({
    ...defaultCustomProxyConfig,
    host: 'browser-proxy',
    port: '8080',
    password: ' secret ',
  });
  await service.updateConfig({ browserProxy });
  expect(mocks.patchAppConfig).toHaveBeenCalledWith({
    browserProxy: service.getConfig().browserProxy,
  });
  expect(service.getConfig().proxy.mode).toBe(ProxyMode.DIRECT);
});
