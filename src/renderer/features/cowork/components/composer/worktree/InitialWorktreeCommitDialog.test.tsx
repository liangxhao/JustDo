// @vitest-environment jsdom
import type { WorktreeInitialCommitOffer } from '@shared/cowork/worktreeInitialCommit';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { InitialWorktreeCommitDialog } from './InitialWorktreeCommitDialog';

const offer: WorktreeInitialCommitOffer = {
  id: 'initial-commit-offer',
  projectRoot: 'C:\\Projects\\My Project',
  files: [
    { path: 'README.md', staged: true },
    { path: 'src/components/ProjectTree.tsx', staged: false },
    { path: 'src/components/PreviewPane.tsx', staged: false },
    { path: 'src/utils/paths.ts', staged: false },
    { path: 'docs/setup.md', staged: false },
  ],
};

const checkbox = (name: string) => screen.getByRole('checkbox', { name });
const expand = (path: string) =>
  fireEvent.click(
    screen.getByRole('button', {
      name: i18nService.t('worktreeInitialCommitExpandFolder').replace('{folder}', path),
    }),
  );
const collapse = (path: string) =>
  fireEvent.click(
    screen.getByRole('button', {
      name: i18nService.t('worktreeInitialCommitCollapseFolder').replace('{folder}', path),
    }),
  );
const confirm = () =>
  fireEvent.click(
    screen.getByRole('button', {
      name: i18nService.t('worktreeInitialCommitConfirm'),
    }),
  );

afterEach(cleanup);

test('keeps the exact checked paths through nested expansion, collapse and search', () => {
  const onConfirm = vi.fn();
  render(
    <InitialWorktreeCommitDialog
      offer={offer}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  expect(checkbox('README.md')).toHaveProperty('checked', true);
  expect(screen.queryByRole('checkbox', { name: 'src/components/ProjectTree.tsx' })).toBeNull();

  expand('src');
  expand('src/components');
  fireEvent.click(checkbox('src/components/ProjectTree.tsx'));
  expect(checkbox('src/components')).toHaveProperty('indeterminate', true);
  expect(checkbox('src')).toHaveProperty('indeterminate', true);
  collapse('src');

  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'preview' } });
  expect(screen.queryByRole('checkbox', { name: 'src/components/ProjectTree.tsx' })).toBeNull();
  // Bulk selection within search includes only matching files and retains previous selections.
  fireEvent.click(checkbox('src'));
  expect(checkbox('src/components/PreviewPane.tsx')).toHaveProperty('checked', true);
  expect(within(screen.getByRole('complementary')).getByText('ProjectTree.tsx')).toBeTruthy();
  fireEvent.change(search, { target: { value: '' } });
  expect(screen.queryByRole('checkbox', { name: 'src/components/PreviewPane.tsx' })).toBeNull();

  confirm();
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith([
    'README.md',
    'src/components/PreviewPane.tsx',
    'src/components/ProjectTree.tsx',
  ]);
});

test('allows an explicit empty commit and keeps the two footer actions locked while creating it', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const props = { offer: { ...offer, files: [] }, onCancel, onConfirm };
  const view = render(<InitialWorktreeCommitDialog {...props} busy={false} />);
  expect(screen.getByText(i18nService.t('worktreeInitialCommitEmptySelection'))).toBeTruthy();
  confirm();
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith([]);

  view.rerender(<InitialWorktreeCommitDialog {...props} busy />);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getAllByRole('button')).toHaveLength(2);
  expect(within(dialog).getByRole('button', { name: i18nService.t('cancel') })).toHaveProperty(
    'disabled',
    true,
  );
  expect(
    within(dialog).getByRole('button', { name: i18nService.t('worktreeInitialCommitCreating') }),
  ).toHaveProperty('disabled', true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onCancel).not.toHaveBeenCalled();

  view.rerender(<InitialWorktreeCommitDialog {...props} busy={false} error="Commit failed" />);
  expect(within(dialog).getByRole('alert').textContent).toBe('Commit failed');
  fireEvent.click(within(dialog).getByRole('button', { name: i18nService.t('cancel') }));
  expect(onCancel).toHaveBeenCalledOnce();
});
