// @vitest-environment jsdom

import { defaultLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import VoiceInputDiagnostics from './VoiceInputDiagnostics';

const { recordedAudioToWav } = vi.hoisted(() => ({ recordedAudioToWav: vi.fn() }));
vi.mock('@/shared/audio/localAudioCapture', () => ({ recordedAudioToWav }));
const recording = new Blob(['shared microphone sample']);
const transcribe = vi.fn();
const getUserMedia = vi.fn();
beforeEach(() => {
  recordedAudioToWav.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  transcribe.mockReset().mockResolvedValue({ success: true, text: 'recognized sample' });
  getUserMedia.mockReset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { localAsr: { transcribe } },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('recognition of the shared microphone recording', () => {
  it('recognizes the supplied sample only on request without acquiring another microphone', async () => {
    render(
      <VoiceInputDiagnostics
        settings={{ ...defaultLocalSpeechSettings, inputLanguage: 'zh', recognitionThreads: 4 }}
        modelReady
        recording={recording}
      />,
    );
    expect(transcribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('voiceDiagnosticStart') }));
    expect(await screen.findByText('recognized sample')).toBeTruthy();
    expect(recordedAudioToWav).toHaveBeenCalledExactlyOnceWith(recording);
    expect(transcribe).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), {
      modelId: defaultLocalSpeechSettings.asrModelId,
      language: 'zh',
      numThreads: 4,
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('requires both a ready local model and a completed sample', () => {
    const view = render(
      <VoiceInputDiagnostics settings={defaultLocalSpeechSettings} modelReady recording={null} />,
    );
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    expect(screen.getByText(i18nService.t('voiceDiagnosticNeedsRecording'))).toBeTruthy();
    view.rerender(
      <VoiceInputDiagnostics
        settings={defaultLocalSpeechSettings}
        modelReady={false}
        recording={recording}
      />,
    );
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
    expect(screen.getByText(i18nService.t('voiceDiagnosticNeedsModel'))).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('does not dispatch decoded audio after the recognition panel is closed', async () => {
    let finish!: (value: Uint8Array) => void;
    recordedAudioToWav.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const view = render(
      <VoiceInputDiagnostics
        settings={defaultLocalSpeechSettings}
        modelReady
        recording={recording}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    view.unmount();
    await act(async () => {
      finish(new Uint8Array([1, 2]));
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('does not replace a newer sample result with an old recognition response', async () => {
    let finish!: (value: { success: boolean; text: string }) => void;
    transcribe
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ success: true, text: 'new sample result' });
    const view = render(
      <VoiceInputDiagnostics
        settings={defaultLocalSpeechSettings}
        modelReady
        recording={recording}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    view.rerender(
      <VoiceInputDiagnostics
        settings={defaultLocalSpeechSettings}
        modelReady
        recording={new Blob(['new sample'])}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('new sample result')).toBeTruthy();
    await act(async () => {
      finish({ success: true, text: 'old response' });
    });
    expect(screen.queryByText('old response')).toBeNull();
    expect(screen.getByText('new sample result')).toBeTruthy();
  });

  it('discards a recognition response after the window becomes hidden', async () => {
    let finish!: (value: { success: boolean; text: string }) => void;
    transcribe.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    render(
      <VoiceInputDiagnostics
        settings={defaultLocalSpeechSettings}
        modelReady
        recording={recording}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      finish({ success: true, text: 'hidden response' });
    });
    expect(screen.queryByText('hidden response')).toBeNull();
  });
});
