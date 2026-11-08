// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SpeechModelOptionsEditor from './SpeechModelOptionsEditor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('speech model options', () => {
  it('preserves legacy model options until the provider has an explicit interface', () => {
    const onChange = vi.fn();
    render(<SpeechModelOptionsEditor protocol={undefined} value={{}} onChange={onChange} />);
    expect(screen.getByText(i18nService.t('speechModelOptionsChooseProtocol'))).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('edits realtime model parameters without exposing a protocol selector', () => {
    const onChange = vi.fn();
    render(
      <SpeechModelOptionsEditor
        protocol={{ protocolId: 'openai-voice-realtime' }}
        value={{}}
        onChange={onChange}
      />,
    );
    fireEvent.change(
      screen.getByLabelText(i18nService.t('speechInputTranscriptionModel'), { exact: false }),
      { target: { value: 'internal/transcriber' } },
    );
    expect(onChange).toHaveBeenCalledWith({
      voicePolicy: 'preset',
      inputTranscriptionModel: 'internal/transcriber',
    });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('does not expose a synthesis policy selector or invent a selection', () => {
    const onChange = vi.fn();
    render(
      <SpeechModelOptionsEditor
        protocol={{ protocolId: 'openai-speech-http' }}
        value={{}}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
