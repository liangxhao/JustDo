// @vitest-environment jsdom

import { defaultLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import type { LocalSpeechModelStatus } from '@shared/speech/localSpeechModels';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';

import LocalSpeechExtensionSettingsDialog from './LocalSpeechExtensionSettingsDialog';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => ({ localSpeechExtensions: defaultLocalSpeechExtensionSettings }),
    updateConfig: vi.fn(),
  },
}));

let changed: (status: LocalSpeechModelStatus) => void;
const list = vi.fn();
const install = vi.fn();
const close = vi.fn();
const status: LocalSpeechModelStatus = {
  id: defaultLocalSpeechExtensionSettings.ttsModelId,
  kind: 'tts',
  installed: false,
  phase: 'not-installed',
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ supported: true, models: [status] });
  vi.mocked(configService.updateConfig).mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      localSpeechModels: {
        list,
        install,
        onChanged: (callback: typeof changed) => {
          changed = callback;
          return vi.fn();
        },
      },
    },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 130,
    height: 30,
    left: 20,
    right: 220,
    top: 100,
    width: 200,
    x: 20,
    y: 100,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('extension speech model dialog', () => {
  it('offers an explicit shared download and saves only the extension selection once ready', async () => {
    let finish!: (value: unknown) => void;
    install.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelNotInstalled');
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'voiceModelDownload' }));
    expect(install).toHaveBeenCalledExactlyOnceWith('tts', status.id);

    act(() => changed({ ...status, phase: 'downloading', downloadPercent: 43 }));
    expect(screen.getByRole('status').textContent).toContain('43%');
    expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      finish({ success: true, status: { ...status, phase: 'ready', installed: true } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(configService.updateConfig).toHaveBeenCalledExactlyOnceWith({
      localSpeechExtensions: { ttsModelId: status.id },
    });
  });

  it('keeps model selection in the draft until Save and does not change speech settings on Cancel', async () => {
    const asrId = defaultLocalSpeechExtensionSettings.sttModelId;
    list.mockResolvedValue({
      supported: true,
      models: [
        { id: asrId, kind: 'asr', phase: 'ready', installed: true },
        { id: 'sherpa-onnx-whisper-base', kind: 'asr', phase: 'ready', installed: true },
      ],
    });
    render(<LocalSpeechExtensionSettingsDialog kind="asr" onClose={close} />);
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'voiceAsrModelWhisperBase' }));
    expect(configService.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('shows a save error and retains the selected model for an explicit retry', async () => {
    list.mockResolvedValue({
      supported: true,
      models: [{ ...status, phase: 'ready', installed: true }],
    });
    vi.mocked(configService.updateConfig).mockRejectedValueOnce(new Error('apply failed'));
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    await screen.findByText('voiceModelReady');
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'speechExtensionSaveFailed',
    );
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it('does not let a late status list overwrite live download progress', async () => {
    let finish!: (value: unknown) => void;
    list.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    act(() => changed({ ...status, phase: 'downloading', downloadPercent: 65 }));
    await act(async () => finish({ supported: true, models: [status] }));
    expect(screen.getByRole('status').textContent).toContain('65%');
    expect(screen.queryByRole('button', { name: 'voiceModelDownload' })).toBeNull();
  });

  it('reports a failed list and retries without downloading or changing preferences', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    render(<LocalSpeechExtensionSettingsDialog kind="tts" onClose={close} />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'voiceModelLoadFailed retry',
    );
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await screen.findByText('voiceModelNotInstalled');
    expect(install).not.toHaveBeenCalled();
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });
});
