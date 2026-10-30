import type { EditableSchedule, Schedule } from '@shared/scheduledTask/types';
import { Cron } from 'croner';

export type ScheduleMode = 'recurring' | 'once';
export type RecurrenceKind = 'interval' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
export type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface ScheduleFormState {
  mode: ScheduleMode;
  recurrence: RecurrenceKind;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  intervalAnchorMs?: number;
  timeOfDay: string;
  weekday: number;
  hourlyMinute: number;
  customCron: string;
  onceDate: string;
  onceTime: string;
  timezone: string;
  staggerSeconds: string;
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function timeInput(date: Date): string {
  const minutes = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (!date.getSeconds() && !date.getMilliseconds()) return minutes;
  const seconds = `${minutes}:${pad2(date.getSeconds())}`;
  return date.getMilliseconds()
    ? `${seconds}.${String(date.getMilliseconds()).padStart(3, '0')}`
    : seconds;
}

function defaultScheduleForm(): ScheduleFormState {
  return {
    mode: 'recurring',
    recurrence: 'daily',
    intervalValue: 1,
    intervalUnit: 'minutes',
    timeOfDay: '09:00',
    weekday: 1,
    hourlyMinute: 0,
    customCron: '',
    onceDate: dateInput(new Date()),
    onceTime: '09:00',
    timezone: '',
    staggerSeconds: '',
  };
}

const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function intervalMilliseconds(form: ScheduleFormState): number {
  return Math.round(form.intervalValue * INTERVAL_UNIT_MS[form.intervalUnit]);
}

export function parseScheduleToForm(schedule?: Schedule): ScheduleFormState {
  const base = defaultScheduleForm();
  if (!schedule) return base;
  if (schedule.kind === 'at') {
    const date = new Date(schedule.at);
    return Number.isFinite(date.getTime())
      ? { ...base, mode: 'once', onceDate: dateInput(date), onceTime: timeInput(date) }
      : { ...base, mode: 'once' };
  }
  if (schedule.kind === 'every') {
    const unit =
      (['days', 'hours', 'minutes', 'seconds'] as const).find(
        candidate => schedule.everyMs % INTERVAL_UNIT_MS[candidate] === 0,
      ) ?? 'seconds';
    return {
      ...base,
      recurrence: 'interval',
      intervalUnit: unit,
      intervalValue: schedule.everyMs / INTERVAL_UNIT_MS[unit],
      intervalAnchorMs: schedule.anchorMs,
    };
  }
  if (schedule.kind !== 'cron') return base;
  const expr = schedule.expr.trim();
  const cronBase = {
    ...base,
    timezone: schedule.tz ?? '',
    staggerSeconds: schedule.staggerMs === undefined ? '' : String(schedule.staggerMs / 1000),
  };
  const custom: ScheduleFormState = { ...cronBase, recurrence: 'custom', customCron: expr };
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return custom;
  const [minute, hour, dom, month, dow] = parts;
  const inRange = (value: string, max: number) => /^\d+$/.test(value) && Number(value) <= max;
  if (month !== '*' || dom !== '*' || !inRange(minute, 59)) return custom;
  if (hour === '*' && dow === '*') {
    return { ...cronBase, recurrence: 'hourly', hourlyMinute: Number(minute) };
  }
  if (!inRange(hour, 23)) return custom;
  const timeOfDay = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
  if (dow === '*') return { ...cronBase, recurrence: 'daily', timeOfDay };
  if (dow === '1-5') return { ...cronBase, recurrence: 'weekdays', timeOfDay };
  if (inRange(dow, 6))
    return { ...cronBase, recurrence: 'weekly', weekday: Number(dow), timeOfDay };
  return custom;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    if (timezone.trim()) new Intl.DateTimeFormat('en', { timeZone: timezone.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

export function buildScheduleFromForm(form: ScheduleFormState): EditableSchedule {
  if (form.mode === 'once') {
    return {
      kind: 'at',
      at: new Date(`${form.onceDate}T${form.onceTime || '00:00'}`).toISOString(),
    };
  }
  if (form.recurrence === 'interval') {
    const everyMs = intervalMilliseconds(form);
    if (!Number.isSafeInteger(everyMs) || everyMs < 1) throw new RangeError('Invalid interval');
    return {
      kind: 'every',
      everyMs,
      ...(form.intervalAnchorMs !== undefined ? { anchorMs: form.intervalAnchorMs } : {}),
    };
  }
  const [hour, minute] = (form.timeOfDay || '09:00').split(':').map(Number);
  const expr =
    form.recurrence === 'hourly'
      ? `${form.hourlyMinute} * * * *`
      : form.recurrence === 'daily'
        ? `${minute} ${hour} * * *`
        : form.recurrence === 'weekdays'
          ? `${minute} ${hour} * * 1-5`
          : form.recurrence === 'weekly'
            ? `${minute} ${hour} * * ${form.weekday}`
            : form.customCron.trim();
  const tz = form.timezone.trim();
  if (!isValidTimezone(tz)) throw new RangeError('Invalid timezone');
  const staggerText = form.staggerSeconds.trim();
  const staggerMs = staggerText ? Math.round(Number(staggerText) * 1000) : undefined;
  if (
    staggerMs !== undefined &&
    (!/^\d+(?:\.\d{1,3})?$/.test(staggerText) || !Number.isSafeInteger(staggerMs) || staggerMs < 0)
  ) {
    throw new RangeError('Invalid stagger');
  }
  // Parse only; no callback means this never starts a scheduler or timer.
  new Cron(expr, { timezone: tz || undefined, catch: false });
  return {
    kind: 'cron',
    expr,
    ...(tz ? { tz } : {}),
    ...(staggerMs !== undefined ? { staggerMs } : {}),
  };
}

function cadence(form: ScheduleFormState): string {
  return JSON.stringify(
    form.mode === 'once'
      ? [form.mode, form.onceDate, form.onceTime]
      : form.recurrence === 'interval'
        ? [form.mode, form.recurrence, form.intervalValue, form.intervalUnit, form.intervalAnchorMs]
        : [
            form.mode,
            form.recurrence,
            form.recurrence === 'custom'
              ? form.customCron
              : form.recurrence === 'hourly'
                ? form.hourlyMinute
                : [form.timeOfDay, form.recurrence === 'weekly' ? form.weekday : null],
          ],
  );
}

export function isScheduleFormUnchanged(form: ScheduleFormState, original: Schedule): boolean {
  const initial = parseScheduleToForm(original);
  return (
    cadence(form) === cadence(initial) &&
    form.timezone === initial.timezone &&
    form.staggerSeconds === initial.staggerSeconds
  );
}

/** Preserve native precision and expression syntax when editing unrelated fields. */
export function buildScheduleForSubmission(
  form: ScheduleFormState,
  original?: EditableSchedule,
): EditableSchedule {
  if (original && isScheduleFormUnchanged(form, original)) return original;
  const built = buildScheduleFromForm(form);
  if (built.kind === 'cron' && original?.kind === 'cron') {
    return {
      ...built,
      ...(cadence(form) === cadence(parseScheduleToForm(original)) ? { expr: original.expr } : {}),
      ...(!form.staggerSeconds.trim() && original.staggerMs !== undefined
        ? { staggerMs: original.staggerMs }
        : {}),
    };
  }
  return built;
}

export function isValidFutureOnceSchedule(
  form: Pick<ScheduleFormState, 'onceDate' | 'onceTime'>,
  now = Date.now(),
): boolean {
  const timestamp = new Date(`${form.onceDate}T${form.onceTime || '00:00'}`).getTime();
  return Boolean(form.onceDate.trim()) && Number.isFinite(timestamp) && timestamp > now;
}

export function computeNextRunDate(form: ScheduleFormState, now = new Date()): Date | null {
  try {
    const schedule = buildScheduleFromForm(form);
    if (schedule.kind === 'at') {
      const date = new Date(schedule.at);
      return date.getTime() > now.getTime() ? date : null;
    }
    if (schedule.kind === 'every') {
      const anchor = schedule.anchorMs;
      return new Date(
        anchor === undefined
          ? now.getTime() + schedule.everyMs
          : anchor > now.getTime()
            ? anchor
            : anchor +
              (Math.floor((now.getTime() - anchor) / schedule.everyMs) + 1) * schedule.everyMs,
      );
    }
    const cron = new Cron(schedule.expr, { timezone: schedule.tz, catch: false });
    let next = cron.nextRun(now);
    // Do not display the wall time invented for a nonexistent DST occurrence.
    for (let attempt = 0; next && !cron.match(next) && attempt < 3; attempt += 1) {
      next = cron.nextRun(next);
    }
    return next && cron.match(next) ? next : null;
  } catch {
    return null;
  }
}

export function computeNextRunPreview(form: ScheduleFormState, now = new Date()): string | null {
  const next = computeNextRunDate(form, now);
  if (!next) return null;
  const tz =
    form.mode === 'recurring' && form.recurrence !== 'interval' ? form.timezone.trim() : '';
  return tz ? `${next.toLocaleString(undefined, { timeZone: tz })} (${tz})` : next.toLocaleString();
}
