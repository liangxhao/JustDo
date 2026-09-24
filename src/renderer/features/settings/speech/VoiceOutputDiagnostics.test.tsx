// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import VoiceOutputDiagnostics from './VoiceOutputDiagnostics';

const pause = vi.fn();
const play = vi.fn().mockResolvedValue(undefined);

class MockAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = pause;
  play = play;
}

describe('VoiceOutputDiagnostics', () => {
  beforeEach(() => {
    pause.mockClear();
    play.mockClear();
    vi.stubGlobal('Audio', MockAudio);
    vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('plays editable sample text through the shared speech synthesis bridge', async () => {
    const speak = vi.fn().mockResolvedValue({
      audioBase64: Buffer.from('audio').toString('base64'),
      provider: 'tts-local-cli',
      mimeType: 'audio/wav',
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { speechSynthesis: { speak } },
    });
    render(<VoiceOutputDiagnostics available configurationKey="local:model:3" />);

    const input = screen.getByRole('textbox', {
      name: i18nService.t('voiceOutputDiagnosticText'),
    });
    fireEvent.change(input, { target: { value: '  自定义试听内容  ' } });
    fireEvent.click(
      screen.getByRole('button', { name: i18nService.t('voiceOutputDiagnosticPlay') }),
    );

    await vi.waitFor(() => {
      expect(speak).toHaveBeenCalledWith('自定义试听内容');
      expect(play).toHaveBeenCalledOnce();
    });
    expect(
      screen.getByRole('button', { name: i18nService.t('voiceOutputDiagnosticStop') }),
    ).toBeTruthy();
  });

  it('disables preview until the configured service is ready', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { speechSynthesis: { speak: vi.fn() } },
    });
    render(<VoiceOutputDiagnostics available={false} configurationKey="local:model:3" />);

    expect(
      (
        screen.getByRole('button', {
          name: i18nService.t('voiceOutputDiagnosticPlay'),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(i18nService.t('voiceOutputDiagnosticUnavailable'))).toBeTruthy();
  });
});
