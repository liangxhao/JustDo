// @vitest-environment jsdom

import { defaultLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import type { LocalSpeechModelStatus } from '@shared/speech/localSpeechModels';
import { LOCAL_TTS_MODEL_ID } from '@shared/speech/localTts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';

import LocalSpeechExtensionSettingsDialog from './LocalSpeechExtensionSettingsDialog';

const { storedExtensions, storedOnlineProviders } = vi.hoisted(() => ({
  storedExtensions: { value: {} as unknown },
  storedOnlineProviders: { value: {} as unknown },
}));

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => ({
      localSpeechExtensions: storedExtensions.value,
      onlineModelProviders: storedOnlineProviders.value,
    }),
    updateConfig: vi.fn(),
  },
}));

let changed: (status: LocalSpeechModelStatus) => void;
const list = vi.fn();
const install = vi.fn();
const close = vi.fn();
const status: LocalSpeechModelStatus = {
  id: defaultLocalSpeechExtensionSettings.ttsModelId,
  kind: 'tts',
  installed: false,
  phase: 'not-installed',
};

beforeEach(() => {
  vi.clearAllMocks();
  storedExtensions.value = { ...defaultLocalSpeechExtensionSettings };
  storedOnlineProviders.value = {};
  list.mockResolvedValue({ supported: true, models: [status] });
  vi.mocked(configService.updateConfig).mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      localSpeechModels: {
        list,
        install,
        onChanged: (callback: typeof changed) => {
          changed = callback;
          return vi.fn();
        },
      },
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 130,
    height: 30,
    left: 20,
    right: 220,
    top: 100,
    width: 200,
    x: 20,
    y: 100,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('extension speech model dialog', () => {
  it('opens model management without saving and follows shared download status until ready', async () => {
    const onManageModels = vi.fn();
    render(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    await screen.findByText('voiceModelNotInstalled');
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(install).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'voiceModelDownload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'speechManageModels' }));
    expect(onManageModels).toHaveBeenCalledExactlyOnceWith('tts');
    expect(configService.updateConfig).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    act(() => changed({ ...status, phase: 'downloading', downloadPercent: 43 }));
    expect(screen.getByRole('status').textContent).toContain('43%');
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => changed({ ...status, phase: 'ready', installed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        ttsMode: 'local',
        onlineTtsModelRef: '',
        onlineTtsVoice: '',
        ttsModelId: status.id,
        ttsVoiceId: defaultLocalSpeechExtensionSettings.ttsVoiceId,
      },
    });
  });

  it.each([
    [LOCAL_TTS_MODEL_ID, 103, 102, 'zm_100'],
    ['vits-icefall-zh-aishell3', 174, 173, 'SSB1956'],
    ['vits-piper-en_US-lessac-medium-int8', 1, 0, 'Lessac'],
  ] as const)(
    'selects and saves any %s voice independently from Voice settings',
    async (ttsModelId, count, ttsVoiceId, name) => {
      storedExtensions.value = { ...defaultLocalSpeechExtensionSettings, ttsModelId };
      list.mockResolvedValue({
        supported: true,
        models: [{ id: ttsModelId, kind: 'tts', phase: 'ready', installed: true }],
      });
      render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
      await screen.findByText('voiceModelReady');

      fireEvent.click(screen.getByRole('combobox', { name: 'voiceSpeaker' }));
      expect(screen.getAllByRole('option')).toHaveLength(count);
      fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
      expect(configService.updateConfig).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'save' }));

      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
        localSpeechExtensions: {
          ttsMode: 'local',
          onlineTtsModelRef: '',
          onlineTtsVoice: '',
          ttsModelId,
          ttsVoiceId,
        },
      });
      expect(install).not.toHaveBeenCalled();
    },
  );

  it('preserves an unlisted shortcut voice draft while managing models and restores it after save', async () => {
    list.mockResolvedValue({
      supported: true,
      models: [{ ...status, phase: 'ready', installed: true }],
    });
    const onManageModels = vi.fn();
    const { rerender } = render(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSpeaker' }));
    fireEvent.click(screen.getByRole('option', { name: /zf_004/ }));
    fireEvent.click(screen.getByRole('button', { name: 'speechManageModels' }));
    expect(onManageModels).toHaveBeenCalledExactlyOnceWith('tts');
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
        hidden
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(configService.updateConfig).not.toHaveBeenCalled();
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zf_004');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const saved = { ttsModelId: LOCAL_TTS_MODEL_ID, ttsVoiceId: 6 };
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        ttsMode: 'local',
        onlineTtsModelRef: '',
        onlineTtsVoice: '',
        ...saved,
      },
    });

    cleanup();
    storedExtensions.value = { ...defaultLocalSpeechExtensionSettings, ...saved };
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zf_004');
  });

  it('does not persist either the TTS model or voice when cancelled', async () => {
    list.mockResolvedValue({
      supported: true,
      models: [{ ...status, phase: 'ready', installed: true }],
    });
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSpeaker' }));
    fireEvent.click(screen.getByRole('option', { name: /zm_100/ }));
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceTtsModelPiperEnglish' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('Lessac');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(close).toHaveBeenCalledOnce();
    expect(configService.updateConfig).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('resets the plugin voice to each model default before saving', async () => {
    storedExtensions.value = { ...defaultLocalSpeechExtensionSettings, ttsVoiceId: 102 };
    list.mockResolvedValue({
      supported: true,
      models: [
        { ...status, phase: 'ready', installed: true },
        { id: 'vits-icefall-zh-aishell3', kind: 'tts', phase: 'ready', installed: true },
        { id: 'vits-piper-en_US-lessac-medium-int8', kind: 'tts', phase: 'ready', installed: true },
      ],
    });
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelReady');
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zm_100');
    const chooseModel = (label: string) => {
      fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
      fireEvent.click(screen.getByRole('option', { name: label }));
    };
    chooseModel('voiceTtsModelAishell3');
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('SSB0005');
    chooseModel('voiceTtsModelPiperEnglish');
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('Lessac');
    chooseModel('voiceTtsModelKokoro');
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zf_001');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        ttsMode: 'local',
        onlineTtsModelRef: '',
        onlineTtsVoice: '',
        ttsModelId: LOCAL_TTS_MODEL_ID,
        ttsVoiceId: 3,
      },
    });
  });

  it('preserves the selected plugin voice when the same model is selected again', async () => {
    storedExtensions.value = { ...defaultLocalSpeechExtensionSettings, ttsVoiceId: 102 };
    list.mockResolvedValue({
      supported: true,
      models: [{ ...status, phase: 'ready', installed: true }],
    });
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelReady');

    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceTtsModelKokoro' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zm_100');
    expect(configService.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        ttsMode: 'local',
        onlineTtsModelRef: '',
        onlineTtsVoice: '',
        ttsModelId: LOCAL_TTS_MODEL_ID,
        ttsVoiceId: 102,
      },
    });
  });

  it('hides the portal during model management and restores the independent selection draft', async () => {
    const asrId = defaultLocalSpeechExtensionSettings.sttModelId;
    list.mockResolvedValue({
      supported: true,
      models: [
        { id: asrId, kind: 'asr', phase: 'ready', installed: true },
        { id: 'sherpa-onnx-whisper-base', kind: 'asr', phase: 'not-installed', installed: false },
      ],
    });
    const onManageModels = vi.fn();
    const { rerender } = render(
      <LocalSpeechExtensionSettingsDialog
        kind="asr"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceRecognitionModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceAsrModelWhisperBase' }));
    fireEvent.click(screen.getByRole('button', { name: 'speechManageModels' }));
    expect(onManageModels).toHaveBeenCalledExactlyOnceWith('asr');
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="asr"
        onClose={close}
        onManageModels={onManageModels}
        hidden
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() =>
      changed({ id: 'sherpa-onnx-whisper-base', kind: 'asr', phase: 'ready', installed: true }),
    );
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="asr"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'voiceRecognitionModel' }).textContent).toContain(
      'voiceAsrModelWhisperBase',
    );
    expect(screen.getByRole('dialog')).toHaveProperty('tabIndex', -1);
    expect(configService.updateConfig).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        sttMode: 'local',
        onlineSttModelRef: '',
        sttModelId: 'sherpa-onnx-whisper-base',
      },
    });
  });

  it('keeps model selection in the draft until Save and does not change speech settings on Cancel', async () => {
    const asrId = defaultLocalSpeechExtensionSettings.sttModelId;
    list.mockResolvedValue({
      supported: true,
      models: [
        { id: asrId, kind: 'asr', phase: 'ready', installed: true },
        { id: 'sherpa-onnx-whisper-base', kind: 'asr', phase: 'ready', installed: true },
      ],
    });
    render(<LocalSpeechExtensionSettingsDialog kind="asr" onClose={close} />);
    await screen.findByText('voiceModelReady');
    expect(screen.queryByRole('combobox', { name: 'voiceSpeaker' })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceRecognitionModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceAsrModelWhisperBase' }));
    expect(configService.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('shows a save error and retains the selected model for an explicit retry', async () => {
    list.mockResolvedValue({
      supported: true,
      models: [{ ...status, phase: 'ready', installed: true }],
    });
    vi.mocked(configService.updateConfig).mockRejectedValueOnce(new Error('apply failed'));
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'speechExtensionSaveFailed',
    );
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('does not let a late status list overwrite live download progress', async () => {
    let finish!: (value: unknown) => void;
    list.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    act(() => changed({ ...status, phase: 'downloading', downloadPercent: 65 }));
    await act(async () => finish({ supported: true, models: [status] }));
    expect(screen.getByRole('status').textContent).toContain('65%');
    expect(screen.queryByRole('button', { name: 'voiceModelDownload' })).toBeNull();
  });

  it('reports a failed list and retries without downloading or changing preferences', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'voiceModelLoadFailed retry',
    );
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await screen.findByText('voiceModelNotInstalled');
    expect(install).not.toHaveBeenCalled();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('selects online TTS from the shared catalog and saves an independent draft', async () => {
    storedOnlineProviders.value = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: 'key',
            models: [
              {
                id: 'speech',
                name: 'Speech',
                voices: [
                  { id: ' echo ', name: ' Echo ' },
                  { id: 'echo', name: 'Duplicate' },
                  { id: '', name: 'Invalid' },
                ],
              },
              { id: 'empty', name: 'Empty', voices: [{ id: ' ', name: 'Invalid' }] },
            ],
          },
        },
      },
    };
    list.mockResolvedValue({ supported: false, models: [] });
    const onManageModels = vi.fn();
    const { rerender } = render(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisMode' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceSynthesisModeOnline' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
    expect(screen.queryByRole('option', { name: 'Office / Empty' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Office / Speech' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSpeaker' }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('option', { name: 'Echo' }));
    expect(configService.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'speechManageModels' }));
    expect(onManageModels).toHaveBeenCalledExactlyOnceWith('tts', {
      source: 'online',
      providerId: 'office',
    });
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
        hidden
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <LocalSpeechExtensionSettingsDialog
        kind="tts"
        onClose={close}
        onManageModels={onManageModels}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toBe('Echo');
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'Office / Speech' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toBe('Echo');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        ttsMode: 'online',
        ttsModelId: LOCAL_TTS_MODEL_ID,
        ttsVoiceId: 3,
        onlineTtsModelRef: 'office/speech',
        onlineTtsVoice: 'echo',
      },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('offers HTTP attachment transcription without admitting WebSocket-only models', async () => {
    storedOnlineProviders.value = {
      'speech-recognition': {
        providers: {
          files: {
            displayName: 'Files',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'asr', name: 'ASR' }],
          },
          realtime: {
            displayName: 'Realtime',
            baseUrl: 'wss://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'stream', name: 'Stream' }],
          },
        },
      },
    };
    list.mockResolvedValue({ supported: false, models: [] });
    render(<LocalSpeechExtensionSettingsDialog kind="asr" onClose={close} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceRecognitionMode' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceRecognitionModeOnline' }));
    expect(screen.getByText('speechFileTranscriptionDescription')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceRecognitionModel' }));
    expect(screen.queryByRole('option', { name: 'Realtime / Stream' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Files / ASR' }));
    expect(screen.queryByRole('combobox', { name: 'voiceSpeaker' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: {
        sttMode: 'online',
        sttModelId: defaultLocalSpeechExtensionSettings.sttModelId,
        onlineSttModelRef: 'files/asr',
      },
    });
  });

  it('retains the online choice but blocks save when the catalog removes its voice or model', async () => {
    storedExtensions.value = {
      ...defaultLocalSpeechExtensionSettings,
      ttsMode: 'online',
      onlineTtsModelRef: 'office/speech',
      onlineTtsVoice: 'echo',
    };
    const provider = {
      displayName: 'Office',
      baseUrl: 'http://speech.lan/v1',
      apiKey: '',
      models: [{ id: 'speech', name: 'Speech', voices: [{ id: 'echo', name: 'Echo' }] }],
    };
    storedOnlineProviders.value = { 'speech-synthesis': { providers: { office: provider } } };
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    storedOnlineProviders.value = {
      'speech-synthesis': {
        providers: {
          office: {
            ...provider,
            models: [{ ...provider.models[0], voices: [{ id: 'other', name: 'Other' }] }],
          },
        },
      },
    };
    act(() => window.dispatchEvent(new Event('config-updated')));
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toBe(
      'speechOnlineVoiceUnavailable',
    );
    storedOnlineProviders.value = {};
    act(() => window.dispatchEvent(new Event('config-updated')));
    expect(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }).textContent).toBe(
      'speechOnlineSelectionUnavailable',
    );
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps separate online and local selections when switching modes without saving', async () => {
    storedExtensions.value = {
      ...defaultLocalSpeechExtensionSettings,
      ttsVoiceId: 102,
      ttsMode: 'online',
      onlineTtsModelRef: 'office/speech',
      onlineTtsVoice: 'echo',
    };
    storedOnlineProviders.value = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'speech', name: 'Speech', voices: [{ id: 'echo', name: 'Echo' }] }],
          },
        },
      },
    };
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisMode' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceSynthesisModeLocal' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toContain('zm_100');
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisMode' }));
    fireEvent.click(screen.getByRole('option', { name: 'voiceSynthesisModeOnline' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toBe('Echo');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('requires a new voice after selecting a different online model', () => {
    storedExtensions.value = {
      ...defaultLocalSpeechExtensionSettings,
      ttsMode: 'online',
      onlineTtsModelRef: 'office/first',
      onlineTtsVoice: 'echo',
    };
    storedOnlineProviders.value = {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'http://speech.lan/v1',
            apiKey: '',
            models: [
              { id: 'first', name: 'First', voices: [{ id: 'echo', name: 'Echo' }] },
              { id: 'second', name: 'Second', voices: [{ id: 'nova', name: 'Nova' }] },
            ],
          },
        },
      },
    };
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSynthesisModel' }));
    fireEvent.click(screen.getByRole('option', { name: 'Office / Second' }));
    expect(screen.getByRole('combobox', { name: 'voiceSpeaker' }).textContent).toBe(
      'voiceSelectSpeaker',
    );
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('combobox', { name: 'voiceSpeaker' }));
    expect(screen.queryByRole('option', { name: 'Echo' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Nova' }));
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('blocks a saved realtime-only selection instead of switching it to another service', () => {
    storedExtensions.value = {
      ...defaultLocalSpeechExtensionSettings,
      sttMode: 'online',
      onlineSttModelRef: 'realtime/asr',
    };
    storedOnlineProviders.value = {
      'speech-recognition': {
        providers: {
          realtime: {
            displayName: 'Realtime',
            baseUrl: 'wss://speech.lan/v1',
            apiKey: '',
            models: [{ id: 'asr', name: 'ASR' }],
          },
        },
      },
    };
    render(<LocalSpeechExtensionSettingsDialog kind="asr" onClose={close} />);
    expect(screen.getByRole('combobox', { name: 'voiceRecognitionModel' }).textContent).toBe(
      'speechOnlineSelectionUnavailable',
    );
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('speechFileTranscriptionDescription')).toBeTruthy();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });
});
