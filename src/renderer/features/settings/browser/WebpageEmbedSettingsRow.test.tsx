// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import WebpageEmbedSettingsRow from './WebpageEmbedSettingsRow';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const getSettings = vi.fn();
const saveSettings = vi.fn();
const value = { allowExternalEmbedUrls: false, revision: 'native-revision', applied: true };
const toggle = () => screen.getByRole('switch', { name: 'browserWebpageEmbedTitle' });
const deferred = <T,>() => {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({ success: true, value });
  saveSettings.mockReset();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { webpageEmbed: { getSettings, saveSettings } },
  });
});
afterEach(cleanup);

it('reads the existing native preference without writing it on open', async () => {
  getSettings.mockResolvedValue({ success: true, value: { ...value, allowExternalEmbedUrls: true } });
  render(<WebpageEmbedSettingsRow />);
  await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
  expect(saveSettings).not.toHaveBeenCalled();
});

it('saves the toggle immediately using the read revision and waits for confirmation', async () => {
  const saving = deferred<unknown>();
  saveSettings.mockReturnValue(saving.promise);
  render(<WebpageEmbedSettingsRow />);
  await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle());
  expect(saveSettings).toHaveBeenCalledWith({ allowExternalEmbedUrls: true, revision: 'native-revision' });
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle());
  expect(saveSettings).toHaveBeenCalledTimes(1);

  await act(async () => saving.resolve({ success: true, value: { ...value, allowExternalEmbedUrls: true, revision: 'new' } }));
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect((toggle() as HTMLButtonElement).disabled).toBe(false);
  saveSettings.mockResolvedValue({ success: true, value: { ...value, revision: 'third' } });
  fireEvent.click(toggle());
  await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ allowExternalEmbedUrls: false, revision: 'new' }));
});

it('requires a fresh read after an uncertain save and never retries the write', async () => {
  saveSettings.mockRejectedValue(new Error('disconnected after write'));
  render(<WebpageEmbedSettingsRow />);
  await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle());
  await screen.findByText('browserWebpageEmbedError_unknown');
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  getSettings.mockResolvedValue({ success: true, value: { ...value, allowExternalEmbedUrls: true, revision: 'confirmed' } });
  fireEvent.click(screen.getByRole('button', { name: 'browserWebpageEmbedReload' }));
  await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
  expect(saveSettings).toHaveBeenCalledTimes(1);
});

it('shows a native revision conflict and disables edits until refreshed', async () => {
  saveSettings.mockResolvedValue({ success: false, code: 'conflict' });
  render(<WebpageEmbedSettingsRow />);
  await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle());
  await screen.findByText('browserWebpageEmbedError_conflict');
  expect(toggle().getAttribute('aria-checked')).toBe('false');
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
});

it('keeps unavailable settings disabled and lets the user reload after connecting', async () => {
  getSettings.mockResolvedValueOnce({ success: false, code: 'unavailable' });
  render(<WebpageEmbedSettingsRow />);
  await screen.findByText('browserWebpageEmbedError_unavailable');
  expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'browserWebpageEmbedReload' }));
  await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  expect(saveSettings).not.toHaveBeenCalled();
});

it('does not claim that a saved pending configuration is already applied', async () => {
  saveSettings.mockResolvedValue({ success: true, value: { ...value, allowExternalEmbedUrls: true, applied: false } });
  render(<WebpageEmbedSettingsRow />);
  await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(toggle());
  await screen.findByText('browserWebpageEmbedPending');
  getSettings.mockResolvedValue({ success: true, value: { ...value, allowExternalEmbedUrls: true } });
  fireEvent.click(screen.getByRole('button', { name: 'browserWebpageEmbedReload' }));
  await waitFor(() => expect(screen.queryByText('browserWebpageEmbedPending')).toBeNull());
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(saveSettings).toHaveBeenCalledTimes(1);
});

it('ignores a stale read when StrictMode mounts the row again', async () => {
  const stale = deferred<unknown>();
  getSettings.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ success: true, value: { ...value, allowExternalEmbedUrls: true } });
  render(<StrictMode><WebpageEmbedSettingsRow /></StrictMode>);
  await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
  await act(async () => stale.resolve({ success: true, value }));
  expect(toggle().getAttribute('aria-checked')).toBe('true');
});
