import { defaultLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';
import { type AppConfig, defaultConfig } from '@/app/config';

const storeMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  patchAppConfig: vi.fn(),
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
    storeMocks.patchAppConfig.mockReset();
    let persisted = structuredClone(defaultConfig);
    storeMocks.patchAppConfig.mockImplementation(async patch => {
      persisted = { ...persisted, ...patch };
      return persisted;
    });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      electron: { store: { patchAppConfig: storeMocks.patchAppConfig } },
    });
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

  test('loads a legacy stored config without voice settings', async () => {
    const legacyConfig = { ...defaultConfig } as Partial<AppConfig>;
    delete legacyConfig.voice;
    storeMocks.getItem.mockResolvedValue(legacyConfig);
    const service = new ConfigService();

    await service.init();

    expect(service.getConfig().voice).toEqual(defaultLocalSpeechSettings);
  });

  test('normalizes voice values before persisting an update', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();

    await service.updateConfig({
      voice: {
        ...defaultLocalSpeechSettings,
        maxRecordingSeconds: 500,
        speechRate: 0.1,
      },
    });

    expect(service.getConfig().voice).toMatchObject({
      maxRecordingSeconds: 120,
      speechRate: 0.5,
    });
  });

  test('deletes unsupported numbered custom provider configs', async () => {
    storeMocks.getItem.mockResolvedValue({
      ...defaultConfig,
      api: { key: 'obsolete-secret', baseUrl: 'https://api.example.test/v1' },
      model: {
        ...defaultConfig.model,
        defaultModel: 'model-1',
        defaultModelProvider: 'custom_0',
      },
      providers: {
        ...defaultConfig.providers,
        custom_0: {
          enabled: true,
          apiKey: 'secret',
          baseUrl: 'https://api.example.test/v1',
          displayName: 'AcmeProxy',
          identity: 'obsolete-numbered-provider',
          models: [{ id: 'model-1', name: 'Model 1' }],
        },
      },
    });
    const service = new ConfigService();

    await service.init();

    expect(service.getConfig().providers).not.toHaveProperty('custom_0');
    expect(service.getConfig().providers).not.toHaveProperty('acmeproxy');
    expect(service.getConfig().model.defaultModelProvider).toBe(
      defaultConfig.model.defaultModelProvider,
    );
    expect(service.getConfig().model.defaultModel).toBe(defaultConfig.model.defaultModel);
    expect(service.getConfig().api).toEqual(defaultConfig.api);
    expect(storeMocks.patchAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.not.objectContaining({ custom_0: expect.anything() }),
      }),
    );
  });

  test('does not block initialization while obsolete provider removal is applied by Main', async () => {
    storeMocks.getItem.mockResolvedValue({
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        custom_0: {
          enabled: true,
          apiKey: 'secret',
          baseUrl: 'https://api.example.test/v1',
          displayName: 'AcmeProxy',
          models: [],
        },
      },
    });
    storeMocks.patchAppConfig.mockReturnValue(new Promise<void>(() => undefined));
    const service = new ConfigService();

    await service.init();

    expect(service.getConfig().providers).not.toHaveProperty('custom_0');
    expect(storeMocks.patchAppConfig).toHaveBeenCalledOnce();
  });

  test('reload removes obsolete providers and resets their default model selection', async () => {
    storeMocks.getItem.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...defaultConfig,
      api: { key: 'obsolete-secret', baseUrl: 'https://api.example.test/v1' },
      model: {
        ...defaultConfig.model,
        defaultModel: 'model-1',
        defaultModelProvider: 'custom_0',
      },
      providers: {
        ...defaultConfig.providers,
        custom_0: {
          enabled: true,
          apiKey: 'secret',
          baseUrl: 'https://api.example.test/v1',
          displayName: 'AcmeProxy',
          identity: 'obsolete-numbered-provider',
          models: [{ id: 'model-1', name: 'Model 1' }],
        },
      },
    });
    const service = new ConfigService();
    await service.init();

    const config = await service.reloadFromStore();

    expect(config.providers).not.toHaveProperty('custom_0');
    expect(config.model).toMatchObject({
      defaultModel: defaultConfig.model.defaultModel,
      defaultModelProvider: defaultConfig.model.defaultModelProvider,
    });
    expect(config.api).toEqual(defaultConfig.api);
    expect(storeMocks.patchAppConfig).toHaveBeenCalledOnce();
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
    expect(storeMocks.patchAppConfig).toHaveBeenCalledOnce();
  });

  test('keeps the in-memory config unchanged when main rejects the update', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();
    const previousTheme = service.getConfig().theme;
    storeMocks.patchAppConfig.mockRejectedValue(new Error('OpenClaw config rejected'));

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
    storeMocks.patchAppConfig
      .mockReturnValueOnce(
        new Promise<AppConfig>(resolve => {
          resolveFirst = () => resolve({ ...defaultConfig, theme: 'dark' });
        }),
      )
      .mockResolvedValueOnce({ ...defaultConfig, theme: 'dark', language: 'en' });

    const first = service.updateConfig({ theme: 'dark' });
    const second = service.updateConfig({ language: 'en' });
    await Promise.resolve();
    expect(storeMocks.patchAppConfig).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await first;
    await second;
    expect(storeMocks.patchAppConfig.mock.calls[1]?.[0]).toEqual({
      language: 'en',
    });
    expect(service.getConfig()).toMatchObject({ theme: 'dark', language: 'en' });
  });

  test('saving settings cannot send a cached default model back after a main-process selection', async () => {
    storeMocks.getItem.mockResolvedValue(null);
    const service = new ConfigService();
    await service.init();
    storeMocks.patchAppConfig.mockResolvedValue({
      ...defaultConfig,
      language: 'en',
      model: { ...defaultConfig.model, defaultModel: 'selected', defaultModelProvider: 'acme' },
    });
    await service.updateConfig({ language: 'en' });
    expect(storeMocks.patchAppConfig).toHaveBeenCalledWith({ language: 'en' });
    expect(service.getConfig().model.defaultModel).toBe('selected');
  });

  test('a delayed reload cannot overwrite a model confirmed while the read was pending', async () => {
    const service = new ConfigService();
    let finishRead!: (config: AppConfig) => void;
    storeMocks.getItem.mockReturnValue(
      new Promise<AppConfig>(resolve => {
        finishRead = resolve;
      }),
    );
    const read = service.reloadFromStore();
    service.acceptDefaultModelSelection('selected', 'acme');
    finishRead({ ...defaultConfig, language: 'en' });
    const config = await read;
    expect(config.model).toMatchObject({ defaultModel: 'selected', defaultModelProvider: 'acme' });
    expect(config.language).toBe('en');
  });

  test('the latest reload wins when snapshots return out of order', async () => {
    const service = new ConfigService();
    let finishOldRead!: (config: AppConfig) => void;
    storeMocks.getItem
      .mockReturnValueOnce(
        new Promise<AppConfig>(resolve => {
          finishOldRead = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ...defaultConfig,
        language: 'en',
        model: { ...defaultConfig.model, defaultModel: 'new' },
      });
    const oldRead = service.reloadFromStore();
    await service.reloadFromStore();
    finishOldRead(defaultConfig);
    expect((await oldRead).model.defaultModel).toBe('new');
    expect(service.getConfig().language).toBe('en');
  });

  test('an unrelated delayed save keeps a later confirmed model while applying its other settings', async () => {
    const service = new ConfigService();
    let finishSave!: (config: AppConfig) => void;
    storeMocks.patchAppConfig.mockReturnValue(
      new Promise<AppConfig>(resolve => {
        finishSave = resolve;
      }),
    );
    const save = service.updateConfig({ language: 'en' });
    await Promise.resolve();
    service.acceptDefaultModelSelection('selected', 'acme');
    finishSave({ ...defaultConfig, language: 'en' });
    await save;
    expect(service.getConfig().model.defaultModel).toBe('selected');
    expect(service.getConfig().language).toBe('en');
  });

  test('an explicit model patch applies its confirmed result and supersedes an older reload', async () => {
    const service = new ConfigService();
    let finishRead!: (config: AppConfig) => void;
    storeMocks.getItem.mockReturnValue(
      new Promise<AppConfig>(resolve => {
        finishRead = resolve;
      }),
    );
    const read = service.reloadFromStore();
    service.acceptDefaultModelSelection('previous', 'acme');
    const model = {
      ...defaultConfig.model,
      defaultModel: 'explicit',
      defaultModelProvider: 'acme',
    };
    await service.updateConfig({ model });
    finishRead(defaultConfig);
    expect((await read).model).toEqual(model);
    expect(service.getConfig().model).toEqual(model);
  });
});
