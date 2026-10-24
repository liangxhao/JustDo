// @vitest-environment jsdom

import {
  AppInitializationActivity,
  AppInitializationPhase,
  AppInitializationStep,
} from '@shared/app/initialization';
import { HistoryRecoveryKind } from '@shared/app/startup/history';
import { StartupRoute } from '@shared/app/startup/routing';
import { StartupCompatibilityErrorCode } from '@shared/app/startup/versionPolicy';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import InitializationScreen from './InitializationScreen';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'electron');
});

const startedAt = Date.now();
const state = {
  phase: AppInitializationPhase.Preparing,
  step: AppInitializationStep.Configuration,
  completedSteps: 2,
  totalSteps: 4,
  firstLaunch: true,
  userDataPath: 'C:\\Users\\用户\\AppData\\Roaming\\Product',
  activity: AppInitializationActivity.DefaultFiles,
  startedAt,
  activityStartedAt: startedAt,
  updatedAt: startedAt,
};

test('shows real completed milestones and the active initialization step', () => {
  const view = render(<InitializationScreen state={state} />);
  expect(view.container.querySelector('[data-startup-view="first-launch"]')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="launch"]')).toBeNull();
  const progress = screen.getByRole('progressbar');
  expect(progress.getAttribute('aria-valuenow')).toBe('2');
  expect(progress.getAttribute('aria-valuemax')).toBe('4');
  expect(screen.getByText('initializationConfiguration')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('routes subsequent launches to their compact screen with startup milestones', () => {
  const view = render(<InitializationScreen state={{ ...state, firstLaunch: false }} />);
  expect(view.container.querySelector('[data-startup-view="launch"]')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="first-launch"]')).toBeNull();
  expect(screen.getByText('startupStep_userData')).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(screen.getByText('startupActivity_defaultFiles')).toBeTruthy();
  expect(screen.queryByText('initializationUserData')).toBeNull();
  expect(screen.queryByText('firstLaunchTitle')).toBeNull();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
});

test.each([
  [StartupCompatibilityErrorCode.VersionUnconfirmed, 'startupCompatibilityUnknown'],
  [StartupCompatibilityErrorCode.NativeSchemaUnsupported, 'startupCompatibilitySchema'],
])(
  'explains %s in both startup presentations without offering a compatibility override',
  async (code, key) => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        initialization: { relaunch: vi.fn().mockResolvedValue(undefined) },
        log: { getPath: vi.fn().mockResolvedValue('') },
      },
    });
    for (const firstLaunch of [true, false]) {
      const view = render(
        <InitializationScreen
          state={{
            ...state,
            firstLaunch,
            route: firstLaunch ? StartupRoute.Upgrade : StartupRoute.Normal,
            phase: AppInitializationPhase.Failed,
            error: 'raw native compatibility error',
            failure: {
              source: 'main',
              occurredAt: startedAt,
              context: {},
              error: { name: 'Error', message: 'raw native compatibility error', code },
            },
          }}
        />,
      );
      await act(async () => {});
      expect(screen.getByRole('alert').textContent).toContain(key);
      expect(screen.getByRole('alert').textContent).toContain(`${key}Description`);
      expect(screen.getByText('raw native compatibility error')).toBeTruthy();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(view.container.querySelector('[data-failed="true"]')).toBeTruthy();
      expect(
        view.container.querySelector(
          firstLaunch ? '[data-startup-view="upgrade"]' : '[data-startup-view="launch"]',
        ),
      ).toBeTruthy();
      view.unmount();
    }
  },
);

test.each([
  AppInitializationActivity.NativeInspect,
  AppInitializationActivity.NativeBackup,
  AppInitializationActivity.NativeUpgrade,
  AppInitializationActivity.NativeVerify,
])('shows the real normal-upgrade operation %s while retaining existing data', activity => {
  const view = render(
    <InitializationScreen
      state={{
        ...state,
        route: StartupRoute.Upgrade,
        step: AppInitializationStep.DatabaseUpgrade,
        activity,
        completedSteps: 0,
        totalSteps: 5,
      }}
    />,
  );
  expect(view.container.querySelector('[data-startup-view="upgrade"]')).toBeTruthy();
  expect(screen.getByText('initializationNormalUpgradeTitle')).toBeTruthy();
  expect(screen.getByText('initializationRetainedData')).toBeTruthy();
  expect(screen.getByText(`initializationActivity_${activity}`)).toBeTruthy();
  expect(screen.getByText('initializationNormalUpgradeDescription')).toBeTruthy();
  expect(screen.queryByText('initializationBackup')).toBeNull();
  expect(screen.queryByText('initializationHistory')).toBeNull();
  expect(screen.queryByText('firstLaunchTitle')).toBeNull();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('5');
});

