import type { AppUpdateState } from '@shared/appUpdate';
import { describe, expect, test } from 'vitest';

import { selectNewerAppUpdateState } from './appUpdateState';

const state = (revision: number, phase: AppUpdateState['phase']): AppUpdateState => ({
  revision,
  phase,
  currentVersion: '2026.7.23',
});

describe('selectNewerAppUpdateState', () => {
  test('does not let an older IPC response replace a newer updater event', () => {
    const downloaded = state(4, 'downloaded');
    const staleAvailable = state(3, 'available');

    expect(selectNewerAppUpdateState(downloaded, staleAvailable)).toBe(downloaded);
  });

  test('accepts newer states and same-revision snapshots', () => {
    const checking = state(1, 'checking');
    const downloading = state(2, 'downloading');

    expect(selectNewerAppUpdateState(checking, downloading)).toBe(downloading);
    expect(selectNewerAppUpdateState(downloading, { ...downloading })).toEqual(downloading);
  });
});
