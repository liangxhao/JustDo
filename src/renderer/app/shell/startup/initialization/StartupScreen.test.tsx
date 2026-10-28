// @vitest-environment jsdom
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
  AppInitializationTask,
  AppInitializationTaskStatus,
} from '@shared/app/initialization';
import { StartupFailureSource } from '@shared/app/startupFailure';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { startupTranslations } from '@/services/i18n/startupTranslations.mts';

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
    tasks: {
      [AppInitializationTask.UserData]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Configuration]: AppInitializationTaskStatus.Running,
    },
    startedAt: now,
    activityStartedAt: now,
    updatedAt: now,
  };
}

test('shows real startup task states without deriving completion from sequential Main counts', () => {
  const state = snapshot();
  const view = render(<StartupScreen state={state} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  expect(view.container.querySelectorAll('[data-status="complete"]')).toHaveLength(1);
  expect(screen.getByText(startupTranslations.zh.startupStep_engine)).toBeTruthy();
  expect(screen.getByText(startupTranslations.zh.startupStep_interface)).toBeTruthy();
  expect(screen.getByText(startupTranslations.zh.startupStep_userData)).toBeTruthy();
  expect(screen.queryByText(startupTranslations.zh.startupStep_runtime)).toBeNull();
  expect(screen.getByText(startupTranslations.zh.startupStep_configuration)).toBeTruthy();
  expect(screen.getByText(startupTranslations.zh.startupStep_integrations)).toBeTruthy();
  expect(screen.getByText(startupTranslations.zh.startupActivity_defaultFiles)).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/创建用户目录|准备本机数据|准备默认文件|首次启动/);
  view.rerender(
    <StartupScreen
      state={{
        ...state,
        step: AppInitializationStep.UserData,
        activity: AppInitializationActivity.Database,
        completedSteps: 0,
        tasks: { [AppInitializationTask.UserData]: AppInitializationTaskStatus.Running },
      }}
    />,
  );
  expect(screen.getByText(startupTranslations.zh.startupActivity_database)).toBeTruthy();
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
    tasks: {
      [AppInitializationTask.UserData]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Configuration]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Complete,
    },
  };
  const view = render(
    <StartupScreen state={state} rendererActivity={RendererStartupActivity.Conversations} />,
  );
  const statuses = () =>
    [...view.container.querySelectorAll('.startup-step')].map(step =>
      step.getAttribute('data-status'),
    );
  expect(statuses()).toEqual(['complete', 'complete', 'waiting', 'complete', 'running']);
  const engineStatus = { phase: EnginePhase.Starting, version: null, canRetry: false };
  view.rerender(
    <StartupScreen
      state={state}
      engineStatus={engineStatus}
      rendererActivity={RendererStartupActivity.Conversations}
    />,
  );
  expect(statuses()).toEqual(['complete', 'complete', 'running', 'complete', 'running']);
  view.rerender(
    <StartupScreen
      state={state}
      engineStatus={{ ...engineStatus, phase: EnginePhase.Error }}
      rendererActivity={RendererStartupActivity.Conversations}
    />,
  );
  expect(statuses()).toEqual(['complete', 'complete', 'failed', 'complete', 'running']);
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
  const engine = view.container.querySelectorAll('.startup-step')[2];
  expect(engine.getAttribute('data-status')).toBe('complete');
  expect(screen.getByRole('alert').textContent).toBe('Receipt could not be saved');
});

