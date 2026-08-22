import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';
import { type AppConfig, defaultConfig } from '@/app/config';

const storeMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock('@/services/store', () => ({
  localStore: {
    getItem: storeMocks.getItem,
    setItem: storeMocks.setItem,
  },
}));

import { ConfigService } from '@/services/config';

describe('appearance config persistence', () => {
  beforeEach(() => {
    storeMocks.getItem.mockReset();
    storeMocks.setItem.mockReset();
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  test('loads a legacy stored config without an appearance section', async () => {
    const legacyConfig = { ...defaultConfig } as Partial<AppConfig>;
    delete legacyConfig.appearance;
    storeMocks.getItem.mockResolvedValue(legacyConfig);
    const service = new ConfigService();

    await service.init();

    expect(service.getConfig().appearance).toEqual(defaultAppearanceConfig);
  });

  test('normalizes appearance values before persisting an update', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();

    await service.updateConfig({
      appearance: {
        ...defaultAppearanceConfig,
        chatContentWidth: 120,
        fontSize: 9,
      },
    });

    expect(service.getConfig().appearance).toMatchObject({
      chatContentWidth: 100,
      fontSize: 13,
    });
    expect(storeMocks.setItem).toHaveBeenCalledOnce();
  });
});
