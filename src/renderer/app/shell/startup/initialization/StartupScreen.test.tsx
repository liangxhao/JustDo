// @vitest-environment jsdom
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { startupTranslations } from '@/services/i18n/startupTranslations';

import StartupScreen from './StartupScreen';

vi.mock('../../window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => {
      const dictionary: Record<string, string> = startupTranslations.zh;
      return dictionary[key] ?? key;
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function snapshot(): AppInitializationState {
  const now = Date.now();
  return {
    phase: AppInitializationPhase.Preparing,
    step: AppInitializationStep.Configuration,
    completedSteps: 2,
    totalSteps: 4,
    firstLaunch: false,
    userDataPath: 'C:\\existing-data',
    activity: AppInitializationActivity.DefaultFiles,
    startedAt: now,
    activityStartedAt: now,
    updatedAt: now,
  };
}

test('describes opening existing data and synchronizing runtime settings without setup copy', () => {
  const state = snapshot();
  const view = render(<StartupScreen state={state} />);
  expect(view.container.querySelector('ol')).toBeNull();
  expect(screen.getByText('同步 AI 运行配置')).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/创建用户目录|准备本机数据|准备默认文件|首次启动/);
  view.rerender(
    <StartupScreen
      state={{
        ...state,
        step: AppInitializationStep.UserData,
        activity: AppInitializationActivity.Database,
        completedSteps: 0,
      }}
    />,
  );
  expect(screen.getByText('打开本机数据库')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
});

test('keeps real progress unchanged during a long wait and freezes at the failed operation', async () => {
  vi.useFakeTimers();
  const state = snapshot();
  const view = render(<StartupScreen state={state} />);
  act(() => {
    vi.advanceTimersByTime(95_000);
  });
  expect(screen.getByText(startupTranslations.zh.startupExtendedWait)).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  const relaunch = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { initialization: { relaunch } },
  });
  view.rerender(
    <StartupScreen
      state={{
        ...state,
        phase: AppInitializationPhase.Failed,
        updatedAt: Date.now(),
        error: 'EACCES',
      }}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.getAllByText('01:35')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toBe('EACCES');
  fireEvent.click(screen.getByRole('button', { name: '重新启动' }));
  expect(relaunch).toHaveBeenCalledOnce();
});
