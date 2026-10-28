// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import WorktreeSettingsPage from './WorktreeSettingsPage';

vi.mock('./WorktreePolicySettings', () => ({ default: () => null }));

const mocks = vi.hoisted(() => ({
  engine: { ready: true, pending: false, failed: false },
  state: { cowork: { config: { showWorktreeCheckbox: false } } },
  updateConfig: vi.fn(),
}));
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({ useEngineReadiness: () => mocks.engine }));
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
  mocks.engine = { ready: true, pending: false, failed: false };
});

test('opens without native list errors during startup and loads after execution admission', async () => {
  const list = vi.fn().mockResolvedValue({ success: true, value: [] });
  vi.stubGlobal('electron', { openclaw: { worktrees: { list } } });
  mocks.engine = { ready: false, pending: true, failed: false };
  const view = render(<WorktreeSettingsPage />);
  expect(screen.getByRole('status').textContent).toBe('enginePreparingContent');
  expect(screen.queryByText('worktreeEmpty')).toBeNull();
  expect(list).not.toHaveBeenCalled();
  mocks.engine = { ready: true, pending: false, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  await screen.findByText('worktreeEmpty');
  expect(list).toHaveBeenCalledOnce();
  const checkbox = screen.getByRole('checkbox');
  mocks.engine = { ready: false, pending: true, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  expect(checkbox.closest('[inert]')).not.toBeNull();
  mocks.engine = { ready: true, pending: false, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  expect(screen.getByRole('checkbox')).toBe(checkbox);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

test('rejects a retired list result and reloads once the engine recovers', async () => {
  let finishRetiredRead!: (value: unknown) => void;
  const list = vi.fn()
    .mockReturnValueOnce(new Promise(resolve => { finishRetiredRead = resolve; }))
    .mockResolvedValue({ success: true, value: [] });
  vi.stubGlobal('electron', { openclaw: { worktrees: { list } } });
  const view = render(<WorktreeSettingsPage />);
  mocks.engine = { ready: false, pending: true, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  await act(async () => finishRetiredRead({ success: false, error: 'retired connection' }));
  expect(screen.queryByRole('alert')).toBeNull();
  mocks.engine = { ready: true, pending: false, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  await screen.findByText('worktreeEmpty');
  expect(list).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('defers recovery reads until a submitted cleanup has settled without replaying it', async () => {
  let finishCleanup!: (value: unknown) => void;
  const list = vi.fn().mockResolvedValue({ success: true, value: [] });
  const clean = vi.fn(() => new Promise(resolve => { finishCleanup = resolve; }));
  vi.stubGlobal('electron', { openclaw: { worktrees: { list, clean } } });
  const view = render(<WorktreeSettingsPage />);
  await screen.findByText('worktreeEmpty');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeClean' }));
  mocks.engine = { ready: false, pending: true, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  mocks.engine = { ready: true, pending: false, failed: false };
  view.rerender(<WorktreeSettingsPage />);
  expect(list).toHaveBeenCalledOnce();
  await act(async () => finishCleanup({ success: false, error: 'cleanup outcome unknown' }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(clean).toHaveBeenCalledOnce();
  expect(screen.getByRole('alert').textContent).toBe('cleanup outcome unknown');
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

test('keeps cleanup busy until native completion and refreshes only after it', async () => {
  let finish!: (value: unknown) => void;
  const clean = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const list = vi.fn().mockResolvedValue({ success: true, value: [] });
  vi.stubGlobal('electron', { openclaw: { worktrees: { list, clean } } });
  render(<WorktreeSettingsPage />);
  await screen.findByText('worktreeEmpty');
  fireEvent.click(screen.getByRole('button', { name: 'worktreeClean' }));
  expect(
    (screen.getByRole('button', { name: 'worktreeClean' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(list).toHaveBeenCalledTimes(1);
  finish({
    success: true,
    value: {
      jobId: 'native-job',
      state: 'completed',
      removed: [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
    },
  });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'worktreeClean' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(clean).toHaveBeenCalledOnce();
});

test.each(['unconfirmed', 'ipc-rejected'])(
  'keeps the list and releases busy after %s cleanup',
  async mode => {
    const list = vi.fn().mockResolvedValue({
      success: true,
      value: [
        {
          id: 'retained',
          name: 'keep-this',
          branch: 'openclaw/keep',
          path: '/tree',
          repoRoot: '/repo',
          ownerKind: 'session',
          lastActiveAt: 1,
        },
      ],
    });
    const clean =
      mode === 'unconfirmed'
        ? vi.fn().mockResolvedValue({ success: false, error: 'Original task is unconfirmed' })
        : vi.fn().mockRejectedValue(new Error('IPC disconnected'));
    vi.stubGlobal('electron', { openclaw: { worktrees: { list, clean } } });
    render(<WorktreeSettingsPage />);
    await screen.findByText('keep-this');
    fireEvent.click(screen.getByRole('button', { name: 'worktreeClean' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      mode === 'unconfirmed' ? 'Original task is unconfirmed' : 'worktreeCleanupUnconfirmed',
    );
    expect(screen.getByText('keep-this')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('button', { name: 'worktreeClean' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(clean).toHaveBeenCalledOnce();
  },
);
