import {
  ArrowPathIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  Schedule,
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskInput,
} from '@shared/scheduledTask/types';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import WindowTitleBar from '@/app/shell/window/WindowTitleBar';
import ResultInbox from '@/features/scheduled-tasks/components/ResultInbox';
import TaskRunHistory from '@/features/scheduled-tasks/components/TaskRunHistory';
import { formatDateTime, formatScheduleLabel } from '@/features/scheduled-tasks/components/utils';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import { RootState } from '@/store';

// ── Schedule Builder Types ─────────────────────────────────────────

type ScheduleMode = 'recurring' | 'once';
type RecurrenceKind = 'interval' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

const RECURRENCE_KINDS: RecurrenceKind[] = [
  'interval',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'custom',
];

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
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toTimeInputValue(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultScheduleForm(): ScheduleFormState {
  const now = new Date();
  return {
    mode: 'recurring',
    recurrence: 'daily',
    intervalValue: 1,
    intervalUnit: 'minutes',
    timeOfDay: '09:00',
    weekday: 1,
    hourlyMinute: 0,
    customCron: '',
    onceDate: toDateInputValue(now),
    onceTime: '09:00',
  };
}

function parseEveryInterval(
  everyMs: number,
): Pick<ScheduleFormState, 'intervalValue' | 'intervalUnit'> {
  if (everyMs % 86_400_000 === 0) {
    return { intervalValue: everyMs / 86_400_000, intervalUnit: 'days' };
  }
  if (everyMs % 3_600_000 === 0) {
    return { intervalValue: everyMs / 3_600_000, intervalUnit: 'hours' };
  }
  if (everyMs % 60_000 === 0) {
    return { intervalValue: everyMs / 60_000, intervalUnit: 'minutes' };
  }
  return { intervalValue: everyMs / 1000, intervalUnit: 'seconds' };
}

export function parseScheduleToForm(schedule?: Schedule): ScheduleFormState {
  const base = defaultScheduleForm();
  if (!schedule) return base;
  if (schedule.kind === 'at') {
    const date = new Date(schedule.at);
    if (!Number.isNaN(date.getTime())) {
      return {
        ...base,
        mode: 'once',
        onceDate: toDateInputValue(date),
        onceTime: toTimeInputValue(date),
      };
    }
    return { ...base, mode: 'once' };
  }
  if (schedule.kind === 'every') {
    return {
      ...base,
      mode: 'recurring',
      recurrence: 'interval',
      ...parseEveryInterval(schedule.everyMs),
      intervalAnchorMs: schedule.anchorMs,
    };
  }
  const expr = schedule.expr.trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    return { ...base, mode: 'recurring', recurrence: 'custom', customCron: expr };
  }
  const [minute, hour, dom, , dow] = parts;
  const isNum = (v: string) => /^\d+$/.test(v);
  if (isNum(minute) && hour === '*' && dom === '*') {
    return { ...base, mode: 'recurring', recurrence: 'hourly', hourlyMinute: Number(minute) };
  }
  if (isNum(minute) && isNum(hour) && dom === '*') {
    const tod = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
    if (dow === '*') return { ...base, mode: 'recurring', recurrence: 'daily', timeOfDay: tod };
    if (dow === '1-5')
      return { ...base, mode: 'recurring', recurrence: 'weekdays', timeOfDay: tod };
    if (isNum(dow) && Number(dow) >= 0 && Number(dow) <= 6) {
      return {
        ...base,
        mode: 'recurring',
        recurrence: 'weekly',
        weekday: Number(dow),
        timeOfDay: tod,
      };
    }
  }
  return { ...base, mode: 'recurring', recurrence: 'custom', customCron: expr };
}

const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function intervalMilliseconds(form: ScheduleFormState): number {
  return Math.round(form.intervalValue * INTERVAL_UNIT_MS[form.intervalUnit]);
}