test('keeps a failed database upgrade in its owning guide with a retry and no restoration result', async () => {
  const relaunch = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      initialization: { route: StartupRoute.Upgrade, relaunch },
      log: { getPath: vi.fn().mockResolvedValue('') },
    },
  });
  const view = render(
    <InitializationScreen
      state={{
        ...state,
        route: StartupRoute.Upgrade,
        step: AppInitializationStep.DatabaseUpgrade,
        activity: AppInitializationActivity.NativeUpgrade,
        completedSteps: 0,
        totalSteps: 5,
        phase: AppInitializationPhase.Failed,
        error: 'maintenance lease unavailable',
      }}
    />,
  );
  expect(screen.getByRole('alert').textContent).toBe('maintenance lease unavailable');
  fireEvent.click(screen.getByRole('button'));
  expect(relaunch).toHaveBeenCalledOnce();
  expect(view.container.querySelector('[data-startup-view="upgrade"]')).toBeTruthy();
  expect(screen.queryByText('initializationResultTitle')).toBeNull();
});

test('explains a busy normal-upgrade database without showing history migration instructions', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      platform: 'win32',
      initialization: { route: StartupRoute.Upgrade },
      log: { getPath: vi.fn().mockResolvedValue('') },
    },
  });
  render(
    <InitializationScreen
      state={{
        ...state,
        route: StartupRoute.Upgrade,
        phase: AppInitializationPhase.Failed,
        historyRecovery: HistoryRecoveryKind.Busy,
        error: 'database owner is active',
      }}
    />,
  );
  expect(screen.getByText('initializationDatabaseRecovery_busy')).toBeTruthy();
  expect(screen.queryByText('initializationRecovery_busy')).toBeNull();
  expect(screen.queryByText('initializationUpgradeDescription')).toBeNull();
});

test('keeps a subsequent-launch failure out of the first-launch guide', () => {
  const view = render(
    <InitializationScreen
      state={{
        ...state,
        firstLaunch: false,
        phase: AppInitializationPhase.Failed,
        error: 'startup failed',
      }}
    />,
  );
  expect(view.container.querySelector('[data-startup-view="launch"]')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="first-launch"]')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('startup failed');
});

test('updates elapsed time without inventing progress, and resets the wait hint on a real activity', () => {
  vi.useFakeTimers();
  vi.setSystemTime(state.startedAt);
  const view = render(<InitializationScreen state={state} />);
  act(() => {
    vi.advanceTimersByTime(31_000);
  });
  expect(screen.getByText('initializationLongWait')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  expect(screen.getAllByText('00:31').length).toBe(2);

  view.rerender(
    <InitializationScreen
      state={{
        ...state,
        activity: AppInitializationActivity.StartupSettings,
        activityStartedAt: Date.now(),
        updatedAt: Date.now(),
      }}
    />,
  );
  expect(screen.queryByText('initializationLongWait')).toBeNull();
  expect(screen.getByText('initializationActivity_startupSettings')).toBeTruthy();
  expect(screen.getByText('00:00')).toBeTruthy();
  expect(screen.getByText('00:31')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(91_000);
  });
  expect(screen.getByText('initializationExtendedWait')).toBeTruthy();
});

test('preserves operation time across window handoff and freezes timers after failure', () => {
  vi.useFakeTimers();
  vi.setSystemTime(state.startedAt + 65_000);
  const view = render(<InitializationScreen state={state} />);
  expect(screen.getAllByText('01:05').length).toBe(2);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { log: { getPath: vi.fn().mockResolvedValue('') } },
  });
  view.rerender(
    <InitializationScreen
      state={{
        ...state,
        phase: AppInitializationPhase.Failed,
        updatedAt: Date.now(),
        error: 'failure',
      }}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.getAllByText('01:05').length).toBe(2);
  expect(screen.queryByText('initializationLongWait')).toBeNull();
  expect(view.container.querySelector('details')?.open).toBe(true);
});

test('retains partial progress and displays the error with a restart action', async () => {
  const relaunch = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      initialization: { relaunch },
      log: { getPath: vi.fn().mockResolvedValue('C:\\installed\\logs\\main.log') },
    },
  });
  render(
    <InitializationScreen
      state={{ ...state, phase: AppInitializationPhase.Failed, error: 'EACCES: user data' }}
    />,
  );
  expect(screen.getByRole('alert').textContent).toBe('EACCES: user data');
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  expect(await screen.findByText(/installed.*main\.log/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button'));
  expect(relaunch).toHaveBeenCalledOnce();
});
