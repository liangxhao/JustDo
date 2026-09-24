// @vitest-environment jsdom

import { defaultLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import VoiceSettingsTab from './VoiceSettingsTab';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { onlineModelProviders: {} } as {
    onlineModelProviders: Record<string, unknown>;
  },
}));

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => mockConfig,
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VoiceSettingsTab', () => {
  beforeEach(() => {
    mockConfig.onlineModelProviders = {};
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

  it('waits for an explicit download after voice input is enabled', async () => {
    const install = vi.fn().mockResolvedValue({
      success: true,
      status: {
        id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
        kind: 'asr',
        phase: 'ready',
        installed: true,
      },
    });
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
            ],
          }),
          install,
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });

    const { rerender } = render(
      <VoiceSettingsTab value={defaultLocalSpeechSettings} onChange={vi.fn()} />,
    );
    await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));
    fireEvent.click(screen.getByRole('switch', { name: i18nService.t('voiceInputEnabled') }));

    expect(install).not.toHaveBeenCalled();
    rerender(
      <VoiceSettingsTab
        value={{ ...defaultLocalSpeechSettings, inputEnabled: true }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceModelDownload') }));
    expect(install).toHaveBeenCalledWith(
      'asr',
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    );
  });

  it('shows model download actions only for enabled speech features', async () => {
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
                phase: 'not-installed',
                installed: false,
              },
            ],
          }),
          install: vi.fn().mockResolvedValue({
            success: false,
            status: {
              id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
              kind: 'asr',
              phase: 'not-installed',
              installed: false,
            },
          }),
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });

    const { rerender } = render(
      <VoiceSettingsTab value={defaultLocalSpeechSettings} onChange={vi.fn()} />,
    );
    await screen.findAllByText(i18nService.t('voiceModelNotInstalled'));
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();

    rerender(
      <VoiceSettingsTab
        value={{ ...defaultLocalSpeechSettings, inputEnabled: true }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeTruthy();
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
        provider: 'openai',
        baseUrl: 'http://10.0.0.8:8000/v1',
        apiKey: 'local',
        model: 'sense-voice',
      });
    });
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
  });

  it('selects an online synthesis model from the user provider catalog', async () => {
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
    expect(selector.textContent).not.toContain('Voice Missing');
    fireEvent.click(selector);
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
      expect(saveConfiguration).toHaveBeenCalledWith({
        provider: 'openai',
        baseUrl: 'http://speech.local/v1',
        apiKey: 'secret',
        model: 'voice-small',
        voice: 'echo',
      });
    });
    expect(screen.queryByRole('button', { name: i18nService.t('voiceModelDownload') })).toBeNull();
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
