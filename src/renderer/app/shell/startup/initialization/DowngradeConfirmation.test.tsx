// @vitest-environment jsdom

import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
  type StartupDowngradeConfirmation,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { StartupCompatibilityErrorCode } from '@shared/app/startup/versionPolicy';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import InitializationScreen from './InitializationScreen';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electron');
});

const confirmation: StartupDowngradeConfirmation = {
  requestId: 'current-downgrade-request',
  source: { appVersion: 'v2027.1.2', runtimeVersion: 'v2027.1.1' },
  target: { appVersion: 'v2026.10.20', runtimeVersion: 'v2026.10.6' },
};
function snapshot(firstLaunch: boolean): AppInitializationState {
  const now = Date.now();
  return {
    route: firstLaunch ? StartupRoute.Upgrade : StartupRoute.Normal,
    firstLaunch,
    phase: AppInitializationPhase.Preparing,
    step: AppInitializationStep.DatabaseUpgrade,
    activity: AppInitializationActivity.NativeInspect,
    downgradeConfirmation: confirmation,
    completedSteps: 0,
    totalSteps: firstLaunch ? 5 : 4,
    startedAt: now,
    activityStartedAt: now,
    updatedAt: now,
    userDataPath: '/synthetic-profile',
  };
}
function bridge(confirmDowngrade = vi.fn().mockResolvedValue({ confirmed: false })) {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      initialization: { confirmDowngrade, relaunch: vi.fn().mockResolvedValue(undefined) },
      log: { getPath: vi.fn().mockResolvedValue('') },
    },
  });
  return confirmDowngrade;
}

test.each([true, false])(
  'waits for explicit downgrade continuation without advancing startup (guide=%s)',
  async firstLaunch => {
    let resolve!: (value: { confirmed: boolean }) => void;
    const confirm = bridge(
      vi.fn(
        () =>
          new Promise<{ confirmed: boolean }>(done => {
            resolve = done;
          }),
      ),
    );
    const state = snapshot(firstLaunch);
    const view = render(<InitializationScreen state={state} />);
    expect(screen.getByRole('heading', { name: 'startupDowngradeTitle' })).toBeTruthy();
    expect(screen.getByText(/v2027\.1\.2/)).toBeTruthy();
    expect(screen.getByText(/v2026\.10\.20/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'startupDowngradeContinue' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ requestId: confirmation.requestId });
    await act(async () => {
      resolve({ confirmed: true });
    });
    expect(
      screen.getByRole('button', { name: 'startupDowngradeContinuing' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('progressbar')).toBeNull();
    view.rerender(<InitializationScreen state={{ ...state, downgradeConfirmation: undefined }} />);
    expect(screen.queryByText('startupDowngradeTitle')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    view.rerender(
      <InitializationScreen
        state={{
          ...state,
          downgradeConfirmation: undefined,
          phase: AppInitializationPhase.Failed,
          error: 'Native schema 26 is not supported by this installation.',
          failure: {
            source: 'main',
            occurredAt: Date.now(),
            context: {},
            error: {
              name: 'Error',
              message: 'Native schema 26 is not supported by this installation.',
              code: StartupCompatibilityErrorCode.NativeSchemaUnsupported,
            },
          },
        }}
      />,
    );
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('startupCompatibilitySchema');
    expect(
      screen.getByText('Native schema 26 is not supported by this installation.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'startupDowngradeContinue' })).toBeNull();
  },
);

test.each(['stale', 'rejected'])(
  'keeps the confirmation visible when its exact request is %s',
  async kind => {
    const confirm = bridge(
      kind === 'stale'
        ? vi.fn().mockResolvedValue({ confirmed: false })
        : vi.fn().mockRejectedValue(new Error('trusted window admission refused')),
    );
    render(<InitializationScreen state={snapshot(true)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'startupDowngradeContinue' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('startupDowngradeContinueFailed');
    expect(
      screen.getByRole('button', { name: 'startupDowngradeContinue' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
  },
);
