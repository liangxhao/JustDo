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

  test('keeps the in-memory config unchanged when main rejects the update', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();
    const previousTheme = service.getConfig().theme;
    storeMocks.setItem.mockRejectedValue(new Error('OpenClaw config rejected'));

    await expect(
      service.updateConfig({ theme: previousTheme === 'dark' ? 'light' : 'dark' }),
    ).rejects.toThrow('OpenClaw config rejected');

    expect(service.getConfig().theme).toBe(previousTheme);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  test('serializes partial updates and merges each one onto the latest committed config', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();
    let resolveFirst: (() => void) | undefined;
    storeMocks.setItem
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);

    const first = service.updateConfig({ theme: 'dark' });
    const second = service.updateConfig({ language: 'en' });
    await Promise.resolve();
    expect(storeMocks.setItem).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await first;
    await second;
    expect(storeMocks.setItem.mock.calls[1]?.[1]).toMatchObject({
      theme: 'dark',
      language: 'en',
    });
    expect(service.getConfig()).toMatchObject({ theme: 'dark', language: 'en' });
  });
});
