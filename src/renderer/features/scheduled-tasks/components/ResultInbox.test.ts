// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask, ScheduledTaskResult } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import scheduledTaskReducer from '../scheduledTaskSlice';
import ResultInbox, { isResultTaskDeleted } from './ResultInbox';

afterEach(cleanup);

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
