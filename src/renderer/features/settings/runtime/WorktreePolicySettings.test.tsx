// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import WorktreePolicySettings from './WorktreePolicySettings';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const value = {
  root: null,
  effectiveRoot: 'E:\\state\\worktrees',
  acceleration: true,
  revision: 'viewed',
  applied: true,
};
const getSettings = vi.fn();
const saveSettings = vi.fn();
const selectDirectory = vi.fn();
beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({ success: true, value });
  saveSettings.mockReset();
  selectDirectory.mockReset();
  vi.stubGlobal('electron', {
    openclaw: { worktrees: { getSettings, saveSettings } },
    dialog: { selectDirectory },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('shows default settings and actual directory without writing', async () => {
  render(<WorktreePolicySettings />);
  expect(
    ((await screen.findByRole('textbox', { name: 'worktreeStorageRoot' })) as HTMLInputElement)
      .value,
  ).toBe('');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/E:\\state\\worktrees/)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'worktreeSaveSettings' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(saveSettings).not.toHaveBeenCalled();
});

test('saves a selected directory and acceleration using the displayed revision', async () => {
  const root = 'E:\\工作目录 with spaces';
  selectDirectory.mockResolvedValue({ success: true, path: root });
  saveSettings.mockResolvedValue({
    success: true,
    value: { ...value, root, effectiveRoot: root, acceleration: false, revision: 'new' },
  });
  render(<WorktreePolicySettings />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeChooseDirectory' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(root));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'worktreeSaveSettings' }));
  await screen.findByText('worktreeSettingsSaved');
  expect(saveSettings).toHaveBeenCalledWith({ root, acceleration: false, revision: 'viewed' });
});

test('restores the default directory only after an explicit save', async () => {
  getSettings.mockResolvedValue({
    success: true,
    value: { ...value, root: 'E:\\custom', effectiveRoot: 'E:\\custom' },
  });
  saveSettings.mockResolvedValue({ success: true, value });
  render(<WorktreePolicySettings />);
  await screen.findByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeUseDefaultRoot' }));
  expect(saveSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'worktreeSaveSettings' }));
  await waitFor(() =>
    expect(saveSettings).toHaveBeenCalledWith({
      root: null,
      acceleration: true,
      revision: 'viewed',
    }),
  );
});

test('retains edits on conflict and reloads the new native revision', async () => {
  saveSettings.mockResolvedValue({ success: false, code: 'conflict' });
  render(<WorktreePolicySettings />);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: 'E:\\new' } });
  fireEvent.click(screen.getByRole('button', { name: 'worktreeSaveSettings' }));
  expect((await screen.findByRole('alert')).textContent).toBe('worktreeSettingsError_conflict');
  expect((input as HTMLInputElement).value).toBe('E:\\new');
  getSettings.mockResolvedValue({ success: true, value: { ...value, revision: 'reloaded' } });
  fireEvent.click(screen.getByRole('button', { name: 'worktreeReloadSettings' }));
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(''));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'worktreeSaveSettings' }));
  await waitFor(() =>
    expect(saveSettings).toHaveBeenLastCalledWith({
      root: null,
      acceleration: false,
      revision: 'reloaded',
    }),
  );
});

test('does not call a saved but unapplied directory active', async () => {
  saveSettings.mockResolvedValue({
    success: true,
    value: { ...value, root: 'E:\\new', effectiveRoot: 'E:\\new', applied: false },
  });
  render(<WorktreePolicySettings />);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'E:\\new' } });
  fireEvent.click(screen.getByRole('button', { name: 'worktreeSaveSettings' }));
  await screen.findByText('worktreeSettingsPending');
  expect(screen.queryByText('worktreeSettingsSaved')).toBeNull();
  expect(screen.getByText(/worktreeConfiguredRoot/)).toBeTruthy();
});

test('allows retry after a connection failure without claiming settings were loaded', async () => {
  getSettings.mockRejectedValueOnce(new Error('disconnected'));
  render(<WorktreePolicySettings />);
  expect((await screen.findByRole('alert')).textContent).toBe('worktreeSettingsError_unavailable');
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'worktreeReloadSettings' }));
  await screen.findByRole('textbox');
  expect(screen.queryByRole('alert')).toBeNull();
});
