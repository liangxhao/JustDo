// @vitest-environment jsdom

import {
  defaultLocalSpeechExtensionSettings,
  type LocalSpeechExtensionSettings,
} from '@shared/speech/localSpeechExtensionSettings';
import {
  LocalSpeechModelKind,
  type LocalSpeechModelListResult,
  type LocalSpeechModelStatus,
} from '@shared/speech/localSpeechModels';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';

import LocalSpeechExtensionSettingsButton from './LocalSpeechExtensionSettingsButton';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/services/config', () => ({
  configService: { getConfig: vi.fn(), updateConfig: vi.fn() },
}));

const list = vi.fn();
const install = vi.fn();
const remove = vi.fn();
const setEnabled = vi.fn();
const onOpen = vi.fn();
const listeners = new Set<(status: LocalSpeechModelStatus) => void>();
const extensionName = 'Local speech';
const warningName = `${extensionName} · speechExtensionModelNotReady`;
const settingsName = `${extensionName} · speechExtensionModelSettings`;
let settings: LocalSpeechExtensionSettings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectedStatus(
  kind: LocalSpeechModelKind,
  phase: LocalSpeechModelStatus['phase'] = 'not-installed',
): LocalSpeechModelStatus {
  return {
    id: kind === LocalSpeechModelKind.Asr ? settings.sttModelId : settings.ttsModelId,
    kind,
    phase,
    installed: phase === 'ready',
  };
}

function publish(status: LocalSpeechModelStatus) {
  act(() => {
    for (const listener of listeners) listener(status);
  });
}

function button(kind: LocalSpeechModelKind = LocalSpeechModelKind.Tts, disabled = false) {
  return (
    <LocalSpeechExtensionSettingsButton
      kind={kind}
      name={extensionName}
      disabled={disabled}
      onOpen={onOpen}
    />
  );
}

