// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask, ScheduledTaskResult } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';

import scheduledTaskReducer, { replaceResults } from '../scheduledTaskSlice';
import ResultInbox, { isResultTaskDeleted } from './ResultInbox';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  resolveVisibleResultTaskId: (_tasks: unknown[], taskId: string | null) => taskId,
  scheduledTaskService: {
    markResultRead: vi.fn().mockResolvedValue(undefined),
    setResultsFilter: vi.fn(),
    loadResults: vi.fn().mockResolvedValue(undefined),
    deleteResults: vi.fn().mockResolvedValue({ deletedIds: ['report-run'], failedIds: [] }),
  },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const result = {
  taskId: 'heartbeat-main',
  systemManaged: true,
} satisfies Pick<ScheduledTaskResult, 'taskId' | 'systemManaged'>;

describe('ResultInbox task presentation', () => {
  test('uses the assistant display name in results, task filters, and deletion confirmation', () => {
    i18nService.setLanguage('zh', { persist: false });
    const task: ScheduledTask = {
      id: 'maintenance-research',
      name: 'Project maintenance',
      description: '',
      agentId: 'research',
      management: 'managed',
      enabled: true,
      payload: { kind: 'agentTurn', message: 'Check project status' },
      declarationKey: 'maintenance:research',
      schedule: { kind: 'every', everyMs: 604_800_000 },
      sessionTarget: 'main',
      sessionKey: null,
      wakeMode: 'next-heartbeat',
      delivery: { mode: 'none' },
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '2026-09-23T00:00:00Z',
      updatedAt: '2026-09-23T00:00:00Z',
    };
    const run: ScheduledTaskResult = {
      id: 'maintenance-run',
      taskId: task.id,
      taskName: task.name,
      systemManaged: true,
      sessionId: null,
      sessionKey: null,
      status: 'success',
      summary: 'Checked project status',
      startedAt: task.createdAt,
      finishedAt: task.createdAt,
      durationMs: 10,
      error: null,
      deliveryStatus: null,
      deliveryError: null,
      observedAt: task.createdAt,
      readAt: null,
    };
    const initial = scheduledTaskReducer(undefined, { type: '@@init' });
    const store = configureStore({
      reducer: {
        scheduledTask: () => ({
          ...initial,
          tasks: [task],
          results: [run],
          resultFilter: { ...initial.resultFilter, includeSystem: true },
        }),
        agent: () => ({ agents: [{ id: 'research', name: '研究助手' }] }),
      },
    });
    render(createElement(Provider, { store, children: createElement(ResultInbox) }));

    const title = task.name;
    expect(screen.getByRole('option', { name: title + ' · @研究助手' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText('@研究助手')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsDelete') }),
    );
    expect(
      screen.getByText(
        i18nService.t('scheduledTasksResultsDeleteConfirm').replace('{name}', title),
      ),
    ).toBeTruthy();
  });

  test('does not label hidden system task results as deleted', () => {
    expect(isResultTaskDeleted(result, [])).toBe(false);
  });

  test('labels a missing user task result as deleted', () => {
    expect(isResultTaskDeleted({ ...result, systemManaged: false }, [])).toBe(true);
    expect(
      isResultTaskDeleted({ ...result, systemManaged: false }, [{ id: 'heartbeat-main' }]),
    ).toBe(false);
  });
});

function renderReceipt(overrides: Partial<ScheduledTaskResult> = {}) {
  i18nService.setLanguage('zh', { persist: false });
  const initial = scheduledTaskReducer(undefined, { type: '@@init' });
  const receipt: ScheduledTaskResult = {
    id: 'report-run',
    taskId: 'report',
    taskName: '早晨简报',
    sessionId: 'native-session',
    sessionKey: 'native-session-key',
    status: 'success',
    summary: '**今日早报**\n\n- 上海天气晴',
    startedAt: '2026-11-02T02:01:06.000Z',
    finishedAt: '2026-11-02T02:10:00.000Z',
    durationMs: 534000,
    error: null,
    deliveryStatus: 'not-requested',
    deliveryError: null,
    completionStatus: 'succeeded',
    model: 'internal/report',
    usage: { total_tokens: 42 },
    observedAt: '2026-11-02T02:10:00.000Z',
    readAt: null,
    ...overrides,
  };
  const store = configureStore({
    reducer: {
      scheduledTask: scheduledTaskReducer,
      agent: () => ({ agents: [] }),
    },
    preloadedState: { scheduledTask: { ...initial, results: [receipt] } },
  });
  return {
    ...render(createElement(Provider, { store, children: createElement(ResultInbox) })),
    store,
    receipt,
  };
}

test('opens one run-details dialog beside the session button without reading the session', () => {
  const resolveSession = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const view = renderReceipt();
  expect(screen.getByText('今日早报 上海天气晴').tagName).toBe('P');
  fireEvent.click(screen.getByRole('button', { name: '展开摘要' }));
  expect(screen.getByText('今日早报').tagName).toBe('STRONG');
  expect(screen.getByText('上海天气晴').tagName).toBe('LI');
  expect(screen.queryByTestId('scheduled-run-diagnostics')).toBeNull();
  expect(view.container.querySelector('article details')).toBeNull();
  const detailsButton = screen.getByRole('button', { name: '运行详情' });
  expect(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsViewFull') })
      .nextElementSibling,
  ).toBe(detailsButton);

  fireEvent.click(detailsButton);
  const dialog = screen.getByRole('dialog', { name: '运行详情' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(within(dialog).getAllByText('实际模型: internal/report')).toHaveLength(1);
  expect(within(dialog).getByText('Token 用量: 总计 42')).toBeTruthy();
  expect(within(dialog).getByText('整体完成: 已完成')).toBeTruthy();
  expect(within(dialog).getByText('外部通知: 未请求')).toBeTruthy();
  expect(dialog.querySelector('details')).toBeNull();
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
  expect(resolveSession).not.toHaveBeenCalled();
});

test('shows error information and diagnostics once inside the run-details dialog', () => {
  const view = renderReceipt({
    summary: 'NO_REPLY',
    status: 'error',
    error: 'Notification service unavailable',
    errorReason: 'timeout',
    completionStatus: 'failed',
    deliveryStatus: 'unknown',
    deliveryError: 'Notification service unavailable',
    diagnostics: {
      summary: 'Notification service unavailable',
      entries: [
        {
          ts: 1,
          source: 'delivery',
          severity: 'error',
          message: 'Notification service unavailable',
        },
      ],
    },
  });
  expect(screen.queryByText('Notification service unavailable')).toBeNull();
  expect(view.container.querySelector('article details')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '运行详情' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('整体完成: 未完成')).toBeTruthy();
  expect(within(dialog).getByText('外部通知: 发送结果未知')).toBeTruthy();
  expect(within(dialog).getAllByText('Notification service unavailable')).toHaveLength(1);
  expect(within(dialog).getByRole('heading', { name: '运行诊断 (1)' })).toBeTruthy();
  expect(dialog.querySelector('details')).toBeNull();
  expect(screen.queryByText('NO_REPLY')).toBeNull();
});

test('shows skipped-result details even without a native session', () => {
  renderReceipt({
    status: 'skipped',
    summary: null,
    error: 'disabled',
    sessionId: null,
    sessionKey: null,
    completionStatus: undefined,
  });
  expect(
    screen.queryByRole('button', { name: i18nService.t('scheduledTasksResultsViewFull') }),
  ).toBeNull();
  expect(screen.queryByText(i18nService.t('scheduledTasksReasonDisabled'))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '运行详情' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(i18nService.t('scheduledTasksReasonDisabled'))).toBeTruthy();
  expect(within(dialog).getByText('实际模型: internal/report')).toBeTruthy();
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
});

test('keeps focus inside details and restores its trigger after Escape, close, or backdrop', () => {
  renderReceipt();
  const trigger = screen.getByRole('button', { name: '运行详情' });
  fireEvent.click(trigger);
  let dialog = screen.getByRole('dialog');
  let close = within(dialog).getByRole('button', { name: i18nService.t('close') });
  const content = dialog.querySelector<HTMLElement>('[tabindex="0"]')!;
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(content);
  fireEvent.keyDown(content, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  dialog = screen.getByRole('dialog');
  close = within(dialog).getByRole('button', { name: i18nService.t('close') });
  fireEvent.click(close);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  dialog = screen.getByRole('dialog');
  const overlay = dialog.closest('[data-workspace-overlay]')!;
  fireEvent.mouseDown(dialog);
  fireEvent.click(overlay);
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.mouseDown(overlay);
  fireEvent.click(overlay);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('keeps the eye action dedicated to reading the complete native session', async () => {
  const resolveSession = vi.fn().mockResolvedValue({
    success: true,
    history: { sessionKey: 'native-session-key', messages: [], unavailableReason: 'not-found' },
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  renderReceipt();
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsViewFull') }),
  );
  await waitFor(() => expect(resolveSession).toHaveBeenCalledOnce());
  expect(scheduledTaskService.markResultRead).toHaveBeenCalledWith('report-run');
  expect(screen.queryByRole('dialog', { name: '运行详情' })).toBeNull();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

test('does not reopen details when a removed receipt returns in a later page', () => {
  const { store, receipt } = renderReceipt();
  fireEvent.click(screen.getByRole('button', { name: '运行详情' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => {
    store.dispatch(replaceResults({ results: [], nextCursor: null }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => {
    store.dispatch(replaceResults({ results: [receipt], nextCursor: null }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: '运行详情' })).toBeTruthy();
});

test('keeps same-task runs in separate timeline cards and collapses their date as a group', () => {
  const { store, receipt, container } = renderReceipt();
  const newer = {
    ...receipt,
    id: 'later-run',
    startedAt: '2026-11-02T11:44:25.000Z',
    durationMs: 150000,
  };
  act(() => {
    store.dispatch(replaceResults({ results: [newer, receipt], nextCursor: 'next-native-page' }));
  });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  const times = [...container.querySelectorAll('time')];
  expect(times.map(time => time.dateTime)).toEqual([newer.startedAt, receipt.startedAt]);
  expect(times[0].title).toBe(new Date(newer.startedAt).toLocaleString('zh-CN', { hour12: false }));
  expect(times[0].textContent).toMatch(/^\d{2}:\d{2}$/u);
  expect(screen.getByText('2分钟30秒')).toBeTruthy();
  const collapse = screen.getByRole('button', { name: / · 收起$/ });
  fireEvent.click(collapse);
  expect(screen.queryByRole('article')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: / · 展开$/ }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('scheduledTasksLoadMore') }));
  expect(scheduledTaskService.loadResults).toHaveBeenCalledWith(true);
  expect(store.getState().scheduledTask.resultsNextCursor).toBe('next-native-page');
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
});

test('preserves unread eligibility and system or routine labels on the timeline', () => {
  const { store, receipt } = renderReceipt();
  act(() => {
    store.dispatch(
      replaceResults({
        results: [
          receipt,
          { ...receipt, id: 'system-run', systemManaged: true },
          { ...receipt, id: 'routine-run', summary: 'NO_REPLY' },
        ],
        nextCursor: null,
      }),
    );
  });
  expect(screen.getAllByLabelText(i18nService.t('scheduledTasksResultsUnreadLabel'))).toHaveLength(
    1,
  );
  expect(screen.getByText(i18nService.t('scheduledTasksResultsSystem'))).toBeTruthy();
  expect(screen.getByText(i18nService.t('scheduledTasksResultsRoutine'))).toBeTruthy();
  expect(screen.getByText(i18nService.t('scheduledTasksResultsSilent'))).toBeTruthy();
});

test('excludes running results from batch selection and keeps selection independent of session reads', async () => {
  const { store, receipt } = renderReceipt();
  act(() => {
    store.dispatch(
      replaceResults({
        results: [
          receipt,
          { ...receipt, id: 'active-run', status: 'running', finishedAt: null, durationMs: null },
        ],
        nextCursor: null,
      }),
    );
  });
  const runningCard = screen
    .getAllByRole('article')
    .find(card => within(card).queryByText(i18nService.t('scheduledTasksStatusRunning')))!;
  expect(
    within(runningCard).queryByRole('button', {
      name: i18nService.t('scheduledTasksResultsDelete'),
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: i18nService.t('scheduledTasksResultsBatchDelete') }),
  );
  const rows = screen.getAllByRole('checkbox', {
    name: i18nService.t('scheduledTasksResultsSelectResult').replace('{name}', '早晨简报'),
  });
  expect(rows.filter(row => (row as HTMLInputElement).disabled)).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('checkbox', { name: i18nService.t('scheduledTasksResultsSelectAll') }),
  );
  expect(
    screen.getByText(i18nService.t('scheduledTasksResultsSelected').replace('{count}', '1')),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('delete'), exact: true }));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: i18nService.t('delete'),
      exact: true,
    }),
  );
  await waitFor(() =>
    expect(scheduledTaskService.deleteResults).toHaveBeenCalledWith(['report-run']),
  );
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
});