test('shows engine, local services and interface working concurrently and completing independently', () => {
  const state = {
    ...snapshot(),
    tasks: {
      [AppInitializationTask.UserData]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Configuration]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Running,
    },
  };
  const engineStatus = { phase: EnginePhase.Starting, version: null, canRetry: false };
  const props = { state, engineStatus, rendererActivity: RendererStartupActivity.Conversations };
  const view = render(<StartupScreen {...props} />);
  const statuses = () => [...view.container.querySelectorAll('.startup-step')]
    .map(step => step.getAttribute('data-status'));
  expect(statuses()).toEqual(['complete', 'complete', 'running', 'running', 'running']);
  expect(view.container.querySelector('[aria-current]')).toBeNull();

  view.rerender(<StartupScreen {...props} engineStatus={{ ...engineStatus, phase: EnginePhase.Running }} />);
  expect(statuses()).toEqual(['complete', 'complete', 'complete', 'running', 'running']);
  view.rerender(<StartupScreen {...props} rendererReady />);
  expect(statuses()).toEqual(['complete', 'complete', 'running', 'running', 'complete']);
  view.rerender(<StartupScreen {...props} state={{ ...state, tasks: {
    ...state.tasks, [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Complete,
  } }} />);
  expect(statuses()).toEqual(['complete', 'complete', 'running', 'complete', 'running']);

  view.rerender(<StartupScreen {...props} state={{ ...state,
    phase: AppInitializationPhase.Failed,
    error: 'Local services unavailable',
    tasks: { ...state.tasks, [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Failed },
    failure: {
      source: StartupFailureSource.Main, occurredAt: state.updatedAt, context: {},
      error: { name: 'Error', message: 'Local services unavailable' },
    },
  }} />);
  expect(statuses()).toEqual(['complete', 'complete', 'running', 'failed', 'running']);
});

test('replaces completed Renderer activity with the actual pending engine or services and a fresh activity clock', () => {
  vi.useFakeTimers();
  const now = Date.now();
  const state = {
    ...snapshot(),
    phase: AppInitializationPhase.Ready,
    activity: AppInitializationActivity.Finalize,
    startedAt: now - 100_000,
    activityStartedAt: now - 95_000,
    tasks: {
      [AppInitializationTask.UserData]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Configuration]: AppInitializationTaskStatus.Complete,
      [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Running,
    },
  };
  const engineStatus = { phase: EnginePhase.Starting, version: null, canRetry: false };
  const props = {
    state, engineStatus, rendererActivity: RendererStartupActivity.Conversations,
    rendererActivityStartedAt: now - 91_000,
  };
  const view = render(<StartupScreen {...props} />);
  expect(screen.getByRole('heading', { level: 2 }).textContent)
    .toBe(startupTranslations.zh.startupRenderer_conversations);
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);

  view.rerender(<StartupScreen {...props} rendererReady />);
  expect(screen.getByRole('heading', { level: 2 }).textContent)
    .toBe(startupTranslations.zh.startupActivity_engineStart);
  expect(view.container.querySelectorAll('.startup-step')[4].getAttribute('data-status')).toBe('complete');
  expect(screen.queryByText(startupTranslations.zh.startupRenderer_conversations)).toBeNull();
  expect(screen.queryByText(startupTranslations.zh.startupExtendedWait)).toBeNull();
  expect(screen.getByText('00:00')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
  expect(screen.getByRole('progressbar').classList.contains('startup-progress--indeterminate')).toBe(false);
  act(() => { vi.advanceTimersByTime(31_000); });
  expect(screen.getByText(startupTranslations.zh.startupLongWait)).toBeTruthy();

  const runningEngine = { ...engineStatus, phase: EnginePhase.Running };
  view.rerender(<StartupScreen {...props} rendererReady engineStatus={runningEngine} />);
  expect(screen.getByRole('heading', { level: 2 }).textContent)
    .toBe(startupTranslations.zh.startupActivity_integrations);
  expect(screen.queryByText(startupTranslations.zh.startupLongWait)).toBeNull();
  expect(screen.getByText('00:00')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.getByText('00:01')).toBeTruthy();

  view.rerender(<StartupScreen {...props} rendererReady engineStatus={runningEngine} state={{ ...state,
    tasks: { ...state.tasks, [AppInitializationTask.Integrations]: AppInitializationTaskStatus.Waiting },
  }} />);
  expect(screen.getByRole('heading', { level: 2 }).textContent)
    .toBe(startupTranslations.zh.startupPending);
});

test('does not treat pending engine preparation or renderer readiness as a running engine', () => {
  const state = { ...snapshot(), tasks: undefined, enginePreparationPending: true, completedSteps: 4 };
  const view = render(<StartupScreen state={state} rendererReady />);
  const statuses = () => [...view.container.querySelectorAll('.startup-step')]
    .map(step => step.getAttribute('data-status'));
  expect(statuses()).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'complete']);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('5');
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  view.rerender(<StartupScreen state={state} rendererReady engineError />);
  expect(statuses()).toEqual(['waiting', 'waiting', 'failed', 'waiting', 'complete']);
});

test('keeps real progress unchanged during a long wait and freezes at the failed operation', async () => {
  vi.useFakeTimers();
  const state = snapshot();
  const view = render(<StartupScreen state={state} />);
  act(() => {
    vi.advanceTimersByTime(95_000);
  });
  expect(screen.getByText(startupTranslations.zh.startupExtendedWait)).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
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
        tasks: {
          ...state.tasks,
          [AppInitializationTask.Configuration]: AppInitializationTaskStatus.Failed,
        },
      }}
    />,
  );
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.getAllByText('01:35')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toBe('EACCES');
  expect(view.container.querySelector('[data-status="failed"] .startup-step-name')?.textContent)
    .toBe(startupTranslations.zh.startupStep_configuration);
  expect(view.container.querySelectorAll('[data-status="complete"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '重新启动' }));
  expect(relaunch).toHaveBeenCalledOnce();
});
