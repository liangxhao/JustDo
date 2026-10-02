// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import WorktreeSettingsPage from './WorktreeSettingsPage';

vi.mock('./WorktreePolicySettings', () => ({ default: () => null }));

const mocks = vi.hoisted(() => ({
  state: { cowork: { config: { showWorktreeCheckbox: false } } },
  updateConfig: vi.fn(),
}));
vi.mock('react-redux', () => ({
  useSelector: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}));
vi.mock('@/features/cowork/coworkService', () => ({
  coworkService: { updateConfig: mocks.updateConfig },
}));

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.updateConfig.mockReset();
  mocks.state.cowork.config.showWorktreeCheckbox = false;
});

test('defaults to hiding the checkbox and persists the visibility preference', async () => {
  vi.stubGlobal('electron', {
    openclaw: { worktrees: { list: vi.fn().mockResolvedValue({ success: true, value: [] }) } },
  });
  mocks.updateConfig.mockResolvedValue(true);
  render(<WorktreeSettingsPage />);
  const checkbox = screen.getByRole('checkbox', {
    name: /worktreeShowCheckbox/,
  }) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(mocks.updateConfig).toHaveBeenCalledWith({ showWorktreeCheckbox: true }),
  );
});

test('reports a failed preference save without enabling the checkbox', async () => {
  vi.stubGlobal('electron', {
    openclaw: { worktrees: { list: vi.fn().mockResolvedValue({ success: true, value: [] }) } },
  });
  mocks.updateConfig.mockResolvedValue(false);
  render(<WorktreeSettingsPage />);
  await screen.findByText('worktreeEmpty');
  fireEvent.click(screen.getByRole('checkbox'));
  expect((await screen.findByRole('alert')).textContent).toBe('worktreePreferenceSaveFailed');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

test('lists native records and removes through the non-force Gateway action', async () => {
  const list = vi.fn().mockResolvedValue({
    success: true,
    value: [
      {
        id: 'tree-1',
        name: 'feature',
        branch: 'openclaw/feature',
        repoRoot: 'E:\\project',
        path: 'E:\\state\\worktrees\\feature',
        ownerKind: 'session',
        lastActiveAt: 1,
      },
    ],
  });
  const remove = vi.fn().mockResolvedValue({ success: true, value: { removed: true } });
  vi.stubGlobal('electron', {
    openclaw: {
      worktrees: {
        list,
        remove,
        restore: vi.fn(),
        clean: vi.fn(),
      },
    },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<WorktreeSettingsPage />);
  await screen.findByText('feature');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeRemove' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('tree-1'));
  expect(remove).toHaveBeenCalledTimes(1);
});

test('keeps a worktree visible when snapshot removal fails', async () => {
  const list = vi.fn().mockResolvedValue({
    success: true,
    value: [
      {
        id: 'tree-2',
        name: 'unfinished',
        branch: 'openclaw/unfinished',
        repoRoot: 'E:\\project',
        path: 'E:\\state\\unfinished',
        ownerKind: 'session',
        lastActiveAt: 1,
      },
    ],
  });
  const remove = vi.fn().mockResolvedValue({
    success: true,
    value: { removed: false, snapshotError: 'Snapshot could not be saved' },
  });
  vi.stubGlobal('electron', {
    openclaw: {
      worktrees: {
        list,
        remove,
        restore: vi.fn(),
        clean: vi.fn(),
      },
    },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<WorktreeSettingsPage />);
  await screen.findByText('unfinished');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeRemove' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Snapshot could not be saved');
  expect(screen.getByText('unfinished')).toBeTruthy();
  expect(remove).toHaveBeenCalledTimes(1);
});
