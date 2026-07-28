import { describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  buildScheduleFromForm,
  computeNextRunPreview,
  parseScheduleToForm,
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

  test('formats sub-minute and non-integral-minute intervals without rounding them to minutes', () => {
    i18nService.setLanguage('zh', { persist: false });

    expect(formatScheduleLabel({ kind: 'every', everyMs: 1000 })).toBe('每 1 秒');
    expect(formatScheduleLabel({ kind: 'every', everyMs: 90_500 })).toBe('每 90.5 秒');
  });
});
