// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLocalSpeechModelCatalogEntry } from '@/features/speech/localSpeechModelCatalog';

import BuiltinSpeechVoiceList from './BuiltinSpeechVoiceList';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const model = getLocalSpeechModelCatalogEntry('kokoro-int8-multi-lang-v1_1')!;
const wav = btoa(`RIFF${'\0'.repeat(4)}WAVE${'\0'.repeat(32)}`);
const previewBuiltin = vi.fn();
const cancelBuiltinPreview = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const players: FakeAudio[] = [];
let nextPlay: Promise<void> | undefined;
class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  pause = vi.fn();
  constructor() {
    if (nextPlay) {
      this.play.mockReturnValueOnce(nextPlay);
      nextPlay = undefined;
    }
    players.push(this);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('electron', undefined);
  window.electron = {
    speechSynthesis: { previewBuiltin, cancelBuiltinPreview },
  } as unknown as typeof window.electron;
  vi.stubGlobal('Audio', FakeAudio);
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
  createObjectURL.mockReturnValue('blob:preview');
  previewBuiltin.mockImplementation(async request => ({
    requestId: request.requestId,
    audioBase64: wav,
    mimeType: 'audio/wav',
  }));
  cancelBuiltinPreview.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  players.length = 0;
  nextPlay = undefined;
});

describe('builtin voice browsing and preview', () => {
  it('filters language and gender, searches original names, and preserves native IDs', () => {
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.change(screen.getByRole('combobox', { name: 'speechVoiceLanguageFilter' }), {
      target: { value: 'zh' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'speechVoiceGenderFilter' }), {
      target: { value: 'male' },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(45);
    expect(screen.getByRole('status').textContent).toBe('45 / 103');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zm_069' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('voiceSpeakerChineseMale 069')).toBeTruthy();
    expect(screen.getByText('zm_069 · #92')).toBeTruthy();
    expect(previewBuiltin).not.toHaveBeenCalled();
  });

  it('searches friendly names and engine IDs and shows an empty result', () => {
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'maple' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Maple')).toBeTruthy();
    fireEvent.change(search, { target: { value: '#102' } });
    expect(screen.getByText('zm_100 · #102')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'no such voice' } });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('speechVoiceNoResults')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('0 / 103');
  });

  it('uses the filtered voice native ID and its language sample without saving settings', async () => {
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zm_069' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'speechVoicePreview: voiceSpeakerChineseMale 069' }),
    );
    await waitFor(() => expect(players).toHaveLength(1));
    expect(previewBuiltin).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: model.id, voiceId: 92, text: 'speechVoiceSampleChinese' }),
    );
    expect(players[0].play).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'speechVoiceStopPreview: voiceSpeakerChineseMale 069' }),
    ).toBeTruthy();
    act(() => players[0].onended?.());
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('previews English voices with the English sample and stops audio when filtering', async () => {
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    await waitFor(() => expect(players).toHaveLength(1));
    expect(previewBuiltin).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 0, text: 'speechVoiceSampleEnglish' }),
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zm_' } });
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('disables preview until the model is available', () => {
    render(<BuiltinSpeechVoiceList model={model} previewAvailable={false} />);
    const button = screen.getByRole('button', {
      name: 'speechVoicePreview: Maple',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('speechVoicePreviewNeedsModel');
    fireEvent.click(button);
    expect(previewBuiltin).not.toHaveBeenCalled();
  });

  it('cancels only the previous pending request when another voice starts and ignores its result', async () => {
    const earlier = deferred<{ requestId: string; audioBase64: string }>();
    previewBuiltin.mockImplementationOnce(() => earlier.promise);
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    const firstId = previewBuiltin.mock.calls[0][0].requestId;
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Sol' }));
    await waitFor(() => expect(players).toHaveLength(1));
    expect(cancelBuiltinPreview).toHaveBeenCalledWith(firstId);
    await act(async () => earlier.resolve({ requestId: firstId, audioBase64: wav }));
    expect(players).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'speechVoiceStopPreview: Sol' })).toBeTruthy();
  });

  it('cancels pending synthesis on unmount and discards late audio', async () => {
    const pending = deferred<{ requestId: string; audioBase64: string }>();
    previewBuiltin.mockImplementationOnce(() => pending.promise);
    const view = render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    const requestId = previewBuiltin.mock.calls[0][0].requestId;
    view.unmount();
    expect(cancelBuiltinPreview).toHaveBeenCalledWith(requestId);
    await act(async () => pending.resolve({ requestId, audioBase64: wav }));
    expect(players).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('stops active playback when model availability is revoked', async () => {
    const view = render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    await waitFor(() => expect(players).toHaveLength(1));
    view.rerender(<BuiltinSpeechVoiceList model={model} previewAvailable={false} />);
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('ignores an old audio event or play rejection after a new voice starts', async () => {
    let rejectPlay!: (reason: Error) => void;
    const earlierPlay = new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    nextPlay = earlierPlay;
    const view = render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    await waitFor(() => expect(players).toHaveLength(1));
    const oldError = players[0].onerror;
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Sol' }));
    await waitFor(() => expect(players).toHaveLength(2));
    await act(async () => {
      oldError?.();
      rejectPlay(new Error('old audio stopped'));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'speechVoiceStopPreview: Sol' })).toBeTruthy();
    expect(players[1].pause).not.toHaveBeenCalled();
    view.unmount();
    expect(players[1].pause).toHaveBeenCalledOnce();
  });

  it.each(['invalid audio', 'wrong request'])('rejects %s before creating playback', async kind => {
    previewBuiltin.mockImplementationOnce(async request => ({
      requestId: kind === 'wrong request' ? 'another' : request.requestId,
      audioBase64: kind === 'invalid audio' ? btoa('invalid') : wav,
    }));
    render(<BuiltinSpeechVoiceList model={model} previewAvailable />);
    fireEvent.click(screen.getByRole('button', { name: 'speechVoicePreview: Maple' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('speechVoicePreviewFailed'),
    );
    expect(players).toHaveLength(0);
  });

  it('keeps unknown gender metadata absent and avoids meaningless filters on a single-language model', () => {
    render(
      <BuiltinSpeechVoiceList
        model={getLocalSpeechModelCatalogEntry('vits-icefall-zh-aishell3')!}
        previewAvailable={false}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(174);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('voiceSpeakerChinese SSB0005')).toBeTruthy();
  });
});
