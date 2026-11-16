// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, test } from 'vitest';

import cowork, {
  setSessionDirectory,
  setSessionWorktreeBinding,
} from '@/features/cowork/coworkSlice';
import { i18nService } from '@/services/i18n';

import { WorktreeSessionIndicator } from './WorktreeSessionIndicator';

afterEach(cleanup);

test('shows only the latest Worktree observation for the exact session binding', () => {
  const store = configureStore({ reducer: { cowork } });
  const sessionId = 'conversation';
  const nativeSessionKey = 'agent:main:workspace';
  const entry = { id: sessionId, status: 'idle' as const, pinned: false, createdAt: 1, updatedAt: 1 };
  const label = i18nService.t('worktreeSessionIndicator');
  store.dispatch(setSessionDirectory([{ ...entry, nativeSessionKey }]));
  render(
    <Provider store={store}>
      <WorktreeSessionIndicator nativeSessionKey={nativeSessionKey} sessionId={sessionId} />
    </Provider>,
  );
  const apply = (revision: number, isWorktree: boolean) => act(() => {
    store.dispatch(setSessionWorktreeBinding({
      sessionId,
      binding: { nativeSessionKey, isWorktree },
      revision,
    }));
  });

  expect(screen.queryByRole('img', { name: label })).toBeNull();
  apply(2, true);
  expect(screen.getByRole('img', { name: label }).getAttribute('title')).toBe(label);
  apply(1, false);
  expect(screen.getByRole('img', { name: label })).toBeTruthy();
  apply(3, false);
  expect(screen.queryByRole('img', { name: label })).toBeNull();

  act(() => {
    store.dispatch(setSessionDirectory([{ ...entry, nativeSessionKey: 'agent:main:other-workspace' }]));
  });
  apply(4, true);
  expect(screen.queryByRole('img', { name: label })).toBeNull();
});
