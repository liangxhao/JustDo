// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { TaskStatus } from '@shared/scheduledTask/constants';
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { CronJobCard } from './CronView';
import { formatDateTime } from './utils';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: {},
}));

const runningAtMs = Date.parse('2026-11-02T01:00:00.000Z');
const previousRunAtMs = runningAtMs - 86_400_000;
const job: ScheduledTask = {
  id: 'report',
  name: 'Daily report',
  description: '',
  enabled: true,
  schedule: { kind: 'every', everyMs: 86_400_000 },
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'Prepare a report' },
  delivery: { mode: 'none' },
  agentId: 'main',
  sessionKey: null,
  management: 'editable',
  state: {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: TaskStatus.Running,
    lastError: null,
    lastDurationMs: null,
    runningAtMs,
    consecutiveErrors: 0,
  },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const callbacks = {
  onToggle: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onTrigger: vi.fn().mockResolvedValue(true),
  onHistory: vi.fn(),
  onDetails: vi.fn(),
};

function cardView(task: ScheduledTask, onTrigger = callbacks.onTrigger) {
  const cardStore = configureStore({ reducer: { agent: () => ({ agents: [] }) } });
  return (
    <Provider store={cardStore}>
      <CronJobCard job={task} {...callbacks} onTrigger={onTrigger} />
    </Provider>
  );
}

beforeEach(() => {
  i18nService.setLanguage('zh', { persist: false });
  vi.clearAllMocks();
});
afterEach(cleanup);

test('shows the first active execution without a previous run', () => {
  render(cardView(job));

  expect(screen.getByRole('status').textContent).toBe(
    `运行中: ${formatDateTime(new Date(runningAtMs))}`,
  );
  expect(screen.queryByText(/上次运行/)).toBeNull();
});

test('uses the current start time while a disabled task continues running', () => {
  render(
    cardView({
      ...job,
      enabled: false,
      state: { ...job.state, lastRunAtMs: previousRunAtMs, lastError: 'Previous error' },
    }),
  );

  const status = screen.getByRole('status');
  expect(status.textContent).toBe(`运行中: ${formatDateTime(new Date(runningAtMs))}`);
  expect(status.getAttribute('title')).toBeNull();
  expect(screen.queryByText(/上次运行/)).toBeNull();
});

test('returns to the native previous-run information after the active marker clears', () => {
  const view = render(cardView(job));
  expect(screen.getByRole('status')).toBeTruthy();

  view.rerender(
    cardView({
      ...job,
      state: { ...job.state, runningAtMs: null, lastRunAtMs: null, lastStatus: null },
    }),
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/上次运行/)).toBeNull();

  view.rerender(
    cardView({
      ...job,
      state: {
        ...job.state,
        runningAtMs: null,
        lastRunAtMs: runningAtMs,
        lastStatus: TaskStatus.Success,
      },
    }),
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText(/上次运行/).textContent).toBe(
    `上次运行: ${formatDateTime(new Date(runningAtMs))} · ${i18nService.t('scheduledTasksStatusSuccess')}`,
  );
});

test('does not treat a pending or enqueued manual request as active execution', async () => {
  let enqueue!: (value: boolean) => void;
  const onTrigger = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        enqueue = resolve;
      }),
  );
  render(
    cardView({ ...job, state: { ...job.state, runningAtMs: null, lastStatus: null } }, onTrigger),
  );

  fireEvent.click(screen.getByRole('button', { name: i18nService.t('cronCardRunNow') }));
  expect(onTrigger).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => {
    enqueue(true);
  });
  expect(screen.queryByRole('status')).toBeNull();
});

test('does not display a stale running status without its native active marker', () => {
  render(
    cardView({
      ...job,
      state: { ...job.state, runningAtMs: null, lastRunAtMs: previousRunAtMs },
    }),
  );

  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/运行中/)).toBeNull();
  expect(screen.getByText(/上次运行/).textContent).toBe(
    `上次运行: ${formatDateTime(new Date(previousRunAtMs))}`,
  );
});
