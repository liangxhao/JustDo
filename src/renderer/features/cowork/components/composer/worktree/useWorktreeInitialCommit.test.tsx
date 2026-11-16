// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useWorktreeInitialCommit } from './useWorktreeInitialCommit';

afterEach(() => vi.unstubAllGlobals());

test('revokes an offer on navigation and ignores a late confirmation that would resume the draft', async () => {
  let confirm!: (value: { success: boolean }) => void;
  const confirmWorktreeInitialCommit = vi.fn(
    () => new Promise<{ success: boolean }>(resolve => { confirm = resolve; }),
  );
  const dismissWorktreeInitialCommit = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('electron', {
    cowork: { confirmWorktreeInitialCommit, dismissWorktreeInitialCommit },
  });
  const { result } = renderHook(() => useWorktreeInitialCommit());
  let accepted!: Promise<boolean>;
  act(() => {
    accepted = result.current.requestConfirmation({
      id: 'offer-1',
      projectRoot: '/project',
      files: [{ path: 'README.md', staged: false }],
    });
  });
  const onConfirm = result.current.dialog!.onConfirm;
  act(() => {
    onConfirm(['README.md']);
    onConfirm(['README.md']);
  });
  expect(confirmWorktreeInitialCommit).toHaveBeenCalledExactlyOnceWith({
    id: 'offer-1', paths: ['README.md'],
  });

  act(() => result.current.finish(false));
  await expect(accepted).resolves.toBe(false);
  expect(dismissWorktreeInitialCommit).toHaveBeenCalledExactlyOnceWith('offer-1');

  await act(async () => confirm({ success: true }));
  expect(result.current.dialog).toBeUndefined();
});
