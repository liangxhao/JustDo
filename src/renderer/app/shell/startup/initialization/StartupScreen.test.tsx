// @vitest-environment jsdom
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { startupTranslations } from '@/services/i18n/startupTranslations';

import { RendererStartupActivity } from '../routing/startupPresentation';
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
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(view.container.querySelectorAll('[data-status="complete"]')).toHaveLength(2);
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

test.each([
  AppInitializationActivity.SessionInspect,
  AppInitializationActivity.SessionBackup,
  AppInitializationActivity.SessionPrepare,
  AppInitializationActivity.SessionVerify,
])('describes shared session preparation without schema-upgrade copy: %s', activity => {
  const view = render(<StartupScreen state={{ ...snapshot(), activity }} />);
  expect(view.container.textContent).not.toMatch(/本次升级|更新数据库结构|数据库更新结果/);
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
    startupTranslations.zh[`startupActivity_${activity}`],
  );
});

test('keeps engine and interface steps independent of Main completion', () => {
  const state = {
    ...snapshot(),
    phase: AppInitializationPhase.Ready,
    step: AppInitializationStep.Complete,
    completedSteps: 4,
  };
  const view = render(
    <StartupScreen state={state} rendererActivity={RendererStartupActivity.Conversations} />,
  );
  const statuses = () =>
    [...view.container.querySelectorAll('.startup-step')].map(step =>
      step.getAttribute('data-status'),
    );
  expect(statuses()).toEqual(['complete', 'complete', 'complete', 'waiting', 'running']);
  const engineStatus = { phase: EnginePhase.Starting, version: null, canRetry: false };
  view.rerender(
    <StartupScreen
      state={state}
      engineStatus={engineStatus}
      rendererActivity={RendererStartupActivity.Conversations}
    />,
  );
  expect(statuses()).toEqual(['complete', 'complete', 'complete', 'running', 'running']);
  view.rerender(
    <StartupScreen
      state={state}
      engineStatus={{ ...engineStatus, phase: EnginePhase.Error }}
      rendererActivity={RendererStartupActivity.Conversations}
    />,
  );
  expect(statuses()).toEqual(['complete', 'complete', 'complete', 'failed', 'running']);
  expect(
    view.container.querySelector('[data-status="failed"] .startup-step-marker')?.textContent,
  ).toBe('×');
  view.rerender(
    <StartupScreen
      state={{ ...state, phase: AppInitializationPhase.Failed, error: 'UI failed' }}
      engineStatus={{ ...engineStatus, phase: EnginePhase.Running }}
      rendererActivity={RendererStartupActivity.Conversations}
    />,
  );
  expect(statuses()).toEqual(['complete', 'complete', 'complete', 'complete', 'failed']);
  view.rerender(
    <StartupScreen
      state={state}
      rendererReady
      engineStatus={{ ...engineStatus, phase: EnginePhase.Running }}
    />,
  );
  expect(statuses()).toEqual(Array(5).fill('complete'));
  expect(view.container.querySelectorAll('.startup-step-marker')).toHaveLength(5);
});

test('does not attribute a Main finalization failure to an already running engine', () => {
  const view = render(
    <StartupScreen
      state={{
        ...snapshot(),
        phase: AppInitializationPhase.Failed,
        step: AppInitializationStep.Engine,
        completedSteps: 3,
        activity: AppInitializationActivity.Finalize,
        error: 'Receipt could not be saved',
      }}
      engineStatus={{ phase: EnginePhase.Running, version: null, canRetry: false }}
    />,
  );
  const engine = view.container.querySelectorAll('.startup-step')[3];
  expect(engine.getAttribute('data-status')).toBe('complete');
  expect(screen.getByRole('alert').textContent).toBe('Receipt could not be saved');
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
  expect(
    view.container.querySelector('[data-status="failed"] .startup-step-name')?.textContent,
  ).toBe(startupTranslations.zh.startupStep_configuration);
  expect(view.container.querySelectorAll('[data-status="complete"]')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '重新启动' }));
  expect(relaunch).toHaveBeenCalledOnce();
});