export function buildScheduleFromForm(form: ScheduleFormState): Schedule {
  if (form.mode === 'once') {
    const dateTime = new Date(`${form.onceDate}T${form.onceTime || '00:00'}`);
    return { kind: 'at', at: dateTime.toISOString() };
  }
  if (form.recurrence === 'interval') {
    const everyMs = intervalMilliseconds(form);
    if (!Number.isSafeInteger(everyMs) || everyMs < 1) {
      throw new RangeError('Invalid scheduled task interval');
    }
    return {
      kind: 'every',
      everyMs,
      ...(form.intervalAnchorMs !== undefined ? { anchorMs: form.intervalAnchorMs } : {}),
    };
  }
  const [hourRaw, minuteRaw] = (form.timeOfDay || '09:00').split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  let expr = '';
  switch (form.recurrence) {
    case 'hourly':
      expr = `${form.hourlyMinute} * * * *`;
      break;
    case 'daily':
      expr = `${minute} ${hour} * * *`;
      break;
    case 'weekdays':
      expr = `${minute} ${hour} * * 1-5`;
      break;
    case 'weekly':
      expr = `${minute} ${hour} * * ${form.weekday}`;
      break;
    default:
      expr = form.customCron.trim();
      break;
  }
  return { kind: 'cron', expr };
}

export function computeNextRunPreview(form: ScheduleFormState, now = new Date()): string | null {
  if (form.mode === 'once') {
    const dateTime = new Date(`${form.onceDate}T${form.onceTime || '00:00'}`);
    return Number.isNaN(dateTime.getTime()) ? null : dateTime.toLocaleString();
  }
  const [hourRaw, minuteRaw] = (form.timeOfDay || '09:00').split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  switch (form.recurrence) {
    case 'interval': {
      const everyMs = intervalMilliseconds(form);
      if (!Number.isSafeInteger(everyMs) || everyMs < 1) return null;
      const anchorMs = form.intervalAnchorMs;
      if (anchorMs === undefined || !Number.isFinite(anchorMs)) {
        return new Date(now.getTime() + everyMs).toLocaleString();
      }
      const nextRunAtMs =
        anchorMs > now.getTime()
          ? anchorMs
          : anchorMs + (Math.floor((now.getTime() - anchorMs) / everyMs) + 1) * everyMs;
      return new Date(nextRunAtMs).toLocaleString();
    }
    case 'hourly': {
      next.setMinutes(form.hourlyMinute);
      if (next <= now) next.setHours(next.getHours() + 1);
      return next.toLocaleString();
    }
    case 'daily': {
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next.toLocaleString();
    }
    case 'weekdays': {
      next.setHours(hour, minute, 0, 0);
      while (next <= now || next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
        next.setHours(hour, minute, 0, 0);
      }
      return next.toLocaleString();
    }
    case 'weekly': {
      next.setHours(hour, minute, 0, 0);
      const dayDelta = (form.weekday - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + dayDelta);
      if (next <= now) next.setDate(next.getDate() + 7);
      return next.toLocaleString();
    }
    default:
      return null;
  }
}

// ── Cron Job Card ──────────────────────────────────────────────────

interface CronJobCardProps {
  job: ScheduledTask;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => Promise<void>;
  onHistory: () => void;
}

