// @vitest-environment jsdom

import { defaultLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import VoiceInputDiagnostics from './VoiceInputDiagnostics';

const { recordedAudioToWav } = vi.hoisted(() => ({
  recordedAudioToWav: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('@/shared/audio/localAudioCapture', () => ({
  recordedAudioToWav,
}));

class TestMediaRecorder {
  static instances: TestMediaRecorder[] = [];

  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor() {
    TestMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['recording'], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

describe('VoiceInputDiagnostics', () => {
  const stopTrack = vi.fn();
  const closeAudioContext = vi.fn().mockResolvedValue(undefined);
  const transcribe = vi.fn().mockResolvedValue({ success: true, text: '测试识别成功' });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stopTrack.mockClear();
    closeAudioContext.mockClear();
    transcribe.mockClear();
    recordedAudioToWav.mockClear();
    TestMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', TestMediaRecorder);
    vi.stubGlobal(
      'AudioContext',
      class {
        state: AudioContextState = 'running';
        createAnalyser() {
          return {
            fftSize: 0,
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1),
          };
        }
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
        close = closeAudioContext;
      },
    );
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:test-recording'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { localAsr: { transcribe } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records, preserves playback, and transcribes with the selected local model', async () => {
    render(
      <VoiceInputDiagnostics
        settings={{
          ...defaultLocalSpeechSettings,
          inputEnabled: true,
          inputLanguage: 'zh',
          recognitionThreads: 4,
        }}
        modelReady
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStart') }));
    expect(
      await screen.findByRole('button', { name: i18nService.t('voiceDiagnosticStop') }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStop') }));

    expect(await screen.findByText('测试识别成功')).toBeTruthy();
    expect(screen.getByLabelText(i18nService.t('voiceDiagnosticPlayback'))).toBeTruthy();
    expect(recordedAudioToWav).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), {
      modelId: defaultLocalSpeechSettings.asrModelId,
      language: 'zh',
      numThreads: 4,
    });
    expect(stopTrack).toHaveBeenCalled();
  });

  it('disables testing until the selected model is ready', () => {
    render(<VoiceInputDiagnostics settings={defaultLocalSpeechSettings} modelReady={false} />);

    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceDiagnosticStart'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(i18nService.t('voiceDiagnosticNeedsModel'))).toBeTruthy();
  });

  it('ignores a stale microphone rejection after settings change and a new recording starts', async () => {
    let rejectFirstRequest: (reason: Error) => void = () => undefined;
    const firstRequest = new Promise<MediaStream>((_, reject) => {
      rejectFirstRequest = reject;
    });
    const secondStream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce(secondStream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const { rerender } = render(
      <VoiceInputDiagnostics settings={defaultLocalSpeechSettings} modelReady />,
    );

    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStart') }));
    expect(
      (
        await screen.findByRole('button', {
          name: i18nService.t('voiceDiagnosticRequesting'),
        })
      ).getAttribute('disabled'),
    ).not.toBeNull();

    rerender(
      <VoiceInputDiagnostics
        settings={{ ...defaultLocalSpeechSettings, inputDeviceId: 'second-device' }}
        modelReady
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: i18nService.t('voiceDiagnosticStart') }),
    );
    expect(
      await screen.findByRole('button', { name: i18nService.t('voiceDiagnosticStop') }),
    ).toBeTruthy();

    rejectFirstRequest(new DOMException('denied', 'NotAllowedError'));
    await Promise.resolve();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStop') })).toBeTruthy();
  });

  it('does not transcribe if MediaRecorder reports an error before stopping', async () => {
    render(<VoiceInputDiagnostics settings={defaultLocalSpeechSettings} modelReady />);
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStart') }));
    expect(
      await screen.findByRole('button', { name: i18nService.t('voiceDiagnosticStop') }),
    ).toBeTruthy();
    const recorder = TestMediaRecorder.instances[TestMediaRecorder.instances.length - 1]!;

    recorder.onerror?.(new Event('error'));
    recorder.onstop?.();

    expect((await screen.findByRole('alert')).textContent).toContain(
      i18nService.t('voiceDiagnosticRecordingFailed'),
    );
    expect(recordedAudioToWav).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('warns when a completed recording is completely silent', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        state: AudioContextState = 'running';
        createAnalyser() {
          return {
            fftSize: 0,
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
          };
        }
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
        close = closeAudioContext;
      },
    );
    render(<VoiceInputDiagnostics settings={defaultLocalSpeechSettings} modelReady />);

    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStart') }));
    fireEvent.click(
      await screen.findByRole('button', { name: i18nService.t('voiceDiagnosticStop') }),
    );

    expect(await screen.findByText(i18nService.t('voiceDiagnosticTooQuiet'))).toBeTruthy();
  });
});
