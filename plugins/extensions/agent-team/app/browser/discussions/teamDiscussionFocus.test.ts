// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

import {
  acquireTeamDiscussionFocus,
  currentFocusedRoom,
  TEAM_ROOM_FOCUSED,
} from './teamDiscussionFocus';

it('does not let an older view release a newer room focus', () => {
  const changed = vi.fn();
  window.addEventListener(TEAM_ROOM_FOCUSED, changed);
  const releaseFirst = acquireTeamDiscussionFocus('first');
  const releaseSecond = acquireTeamDiscussionFocus('second');
  try {
    changed.mockClear();
    releaseFirst();
    expect(currentFocusedRoom()).toBe('second');
    expect(changed).not.toHaveBeenCalled();
    releaseSecond();
    expect(currentFocusedRoom()).toBeNull();
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: null }));
  } finally {
    releaseFirst();
    releaseSecond();
    window.removeEventListener(TEAM_ROOM_FOCUSED, changed);
  }
});

it('restores a still visible room when the covering discussion closes', () => {
  const releaseWorkspace = acquireTeamDiscussionFocus('workspace');
  const releaseDialog = acquireTeamDiscussionFocus('dialog');
  try {
    expect(currentFocusedRoom()).toBe('dialog');
    releaseDialog();
    expect(currentFocusedRoom()).toBe('workspace');
    releaseDialog();
    expect(currentFocusedRoom()).toBe('workspace');
  } finally {
    releaseWorkspace();
    releaseDialog();
  }
  expect(currentFocusedRoom()).toBeNull();
});
