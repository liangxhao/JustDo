import type { AppUpdateState } from '@shared/appUpdate';
import { describe, expect, test } from 'vitest';

import { type AppUpdateToastState,selectAppUpdateToastState } from './appUpdateToastState';

const updateState = (revision: number, phase: AppUpdateState['phase']): AppUpdateState => ({
  revision,
  phase,
  currentVersion: 'v2026.8.10',
  availableVersion: 'v2026.8.11',
});

describe('selectAppUpdateToastState', () => {
  test('shows a reminder when an update has downloaded', () => {
    expect(selectAppUpdateToastState(null, updateState(3, 'downloaded'), null)).toEqual({
      state: updateState(3, 'downloaded'),
      installing: false,
      installError: false,
    });
  });

  test('does not restore a dismissed reminder from the same snapshot', () => {
    expect(selectAppUpdateToastState(null, updateState(3, 'downloaded'), 3)).toBeNull();
  });

  test('does not let an older snapshot reset an installation in progress', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloaded'),
      installing: true,
      installError: false,
    };

    expect(selectAppUpdateToastState(current, updateState(3, 'downloaded'), null)).toBe(current);
  });

  test('surfaces an updater error after installation was requested', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloaded'),
      installing: true,
      installError: false,
    };

    expect(selectAppUpdateToastState(current, updateState(5, 'error'), null)).toMatchObject({
      installing: false,
      installError: true,
    });
  });

  test('does not let an older error snapshot fail a newer installation request', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloaded'),
      installing: true,
      installError: false,
    };

    expect(selectAppUpdateToastState(current, updateState(3, 'error'), null)).toBe(current);
  });
});
