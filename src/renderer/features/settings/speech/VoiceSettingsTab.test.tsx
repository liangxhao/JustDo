// @vitest-environment jsdom

import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import {
  defaultLocalSpeechSettings,
  type LocalSpeechSettings,
} from '@shared/speech/localSpeechSettings';
import { LOCAL_TTS_MODEL_ID, type LocalTtsModelId } from '@shared/speech/localTts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import VoiceSettingsTab from './VoiceSettingsTab';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { onlineModelProviders: {} } as {
    onlineModelProviders: Record<string, unknown>;
    voice?: LocalSpeechSettings;
  },
}));

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => ({ ...mockConfig }),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VoiceSettingsTab', () => {
  beforeEach(() => {
    mockConfig.onlineModelProviders = {};
    mockConfig.voice = defaultLocalSpeechSettings;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 132,
      height: 36,
      left: 24,
      right: 280,
      top: 96,
      width: 256,
      x: 24,
      y: 96,
      toJSON: () => ({}),
    });
  });

  const installOnlineBridges = () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => {}),
        },
        onlineAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
        onlineTts: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      },
    });
  };

  it('shows no interface row or selector before a model is selected, including realtime voice', async () => {
    installOnlineBridges();
    const onChange = vi.fn();
    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'online',
          outputEnabled: true,
          synthesisMode: 'online',
          realtimeEnabled: true,
        }}
        onChange={onChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByRole('combobox', { name: i18nService.t('speechProtocolType') }),
    ).toBeNull();
    for (const id of [
      'voice-online-asr-binding',
      'voice-online-tts-binding',
      'voice-realtime-binding',
    ])
      expect(document.getElementById(id)).toBeNull();
    expect(screen.queryByText(i18nService.t('speechConfigureInterfaceInModels'))).toBeNull();
    expect(screen.queryByText(/当前接口：/)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps saved legacy interfaces read-only and preserves their IDs and voices when reselecting the same model', async () => {
    installOnlineBridges();
    const provider = (bindings: unknown[]) => ({
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      models: [{ id: 'one', name: 'one', voices: [{ id: 'calm', name: 'Calm' }], bindings }],
    });
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: provider([
            { id: 'recorded', protocolId: 'openai-transcription-http' },
            { id: 'saved-live', protocolId: 'openai-transcription-realtime' },
          ]),
        },
      },
      'speech-synthesis': {
        providers: { office: provider([{ id: 'saved-speech', protocolId: 'openai-speech-http' }]) },
      },
      'realtime-voice': {
        providers: {
          office: provider([
            {
              id: 'saved-call',
              protocolId: 'openai-voice-realtime',
              inputTranscriptionModel: 'custom/input',
            },
          ]),
        },
      },
    };
    const value: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      recognitionMode: 'online',
      onlineAsrModelRef: 'office/one',
      onlineAsrBindingId: 'saved-live',
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'office/one',
      onlineTtsBindingId: 'saved-speech',
      onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'calm' },
      realtimeEnabled: true,
      realtimeModelRef: 'office/one',
      realtimeBindingId: 'saved-call',
      realtimeVoiceSelection: { kind: 'preset', voiceId: 'calm' },
    };
    const onChange = vi.fn();
    render(<VoiceSettingsTab value={value} onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
    });
    for (const key of [
      'speechProtocolRealtimeTranscription',
      'speechProtocolSynthesis',
      'speechProtocolRealtimeVoice',
    ])
      expect(
        screen.getByText(
          i18nService.t('speechCurrentProtocol').replace('{protocol}', i18nService.t(key)),
        ),
      ).toBeTruthy();
    expect(
      screen.queryByRole('combobox', { name: i18nService.t('speechProtocolType') }),
    ).toBeNull();
    for (const key of ['voiceRecognitionModel', 'voiceSynthesisModel', 'realtimeVoiceModel']) {
      fireEvent.click(screen.getByRole('combobox', { name: i18nService.t(key) }));
      fireEvent.click(screen.getByRole('option', { name: 'Office / one' }));
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not repair unknown saved IDs by reselecting the same inherited model', async () => {
    installOnlineBridges();
    const provider = (protocolId: string) => ({
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      protocolId,
      models: [
        {
          id: 'one',
          name: 'one',
          inputTranscriptionModel:
            protocolId === 'openai-voice-realtime' ? 'custom/input' : undefined,
          voices: [{ id: 'calm', name: 'Calm' }],
        },
      ],
    });
    mockConfig.onlineModelProviders = {
      'speech-recognition': { providers: { office: provider('openai-transcription-http') } },
      'speech-synthesis': { providers: { office: provider('openai-speech-http') } },
      'realtime-voice': { providers: { office: provider('openai-voice-realtime') } },
    };
    const onChange = vi.fn();
    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'online',
          onlineAsrModelRef: 'office/one',
          onlineAsrBindingId: 'deleted',
          outputEnabled: true,
          synthesisMode: 'online',
          onlineTtsModelRef: 'office/one',
          onlineTtsBindingId: 'deleted',
          realtimeEnabled: true,
          realtimeModelRef: 'office/one',
          realtimeBindingId: 'deleted',
        }}
        onChange={onChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByText(i18nService.t('speechConfigureInterfaceInModels'))).toHaveLength(3);
    for (const key of ['voiceRecognitionModel', 'voiceSynthesisModel', 'realtimeVoiceModel']) {
      fireEvent.click(screen.getByRole('combobox', { name: i18nService.t(key) }));
      fireEvent.click(screen.getByRole('option', { name: 'Office / one' }));
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('requires model settings after changing to a legacy model even when it has only one explicit interface', async () => {
    installOnlineBridges();
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: ['one', 'two'].map(id => ({
              id,
              name: id,
              bindings: [{ id: 'saved-recording', protocolId: 'openai-transcription-http' }],
            })),
          },
        },
      },
    };
    const onChange = vi.fn();
    const onManageModels = vi.fn();
    const value: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      recognitionMode: 'online',
      onlineAsrModelRef: 'office/one',
      onlineAsrBindingId: 'saved-recording',
    };
    const view = render(
      <VoiceSettingsTab value={value} onChange={onChange} onManageModels={onManageModels} />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceRecognitionModel') }));
    fireEvent.click(screen.getByRole('option', { name: 'Office / two' }));
    const next = onChange.mock.lastCall![0] as LocalSpeechSettings;
    expect(next).toMatchObject({ onlineAsrModelRef: 'office/two', onlineAsrBindingId: '' });
    view.rerender(
      <VoiceSettingsTab value={next} onChange={onChange} onManageModels={onManageModels} />,
    );
    expect(screen.getByText(i18nService.t('speechConfigureInterfaceInModels'))).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: i18nService.t('speechManageModels') })[0],
    );
    expect(onManageModels).toHaveBeenCalled();
  });

  it('inherits each provider protocol and keeps purpose model choices independent', async () => {
    const provider = (protocolId: string, inputTranscriptionModel?: string) => ({
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      protocolId,
      models: ['one', 'two'].map(id => ({
        id,
        name: id,
        voices: [{ id: 'calm', name: 'Calm' }],
        ...(inputTranscriptionModel ? { inputTranscriptionModel } : {}),
      })),
    });
    mockConfig.onlineModelProviders = {
      'speech-recognition': { providers: { office: provider('openai-transcription-http') } },
      'speech-synthesis': { providers: { office: provider('openai-speech-http') } },
      'realtime-voice': { providers: { office: provider('openai-voice-realtime', 'input-stt') } },
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => {}),
        },
        onlineAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
        onlineTts: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      },
    });
    const value: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      recognitionMode: 'online',
      onlineAsrModelRef: 'office/one',
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'office/one',
      onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'calm' },
      realtimeEnabled: true,
      realtimeModelRef: 'office/one',
      realtimeVoiceSelection: { kind: 'preset', voiceId: 'calm' },
    };
    const onChange = vi.fn();
    render(<VoiceSettingsTab value={value} onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
    });
    for (const id of [
      'voice-online-asr-binding',
      'voice-online-tts-binding',
      'voice-realtime-binding',
    ])
      expect(document.getElementById(id)).toBeNull();
    for (const key of [
      'speechProtocolRecorded',
      'speechProtocolSynthesis',
      'speechProtocolRealtimeVoice',
    ])
      expect(
        screen.getByText(
          i18nService.t('speechCurrentProtocol').replace('{protocol}', i18nService.t(key)),
        ),
      ).toBeTruthy();
    for (const [label, modelKey, bindingKey] of [
      ['voiceRecognitionModel', 'onlineAsrModelRef', 'onlineAsrBindingId'],
      ['voiceSynthesisModel', 'onlineTtsModelRef', 'onlineTtsBindingId'],
      ['realtimeVoiceModel', 'realtimeModelRef', 'realtimeBindingId'],
    ]) {
      fireEvent.click(screen.getByRole('combobox', { name: i18nService.t(label) }));
      fireEvent.click(screen.getByRole('option', { name: 'Office / two' }));
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          [modelKey]: 'office/two',
          [bindingKey]: 'provider',
          asrModelId: value.asrModelId,
          ttsModelId: value.ttsModelId,
          voiceId: value.voiceId,
        }),
      );
    }
  });

  it('does not offer legacy bindings when the selected provider protocol is invalid', async () => {
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'invalid',
            models: [
              {
                id: 'asr',
                name: 'ASR',
                bindings: [{ id: 'old', protocolId: 'openai-transcription-http' }],
              },
            ],
          },
        },
      },
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => {}),
        },
        onlineAsr: { getStatus: vi.fn().mockResolvedValue({ available: false }) },
      },
    });
    const onChange = vi.fn();
    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'online',
          onlineAsrModelRef: 'office/asr',
          onlineAsrBindingId: 'old',
        }}
        onChange={onChange}
      />,
    );
    expect(document.getElementById('voice-online-asr-binding')).toBeNull();
    expect(screen.getByText(i18nService.t('speechConfigureInterfaceInModels'))).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('retains offline Japanese and Korean choices when a retired online interface is remembered', async () => {
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [
              {
                id: 'recognizer',
                name: 'Recognizer',
                bindings: [
                  {
                    id: 'chat',
                    protocolId: 'chat-audio-transcription',
                    compatibilityProfile: 'retired-profile',
                  },
                ],
              },
            ],
          },
        },
      },
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'local',
          onlineAsrModelRef: 'office/recognizer',
          onlineAsrBindingId: 'chat',
        }}
        onChange={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole('combobox', { name: i18nService.t('voiceRecognitionLanguage') }),
    );
    expect(screen.getByRole('option', { name: i18nService.t('japanese') })).toBeTruthy();
    expect(screen.getByRole('option', { name: i18nService.t('korean') })).toBeTruthy();
  });

  it('keeps a retired voice selection unavailable until a preset is explicitly selected', async () => {
    mockConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'openai-speech-http',
            models: [
              { id: 'reader', name: 'Reader', voices: [{ id: 'voice-one', name: 'Voice One' }] },
            ],
          },
        },
      },
    };
    const saveConfiguration = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineTts: {
          getStatus: vi.fn().mockResolvedValue({ available: false }),
          saveConfiguration,
        },
      },
    });
    const onChange = vi.fn();
    const value: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'office/reader',
      onlineTtsBindingId: 'provider',
      onlineTtsVoice: 'voice-one',
      onlineTtsVoiceSelection: {
        kind: 'service-default',
      } as unknown as LocalSpeechSettings['onlineTtsVoiceSelection'],
    };
    mockConfig.voice = value;
    render(<VoiceSettingsTab value={value} onChange={onChange} />);
    expect(screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }).textContent).toBe(
      i18nService.t('speechOnlineVoiceUnavailable'),
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }));
    fireEvent.click(screen.getByRole('option', { name: 'Voice One' }));
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      onlineTtsVoice: 'voice-one',
      onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'voice-one' },
    });
    expect(saveConfiguration).not.toHaveBeenCalled();
  });

  it('does not replace a retired realtime voice selection with a catalog voice', async () => {
    mockConfig.onlineModelProviders = {
      'realtime-voice': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            protocolId: 'openai-voice-realtime',
            models: [
              {
                id: 'call',
                name: 'Call',
                inputTranscriptionModel: 'internal/stt',
                voices: [{ id: 'calm', name: 'Calm' }],
              },
            ],
          },
        },
      },
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: false, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    const onChange = vi.fn();
    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          realtimeEnabled: true,
          realtimeModelRef: 'office/call',
          realtimeBindingId: 'provider',
          realtimeVoiceSelection: {
            kind: 'service-default',
          } as unknown as LocalSpeechSettings['realtimeVoiceSelection'],
        }}
        onChange={onChange}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByRole('combobox', { name: i18nService.t('realtimeVoiceSpeaker') }).textContent,
    ).toBe(i18nService.t('speechOnlineVoiceUnavailable'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows local model status and exposes both feature switches', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({
            supported: true,
            models: [
              {
                id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
                kind: 'asr',
                phase: 'ready',
                installed: true,
              },
              {
                id: 'kokoro-int8-multi-lang-v1_1',
                kind: 'tts',
                phase: 'ready',
                installed: true,
              },
            ],
          }),
          install: vi.fn(),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    const onChange = vi.fn();

    render(<VoiceSettingsTab value={defaultLocalSpeechSettings} onChange={onChange} />);

    expect(await screen.findAllByText(i18nService.t('voiceModelReady'))).toHaveLength(2);
    fireEvent.click(screen.getByRole('switch', { name: i18nService.t('voiceInputEnabled') }));
    expect(onChange).toHaveBeenCalledWith({
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
    });
    expect(screen.getByRole('switch', { name: i18nService.t('voiceOutputEnabled') })).toBeTruthy();
  });

  it('opens the matching built-in model catalogs without downloading or changing preferences', async () => {
    const install = vi.fn();
    const remove = vi.fn();
    const onChange = vi.fn();
    const onManageModels = vi.fn();
    const saveConfiguration = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({
            supported: true,
            models: [
              {
                id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
                kind: 'asr',
                phase: 'not-installed',
                installed: false,
              },
              {
                id: 'kokoro-int8-multi-lang-v1_1',
                kind: 'tts',
                phase: 'ready',
                installed: true,
              },
            ],
          }),
          install,
          remove,
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: false }),
          saveConfiguration,
        },
        onlineTts: {
          getStatus: vi.fn().mockResolvedValue({ available: false }),
          saveConfiguration,
        },
      },
    });

    const { rerender } = render(
      <VoiceSettingsTab
        value={defaultLocalSpeechSettings}
        onChange={onChange}
        onManageModels={onManageModels}
      />,
    );
    await screen.findByText(i18nService.t('voiceModelNotInstalled'));
    const links = screen.getAllByRole('button', { name: i18nService.t('speechManageModels') });
    fireEvent.click(links[0]);
    fireEvent.click(links[1]);
    expect(onManageModels.mock.calls).toEqual([['asr'], ['tts']]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelRemove') })).toBeNull();
    rerender(
      <VoiceSettingsTab
        value={{ ...defaultLocalSpeechSettings, inputEnabled: true, outputEnabled: true }}
        onChange={onChange}
        onManageModels={onManageModels}
      />,
    );
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelRemove') })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceRecognitionModel') }));
    fireEvent.click(
      screen.getByRole('option', { name: i18nService.t('voiceAsrModelWhisperBase') }),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      outputEnabled: true,
      asrModelId: 'sherpa-onnx-whisper-base',
    });
    expect(install).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    rerender(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          recognitionMode: 'online',
          synthesisMode: 'online',
        }}
        onChange={onChange}
        onManageModels={onManageModels}
      />,
    );
    await screen.findAllByText(i18nService.t('voiceOnlineUnavailable'));
    const onlineLinks = screen.getAllByRole('button', {
      name: i18nService.t('speechManageModels'),
    });
    fireEvent.click(onlineLinks[0]);
    fireEvent.click(onlineLinks[1]);
    expect(onManageModels.mock.calls).toEqual([
      ['asr'],
      ['tts'],
      ['asr', { source: 'online', providerId: undefined }],
      ['tts', { source: 'online', providerId: undefined }],
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(saveConfiguration).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('selects an online recognition model from the user provider catalog', async () => {
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office speech',
            baseUrl: 'http://10.0.0.8:8000/v1',
            apiKey: '',
            models: [
              { id: 'whisper-large', name: 'Whisper Large' },
              { id: 'sense-voice', name: 'SenseVoice' },
            ],
          },
        },
      },
    };
    const saveConfiguration = vi.fn().mockResolvedValue({ success: true });
    const onChange = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          install: vi.fn(),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: true, provider: 'openai' }),
          saveConfiguration,
        },
      },
    });

    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'online',
        }}
        onChange={onChange}
      />,
    );

    expect(await screen.findByText(i18nService.t('voiceOnlineUnavailable'))).toBeTruthy();
    const selector = screen.getByRole('combobox', {
      name: i18nService.t('voiceRecognitionModel'),
    });
    expect(selector.textContent).toContain(i18nService.t('voiceSelectModel'));
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole('option', { name: 'Office speech / SenseVoice' }));

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        ...defaultLocalSpeechSettings,
        inputEnabled: true,
        recognitionMode: 'online',
        onlineAsrModelRef: 'office/sense-voice',
      });
      expect(saveConfiguration).not.toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
  });

  it.each([
    [LOCAL_TTS_MODEL_ID, 103, 102, 'zm_100'],
    ['vits-icefall-zh-aishell3', 174, 173, 'SSB1956'],
    ['vits-piper-en_US-lessac-medium-int8', 1, 0, 'Lessac'],
  ] as const)(
    'offers every voice for %s using its native identity',
    async (ttsModelId, count, voiceId, name) => {
      const install = vi.fn();
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          localSpeechModels: {
            list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
            install,
            onChanged: vi.fn().mockReturnValue(() => undefined),
          },
        },
      });
      const onChange = vi.fn();
      const value = { ...defaultLocalSpeechSettings, outputEnabled: true, ttsModelId };
      render(<VoiceSettingsTab value={value} onChange={onChange} />);
      await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));

      fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }));
      expect(screen.getAllByRole('option')).toHaveLength(count);
      fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));

      expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, voiceId });
      expect(install).not.toHaveBeenCalled();
    },
  );

  it('offers a Kokoro voice outside the former shortcuts without changing other voice preferences', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    const onChange = vi.fn();
    const value = { ...defaultLocalSpeechSettings, outputEnabled: true };
    render(<VoiceSettingsTab value={value} onChange={onChange} />);
    await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));

    fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }));
    fireEvent.click(screen.getByRole('option', { name: /zf_004/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, voiceId: 6 });
  });

  it.each([
    ['vits-piper-en_US-lessac-medium-int8', 'voiceTtsModelPiperEnglish', 0],
    ['vits-icefall-zh-aishell3', 'voiceTtsModelAishell3', 0],
    [LOCAL_TTS_MODEL_ID, 'voiceTtsModelKokoro', 3],
  ] as const)(
    'resets to the default voice when switching to %s',
    async (ttsModelId, labelKey, voiceId) => {
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          localSpeechModels: {
            list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
            onChanged: vi.fn().mockReturnValue(() => undefined),
          },
        },
      });
      const onChange = vi.fn();
      const value = {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        ttsModelId: (ttsModelId === 'vits-icefall-zh-aishell3'
          ? LOCAL_TTS_MODEL_ID
          : 'vits-icefall-zh-aishell3') as LocalTtsModelId,
        voiceId: ttsModelId === 'vits-icefall-zh-aishell3' ? 102 : 173,
      };
      render(<VoiceSettingsTab value={value} onChange={onChange} />);
      await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));

      fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceSynthesisModel') }));
      fireEvent.click(screen.getByRole('option', { name: i18nService.t(labelKey) }));
      expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...value, ttsModelId, voiceId });
    },
  );

  it('keeps the selected Kokoro voice when the current model is selected again', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    const onChange = vi.fn();
    render(
      <VoiceSettingsTab
        value={{ ...defaultLocalSpeechSettings, outputEnabled: true, voiceId: 102 }}
        onChange={onChange}
      />,
    );
    await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));

    fireEvent.click(screen.getByRole('combobox', { name: i18nService.t('voiceSynthesisModel') }));
    fireEvent.click(screen.getByRole('option', { name: i18nService.t('voiceTtsModelKokoro') }));
    expect(
      screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }).textContent,
    ).toContain('zm_100');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps online synthesis model and voice selection in the draft without changing the runtime', async () => {
    mockConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          'lan-tts': {
            displayName: 'LAN voice',
            baseUrl: 'http://speech.local/v1/audio/speech',
            apiKey: 'secret',
            models: [
              {
                id: 'voice-small',
                name: 'Voice Small',
                voices: [
                  { id: 'voice-one', name: 'Voice One' },
                  { id: 'voice-two', name: 'Voice Two' },
                ],
              },
              {
                id: 'voice-hq',
                name: 'Voice HQ',
                voices: [
                  { id: 'voice-three', name: 'Voice Three' },
                  { id: 'voice-four', name: 'Voice Four' },
                ],
              },
              { id: 'voice-unconfigured', name: 'Voice Missing' },
            ],
          },
        },
      },
    };
    const saveConfiguration = vi.fn().mockResolvedValue({ success: true });
    const onChange = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          install: vi.fn(),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineTts: {
          getStatus: vi.fn().mockResolvedValue({ available: false }),
          saveConfiguration,
        },
      },
    });

    const { rerender } = render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          outputEnabled: true,
          synthesisMode: 'online',
        }}
        onChange={onChange}
      />,
    );

    expect(await screen.findByText(i18nService.t('voiceOnlineTtsUnavailable'))).toBeTruthy();
    const selector = screen.getByRole('combobox', {
      name: i18nService.t('voiceSynthesisModel'),
    });
    expect(selector.textContent).toContain(i18nService.t('voiceSelectModel'));
    fireEvent.click(selector);
    expect(screen.getByRole('option', { name: 'LAN voice / Voice Missing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'LAN voice / Voice Small' }));

    expect(onChange).toHaveBeenCalledWith({
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'lan-tts/voice-small',
      onlineTtsVoice: '',
    });
    expect(saveConfiguration).not.toHaveBeenCalled();

    rerender(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          outputEnabled: true,
          synthesisMode: 'online',
          onlineTtsModelRef: 'lan-tts/voice-small',
        }}
        onChange={onChange}
      />,
    );
    const speakerSelector = screen.getByRole('combobox', {
      name: i18nService.t('voiceSpeaker'),
    });
    expect(speakerSelector.textContent).toContain(i18nService.t('voiceSelectSpeaker'));
    fireEvent.click(speakerSelector);
    expect(screen.queryByRole('option', { name: 'Voice Three' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Voice Two' }));

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'online',
        onlineTtsModelRef: 'lan-tts/voice-small',
        onlineTtsVoice: 'voice-two',
        onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'voice-two' },
      });
      expect(saveConfiguration).not.toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
  });

  it('allows a configured synthesis model without voices to be selected and explains what is missing', async () => {
    mockConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'https://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'reader', name: 'Reader', voices: [] }],
          },
        },
      },
    };
    const saveConfiguration = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineTts: {
          getStatus: vi.fn().mockResolvedValue({ available: false }),
          saveConfiguration,
        },
      },
    });
    const value: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      synthesisMode: 'online',
    };
    const onChange = vi.fn();
    const view = render(<VoiceSettingsTab value={value} onChange={onChange} />);
    const selector = screen.getByRole('combobox', {
      name: i18nService.t('voiceSynthesisModel'),
    }) as HTMLButtonElement;
    expect(selector.disabled).toBe(false);
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole('option', { name: 'Office / Reader' }));
    const selected = { ...value, onlineTtsModelRef: 'office/reader', onlineTtsVoice: '' };
    expect(onChange).toHaveBeenCalledWith(selected);
    view.rerender(<VoiceSettingsTab value={selected} onChange={onChange} />);
    expect(
      screen.getByRole('combobox', { name: i18nService.t('voiceSynthesisModel') }).textContent,
    ).toContain('Office / Reader');
    expect(
      (screen.getByRole('combobox', { name: i18nService.t('voiceSpeaker') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(i18nService.t('voiceSelectedModelNeedsVoices'))).toBeTruthy();
    expect(saveConfiguration).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceOutputDiagnosticPlay'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('refreshes online synthesis after engine readiness and requires saving a changed voice before preview', async () => {
    const savedVoice: LocalSpeechSettings = {
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'office/reader',
      onlineTtsVoice: 'voice-a',
      onlineTtsVoiceSelection: { kind: 'preset' as const, voiceId: 'voice-a' },
    };
    mockConfig.voice = savedVoice;
    mockConfig.onlineModelProviders = {
      'speech-synthesis': {
        providers: {
          office: {
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [
              {
                id: 'reader',
                name: 'Reader',
                voices: [
                  { id: 'voice-a', name: 'A' },
                  { id: 'voice-b', name: 'B' },
                ],
              },
            ],
          },
        },
      },
    };
    let finishInitial!: (status: { available: boolean }) => void;
    const getStatus = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          }),
      )
      .mockResolvedValue({ available: true });
    let engineChanged!: (status: OpenClawEngineStatus) => void;
    const unsubscribe = vi.fn();
    const speak = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineTts: { getStatus },
        speechSynthesis: { speak },
        openclaw: {
          engine: {
            onProgress: vi.fn(callback => {
              engineChanged = callback;
              return unsubscribe;
            }),
          },
        },
      },
    });
    const onChange = vi.fn();
    const view = render(<VoiceSettingsTab value={savedVoice} onChange={onChange} />);
    const preview = () =>
      screen.getByRole('button', {
        name: i18nService.t('voiceOutputDiagnosticPlay'),
      }) as HTMLButtonElement;
    expect(preview().disabled).toBe(true);
    await act(async () =>
      engineChanged({ phase: EnginePhase.Running, canRetry: false, version: null }),
    );
    expect(preview().disabled).toBe(false);
    await act(async () => finishInitial({ available: false }));
    expect(preview().disabled).toBe(false);
    act(() => engineChanged({ phase: EnginePhase.Starting, canRetry: false, version: null }));
    expect(preview().disabled).toBe(true);
    await act(async () =>
      engineChanged({ phase: EnginePhase.Running, canRetry: false, version: null }),
    );

    const draftVoice = {
      ...savedVoice,
      onlineTtsVoice: 'voice-b',
      onlineTtsVoiceSelection: { kind: 'preset' as const, voiceId: 'voice-b' },
    };
    view.rerender(<VoiceSettingsTab value={draftVoice} onChange={onChange} />);
    expect(preview().disabled).toBe(true);
    expect(screen.getByText(i18nService.t('voiceOutputDiagnosticSaveFirst'))).toBeTruthy();
    fireEvent.click(preview());
    expect(speak).not.toHaveBeenCalled();
    mockConfig.voice = draftVoice;
    await act(async () => window.dispatchEvent(new Event('config-updated')));
    expect(preview().disabled).toBe(false);
    expect(screen.getByText(i18nService.t('voiceOnlineTtsReady'))).toBeTruthy();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps model selection in the draft even while Gateway configuration would fail', async () => {
    mockConfig.onlineModelProviders = {
      'speech-recognition': {
        providers: {
          office: {
            displayName: 'Office speech',
            baseUrl: 'http://speech.lan/v1',
            apiKey: 'key',
            models: [
              { id: 'model-a', name: 'Model A' },
              { id: 'model-b', name: 'Model B' },
            ],
          },
        },
      },
    };
    const onChange = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list: vi.fn().mockResolvedValue({ supported: true, models: [] }),
          install: vi.fn(),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: true }),
          saveConfiguration: vi.fn().mockRejectedValue(new Error('Gateway rejected config')),
        },
      },
    });

    render(
      <VoiceSettingsTab
        value={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          recognitionMode: 'online',
          onlineAsrModelRef: 'office/model-a',
        }}
        onChange={onChange}
      />,
    );
    const selector = screen.getByRole('combobox', {
      name: i18nService.t('voiceRecognitionModel'),
    });
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole('option', { name: 'Office speech / Model B' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlineAsrModelRef: 'office/model-b' }),
    );
    expect(window.electron.onlineAsr.saveConfiguration).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(selector.textContent).toContain('Office speech / Model A');
  });
});
