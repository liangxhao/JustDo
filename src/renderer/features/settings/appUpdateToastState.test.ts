import type { AppUpdateState } from '@shared/appUpdate';
import { describe, expect, test } from 'vitest';

import { type AppUpdateToastState, selectAppUpdateToastState } from './appUpdateToastState';

const updateState = (
  revision: number,
  phase: AppUpdateState['phase'],
  errorCode?: AppUpdateState['errorCode'],
): AppUpdateState => ({
  revision,
  phase,
  currentVersion: 'v2026.8.10',
  availableVersion: 'v2026.8.11',
  errorCode,
});

describe('selectAppUpdateToastState', () => {
  test('shows a reminder as soon as an update is available', () => {
    expect(selectAppUpdateToastState(null, updateState(3, 'available'), null)).toEqual({
      state: updateState(3, 'available'),
      installing: false,
      installError: false,
    });
  });

  test('advances the reminder through downloading and downloaded states', () => {
    const available = selectAppUpdateToastState(null, updateState(3, 'available'), null);
    const downloading = selectAppUpdateToastState(available, updateState(4, 'downloading'), null);
    const downloaded = selectAppUpdateToastState(downloading, updateState(5, 'downloaded'), null);

    expect(downloading?.state.phase).toBe('downloading');
    expect(downloaded?.state.phase).toBe('downloaded');
  });

  test('does not restore a dismissed reminder from the same snapshot', () => {
    expect(selectAppUpdateToastState(null, updateState(3, 'available'), 3)).toBeNull();
  });

  test('does not let an older snapshot reset an installation in progress', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloaded'),
      installing: true,
      installError: false,
    };

    expect(selectAppUpdateToastState(current, updateState(3, 'downloaded'), null)).toBe(current);
  });

  test('keeps a download failure visible and retryable', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloading'),
      installing: false,
      installError: false,
    };

    expect(
      selectAppUpdateToastState(current, updateState(5, 'error', 'DOWNLOAD_FAILED'), null),
    ).toMatchObject({
      state: { phase: 'error', errorCode: 'DOWNLOAD_FAILED' },
      installing: false,
      installError: false,
    });
  });

  test('surfaces an updater error after installation was requested', () => {
    const current: AppUpdateToastState = {
      state: updateState(4, 'downloaded'),
      installing: true,
      installError: false,
    };

    expect(
      selectAppUpdateToastState(current, updateState(5, 'error', 'INSTALL_FAILED'), null),
    ).toMatchObject({
      installing: false,
      installError: true,
    });
  });
});
