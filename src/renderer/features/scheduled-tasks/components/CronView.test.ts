import type { ScheduledTask } from '@shared/scheduledTask/types';
import { describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  buildScheduledTaskExecutionInput,
  buildScheduleFromForm,
  computeNextRunPreview,
  groupScheduledTasks,
  isValidFutureOnceSchedule,
  parseScheduleToForm,
  requiresScheduledTaskRunConfirmation,
} from './CronView';
import { formatScheduleLabel } from './utils';

describe('CronView schedule form mapping', () => {
  test('round-trips fixed-interval schedules without converting every into a cron expression', () => {
    const schedule = {
      kind: 'every' as const,
      everyMs: 60_000,
      anchorMs: 1_785_227_076_712,
    };

    const form = parseScheduleToForm(schedule);

    expect(form).toMatchObject({
      mode: 'recurring',
      recurrence: 'interval',
      intervalValue: 1,
      intervalUnit: 'minutes',
      intervalAnchorMs: schedule.anchorMs,
    });
    expect(buildScheduleFromForm(form)).toEqual(schedule);
  });

  test('preserves non-minute fixed intervals exactly', () => {
    const schedule = {
      kind: 'every' as const,
      everyMs: 90_500,
    };

    expect(buildScheduleFromForm(parseScheduleToForm(schedule))).toEqual(schedule);
  });

  test('rejects intervals that cannot produce a positive safe integer millisecond value', () => {
    const form = parseScheduleToForm({ kind: 'every', everyMs: 1000 });

    expect(() => buildScheduleFromForm({ ...form, intervalValue: 0.0001 })).toThrow(RangeError);
    expect(() =>
      buildScheduleFromForm({
        ...form,
        intervalValue: Number.MAX_VALUE,
        intervalUnit: 'days',
      }),
    ).toThrow(RangeError);
    expect(
      buildScheduleFromForm({ ...form, intervalValue: 0.001, intervalUnit: 'seconds' }),
    ).toMatchObject({ kind: 'every', everyMs: 1 });
  });

  test('previews the next fixed-interval run from its anchor phase', () => {
    const now = new Date('2026-07-28T10:00:30.000Z');
    const form = parseScheduleToForm({
      kind: 'every',
      everyMs: 60_000,
      anchorMs: new Date('2026-07-28T10:00:12.000Z').getTime(),
    });

    expect(computeNextRunPreview(form, now)).toBe(
      new Date('2026-07-28T10:01:12.000Z').toLocaleString(),
    );
  });

  test('requires a valid future date for one-time schedules', () => {
    const now = new Date('2026-09-05T08:00:00').getTime();

    expect(isValidFutureOnceSchedule({ onceDate: '', onceTime: '09:00' }, now)).toBe(false);
    expect(isValidFutureOnceSchedule({ onceDate: 'not-a-date', onceTime: '09:00' }, now)).toBe(
      false,
    );
    expect(isValidFutureOnceSchedule({ onceDate: '2026-09-05', onceTime: '07:59' }, now)).toBe(
      false,
    );
    expect(isValidFutureOnceSchedule({ onceDate: '2026-09-05', onceTime: '09:00' }, now)).toBe(
      true,
    );
  });

  test('formats sub-minute and non-integral-minute intervals without rounding them to minutes', () => {
    i18nService.setLanguage('zh', { persist: false });

    expect(formatScheduleLabel({ kind: 'every', everyMs: 1000 })).toBe('每 1 秒');
    expect(formatScheduleLabel({ kind: 'every', everyMs: 90_500 })).toBe('每 90.5 秒');
  });

  test('preserves an existing system event execution shape while editing', () => {
    expect(
      buildScheduledTaskExecutionInput(
        {
          sessionTarget: 'main',
          payload: { kind: 'systemEvent', text: 'original' },
        },
        'updated',
      ),
    ).toEqual({
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: 'updated' },
    });
  });

  test('preserves native agent-turn execution options while editing the message', () => {
    expect(
      buildScheduledTaskExecutionInput(
        {
          sessionTarget: 'isolated',
          payload: {
            kind: 'agentTurn',
            message: 'original',
            model: 'openai/gpt-5.4',
            timeoutSeconds: 90,
            toolsAllow: ['web_search'],
          },
        },
        'updated',
      ),
    ).toEqual({
      sessionTarget: 'isolated',
      payload: {
        kind: 'agentTurn',
        message: 'updated',
        model: 'openai/gpt-5.4',
        timeoutSeconds: 90,
        toolsAllow: ['web_search'],
      },
    });
  });

  test('formats native event-driven schedules without assuming a cron expression', () => {
    i18nService.setLanguage('en', { persist: false });

    expect(formatScheduleLabel({ kind: 'on-exit', command: './watch.sh', cwd: '/srv/app' })).toBe(
      'On process exit · ./watch.sh',
    );
    expect(formatScheduleLabel({ kind: 'stream', command: ['node', 'events.mjs'] })).toBe(
      'Event stream · node events.mjs',
    );
  });

  test('uses an isolated agent turn for a new task', () => {
    expect(buildScheduledTaskExecutionInput(undefined, 'new task')).toEqual({
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'new task' },
    });
  });

  test('requires confirmation before running advanced command or script tasks', () => {
    const task: ScheduledTask = {
      id: 'advanced-1',
      name: 'Build watcher',
      description: '',
      enabled: true,
      schedule: { kind: 'on-exit', command: './watch.sh' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'command', argv: ['npm', 'test'] },
      delivery: { mode: 'none' },
      agentId: null,
      sessionKey: null,
      management: 'advanced',
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    };

    expect(requiresScheduledTaskRunConfirmation(task)).toBe(true);
    expect(
      requiresScheduledTaskRunConfirmation({
        ...task,
        management: 'editable',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        payload: { kind: 'agentTurn', message: 'Summarize' },
      }),
    ).toBe(false);
  });

  test('groups only system-managed jobs as system tasks', () => {
    const baseTask: ScheduledTask = {
      id: 'task-1',
      name: 'Task',
      description: '',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'Summarize' },
      delivery: { mode: 'none' },
      agentId: null,
      sessionKey: null,
      management: 'editable',
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const editableTask = baseTask;
    const advancedTask = { ...baseTask, id: 'task-2', management: 'advanced' as const };
    const managedTask = { ...baseTask, id: 'task-3', management: 'managed' as const };

    expect(groupScheduledTasks([managedTask, advancedTask, editableTask])).toEqual({
      userTasks: [advancedTask, editableTask],
      systemTasks: [managedTask],
    });
  });
});
