// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type FormEvent, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { currentConfig } = vi.hoisted(() => ({
  currentConfig: { onlineModelProviders: {}, voice: {} } as Record<string, unknown>,
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import {
  createEmptyNonLanguageModelCategory,
  type NonLanguageModelCategory,
  type NonLanguageModelProviders,
} from './nonLanguageModelConfig';
import NonLanguageModelSettings, {
  buildNonLanguageModelEndpointPreview,
  buildNonLanguageModelModelsUrl,
  type NonLanguageModelKind,
  normalizeNonLanguageModelBaseUrl,
  parseDiscoveredVoices,
  parseOpenApiDefaultModels,
} from './NonLanguageModelSettings';
import { buildVoiceDiscoveryUrls } from './nonLanguageModelUrls';

afterEach(cleanup);

describe('NonLanguageModelSettings', () => {
  const saveConfiguration = vi.fn();
  const fetch = vi.fn();

  const renderSettings = (kind: NonLanguageModelKind) => {
    const categories = currentConfig.onlineModelProviders as NonLanguageModelProviders;
    const initial = structuredClone(categories[kind] ?? createEmptyNonLanguageModelCategory());
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const Host = () => {
      const [category, setCategory] = useState<NonLanguageModelCategory>(initial);
      return (
        <form onSubmit={onSubmit}>
          <NonLanguageModelSettings kind={kind} category={category} setCategory={setCategory} />
        </form>
      );
    };
    return { ...render(<Host />), onSubmit };
  };

  beforeEach(() => {
    currentConfig.onlineModelProviders = {};
    currentConfig.voice = {};
    saveConfiguration.mockReset().mockResolvedValue(undefined);
    fetch.mockReset();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        api: { fetch, cancelFetch: vi.fn().mockResolvedValue(undefined) },
        onlineAsr: { saveConfiguration, clearConfiguration: vi.fn().mockResolvedValue(undefined) },
        onlineTts: {
          saveConfiguration: vi.fn(),
          clearConfiguration: vi.fn().mockResolvedValue(undefined),
        },
        mediaGenerationModels: { saveConfiguration: vi.fn() },
      },
    });
  });

  it('builds capability-specific endpoint previews', () => {
    expect(buildNonLanguageModelEndpointPreview('speech-synthesis', 'http://speech.lan/v1/')).toBe(
      'http://speech.lan/v1/audio/speech',
    );
    expect(buildNonLanguageModelEndpointPreview('image', 'https://media.test/v1')).toBe(
      'https://media.test/v1/images/generations',
    );
    expect(buildNonLanguageModelEndpointPreview('video', 'https://media.test/v1')).toBe(
      'https://media.test/v1/videos',
    );
    expect(buildNonLanguageModelEndpointPreview('speech-recognition', 'http://speech.lan/v1')).toBe(
      'ws://speech.lan/v1/realtime?intent=transcription',
    );
    expect(
      buildNonLanguageModelEndpointPreview(
        'speech-synthesis',
        'http://speech.lan/v1/audio/speech?token=value#section',
      ),
    ).toBe('http://speech.lan/v1/audio/speech?token=value');
    expect(
      normalizeNonLanguageModelBaseUrl(
        'speech-synthesis',
        'http://speech.lan/v1/audio/speech?token=value',
      ),
    ).toBe('http://speech.lan/v1?token=value');
    expect(
      buildNonLanguageModelModelsUrl(
        'speech-synthesis',
        'http://speech.lan/v1/audio/speech?token=value',
      ),
    ).toBe('http://speech.lan/v1/models?token=value');
    expect(
      normalizeNonLanguageModelBaseUrl(
        'speech-synthesis',
        'http://speech.lan/v1/audio/speech?token=/',
      ),
    ).toBe('http://speech.lan/v1?token=/');
    expect(buildVoiceDiscoveryUrls('http://speech.lan/v2/audio/speech')).toEqual([
      'http://speech.lan/v2/audio/voices',
      'http://speech.lan/v2/voices',
      'http://speech.lan/api/voices',
    ]);
  });

  it('parses common custom-provider voice catalog shapes for a model', () => {
    expect(
      parseDiscoveredVoices(
        {
          data: [
            { id: 'tts-pro', voices: ['nova', { id: 'calm', name: 'Calm' }] },
            { id: 'other-model', voices: ['ignored'] },
          ],
        },
        'tts-pro',
      ),
    ).toEqual([
      { id: 'nova', name: 'nova' },
      { id: 'calm', name: 'Calm' },
    ]);
    expect(
      parseDiscoveredVoices(
        { voices: [{ voice_id: 'speaker-1', label: 'Speaker One', models: ['tts-pro'] }] },
        'tts-pro',
      ),
    ).toEqual([{ id: 'speaker-1', name: 'Speaker One' }]);
    expect(
      parseDiscoveredVoices(
        {
          builtins: ['Junhao'],
          custom: [{ id: 'voice-clone-id', name: 'Junhao clone' }],
        },
        'tts-pro',
      ),
    ).toEqual([
      { id: 'Junhao', name: 'Junhao' },
      { id: 'voice-clone-id', name: 'Junhao clone' },
    ]);
    expect(
      parseDiscoveredVoices(
        { data: { voices: { calm: 'Calm voice', bright: { label: 'Bright voice' } } } },
        'tts-pro',
      ),
    ).toEqual([
      { id: 'calm', name: 'Calm voice' },
      { id: 'bright', name: 'Bright voice' },
    ]);
    expect(
      parseDiscoveredVoices(
        { data: { builtins: ['Junhao'], custom: { clone: { name: 'Clone' } } } },
        'tts-pro',
      ),
    ).toEqual([
      { id: 'Junhao', name: 'Junhao' },
      { id: 'clone', name: 'Clone' },
    ]);
    expect(
      parseDiscoveredVoices(
        { data: [{ id: 'tts-pro', voices: { calm: 'Calm voice' } }] },
        'tts-pro',
      ),
    ).toEqual([{ id: 'calm', name: 'Calm voice' }]);
    expect(
      parseDiscoveredVoices(['plain', { id: 'plain', name: 'Preferred name' }], 'tts-pro'),
    ).toEqual([{ id: 'plain', name: 'Preferred name' }]);
  });

  it('discovers a default model and voice from an OpenAPI request schema', () => {
    expect(
      parseOpenApiDefaultModels(
        {
          paths: {
            '/v1/audio/speech': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/SpeechRequest' },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              SpeechRequest: {
                properties: {
                  model: { type: 'string', default: 'moss-tts-nano-onnx' },
                  voice: { type: 'string', default: 'Junhao' },
                },
              },
            },
          },
        },
        'speech-synthesis',
        'http://127.0.0.1:18084/v1/audio/speech',
      ),
    ).toEqual([
      {
        id: 'moss-tts-nano-onnx',
        name: 'moss-tts-nano-onnx',
        voices: [{ id: 'Junhao', name: 'Junhao' }],
      },
    ]);
  });

  it('starts empty and keeps provider and model edits in the shared draft', () => {
    renderSettings('speech-recognition');

    expect(screen.getByText('customModelNoProviders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /addCustomProvider/ }));
    fireEvent.change(screen.getByLabelText('customDisplayName'), {
      target: { value: 'Office Speech' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    fireEvent.change(screen.getByLabelText('baseUrl'), {
      target: { value: 'http://speech.lan/v1' },
    });
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'local-key' } });
    fireEvent.click(screen.getByRole('button', { name: /manualAddModel/ }));
    fireEvent.change(screen.getByLabelText('mediaModelId'), {
      target: { value: 'whisper-local' },
    });
    fireEvent.change(screen.getByLabelText('modelName'), {
      target: { value: 'Whisper Local' },
    });
    const confirmButtons = screen.getAllByRole('button', { name: 'confirm' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(screen.getByText('Whisper Local')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /mediaModelSave/ })).toBeNull();
  });

  it('confirms modal fields on Enter without submitting the outer settings form', () => {
    const { onSubmit } = renderSettings('speech-recognition');
    fireEvent.click(screen.getByRole('button', { name: /addCustomProvider/ }));
    const providerNameInput = screen.getByLabelText('customDisplayName');
    fireEvent.change(providerNameInput, { target: { value: 'Office Speech' } });
    fireEvent.keyDown(providerNameInput, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('baseUrl'), {
      target: { value: 'http://speech.lan/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /manualAddModel/ }));
    const modelIdInput = screen.getByLabelText('mediaModelId');
    fireEvent.change(modelIdInput, { target: { value: 'whisper-local' } });
    fireEvent.keyDown(modelIdInput, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('whisper-local')).toBeTruthy();
  });

  it('keeps deletion in the shared draft until the settings form is saved', () => {
    currentConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office Speech',
            baseUrl: 'http://speech.lan/v1',
            apiKey: 'key',
            models: [{ id: 'whisper', name: 'Whisper' }],
          },
        },
      },
    };

    renderSettings('speech-recognition');
    fireEvent.click(screen.getByRole('button', { name: 'deleteCustomProvider: Office Speech' }));

    expect(screen.getByText('customModelNoProviders')).toBeTruthy();
    expect(window.electron.onlineAsr.clearConfiguration).not.toHaveBeenCalled();
  });

  it('validates provider names and rejects duplicates', () => {
    currentConfig.onlineModelProviders = {
      image: {
        providers: {
          existing: {
            displayName: 'Media API',
            baseUrl: 'http://media.lan/v1',
            apiKey: '',
            models: [],
          },
        },
      },
    };
    renderSettings('image');

    fireEvent.click(screen.getByRole('button', { name: /addCustomProvider/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('customDisplayName'), {
      target: { value: '中文供应商' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(screen.getByText('providerNameInvalid')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('customDisplayName'), {
      target: { value: 'media api' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(screen.getByText('providerNameExists')).toBeTruthy();
  });

  it('auto-detects models from the provider models endpoint', async () => {
    currentConfig.onlineModelProviders = {
      image: {
        providers: {
          media: {
            displayName: 'Media API',
            baseUrl: 'https://media.lan/v1',
            apiKey: 'secret',
            models: [{ id: 'manual-model', name: 'Manual model' }],
          },
        },
      },
    };
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      data: { data: [{ id: 'image-pro', name: 'Image Pro' }] },
    });
    renderSettings('image');

    expect(screen.getByTitle('https://media.lan/v1/images/generations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));

    await waitFor(() => expect(screen.getByText('Image Pro')).toBeTruthy());
    expect(screen.getByText('Manual model')).toBeTruthy();
    expect(screen.queryByText('image-pro')).toBeNull();
    expect(screen.queryByText('manual-model')).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://media.lan/v1/models',
        method: 'GET',
        headers: { Authorization: 'Bearer secret' },
        requestId: expect.any(String),
      }),
    );
  });

  it('falls back to OpenAPI discovery for a custom speech service without /models', async () => {
    currentConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          moss: {
            displayName: 'MOSS TTS',
            baseUrl: 'http://127.0.0.1:18084/v1/audio/speech',
            apiKey: '',
            models: [],
          },
        },
      },
    };
    fetch
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        data: {
          paths: {
            '/v1/audio/speech': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/SpeechRequest' },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              SpeechRequest: {
                properties: {
                  model: { default: 'moss-tts-nano-onnx' },
                  voice: { default: 'Junhao' },
                },
              },
            },
          },
        },
      });
    renderSettings('speech-synthesis');

    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));

    await waitFor(() => expect(screen.getByText('moss-tts-nano-onnx')).toBeTruthy());
    expect(screen.getByText('availableVoiceCount')).toBeTruthy();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: 'http://127.0.0.1:18084/openapi.json' }),
    );
  });

  it('stores the complete discovered voice list without selecting a default voice', async () => {
    currentConfig.onlineModelProviders = {
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
    renderSettings('speech-synthesis');

    expect(screen.getByText('availableVoiceCount')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'editModel: TTS Pro' }));
    expect(screen.getByRole('listitem', { name: /Nova/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('manualVoiceId'), {
      target: { value: 'manual-voice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'addVoice' }));
    expect(screen.getByRole('listitem', { name: /manual-voice/ })).toBeTruthy();
    fetch
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        data: { builtins: ['calm'], custom: [{ id: 'clone', name: 'Cloned voice' }] },
      });
    fireEvent.click(screen.getByRole('button', { name: 'detectVoices' }));
    await waitFor(() => expect(screen.getByText('voiceDetectionSummary')).toBeTruthy());
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: 'http://speech.lan/v1/audio/voices', method: 'GET' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: 'http://speech.lan/v1/voices', method: 'GET' }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ url: 'http://speech.lan/api/voices', method: 'GET' }),
    );
    expect(screen.getByRole('listitem', { name: /calm/ })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /Cloned voice/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    fireEvent.click(screen.getByRole('button', { name: 'editModel: TTS Pro' }));
    expect(screen.getByRole('listitem', { name: /calm/ })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /Cloned voice/ })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /manual-voice/ })).toBeTruthy();
  });

  it('ignores stale voice discovery after the model ID changes', async () => {
    currentConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          speech: {
            displayName: 'Speech API',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [
              {
                id: 'tts-old',
                name: 'Old TTS',
                voices: [{ id: 'old-voice', name: 'Old voice' }],
              },
            ],
          },
        },
      },
    };
    let resolveFetch: ((value: unknown) => void) | undefined;
    fetch.mockReturnValueOnce(new Promise(resolve => (resolveFetch = resolve)));
    renderSettings('speech-synthesis');
    fireEvent.click(screen.getByRole('button', { name: 'editModel: Old TTS' }));
    fireEvent.click(screen.getByRole('button', { name: 'detectVoices' }));

    fireEvent.change(screen.getByLabelText('mediaModelId'), { target: { value: 'tts-new' } });
    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        statusText: 'OK',
        data: { voices: ['stale-voice'] },
      });
      await Promise.resolve();
    });

    expect(window.electron.api.cancelFetch).toHaveBeenCalled();
    expect(screen.queryByRole('listitem', { name: 'stale-voice' })).toBeNull();
  });

  it('does not require a default provider, model, or voice', () => {
    currentConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          ready: {
            displayName: 'Ready Speech',
            baseUrl: 'http://ready.lan/v1',
            apiKey: '',
            models: [{ id: 'tts-ready', name: 'Ready TTS' }],
          },
          broken: {
            displayName: 'Broken Speech',
            baseUrl: 'http://broken.lan/v1',
            apiKey: '',
            models: [{ id: 'tts-broken', name: 'Broken TTS' }],
          },
        },
      },
    };
    renderSettings('speech-synthesis');

    expect(screen.queryByText('customModelProviderInvalid')).toBeNull();
    expect(screen.queryByRole('button', { name: /mediaModelSave/ })).toBeNull();
  });

  it('keeps default model selection for image generation', () => {
    currentConfig.onlineModelProviders = {
      image: {
        providers: {
          image: {
            displayName: 'Image API',
            baseUrl: 'https://image.test/v1',
            apiKey: '',
            models: [{ id: 'image-pro', name: 'Image Pro' }],
          },
        },
      },
    };
    renderSettings('image');

    expect(screen.getByText('customModelDefaultRequired')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));
    expect(screen.getByText('mediaModelDefaultBadge')).toBeTruthy();
    expect(screen.queryByText('customModelDefaultRequired')).toBeNull();
  });
});
