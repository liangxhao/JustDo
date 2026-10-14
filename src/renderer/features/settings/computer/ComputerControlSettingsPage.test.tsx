// @vitest-environment jsdom
import type { ExtensionChangedEvent } from '@shared/plugins/extensions';
import type { ComputerControlResult } from '@shared/security/computerControl';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import ComputerControlSettingsPage from './ComputerControlSettingsPage';

vi.mock('@/services/config', () => ({
  configService: {
    getConfig: () => ({ computerOverlayRemotePreview: false }),
    updateConfig: vi.fn(async () => {}),
  },
}));

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => translations.zh[key] ?? key },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(initial = false) {
  let enabled = initial;
  let changed: (value: ExtensionChangedEvent) => void = () => {};
  const get = vi.fn(async (): Promise<ComputerControlResult> => ({ success: true, enabled }));
  const setEnabled = vi.fn(async (value: boolean): Promise<ComputerControlResult> => {
    enabled = value;
    return { success: true, enabled };
  });
  const unsubscribe = vi.fn();
  vi.stubGlobal('electron', {
    extensions: {
      onChanged: (listener: typeof changed) => {
        changed = listener;
        return unsubscribe;
      },
    },
    openclaw: { computerControl: { get, setEnabled } },
  });
  return {
    get,
    setEnabled,
    unsubscribe,
    change: (value: boolean) => {
      enabled = value;
      changed({ extensionId: 'cua-computer', enabled: value });
    },
  };
}

test('shows only one switch and the current-conversation image requirement', async () => {
  const api = setup();
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch', { name: '允许电脑操控' });
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText('使用时，当前会话的模型需要支持图像。')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/openclaw|cua-computer/i);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('false'));
  expect(
    screen.getByRole('switch', { name: translations.zh.computerOverlayRemotePreview }),
  ).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  expect(
    screen.queryByRole('switch', { name: translations.zh.computerOverlayRemotePreview }),
  ).toBeNull();
  expect(api.setEnabled.mock.calls).toEqual([[true], [false]]);
  expect(api.get).toHaveBeenCalledOnce();
});

test.each([false, true])('shows immediate saving feedback from enabled=%s', async initial => {
  const api = setup(initial);
  let completeSave!: (result: ComputerControlResult) => void;
  api.setEnabled.mockReturnValueOnce(
    new Promise(resolve => {
      completeSave = resolve;
    }),
  );
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch', { name: translations.zh.computerControlEnable });
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(toggle);
  fireEvent.click(toggle);

  expect(screen.getByRole('status').textContent).toBe(translations.zh.computerControlSaving);
  expect(toggle.getAttribute('aria-busy')).toBe('true');
  expect(toggle.getAttribute('aria-checked')).toBe(String(initial));
  expect((toggle as HTMLButtonElement).disabled).toBe(true);
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith(!initial);

  await act(async () => completeSave({ success: true, enabled: !initial }));

  await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('false'));
  expect(toggle.getAttribute('aria-checked')).toBe(String(!initial));
  expect((toggle as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole('status')).toBeNull();
  expect(api.get).toHaveBeenCalledOnce();
});

test('defers and combines refreshes during a save, then shows the observed state', async () => {
  const api = setup();
  let completeSave!: (result: ComputerControlResult) => void;
  api.setEnabled.mockReturnValueOnce(
    new Promise(resolve => {
      completeSave = resolve;
    }),
  );
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch');
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle);

  act(() => api.change(false));
  fireEvent(window, new Event('focus'));
  fireEvent(window, new Event('focus'));
  expect(api.get).toHaveBeenCalledOnce();
  expect(toggle.getAttribute('aria-busy')).toBe('true');

  await act(async () => completeSave({ success: true, enabled: true }));

  await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('false'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('ignores a refresh started before a successful save', async () => {
  const api = setup();
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch');
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  let completeRefresh!: (result: ComputerControlResult) => void;
  api.get.mockReturnValueOnce(
    new Promise(resolve => {
      completeRefresh = resolve;
    }),
  );
  fireEvent(window, new Event('focus'));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('false'));

  await act(async () => completeRefresh({ success: true, enabled: false }));

  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(api.get).toHaveBeenCalledTimes(2);
});

test('keeps the observed choice after a failed write and displays a readable error', async () => {
  const api = setup();
  api.setEnabled.mockResolvedValue({ success: false, code: 'conflict' });
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch');
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle);
  expect(await screen.findByRole('alert')).toBeTruthy();
  await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('false'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});

test('reloads persisted state when the native apply fails after a successful write', async () => {
  const api = setup();
  api.setEnabled.mockImplementation(async value => {
    api.get.mockResolvedValue({ success: true, enabled: value });
    return { success: false, code: 'unavailable' };
  });
  render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch');
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

test('disables the switch when loading fails and allows retry', async () => {
  const api = setup();
  api.get.mockRejectedValueOnce(new Error('disconnected'));
  render(<ComputerControlSettingsPage />);
  await screen.findByRole('alert');
  const toggle = screen.getByRole('switch');
  expect((toggle as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: translations.zh.retry }));
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('tracks external extension changes and unsubscribes on leaving the page', async () => {
  const api = setup();
  const view = render(<ComputerControlSettingsPage />);
  const toggle = screen.getByRole('switch');
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  api.change(true);
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  view.unmount();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
});