function expectNoMutation() {
  expect(configService.updateConfig).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(setEnabled).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  settings = { ...defaultLocalSpeechExtensionSettings };
  vi.mocked(configService.getConfig).mockImplementation(
    () => ({ localSpeechExtensions: settings }) as ReturnType<typeof configService.getConfig>,
  );
  list.mockResolvedValue({
    supported: true,
    models: [selectedStatus(LocalSpeechModelKind.Asr), selectedStatus(LocalSpeechModelKind.Tts)],
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      extensions: { setEnabled },
      localSpeechModels: {
        list,
        install,
        remove,
        onChanged: (listener: (status: LocalSpeechModelStatus) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('local speech extension readiness warning', () => {
  test.each([LocalSpeechModelKind.Asr, LocalSpeechModelKind.Tts])(
    'waits for a successful inventory before warning about the selected %s model',
    async kind => {
      const inventory = deferred<LocalSpeechModelListResult>();
      list.mockReturnValue(inventory.promise);
      render(button(kind));
      expect(screen.getByRole('button', { name: settingsName })).toBeTruthy();
      expect(screen.queryByRole('button', { name: warningName })).toBeNull();

      await act(async () => inventory.resolve({ supported: true, models: [] }));

      expect(screen.getByRole('button', { name: warningName })).toBeTruthy();
      expectNoMutation();
    },
  );

  test.each([LocalSpeechModelKind.Asr, LocalSpeechModelKind.Tts])(
    'does not interpret a failed inventory read as a missing %s model',
    async kind => {
      const inventory = deferred<LocalSpeechModelListResult>();
      list.mockReturnValue(inventory.promise);
      render(button(kind));

      await act(async () => inventory.reject(new Error('Inventory unavailable')));

      expect(screen.queryByRole('button', { name: warningName })).toBeNull();
      expect(screen.getByRole('button', { name: settingsName })).toBeTruthy();
      expectNoMutation();
    },
  );

  test('does not warn when local speech models are unsupported on the host', async () => {
    list.mockResolvedValue({ supported: false, models: [] });
    await act(async () => {
      render(button());
    });

    expect(screen.queryByRole('button', { name: warningName })).toBeNull();
    expect(screen.getByRole('button', { name: settingsName })).toBeTruthy();
    expectNoMutation();
  });

  test.each([LocalSpeechModelKind.Asr, LocalSpeechModelKind.Tts])(
    'updates the %s warning as the selected model downloads, becomes ready, and is removed',
    async kind => {
      render(button(kind));
      await screen.findByRole('button', { name: warningName });
      publish({ ...selectedStatus(kind, 'downloading'), downloadPercent: 50 });
      expect(screen.getByRole('button', { name: warningName })).toBeTruthy();

      publish(selectedStatus(kind, 'ready'));
      expect(screen.queryByRole('button', { name: warningName })).toBeNull();
      publish(selectedStatus(kind));
      expect(screen.getByRole('button', { name: warningName })).toBeTruthy();
      expectNoMutation();
    },
  );

  test('keeps a live ready event when a stale initial inventory arrives afterward', async () => {
    const inventory = deferred<LocalSpeechModelListResult>();
    list.mockReturnValue(inventory.promise);
    render(button());
    publish(selectedStatus(LocalSpeechModelKind.Tts, 'ready'));

    await act(async () =>
      inventory.resolve({ supported: true, models: [selectedStatus(LocalSpeechModelKind.Tts)] }),
    );

    expect(screen.queryByRole('button', { name: warningName })).toBeNull();
    publish(selectedStatus(LocalSpeechModelKind.Tts));
    expect(screen.getByRole('button', { name: warningName })).toBeTruthy();
  });

  test.each([
    {
      kind: LocalSpeechModelKind.Asr,
      key: 'sttModelId',
      alternateId: 'sherpa-onnx-whisper-base',
    },
    {
      kind: LocalSpeechModelKind.Tts,
      key: 'ttsModelId',
      alternateId: 'vits-icefall-zh-aishell3',
    },
  ] as const)(
    'follows the saved $kind selection after a config event without changing preferences',
    async ({ kind, key, alternateId }) => {
      list.mockResolvedValue({
        supported: true,
        models: [
          selectedStatus(LocalSpeechModelKind.Asr, 'ready'),
          selectedStatus(LocalSpeechModelKind.Tts, 'ready'),
          { id: alternateId, kind, phase: 'not-installed', installed: false },
        ],
      });
      await act(async () => {
        render(button(kind));
      });
      expect(screen.queryByRole('button', { name: warningName })).toBeNull();

      settings = { ...settings, [key]: alternateId };
      act(() => window.dispatchEvent(new Event('config-updated')));
      expect(screen.getByRole('button', { name: warningName })).toBeTruthy();
      publish(selectedStatus(kind, 'ready'));
      expect(screen.queryByRole('button', { name: warningName })).toBeNull();
      expectNoMutation();
    },
  );

  test('opens settings from either action without opening the surrounding extension card', async () => {
    const openDetails = vi.fn();
    render(<div onClick={openDetails}>{button()}</div>);
    fireEvent.click(await screen.findByRole('button', { name: warningName }));
    fireEvent.click(screen.getByRole('button', { name: settingsName }));

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(openDetails).not.toHaveBeenCalled();
    expectNoMutation();
  });

  test('disables both actions while another extension operation is busy', async () => {
    render(button(LocalSpeechModelKind.Tts, true));
    const warning = await screen.findByRole('button', { name: warningName });
    const settingsAction = screen.getByRole('button', { name: settingsName });

    expect((warning as HTMLButtonElement).disabled).toBe(true);
    expect((settingsAction as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(warning);
    fireEvent.click(settingsAction);
    expect(onOpen).not.toHaveBeenCalled();
    expectNoMutation();
  });

  test('stops observing saved settings and inventory when the card unmounts', async () => {
    const view = render(button());
    await screen.findByRole('button', { name: warningName });
    view.unmount();
    const reads = vi.mocked(configService.getConfig).mock.calls.length;

    act(() => window.dispatchEvent(new Event('config-updated')));

    expect(configService.getConfig).toHaveBeenCalledTimes(reads);
    expect(listeners.size).toBe(0);
  });
});
