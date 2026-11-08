// @vitest-environment jsdom

import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import * as localAudioCapture from '@/shared/audio/localAudioCapture';

import { LocalSpeechInputButton } from './LocalSpeechInputButton';
import { OnlineAsrAudioPump } from './onlineAudioCapture';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LocalSpeechInputButton', () => {
  it('records microphone and system audio once and stops at the ordinary duration limit', async () => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...config,
      voice: {
        ...config.voice,
        inputEnabled: true,
        recognitionMode: 'local',
        inputSource: 'microphone-system',
        maxRecordingSeconds: 5,
        ...({ meetingMode: true, meetingSegmentSeconds: 1 } as object),
      },
    });
    const microphone = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
    const system = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
    const stream = (track: typeof microphone) => ({
      active: true,
      getTracks: () => [track],
      getAudioTracks: () => [track],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream(microphone)),
        getDisplayMedia: vi.fn().mockResolvedValue({ ...stream(system), getVideoTracks: () => [] }),
      },
    });
    vi.stubGlobal(
      'MediaStream',
      class {
        active = true;
        constructor(private tracks: (typeof microphone)[]) {}
        getTracks() {
          return this.tracks;
        }
        getAudioTracks() {
          return this.tracks;
        }
      },
    );
    const recorders: Recorder[] = [];
    class Recorder {
      state = 'inactive';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start = vi.fn(() => {
        this.state = 'recording';
      });
      stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded']) });
        this.onstop?.();
      });
      constructor() {
        recorders.push(this);
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({ success: true, text: 'Microphone words' })
      .mockResolvedValueOnce({ success: true, text: 'System words' });
    vi.stubGlobal('electron', {
      mediaCapture: { armSystemAudio: vi.fn().mockResolvedValue(undefined) },
      localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }), transcribe },
      localSpeechModels: { onChanged: () => () => {} },
    });
    vi.spyOn(localAudioCapture, 'recordedAudioToWav').mockResolvedValue(new Uint8Array([1]));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const onTranscript = vi.fn();
    render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
    const button = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    await vi.waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);
    await screen.findByRole('button', { name: i18nService.t('localAsrStop') });
    expect(recorders).toHaveLength(2);
    expect(recorders.every(recorder => recorder.start.mock.calls.length === 1)).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    const limit = timers.mock.calls.find(([, delay]) => delay === 5000)?.[0];
    expect(limit).toBeTypeOf('function');
    await act(async () => {
      if (typeof limit === 'function') limit();
    });
    await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    expect(recorders).toHaveLength(2);
    expect(recorders.every(recorder => recorder.stop.mock.calls.length === 1)).toBe(true);
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(system.stop).toHaveBeenCalledOnce();
    expect(onTranscript.mock.calls).toEqual([['Microphone words'], ['System words']]);
  });
  it('waits for a cancelled realtime Stop to finish before starting another capture', async () => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...config,
      voice: {
        ...config.voice,
        inputEnabled: true,
        recognitionMode: 'online',
        inputSource: 'microphone',
      },
    });
    const track = () => ({ readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() });
    const oldTrack = track();
    const nextTrack = track();
    const stream = (audioTrack: typeof oldTrack) => ({
      active: true,
      getTracks: () => [audioTrack],
      getAudioTracks: () => [audioTrack],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi
          .fn()
          .mockResolvedValueOnce(stream(oldTrack))
          .mockResolvedValue(stream(nextTrack)),
      },
    });
    vi.spyOn(OnlineAsrAudioPump.prototype, 'prepare').mockImplementation(() => {});
    vi.spyOn(OnlineAsrAudioPump.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(OnlineAsrAudioPump.prototype, 'stop').mockImplementation(() => {});
    let finishClose!: () => void;
    const oldClose = new Promise<void>(resolve => {
      finishClose = resolve;
    });
    const close = vi.fn((id: string) => (id === 'old-session' ? oldClose : Promise.resolve()));
    let emit!: (event: import('@shared/speech/onlineAsr').OnlineAsrEvent) => void;
    const session = (id: string) => ({
      sessionId: `${id}-session`,
      transcriptionSessionId: `${id}-transcription`,
      provider: 'openai',
      inputEncoding: 'g711_ulaw',
      inputSampleRateHz: 8000,
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        onlineAsr: {
          getStatus: vi.fn().mockResolvedValue({ available: true, inputMode: 'realtime' }),
          start: vi.fn().mockResolvedValueOnce(session('old')).mockResolvedValue(session('next')),
          close,
          onEvent: vi.fn(callback => {
            emit = callback;
            return () => {};
          }),
        },
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => {}) },
      },
    });
    const onTranscript = vi.fn();
    render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStart') }));
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStop') }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('old-session'));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceInputFinishing'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      finishClose();
    });
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStart') }));
    await screen.findByRole('button', { name: i18nService.t('localAsrStop') });
    act(() =>
      emit({
        transcriptionSessionId: 'next-transcription',
        type: 'partial',
        text: 'new live words',
      }),
    );
    act(() =>
      emit({
        transcriptionSessionId: 'old-transcription',
        type: 'transcript',
        text: 'stale words',
        final: true,
      }),
    );
    expect(screen.getByRole('button', { name: i18nService.t('localAsrStop') })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('new live words');
    expect(nextTrack.stop).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it.each(['stop', 'cancel-during-decode', 'cancel-during-upload'])(
    'uses recorded HTTP speech with %s and protects the next capture',
    async action => {
      const cancel = action !== 'stop';
      const config = configService.getConfig();
      vi.spyOn(configService, 'getConfig').mockReturnValue({
        ...config,
        voice: {
          ...config.voice,
          inputEnabled: true,
          recognitionMode: 'online',
          onlineAsrModelRef: 'private/recording',
          onlineAsrBindingId: 'recorded',
        },
        onlineModelProviders: {
          ...config.onlineModelProviders,
          'speech-recognition': {
            providers: {
              private: {
                displayName: 'Any compatible server',
                baseUrl: 'http://speech.internal/v1',
                apiKey: '',
                models: [
                  {
                    id: 'recording',
                    name: 'Recording',
                    bindings: [{ id: 'recorded', protocolId: 'openai-transcription-http' }],
                  },
                ],
              },
            },
          },
        },
      });
      const track = { readyState: 'live', stop: vi.fn(), addEventListener: vi.fn() };
      const stream = { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
      const nextTrack = { ...track, stop: vi.fn() };
      const nextStream = {
        active: true,
        getTracks: () => [nextTrack],
        getAudioTracks: () => [nextTrack],
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: vi.fn().mockResolvedValueOnce(stream).mockResolvedValue(nextStream),
        },
      });
      class Recorder {
        state = 'inactive';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror = null;
        start() {
          this.state = 'recording';
        }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['recording']) });
          this.onstop?.();
        }
      }
      vi.stubGlobal('MediaRecorder', Recorder);
      const wav = new Uint8Array([82, 73, 70, 70]);
      let finishDecode!: (value: Uint8Array) => void;
      const decode = vi.spyOn(localAudioCapture, 'recordedAudioToWav').mockImplementation(() =>
        action === 'cancel-during-decode'
          ? new Promise(resolve => {
              finishDecode = resolve;
            })
          : Promise.resolve(wav),
      );
      let finish!: (value: { requestId: string; text: string }) => void;
      const transcribe = vi.fn(request =>
        cancel
          ? new Promise(resolve => {
              finish = resolve;
            })
          : Promise.resolve({ requestId: request.requestId, text: 'dictated words' }),
      );
      const cancelTranscription = vi.fn().mockResolvedValue(undefined);
      const start = vi.fn();
      const localTranscribe = vi.fn();
      let engineChanged!: (value: OpenClawEngineStatus) => void;
      Object.defineProperty(window, 'electron', {
        configurable: true,
        value: {
          onlineAsr: {
            getStatus: vi.fn().mockResolvedValue({ available: true, inputMode: 'recording' }),
            transcribe,
            cancelTranscription,
            start,
            onEvent: vi.fn().mockReturnValue(() => {}),
          },
          localAsr: { transcribe: localTranscribe },
          localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => {}) },
          openclaw: {
            engine: {
              onProgress: vi.fn(callback => {
                engineChanged = callback;
                return () => {};
              }),
            },
          },
        },
      });
      const onTranscript = vi.fn();
      render(<LocalSpeechInputButton disabled={false} onTranscript={onTranscript} />);
      const microphone = await screen.findByRole('button', {
        name: i18nService.t('localAsrStart'),
      });
      act(() => engineChanged({ phase: EnginePhase.Starting, canRetry: false, version: null }));
      expect((microphone as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(microphone);
      fireEvent.click(await screen.findByRole('button', { name: i18nService.t('localAsrStop') }));
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      if (action !== 'cancel-during-decode')
        await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      const requestId = transcribe.mock.calls[0]?.[0].requestId;
      if (cancel) {
        fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
        expect(
          (
            screen.getByRole('button', {
              name: i18nService.t('voiceInputFinishing'),
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        if (action === 'cancel-during-decode') {
          await act(async () => {
            finishDecode(wav);
          });
          expect(transcribe).not.toHaveBeenCalled();
          expect(cancelTranscription).not.toHaveBeenCalled();
        } else {
          expect(cancelTranscription).toHaveBeenCalledWith(requestId);
          await act(async () => {
            finish({ requestId, text: 'late cancelled words' });
          });
        }
        fireEvent.click(
          await screen.findByRole('button', { name: i18nService.t('localAsrStart') }),
        );
        await screen.findByRole('button', { name: i18nService.t('localAsrStop') });
        expect(screen.getByRole('button', { name: i18nService.t('localAsrStop') })).toBeTruthy();
        expect(nextTrack.stop).not.toHaveBeenCalled();
        expect(onTranscript).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith('dictated words'));
        expect(cancelTranscription).not.toHaveBeenCalled();
      }
      expect(start).not.toHaveBeenCalled();
      expect(localTranscribe).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalled();
    },
  );

  it('refreshes online recognition after the engine starts and ignores stale readiness results', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: { ...currentConfig.voice, inputEnabled: true, recognitionMode: 'online' },
    });
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
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        onlineAsr: { getStatus, onEvent: vi.fn().mockReturnValue(() => undefined) },
        localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => undefined) },
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
    const { unmount } = render(<LocalSpeechInputButton disabled={false} onTranscript={vi.fn()} />);
    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceInputUnavailable'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      engineChanged({ phase: EnginePhase.Running, canRetry: false, version: null });
    });
    expect(screen.getByRole('button', { name: i18nService.t('localAsrStart') })).toBeTruthy();
    await act(async () => {
      finishInitial({ available: false });
    });
    expect(screen.getByRole('button', { name: i18nService.t('localAsrStart') })).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(2);

    act(() => engineChanged({ phase: EnginePhase.Starting, canRetry: false, version: null }));
    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceInputUnavailable'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

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
      },
    });
    const segments = [new Uint8Array([1]), new Uint8Array([2])];
    const decode = vi
      .spyOn(localAudioCapture, 'recordedAudioToWavChunks')
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
    fireEvent.click(screen.getByRole('menuitem', { name: i18nService.t('voiceInputSourceFile') }));
    const file = new File(['audio'], 'recording.mp3', { type: 'audio/mpeg' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(decode).toHaveBeenCalledWith(file);
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

  it('waits for a cancelled import to finish and ignores its stale failure', async () => {
    const currentConfig = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({
      ...currentConfig,
      voice: {
        ...currentConfig.voice,
        inputEnabled: true,
        recognitionMode: 'local',
      },
    });
    vi.spyOn(localAudioCapture, 'recordedAudioToWavChunks').mockResolvedValue([
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
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceInputFinishing'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => {
      finishOld({ success: false, error: 'Old request failed' });
    });
    await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    expect(dispatch.mock.calls.some(([event]) => event.type === 'app:showToast')).toBe(false);
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
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
    expect(
      (
        screen.getByRole('menuitem', {
          name: i18nService.t('voiceInputSourceFile'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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

  it.each([false, true])(
    'streams microphone audio and cancels a changed model: %s',
    async changeModel => {
      const currentConfig = configService.getConfig();
      const getConfig = vi.spyOn(configService, 'getConfig').mockReturnValue({
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
      await vi.waitFor(() =>
        expect(appendAudio).toHaveBeenCalledWith('talk-1', expect.any(String)),
      );
      if (changeModel) {
        const previousConfig = configService.getConfig();
        getConfig.mockReturnValue({
          ...previousConfig,
          voice: { ...previousConfig.voice, onlineAsrModelRef: 'internal/another-model' },
        });
        await act(async () => {
          window.dispatchEvent(new CustomEvent('config-updated'));
        });
        await vi.waitFor(() => expect(close).toHaveBeenCalledWith('talk-1'));
        emitOnlineEvent?.({
          transcriptionSessionId: 'transcription-1',
          type: 'transcript',
          text: 'Old model transcript',
          final: true,
        });
        expect(onTranscript).not.toHaveBeenCalled();
        return;
      }
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
    },
  );
});
