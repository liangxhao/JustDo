// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLocalSpeechModelCatalogEntry,
  type LocalSpeechModelCatalogEntry,
} from '@/features/speech/localSpeechModelCatalog';

import BuiltinSpeechModelDetails from './BuiltinSpeechModelDetails';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(cleanup);

const synthesisModel: LocalSpeechModelCatalogEntry = {
  id: 'kokoro-int8-multi-lang-v1_1',
  kind: 'tts',
  name: 'Kokoro 82M',
  descriptionKey: 'speechModelKokoroDescription',
  languages: ['zh', 'en'],
  engine: 'Kokoro',
  quantization: 'INT8',
  voices: [
    { id: '3', name: 'zf_001', language: 'zh', gender: 'female' },
    {
      id: '0',
      name: 'af_maple',
      language: 'en',
      gender: 'female',
      accent: 'en-US',
      displayName: 'Maple',
    },
    { id: '6', name: 'zf_004', language: 'zh', gender: 'female' },
  ],
};

describe('BuiltinSpeechModelDetails', () => {
  it('shows read-only model metadata and every voice without filtering', () => {
    render(
      <BuiltinSpeechModelDetails
        model={synthesisModel}
        downloadBytes={12.5 * 1024 * 1024}
        downloadBytesExact={false}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Kokoro 82M' });

    expect(within(dialog).getByText('speechModelKokoroDescription')).toBeTruthy();
    expect(within(dialog).getByText('chinese · english')).toBeTruthy();
    expect(within(dialog).getByText('Kokoro · INT8')).toBeTruthy();
    expect(within(dialog).getByText(synthesisModel.id)).toBeTruthy();
    expect(within(dialog).getByText('≈12.5 MiB')).toBeTruthy();
    expect(within(dialog).queryByRole('tablist')).toBeNull();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
    expect(within(dialog).getByText('voiceSpeakerChineseFemale 001')).toBeTruthy();
    expect(within(dialog).getByText('zf_001 · #3')).toBeTruthy();
    expect(within(dialog).getByText('voiceSpeakerChineseFemale 004')).toBeTruthy();
    expect(within(dialog).getByRole('searchbox')).toBeTruthy();
    expect(
      within(dialog).getByRole('combobox', { name: 'speechVoiceLanguageFilter' }),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'save' })).toBeNull();
  });

  it('shows all 103 Kokoro voices directly, including the last native speaker', () => {
    render(
      <BuiltinSpeechModelDetails
        model={getLocalSpeechModelCatalogEntry(synthesisModel.id)!}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(103);
    expect(screen.getByText('voiceSpeakerChineseFemale 004')).toBeTruthy();
    expect(screen.getByText('voiceSpeakerChineseMale 100')).toBeTruthy();
    expect(screen.getByText('zm_100 · #102')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('keeps a single voice and the voice list keyboard-scrollable', () => {
    render(
      <BuiltinSpeechModelDetails
        model={{
          ...synthesisModel,
          name: 'Piper Lessac',
          voices: [{ id: '0', name: 'Lessac' }],
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('tablist')).toBeNull();
    const list = screen.getByRole('list');
    expect(list.parentElement?.tabIndex).toBe(0);
    expect(list.parentElement?.className).toContain('overflow-y-auto');
    expect(within(list).getByText('Lessac')).toBeTruthy();
    expect(screen.queryByText('speechModelDownloadSize')).toBeNull();
  });

  it('shows recognition languages without a synthesis voice section', () => {
    render(
      <BuiltinSpeechModelDetails
        model={{
          ...synthesisModel,
          id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
          kind: 'asr',
          name: 'SenseVoice Small',
          languages: ['zh', 'en', 'ja', 'ko', 'yue'],
          voices: [],
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('chinese · english · japanese · korean · cantonese')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('speechModelVoices')).toBeNull();
  });

  it('contains keyboard focus, stops Escape propagation and restores the opener on close', () => {
    const escaped = vi.fn();
    const Host = () => {
      const [open, setOpen] = useState(false);
      return (
        <div onKeyDown={escaped}>
          <button type="button" onClick={() => setOpen(true)}>
            Open model
          </button>
          {open && (
            <BuiltinSpeechModelDetails model={synthesisModel} onClose={() => setOpen(false)} />
          )}
        </div>
      );
    };
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open model' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: 'speechVoiceLanguageFilter' }),
    );
    screen.getByRole('button', { name: 'close' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'speechModelVoices' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'close' }));
    escaped.mockClear();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(escaped).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
});
