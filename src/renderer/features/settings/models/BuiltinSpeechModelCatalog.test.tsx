// @vitest-environment jsdom

import { LOCAL_ASR_MODEL_IDS } from '@shared/speech/localAsr';
import {
  LocalSpeechModelKind,
  type LocalSpeechModelListResult,
  type LocalSpeechModelStatus,
} from '@shared/speech/localSpeechModels';
import { LOCAL_TTS_MODEL_IDS } from '@shared/speech/localTts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLocalSpeechModelCatalog } from '@/features/speech/localSpeechModelCatalog';

import BuiltinSpeechModelCatalog from './BuiltinSpeechModelCatalog';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => (key === 'speechModelVoiceCount' ? 'Voices {count}' : key) },
}));

afterEach(cleanup);

const initialModels = (): LocalSpeechModelStatus[] => [
  ...LOCAL_ASR_MODEL_IDS.map(id => ({
    id,
    kind: LocalSpeechModelKind.Asr,
    phase: 'not-installed' as const,
    installed: false,
  })),
  ...LOCAL_TTS_MODEL_IDS.map(id => ({
    id,
    kind: LocalSpeechModelKind.Tts,
    phase: 'not-installed' as const,
    installed: false,
  })),
];

describe('BuiltinSpeechModelCatalog', () => {
  const list = vi.fn<() => Promise<LocalSpeechModelListResult>>();
  const install = vi.fn();
  const remove = vi.fn();
  let emitChanged: (status: LocalSpeechModelStatus) => void;

  beforeEach(() => {
    list.mockReset().mockResolvedValue({ supported: true, models: initialModels() });
    install.mockReset();
    remove.mockReset();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        localSpeechModels: {
          list,
          install,
          remove,
          onChanged: vi.fn((listener: typeof emitChanged) => {
            emitChanged = listener;
            return () => undefined;
          }),
        },
      },
    });
  });

  it.each([
    [LocalSpeechModelKind.Asr, LOCAL_ASR_MODEL_IDS, LOCAL_TTS_MODEL_IDS],
    [LocalSpeechModelKind.Tts, LOCAL_TTS_MODEL_IDS, LOCAL_ASR_MODEL_IDS],
  ])(
    'lists only %s models and waits for an explicit download',
    async (kind, included, excluded) => {
      render(<BuiltinSpeechModelCatalog kind={kind} />);

      expect(await screen.findAllByRole('button', { name: /^voiceModelDownload:/ })).toHaveLength(
        included.length,
      );
      expect(screen.getAllByRole('article')).toHaveLength(included.length);
      getLocalSpeechModelCatalog(kind).forEach(model => {
        expect(screen.getByRole('button', { name: model.name })).toBeTruthy();
      });
      included.forEach(id => expect(screen.queryByText(id)).toBeNull());
      excluded.forEach(id => expect(screen.queryByText(id)).toBeNull());
      expect(install).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('button', { name: 'mediaModelSetDefault' })).toBeNull();
    },
  );

  it('shows native progress and completion after a manual download', async () => {
    const id = LOCAL_ASR_MODEL_IDS[0];
    install.mockReturnValue(new Promise(() => undefined));
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Asr} />);
    const row = screen.getByRole('article', { name: 'SenseVoice Small' });

    fireEvent.click(await within(row).findByRole('button', { name: /^voiceModelDownload:/ }));
    expect(install).toHaveBeenCalledExactlyOnceWith(LocalSpeechModelKind.Asr, id);

    act(() => {
      emitChanged({
        id,
        kind: LocalSpeechModelKind.Asr,
        phase: 'downloading',
        installed: false,
        downloadPercent: 42,
      });
    });
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(within(row).getByText('42%')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^voiceModelDownload:/ })).toBeNull();

    act(() => {
      emitChanged({ id, kind: LocalSpeechModelKind.Asr, phase: 'installing', installed: false });
    });
    expect(within(row).getByRole('status', { name: 'speechModelInstalling' })).toBeTruthy();
    act(() => {
      emitChanged({ id, kind: LocalSpeechModelKind.Asr, phase: 'ready', installed: true });
    });
    expect(within(row).queryByText('voiceModelReady')).toBeNull();
    const removeButton = within(row).getByRole('button', { name: /^voiceModelRemove:/ });
    expect(removeButton.textContent).toBe('');
    expect(removeButton.querySelector('svg')).toBeTruthy();
  });

  it('retries a failed model download only when requested', async () => {
    const id = LOCAL_TTS_MODEL_IDS[0];
    install
      .mockResolvedValueOnce({
        success: false,
        status: {
          id,
          kind: LocalSpeechModelKind.Tts,
          phase: 'error',
          installed: false,
          error: 'Configured download service unavailable',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        status: { id, kind: LocalSpeechModelKind.Tts, phase: 'ready', installed: true },
      });
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Tts} />);
    const row = screen.getByRole('article', { name: 'Kokoro v1.1' });

    fireEvent.click(await within(row).findByRole('button', { name: /^voiceModelDownload:/ }));
    expect(await within(row).findByText('Configured download service unavailable')).toBeTruthy();
    expect(install).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole('button', { name: /^retry:/ }));
    expect(await within(row).findByRole('button', { name: /^voiceModelRemove:/ })).toBeTruthy();
    expect(install).toHaveBeenNthCalledWith(2, LocalSpeechModelKind.Tts, id);
  });

  it('recovers from a failed inventory read without installing a model', async () => {
    list.mockRejectedValueOnce(new Error('Inventory unavailable'));
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Asr} />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'voiceModelLoadFailed');
    screen
      .getAllByRole('button', { name: /^voiceModelDownload:/ })
      .forEach(button => expect((button as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() =>
      expect(
        (screen.getAllByRole('button', { name: /^voiceModelDownload:/ })[0] as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(install).not.toHaveBeenCalled();
  });

  it('removes an installed model without choosing another model', async () => {
    const models = initialModels();
    const ready = { ...models[0], phase: 'ready' as const, installed: true };
    list.mockResolvedValue({ supported: true, models: [ready, ...models.slice(1)] });
    remove.mockResolvedValue({ success: true, status: models[0] });
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Asr} />);
    const row = screen.getByRole('article', { name: 'SenseVoice Small' });

    fireEvent.click(await within(row).findByRole('button', { name: /^voiceModelRemove:/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(ready.kind, ready.id));
    expect(await within(row).findByRole('button', { name: /^voiceModelDownload:/ })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });

  it('shows unsupported platforms without download or removal actions', async () => {
    list.mockResolvedValue({ supported: false, models: initialModels() });
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Tts} />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'voiceModelUnavailable');
    screen.getAllByRole('button', { name: /^voiceModelDownload:/ }).forEach(button => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    });
    expect(install).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('opens read-only model and voice details without downloading or selecting it', async () => {
    render(<BuiltinSpeechModelCatalog kind={LocalSpeechModelKind.Tts} />);
    expect(
      within(screen.getByRole('article', { name: 'Kokoro v1.1' })).getByText(/Voices 103/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('article', { name: 'AISHELL-3' })).getByText(/Voices 174/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('article', { name: 'Piper Lessac' })).getByText(/Voices 1/),
    ).toBeTruthy();
    const modelButton = screen.getByRole('button', { name: 'Kokoro v1.1' });
    modelButton.focus();
    fireEvent.click(modelButton);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(LOCAL_TTS_MODEL_IDS[0])).toBeTruthy();
    expect(within(dialog).getByText('voiceSpeakerChineseFemale 001')).toBeTruthy();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(103);
    expect(within(dialog).queryByRole('tablist')).toBeNull();
    expect(within(dialog).getByRole('combobox', { name: 'speechVoiceLanguageFilter' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'save' })).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(modelButton);
  });
});
