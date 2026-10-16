import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';

const store = vi.hoisted(() => ({ getItem: vi.fn(), patchAppConfig: vi.fn() }));
vi.mock('@/services/store', () => ({ localStore: { getItem: store.getItem } }));
import { ConfigService } from './config';

afterEach(() => vi.unstubAllGlobals());

test('loads the default for existing users, persists a bounded limit, and restores it on restart', async () => {
  let saved = { ...defaultConfig, browserTabLimit: undefined as number | undefined };
  store.getItem.mockImplementation(async () => saved);
  store.patchAppConfig.mockImplementation(async patch => {
    saved = { ...saved, ...patch };
    return saved;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: { store: { patchAppConfig: store.patchAppConfig } },
  });
  const service = new ConfigService();
  await service.init();
  expect(service.getConfig().browserTabLimit).toBe(20);

  await service.updateConfig({ browserTabLimit: 500 });
  expect(saved.browserTabLimit).toBe(50);
  await service.updateConfig({ browserTabLimit: 35 });
  const restarted = new ConfigService();
  await restarted.init();
  expect(restarted.getConfig().browserTabLimit).toBe(35);

  saved.browserTabLimit = NaN;
  await restarted.reloadFromStore();
  expect(restarted.getConfig().browserTabLimit).toBe(20);
});
