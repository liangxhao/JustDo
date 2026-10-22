// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import * as localAudioCapture from '@/shared/audio/localAudioCapture';

import { LocalSpeechInputButton } from './LocalSpeechInputButton';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LocalSpeechInputButton', () => {
  it('renders the microphone only when local recognition assets are available', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: { ...currentConfig.voice, inputEnabled: true },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: {
          getStatus: vi.fn().mockResolvedValue({
            available: true,
            supported: true,
            modelId: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
          }),
        },
        localSpeechModels: {
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });

    render(<LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />);

    const microphone = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(microphone);
    const importItem = screen.getByRole('menuitem', {
      name: i18nService.t('voiceInputSourceFile'),
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const openPicker = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(importItem);
    expect(openPicker).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(microphone.getAttribute('aria-label')).toBe(i18nService.t('localAsrStart'));

    fireEvent.contextMenu(microphone);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(microphone);
    fireEvent.contextMenu(microphone);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it.each([false, true])('imports file segments and respects cancellation (%s)', async cancel => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: {
        ...currentConfig.voice,
        inputEnabled: true,
        recognitionMode: 'local',
        meetingMode: false,
      },
    });
    const segments = [new Uint8Array([1]), new Uint8Array([2])];
    const decode = vi
      .spyOn(localAudioCapture, 'recordedAudioToWavSegments')
      .mockResolvedValue(segments);
    let finishFirst!: (value: { success: boolean; text: string }) => void;
    const transcribe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({ success: true, text: 'Second segment' });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }), transcribe },
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
      },
    });
    const onTranscript = vi.fn();
    render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
    const microphone = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    fireEvent.contextMenu(microphone);
    fireEvent.click(screen.getByRole('menuitem'));
    const file = new File(['audio'], 'recording.mp3', { type: 'audio/mpeg' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(decode).toHaveBeenCalledWith(file, currentConfig.voice.meetingSegmentSeconds);
    fireEvent.contextMenu(microphone);
    expect(screen.queryByRole('menu')).toBeNull();
    if (cancel)
      fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
    finishFirst({ success: true, text: 'First segment' });
    await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    if (cancel) {
      expect(onTranscript).not.toHaveBeenCalled();
      expect(transcribe).toHaveBeenCalledTimes(1);
    } else {
      expect(onTranscript.mock.calls).toEqual([['First segment'], ['Second segment']]);
      expect(transcribe).toHaveBeenCalledTimes(2);
    }
  });

  it('does not let a cancelled import reset a newer import or report its stale failure', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: {
        ...currentConfig.voice,
        inputEnabled: true,
        recognitionMode: 'local',
        meetingMode: false,
      },
    });
    vi.spyOn(localAudioCapture, 'recordedAudioToWavSegments').mockResolvedValue([
      new Uint8Array([1]),
    ]);
    let finishOld!: (value: { success: boolean; error: string }) => void;
    let finishNew!: (value: { success: boolean; text: string }) => void;
    const transcribe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishNew = resolve;
          }),
      );
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }), transcribe },
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
      },
    });
    const onTranscript = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
    await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    const file = new File(['audio'], 'recording.mp3', { type: 'audio/mpeg' });
    const input = document.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishOld({ success: false, error: 'Old request failed' });
    });
    expect(screen.getByRole('button', { name: i18nService.t('localAsrCancel') })).toBeTruthy();
    expect(dispatch.mock.calls.some(([event]) => event.type === 'app:showToast')).toBe(false);
    await act(async () => {
      finishNew({ success: true, text: 'New recording' });
    });
    expect(onTranscript.mock.calls).toEqual([['New recording']]);
    expect(screen.getByRole('button', { name: i18nService.t('localAsrStart') })).toBeTruthy();
  });

  it('disables file import in online mode and hides the menu when disabled', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: { ...currentConfig.voice, inputEnabled: true, recognitionMode: 'online' },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: true }),
          onEvent: vi.fn().mockReturnValue(() => undefined),
        },
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
      },
    });
    const { rerender } = render(<LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />);
    fireEvent.contextMenu(
      await screen.findByRole('button', { name: i18nService.t('localAsrStart') }),
    );
    expect((screen.getByRole('menuitem') as HTMLButtonElement).disabled).toBe(true);
    rerender(<LocalSpeechInputButton disabled onTranscript={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays hidden when the local recognition bundle is unavailable', async () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: {
          getStatus: vi.fn().mockResolvedValue({
            available: false,
            supported: true,
            modelId: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
          }),
        },
        localSpeechModels: {
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });

    const { container } = render(
      <LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />,
    );
    await vi.waitFor(() => expect(window.electron.localAsr.getStatus).toHaveBeenCalledOnce());
    expect(container.innerHTML).toBe('');
  });

  it('writes one capture failure summary to the main log', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: {
        ...currentConfig.voice,
        inputEnabled: true,
        inputSource: 'system',
      },
    });
    const debug = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: vi
          .fn()
          .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
      },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: {
          getStatus: vi.fn().mockResolvedValue({
            available: true,
            supported: true,
            modelId: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
          }),
        },
        localSpeechModels: {
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
        mediaCapture: { armSystemAudio: vi.fn().mockResolvedValue(undefined) },
        log: { debug },
      },
    });

    render(<LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStart') }));

    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith(
        '[LocalSpeechInput] Audio capture failed.',
        expect.objectContaining({
          source: 'system',
          errorName: 'NotAllowedError',
          errorMessage: 'Permission denied',
        }),
      ),
    );
    expect(debug).toHaveBeenCalledOnce();
  });

  it('releases a late permission result after the composer becomes disabled', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: { ...currentConfig.voice, inputEnabled: true, inputSource: 'microphone' },
    });
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>(resolve => {
          resolveStream = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localAsr: {
          getStatus: vi.fn().mockResolvedValue({
            available: true,
            supported: true,
            modelId: 'sherpa-onnx-whisper-base',
          }),
        },
        localSpeechModels: {
          onChanged: vi.fn().mockReturnValue(() => undefined),
        },
      },
    });
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

    const { rerender } = render(<LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStart') }));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    rerender(<LocalSpeechInputButton disabled onTranscript={vi.fn()} />);
    resolveStream?.(stream);

    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it('streams microphone audio through an OpenClaw transcription Talk session', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: {
        ...currentConfig.voice,
        inputEnabled: true,
        recognitionMode: 'online',
        inputSource: 'microphone',
      },
    });
    const audioTrack = {
      readyState: 'live',
      addEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const stream = {
      active: true,
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    let processAudio: ((event: AudioProcessingEvent) => void) | null = null;
    class FakeAudioContext {
      sampleRate = 8000;
      state = 'running';
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => ({
        get onaudioprocess() {
          return processAudio;
        },
        set onaudioprocess(handler: ((event: AudioProcessingEvent) => void) | null) {
          processAudio = handler;
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      });
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
      close = vi.fn().mockResolvedValue(undefined);
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext,
    });
    let emitOnlineEvent:
      ((event: import('@shared/speech/onlineAsr').OnlineAsrEvent) => void) | undefined;
    const appendAudio = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: true, provider: 'deepgram' }),
          start: vi.fn().mockResolvedValue({
            sessionId: 'talk-1',
            transcriptionSessionId: 'transcription-1',
            provider: 'deepgram',
            inputEncoding: 'g711_ulaw',
            inputSampleRateHz: 8000,
          }),
          appendAudio,
          close,
          onEvent: vi.fn((callback: typeof emitOnlineEvent) => {
            emitOnlineEvent = callback;
            return () => undefined;
          }),
        },
      },
    });
    const onTranscript = vi.fn();

    render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStart') }));
    await screen.findByRole('button', { name: i18nService.t('localAsrStop') });
    const audioHandler = processAudio as ((event: AudioProcessingEvent) => void) | null;
    audioHandler?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 0.5, -0.5]) },
    } as unknown as AudioProcessingEvent);
    await vi.waitFor(() => expect(appendAudio).toHaveBeenCalledWith('talk-1', expect.any(String)));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrStop') }));

    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('talk-1'));
    emitOnlineEvent?.({
      transcriptionSessionId: 'transcription-1',
      type: 'transcript',
      text: '在线识别结果',
      final: true,
    });
    emitOnlineEvent?.({ transcriptionSessionId: 'transcription-1', type: 'close' });
    expect(onTranscript).toHaveBeenCalledWith('在线识别结果');
  });
});
