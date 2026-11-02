// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { TaskStatus } from '@shared/scheduledTask/constants';
import type { ScheduledTask, ScheduledTaskRun } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import scheduledTaskReducer, {
  addOrUpdateRun,
  setRuns,
  setTasks,
  updateTaskState,
} from '@/features/scheduled-tasks/scheduledTaskSlice';
import { i18nService } from '@/services/i18n';

import TaskRunHistory from './TaskRunHistory';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: { loadRuns: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./RunSessionModal', () => ({ default: () => null }));

const runningAtMs = Date.parse('2026-11-02T01:00:00.000Z');
const task: ScheduledTask = {
  id: 'task',
  name: 'Daily report',
  description: '',
  enabled: true,
  schedule: { kind: 'every', everyMs: 60_000 },
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'Prepare a report' },
  delivery: { mode: 'none' },
  agentId: 'main',
  sessionKey: 'owner-session',
  management: 'editable',
  state: {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: TaskStatus.Success,
    lastError: null,
    lastDurationMs: null,
    runningAtMs,
    consecutiveErrors: 0,
  },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const completedRun: ScheduledTaskRun = {
  id: 'native-run',
  taskId: task.id,
  sessionId: 'native-session',
  sessionKey: 'native-session-key',
  status: TaskStatus.Success,
  summary: null,
  startedAt: new Date(runningAtMs).toISOString(),
  finishedAt: new Date(runningAtMs + 1000).toISOString(),
  durationMs: 1000,
  error: null,
  deliveryStatus: null,
  deliveryError: null,
};

function createHistoryStore(tasks = [task]) {
  const historyStore = configureStore({ reducer: { scheduledTask: scheduledTaskReducer } });
  historyStore.dispatch(setTasks(tasks));
  historyStore.dispatch(setRuns({ taskId: task.id, runs: [], hasMore: false, nextOffset: null }));
  return historyStore;
}

type HistoryStore = ReturnType<typeof createHistoryStore>;
type HistoryState = ReturnType<HistoryStore['getState']>;
type HistoryProps = Omit<React.ComponentProps<typeof TaskRunHistory>, 'taskId' | 'runs'>;

function History(props: HistoryProps) {
  const runs = useSelector((state: HistoryState) => state.scheduledTask.runs[task.id]);
  return <TaskRunHistory taskId={task.id} runs={runs} {...props} />;
}

function historyView(historyStore: HistoryStore, props: HistoryProps = {}) {
  return (
    <Provider store={historyStore}>
      <History {...props} />
    </Provider>
  );
}

beforeEach(() => {
  i18nService.setLanguage('zh', { persist: false });
  vi.clearAllMocks();
});
afterEach(cleanup);

test('shows the active run while native history loads or fails, without an invented session', () => {
  const historyStore = createHistoryStore();
  const view = render(historyView(historyStore, { loading: true }));

  expect(screen.getByText('运行中')).toBeTruthy();
  expect(screen.getByText(i18nService.t('loading'))).toBeTruthy();
  expect(view.container.querySelector('time')?.dateTime).toBe(new Date(runningAtMs).toISOString());
  expect(screen.queryByText(i18nService.t('scheduledTasksNoRuns'))).toBeNull();
  expect(screen.queryByText(i18nService.t('scheduledTasksViewSession'))).toBeNull();
  expect(historyStore.getState().scheduledTask.runs[task.id]).toEqual([]);

  const onRetry = vi.fn();
  view.rerender(historyView(historyStore, { loadError: true, onRetry }));
  expect(screen.getByText('运行中')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain(
    i18nService.t('scheduledTasksLoadRunsFailed'),
  );
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('scheduledTasksRetry') }));
  expect(onRetry).toHaveBeenCalledOnce();

  view.rerender(historyView(historyStore));
  expect(screen.getByText('运行中')).toBeTruthy();
  expect(screen.queryByText(i18nService.t('scheduledTasksNoRuns'))).toBeNull();
});

test('follows native start and finish updates while history remains open', () => {
  const historyStore = createHistoryStore([
    { ...task, state: { ...task.state, runningAtMs: null } },
  ]);
  render(historyView(historyStore));
  expect(screen.getByText(i18nService.t('scheduledTasksNoRuns'))).toBeTruthy();

  act(() => {
    historyStore.dispatch(updateTaskState({ taskId: task.id, taskState: task.state }));
  });
  expect(screen.getByText('运行中')).toBeTruthy();

  act(() => {
    historyStore.dispatch(
      updateTaskState({
        taskId: task.id,
        taskState: { ...task.state, runningAtMs: null },
      }),
    );
  });
  expect(screen.queryByText('运行中')).toBeNull();
  expect(screen.getByText(i18nService.t('scheduledTasksNoRuns'))).toBeTruthy();

  act(() => {
    historyStore.dispatch(addOrUpdateRun(completedRun));
  });
  expect(screen.queryByText(i18nService.t('scheduledTasksNoRuns'))).toBeNull();
  expect(
    screen.getByRole('img', { name: i18nService.t('scheduledTasksStatusSuccess') }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksViewSession') }),
  ).toBeTruthy();
});

test('keeps the active row outside native history pagination', () => {
  const historyStore = createHistoryStore();
  historyStore.dispatch(
    setRuns({
      taskId: task.id,
      runs: [completedRun],
      hasMore: true,
      nextOffset: 75,
    }),
  );
  render(historyView(historyStore));

  expect(screen.getByText('运行中')).toBeTruthy();
  expect(
    screen.getAllByRole('button', { name: i18nService.t('scheduledTasksViewSession') }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('scheduledTasksLoadMore') }));

  expect(scheduledTaskService.loadRuns).toHaveBeenCalledWith(task.id, 50, 75);
  expect(historyStore.getState().scheduledTask.runs[task.id]).toEqual([completedRun]);
});

test('does not infer active execution from another task or lastStatus alone', () => {
  const historyStore = createHistoryStore([
    { ...task, state: { ...task.state, runningAtMs: null, lastStatus: TaskStatus.Running } },
    { ...task, id: 'other-task' },
  ]);
  render(historyView(historyStore));

  expect(screen.queryByText('运行中')).toBeNull();
  expect(screen.getByText(i18nService.t('scheduledTasksNoRuns'))).toBeTruthy();
});
