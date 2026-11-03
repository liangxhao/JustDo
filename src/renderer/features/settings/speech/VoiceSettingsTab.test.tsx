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
      expect(saveConfiguration).toHaveBeenCalledWith({
        modelRef: 'office/sense-voice',
      });
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
                  { id: 'alloy', name: 'Alloy' },
                  { id: 'echo', name: 'Echo' },
                ],
              },
              {
                id: 'voice-hq',
                name: 'Voice HQ',
                voices: [
                  { id: 'nova', name: 'Nova' },
                  { id: 'shimmer', name: 'Shimmer' },
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
    expect(screen.queryByRole('option', { name: 'Nova' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Echo' }));

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'online',
        onlineTtsModelRef: 'lan-tts/voice-small',
        onlineTtsVoice: 'echo',
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

    const draftVoice = { ...savedVoice, onlineTtsVoice: 'voice-b' };
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

  it('keeps the previous selection and reports a Gateway model switch failure', async () => {
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

    expect((await screen.findByRole('alert')).textContent).toContain('Gateway rejected config');
    expect(onChange).not.toHaveBeenCalled();
    expect(selector.textContent).toContain('Office speech / Model A');
  });
});
