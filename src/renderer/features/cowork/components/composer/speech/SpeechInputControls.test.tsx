// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { RealtimeVoiceComposerSession } from '@/features/speech/realtime/useRealtimeVoiceSession';
import { SPEECH_SURFACE_HIDDEN_EVENT } from '@/features/speech/speechSettingsNavigation';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import * as audio from '@/shared/audio/localAudioCapture';

import { SpeechInputControls } from './SpeechInputControls';
import { useSpeechTranscriptionActivity } from './useSpeechTranscriptionActivity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(inputSource: 'microphone' | 'microphone-system' = 'microphone') {
  const config = configService.getConfig();
  vi.spyOn(configService, 'getConfig').mockReturnValue({
    ...config,
    voice: {
      ...config.voice,
      inputEnabled: true,
      realtimeEnabled: true,
      recognitionMode: 'local',
      inputSource,
    },
  });
  const transcribe = vi.fn();
  vi.stubGlobal('electron', {
    localAsr: { getStatus: vi.fn().mockResolvedValue({ available: true }), transcribe },
    localSpeechModels: { onChanged: () => () => {} },
  });
  const start = vi.fn();
  const realtime = {
    enabled: true,
    engaged: false,
    canStart: true,
    start,
    view: { phase: 'idle' },
  } as unknown as RealtimeVoiceComposerSession;
  const onTranscript = vi.fn();
  function Controls() {
    const transcription = useSpeechTranscriptionActivity();
    return (
      <SpeechInputControls
        disabled={false}
        onTranscript={onTranscript}
        realtime={realtime}
        transcription={transcription}
      />
    );
  }
  render(<Controls />);
  const phone = () => screen.getByRole('button', { name: i18nService.t('realtimeVoiceStart') });
  return { phone, start, transcribe, onTranscript };
}

it('keeps recording and stopping usable while blocking a call until transcription finishes', async () => {
  const { phone, start, transcribe, onTranscript } = setup();
  const stop = vi.fn();
  const track = { readyState: 'live', stop, addEventListener: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        active: true,
        getTracks: () => [track],
        getAudioTracks: () => [track],
      }),
    },
  });
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['voice']) });
        this.onstop?.();
      }
    },
  );
  vi.spyOn(audio, 'recordedAudioToWav').mockResolvedValue(new Uint8Array([1]));
  let finish!: (result: { success: boolean; text: string }) => void;
  transcribe.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const microphone = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
  await vi.waitFor(() => expect(microphone).toHaveProperty('disabled', false));
  fireEvent.click(microphone);
  const stopButton = await screen.findByRole('button', { name: i18nService.t('localAsrStop') });
  expect(stopButton).toHaveProperty('disabled', false);
  expect(stop).not.toHaveBeenCalled();
  expect(phone()).toHaveProperty('disabled', true);
  fireEvent.click(phone());
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(stopButton);
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  expect(phone()).toHaveProperty('disabled', true);
  await act(async () => {
    finish({ success: true, text: 'editable words' });
  });
  expect(onTranscript).toHaveBeenCalledWith('editable words');
  expect(stop).toHaveBeenCalledOnce();
  expect(phone()).toHaveProperty('disabled', false);
  fireEvent.click(phone());
  expect(start).toHaveBeenCalledOnce();
});

it('releases acquired system audio immediately when mixed microphone permission is cancelled', async () => {
  const { phone, start, transcribe } = setup('microphone-system');
  const system = { stop: vi.fn() };
  const microphone = { stop: vi.fn() };
  let grantMicrophone!: (stream: MediaStream) => void;
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>(resolve => {
        grantMicrophone = resolve;
      }),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      getDisplayMedia: vi
        .fn()
        .mockResolvedValue({ getVideoTracks: () => [], getAudioTracks: () => [system] }),
    },
  });
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private tracks: (typeof system)[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  vi.stubGlobal('electron', {
    ...window.electron,
    mediaCapture: { armSystemAudio: vi.fn().mockResolvedValue(undefined) },
  });
  const button = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
  await vi.waitFor(() => expect(button).toHaveProperty('disabled', false));
  fireEvent.click(button);
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
  expect(system.stop).toHaveBeenCalledOnce();
  expect(phone()).toHaveProperty('disabled', true);
  fireEvent.click(phone());
  expect(start).not.toHaveBeenCalled();
  await act(async () => {
    grantMicrophone({ getTracks: () => [microphone] } as unknown as MediaStream);
  });
  expect(microphone.stop).toHaveBeenCalledOnce();
  expect(system.stop).toHaveBeenCalledOnce();
  expect(transcribe).not.toHaveBeenCalled();
  expect(phone()).toHaveProperty('disabled', false);
});

it.each(['cancel', 'hidden'])(
  'blocks calls during import decoding and %s until the decoder releases',
  async action => {
    const { phone, start, transcribe } = setup();
    let finishDecode!: (chunks: Uint8Array[]) => void;
    vi.spyOn(audio, 'recordedAudioToWavChunks').mockImplementation(
      () =>
        new Promise(resolve => {
          finishDecode = resolve;
        }),
    );
    const microphone = await screen.findByRole('button', { name: i18nService.t('localAsrStart') });
    await vi.waitFor(() => expect(microphone).toHaveProperty('disabled', false));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['audio'], 'sample.wav', { type: 'audio/wav' })] },
    });
    expect(phone()).toHaveProperty('disabled', true);
    if (action === 'cancel')
      fireEvent.click(screen.getByRole('button', { name: i18nService.t('localAsrCancel') }));
    else act(() => window.dispatchEvent(new Event(SPEECH_SURFACE_HIDDEN_EVENT)));
    expect(
      screen.getByRole('button', { name: i18nService.t('voiceInputFinishing') }),
    ).toHaveProperty('disabled', true);
    fireEvent.click(phone());
    expect(start).not.toHaveBeenCalled();
    await act(async () => {
      finishDecode([new Uint8Array([1])]);
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(phone()).toHaveProperty('disabled', false);
  },
);
