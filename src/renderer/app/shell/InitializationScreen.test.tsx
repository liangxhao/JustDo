// @vitest-environment jsdom

import { AppInitializationPhase, AppInitializationStep } from '@shared/app/initialization';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import InitializationScreen from './InitializationScreen';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(cleanup);

const state = {
  phase: AppInitializationPhase.Preparing,
  step: AppInitializationStep.Configuration,
  completedSteps: 2,
  totalSteps: 4,
  firstLaunch: true,
  userDataPath: 'C:\\Users\\用户\\AppData\\Roaming\\Product',
};

test('shows real completed milestones and the active initialization step', () => {
  render(<InitializationScreen state={state} />);
  const progress = screen.getByRole('progressbar');
  expect(progress.getAttribute('aria-valuenow')).toBe('2');
  expect(progress.getAttribute('aria-valuemax')).toBe('4');
  expect(screen.getByText('initializationConfiguration')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
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
