// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type FormEvent, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { currentConfig, engineReadiness } = vi.hoisted(() => ({
  currentConfig: { onlineModelProviders: {}, voice: {} } as Record<string, unknown>,
  engineReadiness: { ready: true, failed: false, listeners: new Set<() => void>() },
}));

vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  getEngineReadinessSnapshot: () => engineReadiness,
  subscribeEngineReadiness: (listener: () => void) => {
    engineReadiness.listeners.add(listener);
    return () => engineReadiness.listeners.delete(listener);
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import {
  commitNonLanguageModelConfigurations,
  createEmptyNonLanguageModelCategory,
  getNonLanguageModelCategoryValidationError,
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NonLanguageModelSettings', () => {
  const saveConfiguration = vi.fn();
  const fetch = vi.fn();

  const renderSettings = (
    kind: NonLanguageModelKind,
    initialBuiltinModels?: boolean,
    initialProviderId?: string,
  ) => {
    const categories = currentConfig.onlineModelProviders as NonLanguageModelProviders;
    const initial = structuredClone(categories[kind] ?? createEmptyNonLanguageModelCategory());
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    let observedCategory = initial;
    const Host = () => {
      const [category, setCategory] = useState<NonLanguageModelCategory>(initial);
      observedCategory = category;
      return (
        <form onSubmit={onSubmit}>
          <NonLanguageModelSettings
            kind={kind}
            category={category}
            setCategory={setCategory}
            initialBuiltinModels={initialBuiltinModels}
            initialProviderId={initialProviderId}
          />
        </form>
      );
    };
    return { ...render(<Host />), onSubmit, getCategory: () => observedCategory };
  };

  it('inherits a visible HTTP provider interface for new recognition models', () => {
    const { getCategory } = renderSettings('speech-recognition');
    fireEvent.click(screen.getByRole('button', { name: /addCustomProvider/ }));
    fireEvent.change(screen.getByLabelText('customDisplayName'), {
      target: { value: 'Recorded Audio' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(Object.values(getCategory().providers)[0].protocolId).toBe('openai-transcription-http');
    expect(screen.getByRole('combobox', { name: 'speechProviderProtocol' }).textContent).toContain(
      'speechProtocolRecorded',
    );
    fireEvent.change(screen.getByLabelText('baseUrl'), {
      target: { value: 'http://speech.lan/deploy/v1' },
    });
    expect(screen.getByText('http://speech.lan/deploy/v1/audio/transcriptions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /manualAddModel/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('mediaModelId'), {
      target: { value: 'asr-one' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
    expect(Object.values(getCategory().providers)[0].models).toEqual([
      { id: 'asr-one', name: 'asr-one' },
    ]);
  });

  it('keeps legacy provider data unchanged until a shared interface is selected', () => {
    const bindings = [{ id: 'retained', protocolId: 'openai-transcription-http' as const }];
    const provider = {
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      models: [{ id: 'asr', name: 'ASR', bindings }],
    };
    currentConfig.onlineModelProviders = {
      'speech-recognition': { providers: { office: provider } },
    };
    const { getCategory } = renderSettings('speech-recognition');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 20,
      bottom: 60,
      left: 20,
      right: 320,
      width: 300,
      height: 40,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    });
    expect(getCategory().providers.office).toEqual(provider);
    expect(screen.getByText('speechProviderProtocolLegacy')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'speechProviderProtocol' }));
    fireEvent.click(screen.getByRole('option', { name: 'speechProtocolRealtimeTranscription' }));
    expect(getCategory().providers.office).toMatchObject({
      protocolId: 'openai-transcription-realtime',
      models: provider.models,
    });
    expect(screen.getByText('ws://speech.lan/v1/realtime?intent=transcription')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires an explicit core interface choice and retains unsupported model metadata', () => {
    const model = {
      id: 'reader',
      name: 'Reader',
      voicePolicy: 'service-default',
      bindings: [{ id: 'retired', protocolId: 'chat-audio-speech' }],
    };
    const provider = {
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      protocolId: 'chat-audio-speech',
      compatibilityProfile: 'retired-profile',
      models: [model],
    };
    currentConfig.onlineModelProviders = {
      'speech-synthesis': { providers: { office: provider } },
    };
    const { getCategory } = renderSettings('speech-synthesis');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 20,
      bottom: 60,
      left: 20,
      right: 320,
      width: 300,
      height: 40,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    });
    expect(screen.getByText('speechProviderProtocolInvalid')).toBeTruthy();
    expect(getCategory().providers.office).toEqual(provider);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'speechProviderProtocol' }));
    fireEvent.click(screen.getByRole('option', { name: 'speechProtocolSynthesis' }));
    expect(getCategory().providers.office).not.toHaveProperty('compatibilityProfile');
    expect(getCategory().providers.office).toMatchObject({
      protocolId: 'openai-speech-http',
      models: [model],
    });
    fireEvent.click(screen.getByRole('button', { name: 'editModel: Reader' }));
    expect(
      within(screen.getByRole('dialog')).getByText('speechModelParametersReview'),
    ).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'confirm' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(getCategory().providers.office.models[0]).toEqual(model);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves legacy binding aliases when editing inherited model parameters', () => {
    const bindings = [
      {
        id: 'old-call',
        protocolId: 'openai-voice-realtime' as const,
        inputTranscriptionModel: 'transcriber-one',
      },
    ];
    currentConfig.onlineModelProviders = {
      'realtime-voice': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'openai-voice-realtime',
            models: [{ id: 'call', name: 'Call', bindings }],
          },
        },
      },
    };
    const { getCategory } = renderSettings('realtime-voice');
    fireEvent.click(screen.getByRole('button', { name: 'editModel: Call' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(
      within(dialog).getByLabelText('speechInputTranscriptionModel', { exact: false }),
    ).toHaveProperty('value', 'transcriber-one');
    fireEvent.change(within(dialog).getByLabelText('modelName'), {
      target: { value: 'Call renamed' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
    expect(getCategory().providers.office.models[0]).toMatchObject({
      name: 'Call renamed',
      inputTranscriptionModel: 'transcriber-one',
      bindings,
    });
  });

  it('requires ambiguous realtime parameters to be entered without deleting old binding data', () => {
    const bindings = ['first', 'second'].map(id => ({
      id,
      protocolId: 'openai-voice-realtime' as const,
      inputTranscriptionModel: id,
    }));
    currentConfig.onlineModelProviders = {
      'realtime-voice': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'openai-voice-realtime',
            models: [{ id: 'call', name: 'Call', bindings }],
          },
        },
      },
    };
    const { getCategory } = renderSettings('realtime-voice');
    fireEvent.click(screen.getByRole('button', { name: 'editModel: Call' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('speechModelParametersReview')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
    expect(getCategory().providers.office.models[0].inputTranscriptionModel).toBeUndefined();
    fireEvent.change(
      within(dialog).getByLabelText('speechInputTranscriptionModel', { exact: false }),
      { target: { value: 'chosen-transcriber' } },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
    expect(getCategory().providers.office.models[0]).toMatchObject({
      inputTranscriptionModel: 'chosen-transcriber',
      bindings,
    });
  });

  it('adds a user-defined synthesis model without guessing a voice or policy', () => {
    currentConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'openai-speech-http',
            models: [],
          },
        },
      },
    };
    const { getCategory } = renderSettings('speech-synthesis');
    fireEvent.click(screen.getByRole('button', { name: /manualAddModel/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('mediaModelId'), {
      target: { value: 'company/reader-v7' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
    expect(getCategory().providers.office.models[0]).toEqual({
      id: 'company/reader-v7',
      name: 'company/reader-v7',
    });
  });

  it.each(['http://speech.lan/v1/audio/transcriptions', 'http://speech.lan/v1#fragment'])(
    'does not discover voices through an invalid explicit Speech endpoint: %s',
    endpoint => {
      currentConfig.onlineModelProviders = {
        'speech-synthesis': {
          providers: {
            office: {
              displayName: 'Office',
              baseUrl: endpoint,
              apiKey: 'configured-key',
              protocolId: 'openai-speech-http',
              models: [{ id: 'speech', name: 'Speech' }],
            },
          },
        },
      };
      renderSettings('speech-synthesis');
      fireEvent.click(screen.getByRole('button', { name: 'editModel: Speech' }));
      const detect = within(screen.getByRole('dialog')).getByRole('button', {
        name: 'detectVoices',
      });
      expect(detect).toHaveProperty('disabled', true);
      fireEvent.click(detect);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('discovers recorded transcription models from a multipart OpenAPI schema', () => {
    expect(
      parseOpenApiDefaultModels(
        {
          paths: {
            '/deploy/v1/audio/transcriptions': {
              post: {
                requestBody: {
                  content: {
                    'multipart/form-data': {
                      schema: { properties: { model: { enum: ['recorded-asr'] } } },
                    },
                  },
                },
              },
            },
          },
        },
        'speech-recognition',
        'http://speech.lan/deploy/v1/audio/transcriptions',
      ),
    ).toEqual([{ id: 'recorded-asr', name: 'recorded-asr' }]);
  });

  it('previews the selected speech protocol and preserves invalid explicit endpoints for validation', () => {
    const protocol = { protocolId: 'openai-transcription-http' } as const;
    expect(
      buildNonLanguageModelEndpointPreview(
        'speech-recognition',
        'http://speech.lan/deploy/v2',
        protocol,
      ),
    ).toBe('http://speech.lan/deploy/v2/audio/transcriptions');
    expect(
      normalizeNonLanguageModelBaseUrl(
        'speech-recognition',
        'http://speech.lan/deploy/v2/audio/transcriptions',
        protocol,
      ),
    ).toBe('http://speech.lan/deploy/v2');
    for (const endpoint of [
      'http://speech.lan/v1/audio/speech',
      'http://speech.lan/v1?token=private',
      'http://speech.lan/v1#fragment',
    ]) {
      expect(normalizeNonLanguageModelBaseUrl('speech-recognition', endpoint, protocol)).toBe(
        endpoint,
      );
    }
  });

  it('shows decision provider URL and key as required and detects with Bearer auth', async () => {
    currentConfig.onlineModelProviders = {
      decision: {
        defaultProviderId: 'lan',
        providers: {
          lan: {
            displayName: 'LAN',
            baseUrl: 'http://192.168.1.9:8009/v1',
            apiKey: 'test-key',
            defaultModel: 'kev-latest',
            models: [{ id: 'kev-latest', name: 'Kev' }],
          },
        },
      },
    };
    fetch.mockResolvedValue({ ok: true, data: { data: [{ id: 'kev-latest' }] } });
    renderSettings('decision');
    expect(screen.getByLabelText('baseUrl *').hasAttribute('required')).toBe(true);
    expect(screen.getByLabelText('apiKey *').hasAttribute('required')).toBe(true);
    expect(screen.getByText('http://192.168.1.9:8009/v1/systemone')).toBeTruthy();
    fireEvent.click(screen.getByText('detectModels'));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://192.168.1.9:8009/v1/models',
          headers: { Authorization: 'Bearer test-key' },
        }),
      ),
    );
  });

  it('keeps decision provider details when clearing, saving and restoring its default', async () => {
    const selected = {
      defaultProviderId: 'lan',
      providers: {
        lan: {
          displayName: 'LAN',
          baseUrl: 'http://inference.test/v1',
          apiKey: 'retained-test-key',
          defaultModel: 'kev-latest',
          models: [{ id: 'kev-latest', name: 'Kev' }],
        },
      },
    };
    currentConfig.onlineModelProviders = { decision: selected };
    const { getCategory, unmount } = renderSettings('decision');

    fireEvent.click(screen.getByRole('button', { name: 'mediaModelClearDefault' }));

    expect(getCategory().defaultProviderId).toBeUndefined();
    expect(getCategory().providers).toEqual(selected.providers);
    const persist = vi.fn().mockResolvedValue(undefined);
    const saved = await commitNonLanguageModelConfigurations(
      { decision: selected },
      { decision: getCategory() },
      persist,
    );
    expect(persist).toHaveBeenCalledWith(saved);
    expect(saved.decision?.defaultProviderId).toBeUndefined();
    expect(saved.decision?.providers).toEqual(selected.providers);

    unmount();
    currentConfig.onlineModelProviders = JSON.parse(JSON.stringify(saved));
    const reopened = renderSettings('decision');
    expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
    expect(reopened.getCategory().defaultProviderId).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));

    expect(reopened.getCategory()).toEqual(selected);
    expect(screen.getByRole('button', { name: 'mediaModelClearDefault' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an unselected decision catalog disabled when discovering more models', async () => {
    currentConfig.onlineModelProviders = {
      decision: {
        providers: {
          lan: {
            displayName: 'LAN',
            baseUrl: 'http://inference.test/v1',
            apiKey: 'retained-test-key',
            defaultModel: 'kev-latest',
            models: [{ id: 'kev-latest', name: 'Kev' }],
          },
        },
      },
    };
    fetch.mockResolvedValue({ ok: true, data: { data: [{ id: 'kev-next' }] } });
    const { getCategory } = renderSettings('decision');

    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));

    await waitFor(() => expect(screen.getByText('kev-next')).toBeTruthy());
    expect(getCategory().defaultProviderId).toBeUndefined();
    expect(getCategory().providers.lan).toMatchObject({
      baseUrl: 'http://inference.test/v1',
      apiKey: 'retained-test-key',
      defaultModel: 'kev-latest',
    });
    expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
  });

  beforeEach(() => {
    engineReadiness.ready = true;
    engineReadiness.failed = false;
    engineReadiness.listeners.clear();
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
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          onChanged: vi.fn(() => () => undefined),
          install: vi.fn(),
          remove: vi.fn(),
        },
        extensions: {
          list: vi.fn().mockResolvedValue({
            success: true,
            extensions: [{ id: 'openai', enabled: true }],
          }),
          onChanged: vi.fn(() => () => undefined),
        },
      },
    });
  });

  const addVideoProvider = async (name: string) => {
    const addButton = screen.getByRole('button', { name: 'addCustomProvider' });
    await waitFor(() => expect(addButton.hasAttribute('disabled')).toBe(false));
    fireEvent.click(addButton);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('customDisplayName'), {
      target: { value: name },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
  };

  const addVideoModel = (id: string, name?: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'manualAddModel' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('mediaModelId'), { target: { value: id } });
    if (name)
      fireEvent.change(within(dialog).getByLabelText('modelName'), { target: { value: name } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
  };

  const catalogKinds = ['decision', 'image', 'video'] as const;
  const createCatalog = (kind: (typeof catalogKinds)[number]): NonLanguageModelCategory => ({
    defaultProviderId: 'provider-7',
    providers: Object.fromEntries(
      Array.from({ length: 10 }, (_, providerIndex) => [
        `provider-${providerIndex}`,
        {
          displayName: `Provider ${providerIndex}`,
          baseUrl: `http://provider-${providerIndex}.test/v1`,
          apiKey: 'test-key',
          defaultModel: 'model/2',
          models: Array.from({ length: 5 }, (_, modelIndex) => ({
            id: `model/${modelIndex}`,
            name: `Model ${providerIndex}-${modelIndex}`,
          })),
          ...(kind === 'video' ? { nativeVideoProvider: 'video-openai' as const } : {}),
        },
      ]),
    ),
  });

  it('announces the default provider when its stored ID contains spaces', () => {
    currentConfig.onlineModelProviders = {
      image: {
        defaultProviderId: 'model api',
        providers: { 'model api': createCatalog('image').providers['provider-7'] },
      },
    };
    renderSettings('image');

    expect(
      screen.getByRole('button', { name: 'Provider 7', description: 'mediaModelDefaultBadge' }),
    ).toBeTruthy();
  });

  it.each(catalogKinds)(
    'marks one default across a 10-provider, 50-model %s catalog without changing it while browsing',
    async kind => {
      const initial = createCatalog(kind);
      currentConfig.onlineModelProviders = { [kind]: initial };
      const { getCategory, onSubmit } = renderSettings(kind);
      await waitFor(() =>
        expect(screen.getByLabelText('customDisplayName')).toHaveProperty('value', 'Provider 7'),
      );
      const source = screen.getByRole('button', { name: 'Provider 7', pressed: true });
      expect(within(source).getByText('mediaModelDefaultBadge')).toBeTruthy();
      expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(2);
      expect(screen.getByText('catalogDefaultConfiguredHint')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Provider 1' }));

      expect(getCategory().defaultProviderId).toBe('provider-7');
      expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(1);
      const nextRow = screen.getByRole('button', { name: 'editModel: Model 1-4' }).parentElement!;
      fireEvent.click(within(nextRow).getByRole('button', { name: 'mediaModelSetDefault' }));

      expect(getCategory().defaultProviderId).toBe('provider-1');
      expect(getCategory().providers['provider-1'].defaultModel).toBe('model/4');
      expect(getCategory().providers['provider-7'].defaultModel).toBe('model/2');
      expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(2);
      expect(
        within(screen.getByRole('button', { name: 'Provider 7' })).queryByText(
          'mediaModelDefaultBadge',
        ),
      ).toBeNull();
      expect(
        within(screen.getByRole('button', { name: 'Provider 1' })).getByText(
          'mediaModelDefaultBadge',
        ),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'deleteModel: Model 1-4' }));

      expect(getCategory().defaultProviderId).toBeUndefined();
      expect(getCategory().providers['provider-1'].models).toHaveLength(4);
      expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
      expect(screen.getByText('catalogDefaultSelectHint')).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(window.electron.mediaGenerationModels.saveConfiguration).not.toHaveBeenCalled();
    },
  );

  it.each(catalogKinds)('preserves a cleared %s default after saving and reopening', async kind => {
    const selected = createCatalog(kind);
    currentConfig.onlineModelProviders = { [kind]: selected };
    const { getCategory, unmount, onSubmit } = renderSettings(kind);
    fireEvent.click(await screen.findByRole('button', { name: 'mediaModelClearDefault' }));

    expect(getCategory().defaultProviderId).toBeUndefined();
    expect(getCategory().providers).toEqual(selected.providers);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(window.electron.mediaGenerationModels.saveConfiguration).not.toHaveBeenCalled();
    const persist = vi.fn().mockResolvedValue(undefined);
    const saved = await commitNonLanguageModelConfigurations(
      { [kind]: selected },
      { [kind]: getCategory() },
      persist,
    );
    expect(persist).toHaveBeenCalledWith(saved);
    expect(saved[kind]?.providers).toEqual(selected.providers);
    if (kind === 'image') {
      expect(window.electron.mediaGenerationModels.saveConfiguration).toHaveBeenCalledWith(
        'image',
        {
          primary: '',
          fallbacks: [],
        },
      );
    }
    unmount();
    currentConfig.onlineModelProviders = JSON.parse(JSON.stringify(saved));
    const reopened = renderSettings(kind);

    await screen.findByText('catalogDefaultSelectHint');
    expect(reopened.getCategory().defaultProviderId).toBeUndefined();
    expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(catalogKinds)(
    'keeps a new %s catalog unselected when adding and discovering models',
    async kind => {
      const { getCategory } = renderSettings(kind);
      await screen.findByText('catalogDefaultAddModelsHint');
      await addVideoProvider('Model API');
      fireEvent.change(screen.getByLabelText(kind === 'image' ? 'baseUrl' : 'baseUrl *'), {
        target: { value: 'http://models.test/v1' },
      });
      fireEvent.change(screen.getByLabelText(kind === 'decision' ? 'apiKey *' : 'apiKey'), {
        target: { value: 'test-key' },
      });
      addVideoModel('first-model');

      expect(getCategory().defaultProviderId).toBeUndefined();
      expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
      expect(screen.getByText('catalogDefaultSelectHint')).toBeTruthy();
      fetch.mockResolvedValue({ ok: true, data: { data: [{ id: 'discovered-model' }] } });
      fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));
      await screen.findByText('discovered-model');

      expect(getCategory().defaultProviderId).toBeUndefined();
      expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
      expect(Object.values(getCategory().providers)[0].models).toHaveLength(2);
    },
  );

  it.each(catalogKinds)(
    'honors explicit %s provider navigation before the default source',
    async kind => {
      currentConfig.onlineModelProviders = { [kind]: createCatalog(kind) };
      const { getCategory } = renderSettings(kind, undefined, 'provider-2');

      await waitFor(() =>
        expect(screen.getByLabelText('customDisplayName')).toHaveProperty('value', 'Provider 2'),
      );
      expect(getCategory().defaultProviderId).toBe('provider-7');
      expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(1);
    },
  );

  it.each(catalogKinds)(
    'can save discovered %s models without selecting a global default',
    async kind => {
      const { getCategory } = renderSettings(kind);
      await addVideoProvider('Model API');
      fireEvent.change(screen.getByLabelText(kind === 'image' ? 'baseUrl' : 'baseUrl *'), {
        target: { value: 'http://models.test/v1' },
      });
      fireEvent.change(screen.getByLabelText(kind === 'decision' ? 'apiKey *' : 'apiKey'), {
        target: { value: 'test-key' },
      });
      fetch.mockResolvedValue({ ok: true, data: { data: [{ id: 'discovered-model' }] } });
      fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));
      await screen.findByText('discovered-model');

      expect(getNonLanguageModelCategoryValidationError(kind, getCategory())).toBe('');
      const persist = vi.fn().mockResolvedValue(undefined);
      const saved = await commitNonLanguageModelConfigurations(
        {},
        { [kind]: getCategory() },
        persist,
      );

      expect(saved[kind]?.defaultProviderId).toBeUndefined();
      expect(Object.values(saved[kind]!.providers)[0].models).toHaveLength(1);
      expect(persist).toHaveBeenCalledWith(saved);
      expect(screen.queryByText('mediaModelDefaultBadge')).toBeNull();
      expect(window.electron.mediaGenerationModels.saveConfiguration).not.toHaveBeenCalled();
    },
  );

  it('uses only OpenAI even when unsupported vendor extensions are installed', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: ['openai', 'kie', 'zai', 'novita'].map(id => ({ id, enabled: true })),
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    const { getCategory } = renderSettings('video');
    await addVideoProvider('Video API');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(Object.values(getCategory().providers)[0]).toMatchObject({
      nativeVideoProvider: 'video-openai',
      baseUrl: '',
      models: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('switches video provider cards without selecting a default or exposing their keys', async () => {
    const { getCategory } = renderSettings('video');
    await addVideoProvider('Video API');
    addVideoModel('internal-video');
    expect(screen.getByLabelText('baseUrl *')).toHaveProperty('value', '');
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'typed-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'voiceOnlineShowApiKey' }));
    expect(screen.getByLabelText('apiKey').getAttribute('type')).toBe('text');
    const defaultProviderId = getCategory().defaultProviderId;

    await addVideoProvider('Second API');
    expect(screen.getByLabelText('apiKey')).toHaveProperty('value', '');
    expect(screen.getByLabelText('apiKey').getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Video API', pressed: false }));
    expect(screen.getByLabelText('apiKey')).toHaveProperty('value', 'typed-test-key');
    expect(screen.getByLabelText('apiKey').getAttribute('type')).toBe('password');
    expect(getCategory().defaultProviderId).toBe(defaultProviderId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps saved video configurations editable without a runtime inventory and across Gateway recovery', async () => {
    engineReadiness.ready = false;
    engineReadiness.failed = true;
    vi.mocked(window.electron.extensions.list).mockResolvedValue({ success: true, extensions: [] });
    currentConfig.onlineModelProviders = {
      video: {
        defaultProviderId: 'native',
        providers: {
          native: {
            displayName: 'Retained API',
            nativeVideoProvider: 'video-openai',
            baseUrl: 'http://video.lan/v1',
            apiKey: 'retained-key',
            defaultModel: 'internal-video',
            models: [{ id: 'internal-video', name: 'Internal Video' }],
          },
        },
      },
    };
    const { getCategory } = renderSettings('video');
    expect(screen.getByRole('button', { name: 'Retained API' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'addCustomProvider' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Internal Video')).toBeTruthy();
    expect(screen.getByLabelText('apiKey')).toHaveProperty('value', 'retained-key');
    expect(screen.getByLabelText('apiKey')).toHaveProperty('type', 'password');
    fireEvent.change(screen.getByLabelText('baseUrl *'), {
      target: { value: 'http://edited-video.lan/v1' },
    });

    await act(async () => {
      engineReadiness.ready = true;
      engineReadiness.failed = false;
      engineReadiness.listeners.forEach(listener => listener());
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.getByLabelText('baseUrl *')).toHaveProperty('value', 'http://edited-video.lan/v1');
    expect(getCategory().providers.native).toMatchObject({
      baseUrl: 'http://edited-video.lan/v1',
      defaultModel: 'internal-video',
      models: [{ id: 'internal-video', name: 'Internal Video' }],
    });
    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.queryByText('nativeVideoProvidersUnavailable')).toBeNull();
    expect(window.electron.extensions.list).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows configuring video models when Gateway startup fails and the runtime catalog cannot settle', async () => {
    engineReadiness.ready = false;
    engineReadiness.failed = true;
    vi.mocked(window.electron.extensions.list).mockImplementation(() => new Promise(() => undefined));

    const { getCategory } = renderSettings('video');

    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByText('customModelNoProviders')).toBeTruthy();
    await addVideoProvider('Offline Video API');
    addVideoModel('internal-video');
    expect(Object.values(getCategory().providers)[0]).toMatchObject({
      nativeVideoProvider: 'video-openai',
      models: [{ id: 'internal-video', name: 'internal-video' }],
    });
    expect(window.electron.extensions.list).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds, edits and selects video models through the shared provider and model editor', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: [{ id: 'openai', enabled: true }],
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    const { getCategory } = renderSettings('video');
    await addVideoProvider('Video API');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByLabelText('baseUrl *')).toHaveProperty('value', '');
    fireEvent.change(screen.getByLabelText('baseUrl *'), {
      target: { value: 'http://video.test:8091/v1/videos' },
    });
    fireEvent.blur(screen.getByLabelText('baseUrl *'));
    expect(screen.getByLabelText('baseUrl *')).toHaveProperty('value', 'http://video.test:8091/v1');
    expect(screen.getByLabelText('apiKey')).toHaveProperty('value', '');
    expect(screen.getByText('http://video.test:8091/v1/videos')).toBeTruthy();
    addVideoModel('Wan-AI/video', 'Wan Video');
    expect(getCategory().defaultProviderId).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));
    expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(2);
    expect(getCategory().providers[getCategory().defaultProviderId!]).toMatchObject({
      nativeVideoProvider: 'video-openai',
      defaultModel: 'Wan-AI/video',
      models: [{ id: 'Wan-AI/video', name: 'Wan Video' }],
    });
    addVideoModel('video-next', 'Next Video');
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));
    fireEvent.click(screen.getByRole('button', { name: 'editModel: Next Video' }));
    fireEvent.change(screen.getByLabelText('mediaModelId'), { target: { value: 'video-renamed' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'confirm' }));
    expect(getCategory().providers[getCategory().defaultProviderId!].defaultModel).toBe(
      'video-renamed',
    );
    fireEvent.click(screen.getByRole('button', { name: 'deleteModel: Next Video' }));
    expect(getCategory().defaultProviderId).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelClearDefault' }));
    expect(getCategory().defaultProviderId).toBeUndefined();
    expect(screen.getByText('Wan Video')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers video models only on request from the configured endpoint', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: [{ id: 'openai', enabled: true }],
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    renderSettings('video');
    await addVideoProvider('Video API');
    fireEvent.change(screen.getByLabelText('baseUrl *'), {
      target: { value: 'http://video.test/v1' },
    });
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'video-test-key' } });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue({
      ok: true,
      data: { data: [{ id: 'video-v1' }, { id: '../invalid' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));
    await screen.findByText('video-v1');
    expect(screen.queryByText('../invalid')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://video.test/v1/models',
        method: 'GET',
        headers: { Authorization: 'Bearer video-test-key' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'mediaModelSetDefault' }));
    expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(2);
  });

  it('falls back to multipart OpenAPI models when the model directory contains no valid video IDs', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: [{ id: 'openai', enabled: true }],
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    renderSettings('video');
    await addVideoProvider('Video API');
    fireEvent.change(screen.getByLabelText('baseUrl *'), {
      target: { value: 'http://video.test/v1' },
    });
    fetch
      .mockResolvedValueOnce({ ok: true, data: { data: [{ id: '../invalid' }] } })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          paths: {
            '/v1/videos': {
              post: {
                requestBody: {
                  content: {
                    'multipart/form-data': {
                      schema: {
                        properties: {
                          model: { enum: ['video-openapi'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));
    await screen.findByText('video-openapi');
    expect(fetch.mock.calls.map(([options]) => options.url)).toEqual([
      'http://video.test/v1/models',
      'http://video.test/openapi.json',
    ]);
  });

  it('cancels pending model discovery when adding another video provider', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: [{ id: 'openai', enabled: true }],
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    const { getCategory } = renderSettings('video');
    await addVideoProvider('First Video');
    fireEvent.change(screen.getByLabelText('baseUrl *'), {
      target: { value: 'http://first.test/v1' },
    });
    let resolveFetch: ((value: unknown) => void) | undefined;
    fetch.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'detectModels' }));
    await addVideoProvider('Second Video');
    expect(window.electron.api.cancelFetch).toHaveBeenCalled();
    await act(async () => {
      resolveFetch?.({ ok: true, data: { data: [{ id: 'stale-video' }] } });
      await Promise.resolve();
    });
    expect(screen.queryByText('stale-video')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('customDisplayName')).toHaveProperty('value', 'Second Video');
    expect(
      Object.values(getCategory().providers).every(provider => provider.models.length === 0),
    ).toBe(true);
  });

  it('clears video selection when deleting its last model or provider', async () => {
    vi.mocked(window.electron.extensions.list).mockResolvedValue({
      success: true,
      extensions: [{ id: 'openai', enabled: true }],
    } as Awaited<ReturnType<typeof window.electron.extensions.list>>);
    const { getCategory } = renderSettings('video');
    await addVideoProvider('Video API');
    addVideoModel('video-v1');
    fireEvent.click(screen.getByRole('button', { name: 'deleteModel: video-v1' }));
    expect(getCategory().defaultProviderId).toBeUndefined();
    expect(Object.values(getCategory().providers)[0].models).toEqual([]);
    addVideoModel('video-v2');
    fireEvent.click(screen.getByRole('button', { name: 'deleteCustomProvider: Video API' }));
    expect(getCategory()).toEqual({ providers: {} });
    expect(screen.queryByLabelText(/apiKey/)).toBeNull();
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
            { id: 'tts-pro', voices: ['voice-three', { id: 'calm', name: 'Calm' }] },
            { id: 'other-model', voices: ['ignored'] },
          ],
        },
        'tts-pro',
      ),
    ).toEqual([
      { id: 'voice-three', name: 'voice-three' },
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

    expect(
      screen.getByRole('button', { name: 'builtinModelsProvider', pressed: true }),
    ).toBeTruthy();
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

    expect(
      screen.getByRole('button', { name: 'builtinModelsProvider', pressed: true }),
    ).toBeTruthy();
    expect(window.electron.onlineAsr.clearConfiguration).not.toHaveBeenCalled();
  });

  it('browses built-in speech models without changing the online catalog or runtime selection', async () => {
    const category = {
      providers: {
        office: {
          displayName: 'Office Speech',
          baseUrl: 'http://speech.lan/v1',
          apiKey: 'key',
          models: [{ id: 'whisper', name: 'Whisper' }],
        },
      },
    };
    currentConfig.onlineModelProviders = { 'speech-recognition': category };
    const { getCategory } = renderSettings('speech-recognition');
    expect(screen.getByRole('button', { name: 'Office Speech', pressed: true })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'builtinModelsProvider' }));
    expect(await screen.findByText('SenseVoice Small')).toBeTruthy();
    expect(getCategory()).toEqual(category);
    expect(window.electron.localSpeechModels.install).not.toHaveBeenCalled();
    expect(window.electron.onlineAsr.saveConfiguration).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'mediaModelSetDefault' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Office Speech' }));
    expect(screen.getByLabelText('baseUrl')).toHaveProperty('value', 'http://speech.lan/v1');
    expect(getCategory()).toEqual(category);
  });

  it('opens the requested built-in speech catalog when online providers exist', async () => {
    currentConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office Speech',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'speech', name: 'Speech' }],
          },
        },
      },
    };
    renderSettings('speech-synthesis', true);

    expect(
      screen.getByRole('button', { name: 'builtinModelsProvider', pressed: true }),
    ).toBeTruthy();
    expect(await screen.findByText('Kokoro v1.1')).toBeTruthy();
    expect(screen.queryByLabelText('baseUrl')).toBeNull();
  });

  it('opens a requested online speech provider without changing the catalog', () => {
    const providers = {
      first: { displayName: 'First', baseUrl: 'http://first.lan/v1', apiKey: '', models: [] },
      office: { displayName: 'Office', baseUrl: 'http://office.lan/v1', apiKey: '', models: [] },
    };
    currentConfig.onlineModelProviders = { 'speech-synthesis': { providers } };
    const { getCategory } = renderSettings('speech-synthesis', false, 'office');

    expect(screen.getByRole('button', { name: 'Office', pressed: true })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'builtinModelsProvider', pressed: false }),
    ).toBeTruthy();
    expect(screen.getByLabelText('baseUrl')).toHaveProperty('value', 'http://office.lan/v1');
    expect(getCategory()).toEqual({ providers });
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
                voices: [{ id: 'voice-three', name: 'Voice Three' }],
              },
            ],
          },
        },
      },
    };
    renderSettings('speech-synthesis');

    expect(screen.getByText('availableVoiceCount')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'editModel: TTS Pro' }));
    expect(screen.getByRole('listitem', { name: /Voice Three/ })).toBeTruthy();
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
    expect(screen.getAllByText('mediaModelDefaultBadge')).toHaveLength(2);
    expect(screen.queryByText('customModelDefaultRequired')).toBeNull();
  });
});