function CronJobCard({ job, onToggle, onEdit, onDelete, onTrigger, onHistory }: CronJobCardProps) {
  const t = i18nService.t.bind(i18nService);
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggering(true);
    try {
      await onTrigger();
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastTriggered') }));
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: t('cronToastFailedTrigger') }),
      );
    } finally {
      setTriggering(false);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const promptText = job.payload.kind === 'systemEvent' ? job.payload.text : job.payload.message;
  const isEnabled = job.enabled;
  const hasLastRun = Boolean(job.state.lastRunAtMs);
  const lastStatus = job.state.lastStatus;
  const lastError = job.state.lastError;
  const nextRunMs = job.state.nextRunAtMs;
  const scheduleLabel = formatScheduleLabel(job.schedule);
  const nextRunLabel =
    nextRunMs && isEnabled ? `${t('cronCardNext')}: ${formatDateTime(new Date(nextRunMs))}` : null;

  return (
    <div
      data-testid={'cron-job-card-' + job.id}
      className={
        'group relative flex h-full min-h-[154px] cursor-pointer flex-col overflow-hidden rounded-2xl border bg-surface shadow-subtle transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card ' +
        (isEnabled
          ? 'border-border-subtle hover:border-primary/25'
          : 'border-border-subtle opacity-75 hover:border-border hover:opacity-100')
      }
      onClick={onEdit}
    >
      <div
        className={
          'absolute inset-x-0 top-0 h-0.5 transition-colors ' +
          (isEnabled ? 'bg-primary' : 'bg-border')
        }
      />

      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
        <h3
          className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-foreground"
          title={job.name}
        >
          {job.name}
        </h3>

        <div className="shrink-0" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            aria-label={t(isEnabled ? 'cronStatsActive' : 'cronStatsPaused')}
            onClick={e => {
              e.stopPropagation();
              onToggle(!job.enabled);
            }}
            className={
              'inline-flex items-center gap-2 rounded-lg py-1 pl-2 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ' +
              (isEnabled ? 'text-green-600 dark:text-green-400' : 'text-secondary')
            }
          >
            <span className="text-[10px] font-medium">
              {t(isEnabled ? 'cronStatsActive' : 'cronStatsPaused')}
            </span>
            <span
              className={
                'relative h-5 w-9 shrink-0 rounded-full transition-colors ' +
                (isEnabled ? 'bg-primary' : 'bg-border')
              }
            >
              <span
                className={
                  'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ' +
                  (isEnabled ? 'translate-x-4' : 'translate-x-0')
                }
              />
            </span>
          </button>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-4 pb-2 text-xs text-secondary">
        <CalendarDaysIcon className="h-3.5 w-3.5" />
        <p
          className="flex min-w-0 items-center gap-1.5 font-medium leading-4"
          title={[scheduleLabel, nextRunLabel].filter(Boolean).join(' · ')}
        >
          <span className={nextRunLabel ? 'max-w-[55%] shrink-0 truncate' : 'truncate'}>
            {scheduleLabel}
          </span>
          {nextRunLabel && (
            <>
              <span className="shrink-0 text-border" aria-hidden="true">
                ·
              </span>
              <span className="min-w-0 truncate font-normal">{nextRunLabel}</span>
            </>
          )}
        </p>

        <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" />
        <p className="min-w-0 truncate leading-4 text-foreground/80" title={promptText}>
          {promptText}
        </p>

        {hasLastRun && (
          <>
            {lastStatus === 'success' ? (
              <CheckCircleIcon className="h-3.5 w-3.5 text-green-500" />
            ) : lastStatus === 'error' ? (
              <XCircleIcon className="h-3.5 w-3.5 text-red-500" />
            ) : lastStatus === 'running' ? (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-primary" />
            ) : (
              <ClockIcon className="h-3.5 w-3.5" />
            )}
            <span
              className={'min-w-0 truncate leading-4 ' + (lastError ? 'cursor-help' : '')}
              title={lastError ?? undefined}
            >
              {t('cronCardLast')}: {formatDateTime(new Date(job.state.lastRunAtMs!))}
            </span>
          </>
        )}
      </div>

      <div
        className="mt-auto flex items-center gap-0.5 border-t border-border-subtle px-2.5 py-1.5"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            void handleTrigger(e);
          }}
          disabled={triggering}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-primary/10 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
        >
          {triggering ? (
            <ArrowPathIcon className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <PlayIcon className="mr-1 h-3 w-3" />
          )}
          {t('cronCardRunNow')}
        </button>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onHistory();
          }}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <ClockIcon className="mr-1 h-3 w-3" />
          {t('cronCardHistory')}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onEdit();
          }}
          title={t('cronDialogEditTitle')}
          aria-label={t('cronDialogEditTitle')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <PencilSquareIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleDeleteClick}
          title={t('delete')}
          aria-label={t('delete')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ── Create/Edit Dialog ─────────────────────────────────────────────

interface DialogProps {
  open: boolean;
  job?: ScheduledTask;
  onClose: () => void;
  onSave: (input: ScheduledTaskInput) => Promise<void>;
}

function CreateEditDialog({ open, job, onClose, onSave }: DialogProps) {
  const t = i18nService.t.bind(i18nService);
  const isEdit = !!job;

  const [name, setName] = useState(job?.name ?? '');
  const [message, setMessage] = useState(
    job ? (job.payload.kind === 'systemEvent' ? job.payload.text : job.payload.message) : '',
  );
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(() =>
    parseScheduleToForm(job?.schedule),
  );
  const [enabled, setEnabled] = useState(job ? job.enabled : true);
  const [deliveryChannel, setDeliveryChannel] = useState(job?.delivery.channel ?? '');
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce' | 'webhook'>(
    job?.delivery.mode === 'announce'
      ? 'announce'
      : job?.delivery.mode === 'webhook'
        ? 'webhook'
        : 'none',
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [prevOpen, setPrevOpen] = useState(open);

  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName(job?.name ?? '');
      setMessage(
        job ? (job.payload.kind === 'systemEvent' ? job.payload.text : job.payload.message) : '',
      );
      setScheduleForm(parseScheduleToForm(job?.schedule));
      setEnabled(job ? job.enabled : true);
      setDeliveryChannel(job?.delivery.channel ?? '');
      setDeliveryMode(
        job?.delivery.mode === 'announce'
          ? 'announce'
          : job?.delivery.mode === 'webhook'
            ? 'webhook'
            : 'none',
      );
      setErrors({});
      setSaving(false);
    }
  }

  const nextRunPreview = useMemo(() => {
    if (scheduleForm.mode === 'recurring' && scheduleForm.recurrence === 'custom') return null;
    return computeNextRunPreview(scheduleForm);
  }, [scheduleForm]);

  useEffect(() => {
    if (open && !isEdit && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [open, isEdit]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void scheduledTaskService.listChannels().then(channels => {
      if (cancelled) return;
      setChannelOptions(channels);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('cronToastNameRequired');
    if (!message.trim()) next.message = t('cronToastMessageRequired');
    if (
      scheduleForm.mode === 'recurring' &&
      scheduleForm.recurrence === 'custom' &&
      !scheduleForm.customCron.trim()
    ) {
      next.schedule = t('cronToastScheduleRequired');
    }
    if (
      scheduleForm.mode === 'recurring' &&
      scheduleForm.recurrence === 'interval' &&
      (!Number.isSafeInteger(intervalMilliseconds(scheduleForm)) ||
        intervalMilliseconds(scheduleForm) < 1)
    ) {
      next.schedule = t('cronToastIntervalRequired');
    }
    if (deliveryMode === 'announce' && !deliveryChannel.trim()) {
      next.delivery = t('cronToastDeliveryChannelRequired');
    }
    if (scheduleForm.mode === 'once') {
      const dt = new Date(scheduleForm.onceDate + 'T' + (scheduleForm.onceTime || '00:00'));
      if (dt.getTime() <= Date.now()) {
        next.schedule = t('cronToastSchedulePast');
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const schedule = buildScheduleFromForm(scheduleForm);
      const input: ScheduledTaskInput = {
        name: name.trim(),
        description: '',
        enabled,
        schedule,
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: message.trim() },
        delivery:
          deliveryMode === 'none'
            ? { mode: 'none' }
            : deliveryMode === 'webhook' && job?.delivery.mode === 'webhook'
              ? job.delivery
              : { mode: 'announce', channel: deliveryChannel || undefined },
      };
      await onSave(input);
      onClose();
    } catch {
      // error handled by service toast
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const inputClass =
    'w-full rounded-xl border border-black/10 dark:border-white/10 bg-transparent px-3 py-2.5 text-sm text-foreground placeholder:text-secondary/60 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all';
  const labelClass = 'block text-sm font-medium text-foreground mb-1.5';
  const isCustomRecurrence = scheduleForm.recurrence === 'custom';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg mx-4 max-h-[85vh] flex flex-col rounded-2xl shadow-2xl bg-background border border-border overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? t('cronDialogEditTitle') : t('cronDialogCreateTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name */}
          <div>
            <label className={labelClass}>{t('cronDialogTaskName')}</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className={inputClass}
              placeholder={t('cronDialogTaskNamePlaceholder')}
            />
            {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
          </div>

          {/* Message */}
          <div>
            <label className={labelClass}>{t('cronDialogMessage')}</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              className={inputClass + ' resize-none'}
              placeholder={t('cronDialogMessagePlaceholder')}
              rows={4}
            />
            {errors.message && <p className="text-xs text-red-500 mt-1">{errors.message}</p>}
          </div>

          {/* Schedule Builder */}
          <div>
            <label className={labelClass}>{t('cronDialogSchedule')}</label>

            {/* Mode tabs */}
            <div className="flex rounded-xl bg-black/5 dark:bg-white/5 p-1 mb-3">
              {(['recurring', 'once'] as ScheduleMode[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScheduleForm(s => ({ ...s, mode }))}
                  className={
                    'flex-1 py-2 text-sm font-medium rounded-lg transition-all ' +
                    (scheduleForm.mode === mode
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-secondary hover:text-foreground')
                  }
                >
                  {mode === 'recurring'
                    ? t('cronDialogScheduleModeRecurring')
                    : t('cronDialogScheduleModeOnce')}
                </button>
              ))}
            </div>

            {scheduleForm.mode === 'once' ? (
              /* Once: date + time inputs */
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-secondary mb-1 block">
                    {t('cronDialogDateLabel')}
                  </label>
                  <input
                    type="date"
                    value={scheduleForm.onceDate}
                    onChange={e => setScheduleForm(s => ({ ...s, onceDate: e.target.value }))}
                    className={inputClass}
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-secondary mb-1 block">
                    {t('cronDialogTimeLabel')}
                  </label>
                  <input
                    type="time"
                    value={scheduleForm.onceTime}
                    onChange={e => setScheduleForm(s => ({ ...s, onceTime: e.target.value }))}
                    className={inputClass}
                  />
                </div>
              </div>
            ) : (
              /* Recurring */
              <>
                {/* Recurrence kind selector */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {RECURRENCE_KINDS.map(kind => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setScheduleForm(s => ({ ...s, recurrence: kind }))}
                      className={
                        'px-3 py-1.5 text-xs font-medium rounded-lg transition-all ' +
                        (scheduleForm.recurrence === kind
                          ? 'bg-primary text-white shadow-sm'
                          : 'bg-black/5 dark:bg-white/5 text-secondary hover:text-foreground')
                      }
                    >
                      {t('cronDialogRecurrence' + kind.charAt(0).toUpperCase() + kind.slice(1))}
                    </button>
                  ))}
                </div>

                {scheduleForm.recurrence === 'interval' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-secondary">
                      {t('scheduledTasksScheduleEvery')}
                    </span>
                    <input
                      type="number"
                      min="0.001"
                      step="any"
                      value={scheduleForm.intervalValue}
                      onChange={e =>
                        setScheduleForm(s => ({
                          ...s,
                          intervalValue: Number(e.target.value),
                        }))
                      }
                      className={inputClass + ' w-28'}
                    />
                    <select
                      value={scheduleForm.intervalUnit}
                      onChange={e =>
                        setScheduleForm(s => ({
                          ...s,
                          intervalUnit: e.target.value as IntervalUnit,
                        }))
                      }
                      className={inputClass + ' w-28'}
                    >
                      {(['seconds', 'minutes', 'hours', 'days'] as const).map(unit => (
                        <option key={unit} value={unit}>
                          {t(
                            unit === 'seconds'
                              ? 'scheduledTasksFormIntervalSeconds'
                              : unit === 'minutes'
                                ? 'scheduledTasksFormIntervalMinutes'
                                : unit === 'hours'
                                  ? 'scheduledTasksFormIntervalHours'
                                  : 'scheduledTasksFormIntervalDays',
                          )}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : isCustomRecurrence ? (
                  <input
                    type="text"
                    value={scheduleForm.customCron}
                    onChange={e => setScheduleForm(s => ({ ...s, customCron: e.target.value }))}
                    className={inputClass}
                    placeholder={t('cronDialogCronPlaceholder')}
                  />
                ) : scheduleForm.recurrence === 'hourly' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-secondary">{t('cronDialogMinuteLabel')}</span>
                    <select
                      value={scheduleForm.hourlyMinute}
                      onChange={e =>
                        setScheduleForm(s => ({
                          ...s,
                          hourlyMinute: Number(e.target.value),
                        }))
                      }
                      className={inputClass + ' w-20 text-center'}
                    >
                      {Array.from({ length: 60 }, (_, i) => (
                        <option key={i} value={i}>
                          {pad2(i)}
                        </option>
                      ))}
                    </select>
                    <span className="text-sm text-secondary">min</span>
                  </div>
                ) : scheduleForm.recurrence === 'weekly' ? (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm text-secondary">{t('cronDialogWeekdayLabel')}</span>
                      <div className="flex gap-1">
                        {[0, 1, 2, 3, 4, 5, 6].map(d => {
                          const selected = scheduleForm.weekday === d;
                          const locale = i18nService.getLanguage();
                          const labels =
                            locale === 'zh'
                              ? ['日', '一', '二', '三', '四', '五', '六']
                              : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
                          return (
                            <button
                              key={d}
                              type="button"
                              onClick={() => setScheduleForm(s => ({ ...s, weekday: d }))}
                              className={
                                'w-9 h-9 rounded-full text-xs font-medium transition-colors ' +
                                (selected
                                  ? 'bg-foreground text-background'
                                  : 'border border-border text-secondary hover:bg-surface-raised')
                              }
                            >
                              {labels[d]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-secondary">{t('cronDialogTimeLabel')}</span>
                      <input
                        type="time"
                        value={scheduleForm.timeOfDay}
                        onChange={e => setScheduleForm(s => ({ ...s, timeOfDay: e.target.value }))}
                        className={inputClass + ' w-32'}
                      />
                    </div>
                  </>
                ) : (
                  /* daily / weekdays: time picker */
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-secondary">{t('cronDialogTimeLabel')}</span>
                    <input
                      type="time"
                      value={scheduleForm.timeOfDay}
                      onChange={e => setScheduleForm(s => ({ ...s, timeOfDay: e.target.value }))}
                      className={inputClass + ' w-32'}
                    />
                  </div>
                )}

                {/* Next run preview */}
                {nextRunPreview && (
                  <div className="mt-3 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10 text-xs text-secondary">
                    <span className="font-medium text-foreground/80">{t('cronCardNext')}:</span>{' '}
                    {nextRunPreview}
                  </div>
                )}
              </>
            )}

            {errors.schedule && <p className="text-xs text-red-500 mt-1">{errors.schedule}</p>}
          </div>

          {/* Delivery */}
          <div>
            <label className={labelClass}>{t('scheduledTasksResultsRetentionTitle')}</label>
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">
              <CheckCircleIcon className="h-5 w-5 text-primary" />
              {t('scheduledTasksResultsRetentionAlways')}
            </div>
            <label className={labelClass}>{t('scheduledTasksExternalNotificationTitle')}</label>
            <p className="text-xs text-secondary mb-3">{t('cronDialogDeliveryDescription')}</p>

            <div className="flex gap-2 mb-3">
              {(['none', 'announce'] as const).map(mode => {
                const selected = deliveryMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setDeliveryMode(mode)}
                    className={
                      'flex-1 p-3 rounded-xl border text-left transition-all ' +
                      (selected
                        ? 'border-primary bg-primary/10 ring-2 ring-primary/20 shadow-sm'
                        : 'border-border hover:border-primary/40 hover:bg-surface-raised')
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={
                          'text-sm font-medium ' + (selected ? 'text-primary' : 'text-foreground')
                        }
                      >
                        {mode === 'none'
                          ? t('cronDialogDeliveryModeNone')
                          : t('cronDialogDeliveryModeAnnounce')}
                      </span>
                      {selected && (
                        <CheckCircleIcon
                          className="h-5 w-5 shrink-0 text-primary"
                          strokeWidth={2.5}
                        />
                      )}
                    </div>
                    <div className="text-xs text-secondary mt-0.5">
                      {mode === 'none'
                        ? t('cronDialogDeliveryModeNoneDesc')
                        : t('cronDialogDeliveryModeAnnounceDesc')}
                    </div>
                  </button>
                );
              })}
            </div>

            {deliveryMode === 'webhook' && job?.delivery.mode === 'webhook' && (
              <div className="mb-3 rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm text-secondary">
                {t('scheduledTasksWebhookPreserved')}
              </div>
            )}

            {deliveryMode === 'announce' && (
              <div className="relative">
                <select
                  value={deliveryChannel}
                  onChange={e => setDeliveryChannel(e.target.value)}
                  className={inputClass + ' appearance-none pr-10'}
                >
                  <option value="">{t('cronDialogSelectChannel')}</option>
                  {channelOptions.map(c => (
                    <option key={c.value} value={c.value} disabled={c.disabled}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                {errors.delivery && <p className="mt-1 text-xs text-red-500">{errors.delivery}</p>}
              </div>
            )}
          </div>

          {/* Enable toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <label className={labelClass + ' cursor-pointer'}>
                {t('cronDialogEnableImmediately')}
              </label>
              <p className="text-xs text-secondary">{t('cronDialogEnableImmediatelyDesc')}</p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled(v => !v)}
              className={
                'relative shrink-0 w-11 h-6 rounded-full transition-colors ' +
                (enabled ? 'bg-primary' : 'bg-border')
              }
            >
              <span
                className={
                  'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow-sm ' +
                  (enabled ? 'translate-x-5' : 'translate-x-0')
                }
              />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-border-subtle shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium rounded-xl text-secondary hover:bg-surface-raised transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            className="px-5 py-2.5 text-sm font-medium rounded-xl bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircleIcon className="h-4 w-4" />
            )}
            {isEdit ? t('cronDialogSaveChanges') : t('cronDialogCreateTitle')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main CronView ──────────────────────────────────────────────────

interface CronViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
}

export const CronView: React.FC<CronViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
}) => {
  const t = i18nService.t.bind(i18nService);
  const isMac = window.electron.platform === 'darwin';

  const tasks = useSelector((s: RootState) => s.scheduledTask.tasks);
  const loading = useSelector((s: RootState) => s.scheduledTask.loading);
  const error = useSelector((s: RootState) => s.scheduledTask.error);

  const [showDialog, setShowDialog] = useState(false);
  const [editingJob, setEditingJob] = useState<ScheduledTask | undefined>();
  const [jobToDelete, setJobToDelete] = useState<ScheduledTask | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tasks' | 'results'>('tasks');

  const historyRuns = useSelector((s: RootState) =>
    historyTaskId ? (s.scheduledTask.runs[historyTaskId] ?? []) : [],
  );
  const historyJob = useSelector((s: RootState) =>
    historyTaskId ? s.scheduledTask.tasks.find(t => t.id === historyTaskId) : undefined,
  );

  useEffect(() => {
    scheduledTaskService.loadTasks();
  }, []);

  useEffect(() => {
    if (historyTaskId) {
      scheduledTaskService.loadRuns(historyTaskId);
    }
  }, [historyTaskId]);

  useEffect(() => {
    if (editingJob && !tasks.some(task => task.id === editingJob.id)) {
      setEditingJob(undefined);
      setShowDialog(false);
    }
    if (jobToDelete && !tasks.some(task => task.id === jobToDelete.id)) {
      setJobToDelete(null);
    }
  }, [editingJob, jobToDelete, tasks]);

  const handleSave = useCallback(
    async (input: ScheduledTaskInput) => {
      if (editingJob) {
        await scheduledTaskService.updateTaskById(editingJob.id, input);
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastUpdated') }));
      } else {
        await scheduledTaskService.createTask(input);
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastCreated') }));
      }
      setEditingJob(undefined);
    },
    [editingJob, t],
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await scheduledTaskService.toggleTask(id, enabled);
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: enabled ? t('cronToastEnabled') : t('cronToastPaused'),
          }),
        );
      } catch {
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: t('cronToastFailedUpdate') }),
        );
      }
    },
    [t],
  );

  const handleDelete = useCallback(async () => {
    if (!jobToDelete) return;
    try {
      await scheduledTaskService.deleteTask(jobToDelete.id);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastDeleted') }));
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: t('cronToastFailedDelete') }),
      );
    }
    setJobToDelete(null);
  }, [jobToDelete, t]);

  const activeJobs = tasks.filter(j => j.enabled);
  const pausedJobs = tasks.filter(j => !j.enabled);
  const failedJobs = tasks.filter(j => j.state.lastStatus === 'error');

  if (loading && tasks.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <ArrowPathIcon className="h-8 w-8 animate-spin text-secondary" />
        <p className="mt-3 text-sm text-secondary">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={'non-draggable flex items-center gap-1 ' + (isMac ? 'pl-[68px]' : '')}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col p-6 md:p-8">
          <div className="mb-6 flex gap-1 self-center rounded-xl bg-surface-raised p-1">
            {(['tasks', 'results'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {t(tab === 'tasks' ? 'scheduledTasksTabTasks' : 'scheduledTasksTabResults')}
              </button>
            ))}
          </div>
          {activeTab === 'results' ? (
            <ResultInbox />
          ) : (
            <>
              {/* Hero Header */}
              <div className="flex flex-col gap-4 mb-6 shrink-0 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-secondary">{t('cronSubtitle')}</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => scheduledTaskService.loadTasks()}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-medium text-secondary shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground"
                  >
                    <ArrowPathIcon className="h-3.5 w-3.5" />
                    {t('cronRefresh')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingJob(undefined);
                      setShowDialog(true);
                    }}
                    className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-3.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-hover active:scale-[0.98]"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    {t('cronNewTask')}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="mb-8 p-4 rounded-xl border border-red-500/50 bg-red-500/10 flex items-center gap-3">
                  <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
                  <span className="text-red-600 dark:text-red-400 text-sm font-medium">
                    {error}
                  </span>
                </div>
              )}

              {/* Statistics */}
              <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  {
                    label: 'cronStatsTotal',
                    value: tasks.length,
                    Icon: ClockIcon,
                    color: 'bg-primary/10 text-primary',
                  },
                  {
                    label: 'cronStatsActive',
                    value: activeJobs.length,
                    Icon: PlayIcon,
                    color: 'bg-green-500/10 text-green-600 dark:text-green-500',
                  },
                  {
                    label: 'cronStatsPaused',
                    value: pausedJobs.length,
                    Icon: PauseIcon,
                    color: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500',
                  },
                  {
                    label: 'cronStatsFailed',
                    value: failedJobs.length,
                    Icon: XCircleIcon,
                    color: 'bg-red-500/10 text-red-500',
                  },
                ].map(stat => (
                  <div
                    key={stat.label}
                    className="flex min-h-[76px] flex-col items-center justify-between rounded-2xl border border-border-subtle bg-surface p-2.5 text-center shadow-subtle transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-card"
                  >
                    <div
                      className={
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ' + stat.color
                      }
                    >
                      <stat.Icon className="h-[18px] w-[18px]" />
                    </div>
                    <div className="flex items-baseline justify-center gap-1.5">
                      <p className="text-lg font-semibold tabular-nums text-foreground">
                        {stat.value}
                      </p>
                      <p className="text-xs font-medium text-secondary">{t(stat.label)}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Jobs Grid / Empty State */}
              {tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-secondary bg-black/5 dark:bg-white/5 rounded-3xl border border-dashed border-border">
                  <ClockIcon className="h-12 w-12 mb-4 opacity-40" />
                  <h3 className="text-lg font-medium mb-2 text-foreground">
                    {t('cronEmptyTitle')}
                  </h3>
                  <p className="text-sm text-center mb-6 max-w-md">{t('cronEmptyDescription')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingJob(undefined);
                      setShowDialog(true);
                    }}
                    className="px-6 py-2.5 text-sm font-medium rounded-full bg-primary text-white hover:bg-primary-hover transition-colors inline-flex items-center gap-2"
                  >
                    <PlusIcon className="h-4 w-4" />
                    {t('cronEmptyCreate')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {tasks.map(job => (
                    <CronJobCard
                      key={job.id}
                      job={job}
                      onToggle={enabled => handleToggle(job.id, enabled)}
                      onEdit={() => {
                        setEditingJob(job);
                        setShowDialog(true);
                      }}
                      onDelete={() => setJobToDelete(job)}
                      onTrigger={() => scheduledTaskService.runManually(job.id)}
                      onHistory={() => setHistoryTaskId(job.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Create/Edit Dialog */}
      <CreateEditDialog
        open={showDialog}
        job={editingJob}
        onClose={() => {
          setShowDialog(false);
          setEditingJob(undefined);
        }}
        onSave={handleSave}
      />

      {/* Delete Confirmation Dialog */}
      {jobToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setJobToDelete(null)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-full max-w-sm mx-4 rounded-2xl shadow-2xl bg-background border border-border p-6"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-foreground mb-2">{t('delete')}</h3>
            <p className="text-sm text-secondary mb-6">
              {t('scheduledTasksDeleteConfirm').replace('{name}', jobToDelete.name)}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setJobToDelete(null)}
                className="px-4 py-2 text-sm font-medium rounded-xl text-secondary hover:bg-surface-raised transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="px-4 py-2 text-sm font-medium rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run History Modal */}
      {historyTaskId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setHistoryTaskId(null)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-2xl shadow-2xl bg-background border border-border overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
              <h2 className="text-lg font-semibold text-foreground">
                {historyJob?.name ?? ''} - {t('cronCardHistory')}
              </h2>
              <button
                type="button"
                onClick={() => setHistoryTaskId(null)}
                className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <TaskRunHistory
                taskId={historyTaskId}
                taskName={historyJob?.name}
                runs={historyRuns}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CronView;
