// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import {
  commitNonLanguageModelConfigurations,
  getNonLanguageModelCategoryValidationError,
  type NonLanguageModelProviders,
  normalizeNonLanguageModelCategory,
} from './nonLanguageModelConfig';

describe('non-language model configuration persistence', () => {
  const saveTtsConfiguration = vi.fn();
  const saveAsrConfiguration = vi.fn();
  const clearAsrConfiguration = vi.fn();
  const clearTtsConfiguration = vi.fn();
  const saveMediaConfiguration = vi.fn();

  beforeEach(() => {
    saveTtsConfiguration.mockReset().mockResolvedValue(undefined);
    saveAsrConfiguration.mockReset().mockResolvedValue(undefined);
    clearAsrConfiguration.mockReset().mockResolvedValue(undefined);
    clearTtsConfiguration.mockReset().mockResolvedValue(undefined);
    saveMediaConfiguration.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        onlineAsr: {
          saveConfiguration: saveAsrConfiguration,
          clearConfiguration: clearAsrConfiguration,
        },
        onlineTts: {
          saveConfiguration: saveTtsConfiguration,
          clearConfiguration: clearTtsConfiguration,
        },
        mediaGenerationModels: { saveConfiguration: saveMediaConfiguration },
      },
    });
  });

  it('validates a category without requiring its settings panel to be mounted', () => {
    expect(
      getNonLanguageModelCategoryValidationError('image', {
        providers: {
          image: {
            displayName: 'Image API',
            baseUrl: 'not-a-url',
            apiKey: '',
            models: [],
          },
        },
      }),
    ).toBe('customModelProviderInvalid');
  });

  it('selects a remaining image provider when the previous default is removed', () => {
    const normalized = normalizeNonLanguageModelCategory('image', {
      defaultProviderId: 'removed',
      providers: {
        remaining: {
          displayName: 'Remaining API',
          baseUrl: 'https://image.test/v1',
          apiKey: '',
          defaultModel: 'image-pro',
          models: [{ id: 'image-pro', name: 'Image Pro' }],
        },
      },
    });

    expect(normalized.defaultProviderId).toBe('remaining');
  });

  it('normalizes and persists speech synthesis catalog data without selecting defaults', async () => {
    const draft: NonLanguageModelProviders = {
      'speech-synthesis': {
        providers: {
          speech: {
            displayName: 'Speech API',
            baseUrl: 'http://speech.lan/v1/audio/speech',
            apiKey: '',
            models: [
              {
                id: 'tts-pro',
                name: 'TTS Pro',
                voices: [{ id: 'nova', name: 'Nova' }],
              },
            ],
          },
        },
      },
    };

    const persist = vi.fn().mockResolvedValue(undefined);
    const normalized = await commitNonLanguageModelConfigurations({}, draft, persist);

    expect(saveTtsConfiguration).not.toHaveBeenCalled();
    expect(normalized['speech-synthesis']?.providers.speech.baseUrl).toBe('http://speech.lan/v1');
    expect(normalized['speech-synthesis']?.providers.speech.models[0]?.voices).toEqual([
      { id: 'nova', name: 'Nova' },
    ]);
    expect(persist).toHaveBeenCalledWith(normalized);
  });

  it('persists a deleted category without changing runtime selection', async () => {
    const current: NonLanguageModelProviders = {
      'speech-recognition': {
        providers: {
          speech: {
            displayName: 'Speech API',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'whisper', name: 'Whisper' }],
          },
        },
      },
    };

    await commitNonLanguageModelConfigurations(
      current,
      { 'speech-recognition': { providers: {} } },
      vi.fn().mockResolvedValue(undefined),
    );

    expect(clearAsrConfiguration).not.toHaveBeenCalled();
  });

  it('does not contact the runtime when the configuration is unchanged', async () => {
    const category = {
      providers: {
        speech: {
          displayName: 'Speech API',
          baseUrl: 'http://speech.lan/v1',
          apiKey: '',
          models: [
            {
              id: 'tts-pro',
              name: 'TTS Pro',
              voices: [{ id: 'nova', name: 'Nova' }],
            },
          ],
        },
      },
    };
    const configuration: NonLanguageModelProviders = {
      'speech-synthesis': category,
    };

    await commitNonLanguageModelConfigurations(
      configuration,
      structuredClone(configuration),
      vi.fn().mockResolvedValue(undefined),
    );

    expect(saveTtsConfiguration).not.toHaveBeenCalled();
  });

  it('persists metadata edits without patching an unchanged runtime configuration', async () => {
    const current: NonLanguageModelProviders = {
      image: {
        defaultProviderId: 'image',
        providers: {
          image: {
            displayName: 'Old provider name',
            baseUrl: 'https://image.test/v1',
            apiKey: 'secret',
            defaultModel: 'image-pro',
            models: [{ id: 'image-pro', name: 'Old model name' }],
          },
        },
      },
    };
    const draft = structuredClone(current);
    draft.image!.providers.image.displayName = 'New provider name';
    draft.image!.providers.image.models[0].name = 'New model name';
    const persist = vi.fn().mockResolvedValue(undefined);

    await commitNonLanguageModelConfigurations(current, draft, persist);

    expect(window.electron.mediaGenerationModels.saveConfiguration).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('synchronizes an explicitly selected image model with the runtime', async () => {
    const draft: NonLanguageModelProviders = {
      image: {
        defaultProviderId: 'image',
        providers: {
          image: {
            displayName: 'Image API',
            baseUrl: 'https://image.test/v1/images/generations',
            apiKey: 'secret',
            defaultModel: 'image-pro',
            models: [{ id: 'image-pro', name: 'Image Pro' }],
          },
        },
      },
    };

    await commitNonLanguageModelConfigurations({}, draft, vi.fn().mockResolvedValue(undefined));

    expect(window.electron.mediaGenerationModels.saveConfiguration).toHaveBeenCalledWith('image', {
      primary: 'openai/image-pro',
      fallbacks: [],
      baseUrl: 'https://image.test/v1',
      apiKey: 'secret',
    });
  });

  it('clears a deleted image selection from the runtime', async () => {
    const current: NonLanguageModelProviders = {
      image: {
        defaultProviderId: 'image',
        providers: {
          image: {
            displayName: 'Image API',
            baseUrl: 'https://image.test/v1',
            apiKey: 'secret',
            defaultModel: 'image-pro',
            models: [{ id: 'image-pro', name: 'Image Pro' }],
          },
        },
      },
    };

    await commitNonLanguageModelConfigurations(
      current,
      { image: { providers: {} } },
      vi.fn().mockResolvedValue(undefined),
    );

    expect(saveMediaConfiguration).toHaveBeenCalledWith('image', {
      primary: '',
      fallbacks: [],
    });
  });

  it('restores the previous image selection when local persistence fails', async () => {
    const current: NonLanguageModelProviders = {
      image: {
        defaultProviderId: 'image',
        providers: {
          image: {
            displayName: 'Image API',
            baseUrl: 'https://image.test/v1',
            apiKey: 'secret',
            defaultModel: 'image-old',
            models: [
              { id: 'image-old', name: 'Image Old' },
              { id: 'image-new', name: 'Image New' },
            ],
          },
        },
      },
    };
    const draft = structuredClone(current);
    draft.image!.providers.image.defaultModel = 'image-new';

    await expect(
      commitNonLanguageModelConfigurations(
        current,
        draft,
        vi.fn().mockRejectedValue(new Error('disk full')),
      ),
    ).rejects.toThrow('disk full');

    expect(saveMediaConfiguration).toHaveBeenNthCalledWith(1, 'image', {
      primary: 'openai/image-new',
      fallbacks: [],
      baseUrl: 'https://image.test/v1',
      apiKey: 'secret',
    });
    expect(saveMediaConfiguration).toHaveBeenNthCalledWith(2, 'image', {
      primary: 'openai/image-old',
      fallbacks: [],
      baseUrl: 'https://image.test/v1',
      apiKey: 'secret',
    });
  });

  it('propagates local persistence failures without touching runtime selection', async () => {
    const draft: NonLanguageModelProviders = {
      'speech-synthesis': {
        providers: {
          speech: {
            displayName: 'Speech API',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [
              {
                id: 'tts-pro',
                name: 'TTS Pro',
                voices: [{ id: 'nova', name: 'Nova' }],
              },
            ],
          },
        },
      },
    };

    await expect(
      commitNonLanguageModelConfigurations(
        {},
        draft,
        vi.fn().mockRejectedValue(new Error('disk full')),
      ),
    ).rejects.toThrow('disk full');

    expect(saveTtsConfiguration).not.toHaveBeenCalled();
    expect(clearTtsConfiguration).not.toHaveBeenCalled();
  });
});
