// @vitest-environment jsdom

import {
  AppInitializationActivity,
  AppInitializationPhase,
  AppInitializationStep,
} from '@shared/app/initialization';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import InitializationScreen from './InitializationScreen';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

test('routes subsequent launches to their compact screen without setup steps', () => {
  const view = render(<InitializationScreen state={{ ...state, firstLaunch: false }} />);
  expect(view.container.querySelector('[data-startup-view="launch"]')).toBeTruthy();
  expect(view.container.querySelector('[data-startup-view="first-launch"]')).toBeNull();
  expect(screen.queryByText('startupStep_userData')).toBeNull();
  expect(screen.getByText('startupActivity_defaultFiles')).toBeTruthy();
  expect(screen.queryByText('initializationUserData')).toBeNull();
  expect(screen.queryByText('firstLaunchTitle')).toBeNull();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
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
