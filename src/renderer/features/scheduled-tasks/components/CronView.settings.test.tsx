// @vitest-environment jsdom
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';

import { CronView } from './CronView';

const engine = vi.hoisted(() => ({ ready: true, pending: false, failed: false }));
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  useEngineReadiness: () => engine,
}));
vi.mock('./ResultInbox', () => ({ default: () => <div>result-inbox</div> }));
const state = {
  model: { availableModels: [] },
  scheduledTask: {
    tasks: [] as ScheduledTask[],
    loading: false,
    error: null as string | null,
    unreadResultCount: 0,
    runs: {},
    runsHasMore: {},
    runsNextOffset: {},
  },
  agent: { agents: [] as { id: string; name: string; deletedAt?: number }[] },
};
vi.mock('react-redux', () => ({
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
vi.mock('@/app/shell/window/WindowTitleBar', () => ({ default: () => null }));
vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: {
    loadTasks: vi.fn(),
    loadRuns: vi.fn().mockResolvedValue(undefined),
    listChannels: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('./memoryDreamingControl', async importOriginal => ({
  ...(await importOriginal<typeof import('./memoryDreamingControl')>()),
  useMemoryDreamingControl: () => ({
    settings: { memoryDreamingEnabled: false, memoryAvailable: true },
    busy: false,
    failed: false,
    toggle: vi.fn(),
  }),
  withMemoryDreamingCard: (tasks: unknown[]) => tasks,
}));
vi.mock('./SchedulerSettingsDialog', () => ({
  default: ({
    onSaved,
    onClose,
  }: {
    onSaved: (settings: { enabled: boolean }) => void;
    onClose: () => void;
  }) => (
    <button
      onClick={() => {
        onSaved({ enabled: false });
        onClose();
      }}
    >
      save-paused
    </button>
  ),
}));
afterEach(() => {
  cleanup();
  state.scheduledTask.tasks = [];
  state.scheduledTask.error = null;
  state.agent.agents = [];
});
beforeEach(() => {
  Object.assign(engine, { ready: true, pending: false, failed: false });
  vi.clearAllMocks();
});

test('allows task navigation while preparation defers native reads and content', () => {
  Object.assign(engine, { ready: false, pending: true });
  const getSchedulerSettings = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: { getSchedulerSettings } },
  });
  const { rerender } = render(<CronView />);
  expect(screen.getByRole('status').textContent).toBe('enginePreparingContent');
  expect(screen.queryByText('cronEmptyTitle')).toBeNull();
  expect(screen.queryByText('cronNewTask')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'schedulerSettingsTitle' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'scheduledTasksTabResults' }));
  expect(screen.queryByText('result-inbox')).toBeNull();
  expect(scheduledTaskService.loadTasks).not.toHaveBeenCalled();
  expect(getSchedulerSettings).not.toHaveBeenCalled();

  Object.assign(engine, { pending: false, failed: true });
  rerender(<CronView />);
  expect(screen.getByRole('status').textContent).toBe('engineUnavailableContent');
  Object.assign(engine, { ready: true, failed: false });
  getSchedulerSettings.mockResolvedValue({ success: false });
  rerender(<CronView />);
  expect(screen.getByText('result-inbox')).toBeTruthy();
  expect(scheduledTaskService.loadTasks).toHaveBeenCalledOnce();
});

test('preserves a task draft while restart preparation blocks its native actions', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: {} },
  });
  const { rerender } = render(<CronView />);
  fireEvent.click(screen.getByRole('button', { name: 'cronNewTask' }));
  const input = screen.getByPlaceholderText('cronDialogTaskNamePlaceholder') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Unsaved report' } });
  Object.assign(engine, { ready: false, pending: true });
  rerender(<CronView />);
  expect(input.closest('[inert]')).toBeTruthy();
  const resultTab = screen.getByRole('button', { name: 'scheduledTasksTabResults' }) as HTMLButtonElement;
  expect(resultTab.disabled).toBe(true);
  fireEvent.click(resultTab);
  expect(screen.queryByText('result-inbox')).toBeNull();
  Object.assign(engine, { ready: true, pending: false });
  rerender(<CronView />);
  expect(screen.getByPlaceholderText('cronDialogTaskNamePlaceholder')).toBe(input);
  expect(input.value).toBe('Unsaved report');
  expect(input.closest('[inert]')).toBeNull();
});

test('does not report an empty inventory after a failed initial task read', () => {
  state.scheduledTask.error = 'Gateway unavailable';
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: {} },
  });
  render(<CronView />);
  expect(screen.getByText('Gateway unavailable')).toBeTruthy();
  expect(screen.queryByText('cronEmptyTitle')).toBeNull();
});

test('does not synthesize additional tasks from native memory settings', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: {} },
  });
  render(<CronView />);
  expect(screen.queryByTestId(/^cron-job-card-/)).toBeNull();
  expect(screen.getByText('cronEmptyTitle')).toBeTruthy();
  expect(state.scheduledTask.tasks).toEqual([]);
});

test('keeps native system-managed tasks available by their real history identity', async () => {
  const { withMemoryDreamingCard } =
    await vi.importActual<typeof import('./memoryDreamingControl')>('./memoryDreamingControl');
  const base = withMemoryDreamingCard([], {
    memoryDreamingEnabled: false,
    memoryAvailable: true,
  })[0];
  const managed = {
    ...base,
    id: 'maintenance-reviewer',
    name: 'Project maintenance',
    agentId: 'reviewer',
    declarationKey: 'maintenance:reviewer',
    payload: { kind: 'agentTurn' as const, message: 'Check project status' },
  };
  state.scheduledTask.tasks = [managed];
  state.agent.agents = [{ id: 'reviewer', name: 'Reviewer' }];
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: {} },
  });
  render(<CronView />);
  const card = screen.getByTestId('cron-job-card-maintenance-reviewer');
  expect(screen.getAllByTestId(/^cron-job-card-/)).toHaveLength(1);
  expect(within(card).queryByRole('switch')).toBeNull();
  expect(within(card).queryByRole('button', { name: 'cronDialogEditTitle' })).toBeNull();
  fireEvent.click(within(card).getByRole('button', { name: 'cronCardHistory' }));
  expect(scheduledTaskService.loadRuns).toHaveBeenCalledWith(managed.id);
  expect(state.scheduledTask.tasks).toEqual([managed]);
});

test('a delayed initial settings read does not overwrite the saved scheduling state', async () => {
  let resolveInitial!: (value: unknown) => void;
  const getSchedulerSettings = vi.fn(
    () =>
      new Promise(resolve => {
        resolveInitial = resolve;
      }),
  );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: { getSchedulerSettings } },
  });
  render(<CronView />);
  fireEvent.click(screen.getByRole('button', { name: 'schedulerSettingsTitle' }));
  fireEvent.click(screen.getByRole('button', { name: 'save-paused' }));
  expect(screen.getByText('schedulerSettingsPaused')).toBeTruthy();
  await act(async () => {
    resolveInitial({ success: true, snapshot: { settings: { enabled: true } } });
  });
  expect(screen.getByText('schedulerSettingsPaused')).toBeTruthy();
});
