import type { EditableSchedule } from '@shared/scheduledTask/types';
import { describe, expect, test } from 'vitest';

import {
  buildScheduleForSubmission,
  buildScheduleFromForm,
  computeNextRunDate,
  isScheduleFormUnchanged,
  parseScheduleToForm,
} from './scheduleForm';
import { buildAdvancedPayloadPatch, parseAdvancedTaskForm } from './taskEditor';

describe('native schedule preservation', () => {
  test.each(['0 9 * 12 *', '0 * * * 1', '15 * * 3 1-5', '0 0 9 * * *'])(
    'keeps unsupported preset restrictions intact: %s',
    expr => {
      const schedule = { kind: 'cron' as const, expr, tz: 'America/New_York', staggerMs: 57 };
      const form = parseScheduleToForm(schedule);
      expect(form.recurrence).toBe('custom');
      expect(buildScheduleFromForm(form)).toEqual(schedule);
      expect(buildScheduleForSubmission(form, schedule)).toBe(schedule);
    },
  );

  test('preserves one-time precision and the original timestamp syntax', () => {
    const schedule = { kind: 'at' as const, at: '2027-01-01T09:00:45.123+08:00' };
    const form = parseScheduleToForm(schedule);
    expect(
      new Date(
        buildScheduleFromForm(form).kind === 'at'
          ? (buildScheduleFromForm(form) as { at: string }).at
          : '',
      ).getTime(),
    ).toBe(Date.parse(schedule.at));
    expect(buildScheduleForSubmission(form, schedule)).toBe(schedule);
  });

  test('changing only stagger preserves the exact cron expression and timezone', () => {
    const schedule = {
      kind: 'cron' as const,
      expr: '00 09 * * *',
      tz: 'Asia/Shanghai',
      staggerMs: 57,
    };
    const form = { ...parseScheduleToForm(schedule), staggerSeconds: '0' };
    expect(isScheduleFormUnchanged(form, schedule)).toBe(false);
    expect(buildScheduleForSubmission(form, schedule)).toEqual({ ...schedule, staggerMs: 0 });
    expect(buildScheduleForSubmission({ ...form, staggerSeconds: '' }, schedule)).toEqual(schedule);
  });

  test('interval changes preserve the native anchor without converting to cron', () => {
    const schedule: EditableSchedule = { kind: 'every', everyMs: 90_500, anchorMs: 1234 };
    expect(buildScheduleFromForm({ ...parseScheduleToForm(schedule), intervalValue: 120 })).toEqual(
      { kind: 'every', everyMs: 120_000, anchorMs: 1234 },
    );
  });

  test('previews the saved timezone rather than the computer timezone', () => {
    const form = parseScheduleToForm({ kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' });
    expect(computeNextRunDate(form, new Date('2027-01-01T00:00:00Z'))?.toISOString()).toBe(
      '2027-01-01T14:00:00.000Z',
    );
  });

  test('does not preview a nonexistent local time during the DST spring gap', () => {
    const form = parseScheduleToForm({ kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York' });
    expect(computeNextRunDate(form, new Date('2027-03-14T05:00:00Z'))?.toISOString()).toBe(
      '2027-03-15T06:30:00.000Z',
    );
  });
});

describe('advanced override inputs', () => {
  test('untouched defaults and legacy zero timeout do not author overrides', () => {
    expect(buildAdvancedPayloadPatch(parseAdvancedTaskForm())).toEqual({});
    const payload = {
      kind: 'agentTurn' as const,
      message: 'Report',
      timeoutSeconds: 0,
      thinking: 'future-native-level',
    };
    expect(buildAdvancedPayloadPatch(parseAdvancedTaskForm({ payload }), payload)).toEqual({});
  });

  test('distinguishes reset, no fallbacks, and disabled lightweight context', () => {
    const payload = {
      kind: 'agentTurn' as const,
      message: 'Report',
      timeoutSeconds: 60,
      fallbacks: ['internal/model'],
      lightContext: true,
    };
    const form = { ...parseAdvancedTaskForm({ payload }), timeoutSeconds: '', lightContext: false };
    expect(buildAdvancedPayloadPatch({ ...form, fallbackMode: 'inherit' }, payload)).toEqual({
      timeoutSeconds: null,
      lightContext: false,
      fallbacks: null,
    });
    expect(buildAdvancedPayloadPatch({ ...form, fallbackMode: 'none' }, payload).fallbacks).toEqual(
      [],
    );
  });

  test('keeps model order and rejects an invalid model reference', () => {
    const form = {
      ...parseAdvancedTaskForm(),
      fallbackMode: 'custom' as const,
      fallbackText: 'internal/first, internal/second',
    };
    expect(buildAdvancedPayloadPatch(form).fallbacks).toEqual([
      'internal/first',
      'internal/second',
    ]);
    expect(() => buildAdvancedPayloadPatch({ ...form, fallbackText: 'unqualified' })).toThrow();
  });
});
