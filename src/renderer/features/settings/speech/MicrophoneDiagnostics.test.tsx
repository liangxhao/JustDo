// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import MicrophoneDiagnostics from './MicrophoneDiagnostics';

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
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['sample']) } as BlobEvent);
    this.onstop?.();
  }
}
const stopTrack = vi.fn();
const close = vi.fn(async () => {});
const pause = vi.fn();
const getUserMedia = vi.fn();
const onRecordingChange = vi.fn();
const stream = () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  TestMediaRecorder.instances = [];
  getUserMedia.mockResolvedValue(stream());
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:microphone-check'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
  vi.stubGlobal('MediaRecorder', TestMediaRecorder);
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1),
        };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      close = close;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const start = () =>
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceMicrophoneCheckStart') }));
const stop = () =>
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceMicrophoneCheckStop') }));

describe('shared microphone check', () => {
  it('requests only the explicitly selected microphone on click and stops at ten seconds without any recognition model', async () => {
    render(
      <MicrophoneDiagnostics
        deviceId="chosen-device"
        contextKey="conversation"
        onRecordingChange={onRecordingChange}
      />,
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    start();
    await screen.findByRole('button', { name: i18nService.t('voiceMicrophoneCheckStop') });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'chosen-device' } }),
    });
    act(() => vi.advanceTimersByTime(10_000));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(onRecordingChange).toHaveBeenLastCalledWith({
      deviceId: 'chosen-device',
      blob: expect.any(Blob),
    });
    expect(screen.getByLabelText(i18nService.t('voiceDiagnosticPlayback'))).toHaveProperty(
      'autoplay',
      false,
    );
  });

  it('keeps a completed sample across tabs but clears it and pauses playback when the device changes', async () => {
    const view = render(
      <MicrophoneDiagnostics
        deviceId="one"
        contextKey="conversation"
        onRecordingChange={onRecordingChange}
      />,
    );
    start();
    await screen.findByRole('button', { name: i18nService.t('voiceMicrophoneCheckStop') });
    stop();
    const completed = onRecordingChange.mock.lastCall![0];
    view.rerender(
      <MicrophoneDiagnostics
        deviceId="one"
        contextKey="transcription"
        onRecordingChange={onRecordingChange}
      />,
    );
    expect(onRecordingChange.mock.lastCall![0]).toBe(completed);
    expect(screen.getByLabelText(i18nService.t('voiceDiagnosticPlayback'))).toBeTruthy();
    expect(pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.rerender(
      <MicrophoneDiagnostics
        deviceId="two"
        contextKey="transcription"
        onRecordingChange={onRecordingChange}
      />,
    );
    expect(onRecordingChange).toHaveBeenLastCalledWith(null);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:microphone-check');
    expect(screen.queryByLabelText(i18nService.t('voiceDiagnosticPlayback'))).toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('keeps a cancelled permission request busy until its late stream is stopped', async () => {
    let finish!: (value: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const view = render(
      <MicrophoneDiagnostics
        deviceId="one"
        contextKey="conversation"
        onRecordingChange={onRecordingChange}
      />,
    );
    start();
    view.rerender(
      <MicrophoneDiagnostics
        deviceId="two"
        contextKey="transcription"
        onRecordingChange={onRecordingChange}
      />,
    );
    const finishing = screen.getByRole('button', { name: i18nService.t('voiceInputFinishing') });
    expect(finishing).toHaveProperty('disabled', true);
    fireEvent.click(finishing);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => {
      finish(stream());
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: i18nService.t('voiceMicrophoneCheckStart') }),
    ).toHaveProperty('disabled', false);
    expect(onRecordingChange.mock.calls.some(([value]) => value?.blob)).toBe(false);
  });

  it('stops capture on hiding or closing without publishing an incomplete sample', async () => {
    const view = render(
      <MicrophoneDiagnostics
        deviceId="one"
        contextKey="transcription"
        onRecordingChange={onRecordingChange}
      />,
    );
    start();
    await screen.findByRole('button', { name: i18nService.t('voiceMicrophoneCheckStop') });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(TestMediaRecorder.instances[0].state).toBe('inactive');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onRecordingChange.mock.calls.some(([value]) => value?.blob)).toBe(false);
    view.unmount();
    expect(close).toHaveBeenCalledOnce();
  });

  it('releases the acquired stream if audio setup fails', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('Audio unavailable');
        }
      },
    );
    render(
      <MicrophoneDiagnostics
        deviceId="one"
        contextKey="transcription"
        onRecordingChange={onRecordingChange}
      />,
    );
    start();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onRecordingChange.mock.calls.some(([value]) => value?.blob)).toBe(false);
  });
});
