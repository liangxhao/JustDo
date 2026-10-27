import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { AppConfigIpc } from '../../../shared/app/appConfig';
import { defaultLocalSpeechExtensionSettings } from '../../../shared/speech/localSpeechExtensionSettings';
import { registerDefaultModelHandlers } from '../cowork/defaultModel';
import { registerStoreHandlers } from './store';

describe('store IPC', () => {
  const set = vi.fn();
  const get = vi.fn();
  const remove = vi.fn();
  const onAppConfigChanged = vi.fn();
  const refreshBuiltinModels = vi.fn();

  beforeEach(() => {
    handlers.clear();
    set.mockReset();
    get.mockReset();
    remove.mockReset();
    onAppConfigChanged.mockReset();
    refreshBuiltinModels.mockReset();
    registerStoreHandlers({
      getStore: () => ({ set, get, delete: remove }) as never,
      onAppConfigChanged,
      refreshBuiltinModels,
    });
  });

  it('merges each extension model independently without replacing voice settings', async () => {
    let config: Record<string, unknown> = {
      voice: { inputEnabled: false, ttsModelId: 'voice-model' },
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    const save = handlers.get(AppConfigIpc.Patch)!;

    await Promise.all([
      save({}, { localSpeechExtensions: { sttModelId: 'sherpa-onnx-whisper-base' } }),
      save({}, { localSpeechExtensions: { ttsModelId: 'vits-icefall-zh-aishell3' } }),
    ]);

    expect(config).toEqual({
      voice: { inputEnabled: false, ttsModelId: 'voice-model' },
      localSpeechExtensions: {
        ...defaultLocalSpeechExtensionSettings,
        sttModelId: 'sherpa-onnx-whisper-base',
        ttsModelId: 'vits-icefall-zh-aishell3',
        ttsVoiceId: 0,
      },
    });
  });

  it('merges a plugin voice independently from STT and reply-reading preferences', async () => {
    let config: Record<string, unknown> = {
      voice: { ttsModelId: 'kokoro-int8-multi-lang-v1_1', voiceId: 4, outputEnabled: false },
      localSpeechExtensions: {
        sttModelId: 'sherpa-onnx-whisper-base',
        ttsModelId: 'vits-icefall-zh-aishell3',
        ttsVoiceId: 0,
      },
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    const save = handlers.get(AppConfigIpc.Patch)!;

    await save({}, { localSpeechExtensions: { ttsVoiceId: 173 } });
    await save(
      {},
      {
        localSpeechExtensions: {
          sttModelId: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
        },
      },
    );

    expect(config.voice).toEqual({
      ttsModelId: 'kokoro-int8-multi-lang-v1_1',
      voiceId: 4,
      outputEnabled: false,
    });
    expect(config.localSpeechExtensions).toMatchObject({
      ttsModelId: 'vits-icefall-zh-aishell3',
      ttsVoiceId: 173,
    });
  });

  it('resets a model-only change and validates an explicit voice against the new model atomically', async () => {
    let config: Record<string, unknown> = {
      localSpeechExtensions: { ttsModelId: 'kokoro-int8-multi-lang-v1_1', ttsVoiceId: 102 },
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    const save = handlers.get(AppConfigIpc.Patch)!;

    await save(
      {},
      { localSpeechExtensions: { ttsModelId: 'vits-piper-en_US-lessac-medium-int8' } },
    );
    expect(config.localSpeechExtensions).toMatchObject({
      ttsModelId: 'vits-piper-en_US-lessac-medium-int8',
      ttsVoiceId: 0,
    });
    set.mockClear();
    onAppConfigChanged.mockClear();
    await expect(save({}, { localSpeechExtensions: { ttsVoiceId: 1 } })).rejects.toThrow();
    await expect(
      save(
        {},
        { localSpeechExtensions: { ttsModelId: 'kokoro-int8-multi-lang-v1_1', ttsVoiceId: 103 } },
      ),
    ).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
    expect(onAppConfigChanged).not.toHaveBeenCalled();
    expect(config.localSpeechExtensions).toMatchObject({
      ttsModelId: 'vits-piper-en_US-lessac-medium-int8',
      ttsVoiceId: 0,
    });
  });

  it('rejects untrusted extension model fields before writing or applying config', async () => {
    await expect(
      handlers.get(AppConfigIpc.Patch)!(
        {},
        {
          localSpeechExtensions: { ttsModelId: 'untrusted.exe', enabled: true },
        },
      ),
    ).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
    expect(onAppConfigChanged).not.toHaveBeenCalled();
  });

  const speechCatalog = {
    providers: {
      internal: {
        displayName: 'Speech',
        baseUrl: 'https://speech.internal/v1',
        apiKey: '',
        models: [{ id: 'speech', name: 'Speech', voices: [{ id: 'v1', name: 'Voice' }] }],
      },
    },
  };

  it('validates online plugin routes against the merged catalog without changing voice-page preferences', async () => {
    let config: Record<string, unknown> = {
      voice: { onlineTtsModelRef: 'other/reply', onlineTtsVoice: 'reply' },
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    await handlers.get(AppConfigIpc.Patch)!(
      {},
      {
        onlineModelProviders: {
          'speech-synthesis': speechCatalog,
          'speech-recognition': speechCatalog,
        },
        localSpeechExtensions: {
          ttsMode: 'online',
          onlineTtsModelRef: 'internal/speech',
          onlineTtsVoice: 'v1',
          sttMode: 'online',
          onlineSttModelRef: 'internal/speech',
        },
      },
    );
    expect(config.localSpeechExtensions).toMatchObject({
      ttsMode: 'online',
      onlineTtsModelRef: 'internal/speech',
      onlineTtsVoice: 'v1',
      sttMode: 'online',
      onlineSttModelRef: 'internal/speech',
    });
    await handlers.get(AppConfigIpc.Patch)!({}, { localSpeechExtensions: { sttMode: 'local' } });
    expect(config.localSpeechExtensions).toMatchObject({
      ttsMode: 'online',
      onlineTtsVoice: 'v1',
      sttMode: 'local',
    });
    set.mockClear();
    await expect(
      handlers.get(AppConfigIpc.Patch)!(
        {},
        { localSpeechExtensions: { onlineTtsVoice: 'not-configured' } },
      ),
    ).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it('clears deleted speech model references while preserving online mode, including simultaneous unrelated plugin patches', async () => {
    let config: Record<string, unknown> = {
      onlineModelProviders: {
        'speech-synthesis': speechCatalog,
        'speech-recognition': speechCatalog,
      },
      localSpeechExtensions: {
        ...defaultLocalSpeechExtensionSettings,
        sttMode: 'online',
        onlineSttModelRef: 'internal/speech',
        ttsMode: 'online',
        onlineTtsModelRef: 'internal/speech',
        onlineTtsVoice: 'v1',
      },
      voice: {
        synthesisMode: 'online',
        recognitionMode: 'online',
        onlineAsrModelRef: 'internal/speech',
        onlineTtsModelRef: 'internal/speech',
        onlineTtsVoice: 'v1',
      },
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    await handlers.get(AppConfigIpc.Patch)!(
      {},
      {
        onlineModelProviders: {
          'speech-synthesis': { providers: {} },
          'speech-recognition': { providers: {} },
        },
        localSpeechExtensions: { ttsVoiceId: 102 },
      },
    );
    expect(config.localSpeechExtensions).toMatchObject({
      sttMode: 'online',
      onlineSttModelRef: '',
      ttsMode: 'online',
      onlineTtsModelRef: '',
      onlineTtsVoice: '',
      ttsVoiceId: 102,
    });
    expect(config.voice).toMatchObject({
      synthesisMode: 'online',
      recognitionMode: 'online',
      onlineAsrModelRef: '',
      onlineTtsModelRef: '',
      onlineTtsVoice: '',
    });
  });

  it('keeps stable references through display-name changes but rejects websocket-only file transcription selection', async () => {
    get.mockReturnValue({
      onlineModelProviders: { 'speech-recognition': speechCatalog },
      localSpeechExtensions: {
        ...defaultLocalSpeechExtensionSettings,
        sttMode: 'online',
        onlineSttModelRef: 'internal/speech',
      },
    });
    await handlers.get(AppConfigIpc.Patch)!(
      {},
      {
        onlineModelProviders: {
          'speech-recognition': {
            providers: {
              internal: { ...speechCatalog.providers.internal, displayName: 'Renamed' },
            },
          },
        },
      },
    );
    expect(set).toHaveBeenCalledWith(
      'app_config',
      expect.objectContaining({
        localSpeechExtensions: expect.objectContaining({ onlineSttModelRef: 'internal/speech' }),
      }),
    );
    set.mockClear();
    await expect(
      handlers.get(AppConfigIpc.Patch)!(
        {},
        {
          onlineModelProviders: {
            'speech-recognition': {
              providers: {
                internal: {
                  ...speechCatalog.providers.internal,
                  baseUrl: 'wss://speech.internal/realtime',
                },
              },
            },
          },
          localSpeechExtensions: { sttMode: 'online', onlineSttModelRef: 'internal/speech' },
        },
      ),
    ).rejects.toThrow('HTTP');
    expect(set).not.toHaveBeenCalled();
  });

  it('waits for the persisted app config to be applied', async () => {
    let resolveApplication: (() => void) | undefined;
    onAppConfigChanged.mockReturnValue(
      new Promise<void>(resolve => {
        resolveApplication = resolve;
      }),
    );
    const config = { providers: { custom_0: { enabled: true } } };

    const result = handlers.get('store:set')?.({}, 'app_config', config) as Promise<void>;
    await Promise.resolve();

    expect(set).toHaveBeenCalledWith('app_config', config);
    expect(onAppConfigChanged).toHaveBeenCalledWith(config, undefined);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    resolveApplication?.();
    await expect(result).resolves.toBeUndefined();
  });

  it('keeps the refreshed built-in catalog when a stale settings draft is saved', async () => {
    const latestBuiltin = {
      enabled: true,
      baseUrl: 'https://current.test/v1',
      models: [
        { id: 'kept', name: 'Updated name', enabled: true },
        { id: 'new', name: 'New', enabled: true },
      ],
    };
    get.mockReturnValue({
      providers: { builtin_models: latestBuiltin },
      model: { defaultModel: 'new' },
    });

    await handlers.get(AppConfigIpc.Patch)?.(
      {},
      {
        providers: {
          builtin_models: {
            models: [
              { id: 'retired', enabled: true },
              { id: 'kept', enabled: false },
            ],
          },
          custom: { enabled: true },
        },
      },
    );

    expect(set).toHaveBeenCalledWith('app_config', {
      model: { defaultModel: 'new' },
      providers: {
        custom: { enabled: true },
        builtin_models: {
          ...latestBuiltin,
          models: [
            { id: 'kept', name: 'Updated name', enabled: false },
            { id: 'new', name: 'New', enabled: true },
          ],
        },
      },
    });
  });

  it('does not restore a logged-out built-in provider from a stale settings draft', async () => {
    get.mockReturnValue({ providers: {} });
    await handlers.get(AppConfigIpc.Patch)?.(
      {},
      { providers: { builtin_models: { enabled: true, models: [{ id: 'old' }] } } },
    );
    expect(set).toHaveBeenCalledWith('app_config', { providers: {} });
  });

  it('rolls back app config and rejects when runtime application fails', async () => {
    const error = new Error('reload failed');
    const previous = { providers: { custom_0: { displayName: 'Previous' } } };
    get.mockReturnValue(previous);
    onAppConfigChanged.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

    const result = handlers.get('store:set')?.({}, 'app_config', {}) as Promise<void>;

    await expect(result).rejects.toThrow('reload failed');
    expect(set).toHaveBeenNthCalledWith(1, 'app_config', {});
    expect(set).toHaveBeenNthCalledWith(2, 'app_config', previous);
    expect(onAppConfigChanged).toHaveBeenNthCalledWith(1, {}, previous);
    expect(onAppConfigChanged).toHaveBeenNthCalledWith(2, previous, {}, { rollback: true });
  });

  it('removes a newly-created app config when its runtime application fails', async () => {
    get.mockReturnValue(undefined);
    onAppConfigChanged.mockRejectedValueOnce(new Error('invalid config'));
    onAppConfigChanged.mockResolvedValueOnce(undefined);

    const result = handlers.get('store:set')?.({}, 'app_config', {}) as Promise<void>;

    await expect(result).rejects.toThrow('invalid config');
    expect(remove).toHaveBeenCalledWith('app_config');
    expect(onAppConfigChanged).toHaveBeenNthCalledWith(2, undefined, {}, { rollback: true });
  });

  it.each(['store:set', AppConfigIpc.Patch])(
    'waits for failed %s application and rollback before exposing config to the renderer',
    async channel => {
      const previous = { model: { defaultModel: 'confirmed' } };
      const proposed = { model: { defaultModel: 'rejected' } };
      let config = previous;
      get.mockImplementation(key => (key === 'app_config' ? config : 'unrelated'));
      set.mockImplementation((_key, value) => {
        config = value;
      });
      let rejectApplication!: (error: Error) => void;
      let finishRollback!: () => void;
      onAppConfigChanged
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectApplication = reject;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>(resolve => {
              finishRollback = resolve;
            }),
        );

      const writing = (
        channel === 'store:set'
          ? handlers.get(channel)!({}, 'app_config', proposed)
          : handlers.get(channel)!({}, proposed)
      ) as Promise<void>;
      const writeRejected = expect(writing).rejects.toThrow('reload failed');
      await vi.waitFor(() => expect(config).toEqual(proposed));
      let readSettled = false;
      const reading = (handlers.get('store:get')!({}, 'app_config') as Promise<unknown>).then(
        value => {
          readSettled = true;
          return value;
        },
      );
      await Promise.resolve();
      expect(readSettled).toBe(false);
      expect(handlers.get('store:get')!({}, 'other')).toBe('unrelated');

      rejectApplication(new Error('reload failed'));
      await vi.waitFor(() => expect(onAppConfigChanged).toHaveBeenCalledTimes(2));
      expect(config).toEqual(previous);
      expect(readSettled).toBe(false);
      finishRollback();
      await writeRejected;
      await expect(reading).resolves.toEqual(previous);
    },
  );

  it('finishes a failed write rollback before applying the next renderer update', async () => {
    onAppConfigChanged
      .mockRejectedValueOnce(new Error('first rejected'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const first = { providers: { custom_0: { displayName: 'First' } } };
    const second = { providers: { custom_0: { displayName: 'Second' } } };

    const firstResult = handlers.get('store:set')?.({}, 'app_config', first) as Promise<void>;
    const secondResult = handlers.get('store:set')?.({}, 'app_config', second) as Promise<void>;
    await Promise.resolve();

    expect(set).toHaveBeenCalledTimes(1);
    await expect(firstResult).rejects.toThrow('first rejected');
    await secondResult;
    expect(set).toHaveBeenNthCalledWith(2, 'app_config', second);
    expect(remove).toHaveBeenCalledWith('app_config');
    expect(onAppConfigChanged).toHaveBeenCalledTimes(3);
  });

  it('does not synchronize OpenClaw for unrelated store keys', async () => {
    await handlers.get('store:set')?.({}, 'prevent_sleep_enabled', true);

    expect(set).toHaveBeenCalledWith('prevent_sleep_enabled', true);
    expect(onAppConfigChanged).not.toHaveBeenCalled();
  });

  it('merges settings after an in-flight model selection without restoring the old default', async () => {
    const providers = {
      p: {
        enabled: true,
        baseUrl: 'https://provider.test/v1',
        apiKey: 'test-key',
        models: [{ id: 'selected' }],
      },
    };
    let config = {
      model: { defaultModel: 'old', defaultModelProvider: 'p' },
      theme: 'light',
      providers,
    };
    get.mockImplementation(() => config);
    set.mockImplementation((_key, value) => {
      config = value;
    });
    let release!: () => void;
    const sync = vi.fn(
      () =>
        new Promise<{ success: boolean }>(resolve => {
          release = () => resolve({ success: true });
        }),
    );
    registerDefaultModelHandlers({
      getStore: () => ({ get, set }) as never,
      getCoworkStore: () => ({ getAgent: () => ({ model: '' }) }) as never,
      syncOpenClawConfig: sync,
    });
    const selecting = handlers.get('config:setDefaultModel')!(
      {},
      { modelId: 'selected', providerKey: 'p' },
    );
    await Promise.resolve();
    const saving = handlers.get(AppConfigIpc.Patch)!({}, { theme: 'dark' });
    release();
    await selecting;
    await saving;
    expect(config).toEqual({
      model: { defaultModel: 'selected', defaultModelProvider: 'p' },
      theme: 'dark',
      providers,
    });
  });

  it('renames the current default provider atomically without replacing its model', async () => {
    const previous = {
      providers: { old: { identity: 'stable', displayName: 'Old' } },
      model: { defaultModelProvider: 'old', defaultModel: 'latest' },
    };
    get.mockReturnValue(previous);
    await handlers.get(AppConfigIpc.Patch)!(
      {},
      {
        providers: { renamed: { identity: 'stable', displayName: 'Renamed' } },
      },
    );
    expect(set).toHaveBeenCalledWith(
      'app_config',
      expect.objectContaining({
        model: { defaultModelProvider: 'renamed', defaultModel: 'latest' },
      }),
    );
  });
});
