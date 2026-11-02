// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask, ScheduledTaskResult } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';

import scheduledTaskReducer from '../scheduledTaskSlice';
import ResultInbox, { isResultTaskDeleted } from './ResultInbox';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  resolveVisibleResultTaskId: (_tasks: unknown[], taskId: string | null) => taskId,
  scheduledTaskService: {
    markResultRead: vi.fn().mockResolvedValue(undefined),
    setResultsFilter: vi.fn(),
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
      scheduledTask: () => ({ ...initial, results: [receipt] }),
      agent: () => ({ agents: [] }),
    },
  });
  return render(createElement(Provider, { store, children: createElement(ResultInbox) }));
}

test('formats result content and keeps routine metadata inside a closed disclosure', () => {
  renderReceipt();
  expect(screen.getByText('今日早报').tagName).toBe('STRONG');
  expect(screen.getByText('上海天气晴').tagName).toBe('LI');
  const model = screen.getByText('实际模型: internal/report');
  const details = model.closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText('Token 用量: 总计 42').closest('details')).toBe(details);
  expect(screen.getByText('整体完成: 已完成').closest('details')).toBe(details);
  expect(screen.getByText('外部通知: 未请求').closest('details')).toBe(details);

  fireEvent.click(screen.getByText('运行详情'));
  expect(details.open).toBe(true);
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
});

test('folds completion and notification failures into details even for NO_REPLY results', () => {
  renderReceipt({
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
  const details = screen.getByText('整体完成: 未完成').closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText('外部通知: 发送结果未知').closest('details')).toBe(details);
  expect(
    screen.getByText('外部通知失败: Notification service unavailable').closest('details'),
  ).toBe(details);
  expect(
    screen.getAllByText('Notification service unavailable').every(node => node.closest('details')),
  ).toBe(true);
  fireEvent.click(screen.getByText('运行详情'));
  expect(details.open).toBe(true);
  expect(screen.queryByText('NO_REPLY')).toBeNull();
});

test('keeps skipped-result reasons and details accessible without a native session', () => {
  renderReceipt({
    status: 'skipped',
    summary: null,
    error: 'disabled',
    sessionId: null,
    sessionKey: null,
    completionStatus: undefined,
  });
  expect(
    screen
      .getAllByText(i18nService.t('scheduledTasksReasonDisabled'))
      .some(node => !node.closest('details')),
  ).toBe(true);
  expect(
    screen.queryByRole('button', { name: i18nService.t('scheduledTasksResultsViewFull') }),
  ).toBeNull();
  fireEvent.click(screen.getByText('运行详情'));
  expect(screen.getByText('实际模型: internal/report').closest('details')?.open).toBe(true);
  expect(scheduledTaskService.markResultRead).not.toHaveBeenCalled();
});
