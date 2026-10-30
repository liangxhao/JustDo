import {
  ArrowPathIcon,
  BoltIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  HeartIcon,
  InboxIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  getScheduledTaskPermission,
  ScheduledTaskPermission,
} from '@shared/scheduledTask/permissions';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskUpdateInput,
} from '@shared/scheduledTask/types';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import EngineInteractionBoundary from '@/app/shell/startup/routing/EngineInteractionBoundary';
import { useEngineReadiness } from '@/app/shell/startup/routing/useEngineReadiness';
import type { Model } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';
import ResultInbox from '@/features/scheduled-tasks/components/ResultInbox';
import TaskRunHistory from '@/features/scheduled-tasks/components/TaskRunHistory';
import {
  formatDateTime,
  formatScheduleLabel,
  getKnownSystemTaskPresentation,
  getStatusLabelKey,
  getStatusTone,
  getTaskAgentLabel,
  getTaskDisplayName,
  getTaskExecutionPreview,
  getTaskPromptText,
  isMemoryDreamingTask,
} from '@/features/scheduled-tasks/components/utils';
import { scheduledTaskService } from '@/features/scheduled-tasks/scheduledTaskService';
import { i18nService } from '@/services/i18n';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import { RootState } from '@/store';

import {
  MEMORY_DREAMING_CARD_ID,
  useMemoryDreamingControl,
  withMemoryDreamingCard,
} from './memoryDreamingControl';
import type { IntervalUnit, RecurrenceKind, ScheduleFormState, ScheduleMode } from './scheduleForm';
import {
  buildScheduleForSubmission,
  buildScheduleFromForm,
  computeNextRunPreview,
  intervalMilliseconds,
  isScheduleFormUnchanged,
  isValidFutureOnceSchedule,
  isValidTimezone,
  pad2,
  parseScheduleToForm,
} from './scheduleForm';
import SchedulerSettingsDialog from './SchedulerSettingsDialog';
import { buildAdvancedPayloadPatch, parseAdvancedTaskForm } from './taskEditor';
import TaskStateNotice from './TaskStateNotice';

export type { ScheduleFormState } from './scheduleForm';
export {
  buildScheduleFromForm,
  computeNextRunPreview,
  isValidFutureOnceSchedule,
  parseScheduleToForm,
} from './scheduleForm';

// ── Schedule Builder Types ─────────────────────────────────────────

const RECURRENCE_KINDS: RecurrenceKind[] = [
  'interval',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'custom',
];
const EMPTY_SCHEDULED_TASK_RUNS: ScheduledTaskRun[] = [];

export function requiresScheduledTaskRunConfirmation(job: ScheduledTask): boolean {
  return (
    job.management === 'advanced' &&
    (job.payload.kind === 'command' || job.payload.kind === 'script')
  );
}

export function groupScheduledTasks(tasks: ScheduledTask[]): {
  userTasks: ScheduledTask[];
  systemTasks: ScheduledTask[];
} {
  return tasks.reduce(
    (groups, task) => {
      if (task.management === 'managed') {
        groups.systemTasks.push(task);
      } else {
        groups.userTasks.push(task);
      }
      return groups;
    },
    { userTasks: [], systemTasks: [] } as {
      userTasks: ScheduledTask[];
      systemTasks: ScheduledTask[];
    },
  );
}

export function buildScheduledTaskExecutionInput(
  job: Pick<ScheduledTask, 'sessionTarget' | 'payload'> | undefined,
  message: string,
): Pick<ScheduledTaskInput, 'sessionTarget' | 'payload'> {
  if (job?.payload.kind === 'systemEvent') {
    return {
      sessionTarget: job.sessionTarget === 'main' ? 'main' : 'isolated',
      payload: { ...job.payload, text: message },
    };
  }
  if (job?.payload.kind === 'agentTurn') {
    return {
      sessionTarget: job.sessionTarget === 'main' ? 'main' : 'isolated',
      payload: { ...job.payload, message },
    };
  }
  return {
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message },
  };
}

function editablePayloadText(job?: ScheduledTask): string {
  if (job?.payload.kind === 'systemEvent') return job.payload.text;
  if (job?.payload.kind === 'agentTurn') return job.payload.message;
  return '';
}

// ── Cron Job Card ──────────────────────────────────────────────────

interface CronJobCardProps {
  memoryToggleDisabled?: boolean;
  memoryFeatureEnabled?: boolean;
  job: ScheduledTask;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTrigger: () => Promise<boolean>;
  onHistory: () => void;
  onDetails: () => void;
}

function getTaskVisual(job: ScheduledTask): {
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  cardClass: string;
  iconClass: string;
} {
  switch (job.payload.kind) {
    case 'heartbeat':
      return {
        Icon: HeartIcon,
        cardClass: 'bg-gradient-to-br from-rose-500/[0.07] via-surface to-surface',
        iconClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
      };
    case 'command':
      return {
        Icon: CommandLineIcon,
        cardClass: 'bg-gradient-to-br from-orange-500/[0.07] via-surface to-surface',
        iconClass: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
      };
    case 'script':
      return {
        Icon: CodeBracketIcon,
        cardClass: 'bg-gradient-to-br from-indigo-500/[0.07] via-surface to-surface',
        iconClass: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
      };
    case 'systemEvent':
      return {
        Icon: BoltIcon,
        cardClass: 'bg-gradient-to-br from-cyan-500/[0.07] via-surface to-surface',
        iconClass: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
      };
    default:
      return {
        Icon: ChatBubbleLeftRightIcon,
        cardClass: 'bg-gradient-to-br from-violet-500/[0.07] via-surface to-surface',
        iconClass: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
      };
  }
}

export function CronJobCard({
  memoryToggleDisabled = true,
  memoryFeatureEnabled,
  job,
  onToggle,
  onEdit,
  onDelete,
  onTrigger,
  onHistory,
  onDetails,
}: CronJobCardProps) {
  const t = i18nService.t.bind(i18nService);
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggering(true);
    try {
      const queued = await onTrigger();
      if (queued) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastTriggered') }));
      }
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

  const promptText = getTaskPromptText(job);
  const agents = useSelector((s: RootState) => s.agent.agents);
  const displayName = getTaskDisplayName(job);
  const agentLabel = isMemoryDreamingTask(job)
    ? t('cronMemoryScope')
    : getTaskAgentLabel(job, agents);
  const isEnabled = job.enabled;
  const isManaged = job.management === 'managed';
  const isMemory = isMemoryDreamingTask(job);
  const switchEnabled = isMemory ? (memoryFeatureEnabled ?? isEnabled) : isEnabled;
  const switchLabel = isMemory
    ? t(switchEnabled ? 'cronMemoryFeatureOn' : 'cronMemoryFeatureOff')
    : t(switchEnabled ? 'cronStatsActive' : 'cronStatsPaused');
  const isPlaceholder = job.id === MEMORY_DREAMING_CARD_ID;
  const toggleDisabled = isMemory ? memoryToggleDisabled : isManaged;
  const isEditable = job.management === 'editable';
  const hasLastRun = Boolean(job.state.lastRunAtMs);
  const lastStatus = job.state.lastStatus;
  const lastError = job.state.lastError;
  const nextRunMs = job.state.nextRunAtMs;
  const scheduleLabel = isPlaceholder
    ? t('cronMemoryScheduleManaged')
    : formatScheduleLabel(job.schedule);
  const nextRunLabel =
    nextRunMs && isEnabled ? `${t('cronCardNext')}: ${formatDateTime(new Date(nextRunMs))}` : null;
  const visual = getTaskVisual(job);

  return (
    <div
      data-testid={'cron-job-card-' + job.id}
      className={
        'group relative flex h-full min-h-[132px] flex-col overflow-hidden rounded-xl border transition-colors ' +
        visual.cardClass +
        ' ' +
        (isEditable ? 'cursor-pointer ' : '') +
        (isEnabled
          ? 'border-border-subtle hover:border-border'
          : 'border-border-subtle opacity-75 hover:border-border hover:opacity-100')
      }
      onClick={isEditable ? onEdit : undefined}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${visual.iconClass}`}
          >
            <visual.Icon className="h-4 w-4" />
          </span>
          <h3
            className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-foreground"
            title={displayName}
          >
            {displayName}
          </h3>
        </div>

        {job.management === 'advanced' && (
          <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
            {t('cronCardAdvanced')}
          </span>
        )}

        {isManaged && !isMemory ? (
          <span
            className="shrink-0 text-xs text-secondary"
            title={t('cronCardManagedHint')}
          >
            {t(isEnabled ? 'cronStatsActive' : 'cronStatsPaused')}
          </span>
        ) : (
          <div className="shrink-0" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              role="switch"
              aria-checked={switchEnabled}
              aria-label={switchLabel}
              disabled={toggleDisabled}
              title={isMemory ? t('cronMemoryToggleHint') : undefined}
              onClick={e => {
                e.stopPropagation();
                onToggle(!switchEnabled);
              }}
              className={
                'inline-flex items-center gap-1.5 rounded-lg py-1 pl-1.5 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ' +
                (switchEnabled ? 'text-green-600 dark:text-green-400' : 'text-secondary') +
                (toggleDisabled ? ' cursor-not-allowed opacity-60' : '')
              }
            >
              <span className="text-[10px] font-medium">{switchLabel}</span>
              <span
                className={
                  'relative h-[18px] w-8 shrink-0 rounded-full transition-colors ' +
                  (switchEnabled ? 'bg-primary' : 'bg-border')
                }
              >
                <span
                  className={
                    'absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ' +
                    (switchEnabled ? 'translate-x-3.5' : 'translate-x-0')
                  }
                />
              </span>
            </button>
          </div>
        )}
      </div>

      <div className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 pb-2 text-xs text-secondary">
        {agentLabel && (
          <>
            <UserIcon className="h-3.5 w-3.5" />
            <p className="min-w-0 truncate leading-4" title={agentLabel}>
              {agentLabel}
            </p>
          </>
        )}
        <CalendarDaysIcon className="h-3.5 w-3.5" />
        <p
          className="flex min-w-0 items-center gap-1.5 font-medium leading-4"
          title={[scheduleLabel, nextRunLabel].filter(Boolean).join(' · ')}
        >
          <span className={nextRunLabel ? 'max-w-[55%] shrink-0 truncate' : 'truncate'}>
            {scheduleLabel}
          </span>
          {isMemory && !isPlaceholder && !isEnabled && (
            <span className="shrink-0 text-amber-600 dark:text-amber-400">
              {t('cronMemoryJobPaused')}
            </span>
          )}
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
              {lastStatus && (
                <span className={getStatusTone(lastStatus)}>
                  {' · '}
                  {t(getStatusLabelKey(lastStatus))}
                </span>
              )}
            </span>
          </>
        )}
      </div>

      <TaskStateNotice state={job.state} enabled={job.enabled} className="px-3 pb-2" />
      {!isPlaceholder && (
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
            disabled={triggering || isManaged}
            title={isManaged ? t('cronCardManagedHint') : undefined}
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
          {!isEditable && (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onDetails();
              }}
              title={t('cronDetailsTitle')}
              aria-label={t('cronDetailsTitle')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <InformationCircleIcon className="h-4 w-4" />
            </button>
          )}
          {isEditable && (
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
          )}
          {!isManaged && (
            <button
              type="button"
              onClick={handleDeleteClick}
              title={t('delete')}
              aria-label={t('delete')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface TaskDetailsDialogProps {
  job: ScheduledTask;
  onClose: () => void;
}

function TaskDetailsDialog({ job, onClose }: TaskDetailsDialogProps) {
  const t = i18nService.t.bind(i18nService);
  const systemPresentation = getKnownSystemTaskPresentation(job);
  const isKnownSystemTask = systemPresentation !== null;
  const agents = useSelector((s: RootState) => s.agent.agents);
  const displayName = getTaskDisplayName(job);
  const agentLabel = isMemoryDreamingTask(job)
    ? t('cronMemoryScope')
    : getTaskAgentLabel(job, agents);
  const payloadKind = isKnownSystemTask
    ? t('scheduledTasksManagedBackgroundType')
    : job.payload.kind === 'agentTurn'
      ? t('scheduledTasksFormPayloadKindAgentTurn')
      : job.payload.kind === 'systemEvent'
        ? t('scheduledTasksFormPayloadKindSystemEvent')
        : job.payload.kind === 'command'
          ? t('scheduledTasksPayloadCommand')
          : job.payload.kind === 'script'
            ? t('scheduledTasksPayloadScript')
            : t('scheduledTasksPayloadHeartbeat');
  const sessionTarget =
    job.sessionTarget === 'main'
      ? t('cronDetailsSessionMain')
      : job.sessionTarget === 'isolated'
        ? t('cronDetailsSessionIsolated')
        : job.sessionTarget === 'current'
          ? t('cronDetailsSessionCurrent')
          : job.sessionTarget.slice('session:'.length);
  const delivery = isKnownSystemTask
    ? t('scheduledTasksManagedBackgroundDelivery')
    : job.delivery.mode === 'none'
      ? t('cronDialogDeliveryModeNone')
      : [
          job.delivery.mode === 'announce'
            ? t('cronDialogDeliveryModeAnnounce')
            : t('scheduledTasksFormDeliveryModeWebhook'),
          job.delivery.channel,
          job.delivery.to,
          job.delivery.accountId,
          job.delivery.bestEffort === true ? t('cronDetailsBestEffort') : undefined,
        ]
          .filter(Boolean)
          .join(' · ');
  const triggerOptions =
    job.schedule.kind === 'cron'
      ? [
          job.schedule.tz ? `${t('cronDetailsTimezone')}: ${job.schedule.tz}` : undefined,
          typeof job.schedule.staggerMs === 'number'
            ? `${t('cronDetailsStagger')}: ${job.schedule.staggerMs} ms`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : job.schedule.kind === 'every'
        ? [
            typeof job.schedule.anchorMs === 'number'
              ? `${t('cronDetailsAnchor')}: ${formatDateTime(new Date(job.schedule.anchorMs))}`
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ')
        : job.schedule.kind === 'on-exit'
          ? [
              job.schedule.cwd
                ? `${t('cronDetailsWorkingDirectory')}: ${job.schedule.cwd}`
                : undefined,
            ]
              .filter(Boolean)
              .join(' · ')
          : job.schedule.kind === 'stream'
            ? [
                job.schedule.cwd
                  ? `${t('cronDetailsWorkingDirectory')}: ${job.schedule.cwd}`
                  : undefined,
                job.schedule.mode ? `${t('cronDetailsMode')}: ${job.schedule.mode}` : undefined,
                job.schedule.match ? `${t('cronDetailsMatch')}: ${job.schedule.match}` : undefined,
                typeof job.schedule.batchMs === 'number'
                  ? `${t('cronDetailsBatchWindow')}: ${job.schedule.batchMs} ms`
                  : undefined,
                typeof job.schedule.maxBatchBytes === 'number'
                  ? `${t('cronDetailsMaxOutput')}: ${job.schedule.maxBatchBytes} bytes`
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · ')
            : '';
  const payloadOptions =
    job.payload.kind === 'command'
      ? [
          job.payload.cwd ? `${t('cronDetailsWorkingDirectory')}: ${job.payload.cwd}` : undefined,
          typeof job.payload.timeoutSeconds === 'number'
            ? `${t('cronDetailsTimeout')}: ${job.payload.timeoutSeconds} s`
            : undefined,
          typeof job.payload.noOutputTimeoutSeconds === 'number'
            ? `${t('cronDetailsNoOutputTimeout')}: ${job.payload.noOutputTimeoutSeconds} s`
            : undefined,
          typeof job.payload.outputMaxBytes === 'number'
            ? `${t('cronDetailsMaxOutput')}: ${job.payload.outputMaxBytes} bytes`
            : undefined,
          job.payload.toolsAllow?.length
            ? `${t('cronDetailsAllowedTools')}: ${job.payload.toolsAllow.join(', ')}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : job.payload.kind === 'script'
        ? [
            typeof job.payload.timeoutSeconds === 'number'
              ? `${t('cronDetailsTimeout')}: ${job.payload.timeoutSeconds} s`
              : undefined,
            typeof job.payload.toolBudget === 'number'
              ? `${t('cronDetailsToolBudget')}: ${job.payload.toolBudget}`
              : undefined,
            job.payload.toolsAllow?.length
              ? `${t('cronDetailsAllowedTools')}: ${job.payload.toolsAllow.join(', ')}`
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ')
        : job.payload.kind === 'agentTurn'
          ? [
              job.payload.model ? `${t('cronDetailsModel')}: ${job.payload.model}` : undefined,
              job.payload.fallbacks?.length
                ? `${t('cronDetailsFallbacks')}: ${job.payload.fallbacks.join(', ')}`
                : undefined,
              typeof job.payload.timeoutSeconds === 'number'
                ? `${t('cronDetailsTimeout')}: ${job.payload.timeoutSeconds} s`
                : undefined,
              job.payload.toolsAllow?.length
                ? `${t('cronDetailsAllowedTools')}: ${job.payload.toolsAllow.join(', ')}`
                : undefined,
            ]
              .filter(Boolean)
              .join(' · ')
          : job.payload.kind === 'systemEvent' && job.payload.toolsAllow?.length
            ? `${t('cronDetailsAllowedTools')}: ${job.payload.toolsAllow.join(', ')}`
            : '';
  const advancedFeatureLabels: Record<
    NonNullable<ScheduledTask['advancedFeatures']>[number],
    string
  > = {
    owner: t('cronAdvancedFeatureOwner'),
    'account-tool-policy': t('cronAdvancedFeatureAccountPolicy'),
    pacing: t('cronAdvancedFeaturePacing'),
    trigger: t('cronAdvancedFeatureTrigger'),
    'failure-alert': t('cronAdvancedFeatureFailureAlert'),
    'delete-after-run': t('cronAdvancedFeatureDeleteAfterRun'),
    'advanced-delivery': t('cronAdvancedFeatureDelivery'),
    'command-environment': t('cronAdvancedFeatureCommandEnvironment'),
    'command-input': t('cronAdvancedFeatureCommandInput'),
  };
  const advancedFeatures = job.advancedFeatures
    ?.map(feature => advancedFeatureLabels[feature])
    .join(' · ');
  const rows = [
    ...(systemPresentation
      ? [
          {
            label: t('cronDetailsDescription'),
            value: systemPresentation.description,
          },
        ]
      : job.description
        ? [{ label: t('cronDetailsDescription'), value: job.description }]
        : []),
    ...(isKnownSystemTask
      ? [{ label: t('cronDialogPermissionTitle'), value: t('cronSystemPermissionHint') }]
      : []),
    { label: t('cronDialogSchedule'), value: formatScheduleLabel(job.schedule) },
    ...(triggerOptions ? [{ label: t('cronDetailsTriggerOptions'), value: triggerOptions }] : []),
    { label: t('cronDetailsPayloadType'), value: payloadKind },
    ...(!isKnownSystemTask && payloadOptions
      ? [{ label: t('cronDetailsPayloadOptions'), value: payloadOptions }]
      : []),
    ...(!isKnownSystemTask && advancedFeatures
      ? [{ label: t('cronDetailsAdvancedFeatures'), value: advancedFeatures }]
      : []),
    ...(!isKnownSystemTask ? [{ label: t('cronDetailsSessionTarget'), value: sessionTarget }] : []),
    { label: t('cronDialogDeliveryTitle'), value: delivery },
    {
      label: t('cronDetailsStatus'),
      value: t(job.enabled ? 'cronStatsActive' : 'cronStatsPaused'),
    },
    ...(!isKnownSystemTask ? [{ label: t('cronDetailsTaskId'), value: job.id }] : []),
  ];
  const technicalRows = [{ label: t('cronDetailsTaskId'), value: job.id }];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-task-details-title"
        className="relative mx-4 flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2
              id="scheduled-task-details-title"
              className="truncate text-lg font-semibold text-foreground"
            >
              {displayName}
            </h2>
            {agentLabel && (
              <p className="mt-1 flex items-center gap-2 text-xs text-secondary">
                <UserIcon className="h-3.5 w-3.5" />
                {agentLabel}
              </p>
            )}
            <p className="mt-0.5 text-xs text-secondary">{t('cronDetailsTitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-border-subtle bg-surface-raised/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-background px-2 py-1 text-xs font-medium text-secondary">
                {t(job.management === 'managed' ? 'cronCardManaged' : 'cronCardAdvanced')}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-secondary">
              {systemPresentation?.managedHint ??
                t(job.management === 'managed' ? 'cronCardManagedHint' : 'cronDetailsAdvancedHint')}
            </p>
          </div>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
            {rows.map(row => (
              <React.Fragment key={row.label}>
                <dt className="text-xs font-medium text-secondary">{row.label}</dt>
                <dd className="break-words text-sm text-foreground">{row.value}</dd>
              </React.Fragment>
            ))}
          </dl>

          {isKnownSystemTask ? (
            <details className="rounded-xl border border-border-subtle bg-surface-raised/30 px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-secondary">
                {t('cronDetailsTechnicalInfo')}
              </summary>
              <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
                {technicalRows.map(row => (
                  <React.Fragment key={row.label}>
                    <dt className="text-xs font-medium text-secondary">{row.label}</dt>
                    <dd className="break-all text-xs leading-5 text-secondary">{row.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </details>
          ) : (
            <div>
              <h3 className="mb-2 text-xs font-medium text-secondary">{t('cronDetailsPayload')}</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-surface px-4 py-3 font-sans text-sm leading-6 text-foreground">
                {getTaskPromptText(job)}
              </pre>
            </div>
          )}
        </div>
        <div className="flex justify-end border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
          >
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create/Edit Dialog ─────────────────────────────────────────────

type TaskAgentOption = { id: string; name: string; enabled: boolean; deletedAt?: number };

interface DialogProps {
  agents?: readonly TaskAgentOption[];
  models?: readonly Model[];
  open: boolean;
  job?: ScheduledTask;
  onClose: () => void;
  onSave: (input: ScheduledTaskInput | ScheduledTaskUpdateInput) => Promise<void>;
}

export function CreateEditDialog({
  open,
  job,
  onClose,
  onSave,
  agents = [],
  models = [],
}: DialogProps) {
  const t = i18nService.t.bind(i18nService);
  const isEdit = !!job;
  const initialAgentId = job?.agentId ?? 'main';
  const [agentId, setAgentId] = useState(initialAgentId);
  const initialModel = job?.payload.kind === 'agentTurn' ? (job.payload.model ?? '') : '';
  const [modelRef, setModelRef] = useState(initialModel);
  const modelOptions = models
    .filter(model => model.id)
    .map(model => ({
      ref: toOpenClawModelRef(model),
      label: `${model.name} · ${model.provider || model.providerKey || toOpenClawModelRef(model).split('/')[0]}`,
      disabled: model.available === false,
    }));
  const availableAgents = agents.filter(agent => agent.enabled && !agent.deletedAt);
  const showFallbackMain = !agents.some(agent => agent.id === 'main');
  const knownAgentIds = new Set([
    ...(showFallbackMain ? ['main'] : []),
    ...availableAgents.map(agent => agent.id),
  ]);

  const [name, setName] = useState(job?.name ?? '');
  const [message, setMessage] = useState(editablePayloadText(job));
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(() =>
    parseScheduleToForm(job?.schedule),
  );
  const [advancedForm, setAdvancedForm] = useState(() => parseAdvancedTaskForm(job));
  const [enabled, setEnabled] = useState(job ? job.enabled : true);
  const [permissionMode, setPermissionMode] = useState<ScheduledTaskPermission>(
    job?.payload.kind === 'agentTurn'
      ? getScheduledTaskPermission(job.payload)
      : ScheduledTaskPermission.ReadOnly,
  );
  const [deliveryChannel, setDeliveryChannel] = useState(job?.delivery.channel ?? '');
  const [deliveryMode, setDeliveryMode] = useState<'none' | 'announce' | 'webhook'>(
    job?.delivery.mode === 'announce'
      ? 'announce'
      : job?.delivery.mode === 'webhook'
        ? 'webhook'
        : 'none',
  );
  const [notificationExpanded, setNotificationExpanded] = useState(
    !!job && job.delivery.mode !== 'none',
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [channelOptions, setChannelOptions] = useState<ScheduledTaskChannelOption[]>([]);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [prevOpen, setPrevOpen] = useState(open);

  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setAgentId(initialAgentId);
      setModelRef(initialModel);
      setName(job?.name ?? '');
      setMessage(editablePayloadText(job));
      setScheduleForm(parseScheduleToForm(job?.schedule));
      setAdvancedForm(parseAdvancedTaskForm(job));
      setEnabled(job ? job.enabled : true);
      setPermissionMode(
        job?.payload.kind === 'agentTurn'
          ? getScheduledTaskPermission(job.payload)
          : ScheduledTaskPermission.ReadOnly,
      );
      setDeliveryChannel(job?.delivery.channel ?? '');
      setDeliveryMode(
        job?.delivery.mode === 'announce'
          ? 'announce'
          : job?.delivery.mode === 'webhook'
            ? 'webhook'
            : 'none',
      );
      setNotificationExpanded(!!job && job.delivery.mode !== 'none');
      setErrors({});
      setSubmitError(null);
      setSaving(false);
    }
  }

  const scheduleUnchanged = Boolean(job && isScheduleFormUnchanged(scheduleForm, job.schedule));
  const nativeNextRun = scheduleUnchanged ? job?.state.nextRunAtMs : null;
  const nextRunPreview = useMemo(() => {
    if (nativeNextRun && Number.isFinite(nativeNextRun)) {
      const tz = scheduleForm.timezone.trim();
      const date = new Date(nativeNextRun);
      return tz && isValidTimezone(tz)
        ? `${date.toLocaleString(undefined, { timeZone: tz })} (${tz})`
        : date.toLocaleString();
    }
    return computeNextRunPreview(scheduleForm);
  }, [scheduleForm, nativeNextRun]);

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
      setNotificationExpanded(true);
    }
    if (scheduleForm.mode === 'once' && !scheduleUnchanged) {
      const dt = new Date(scheduleForm.onceDate + 'T' + (scheduleForm.onceTime || '00:00'));
      if (!scheduleForm.onceDate.trim() || !Number.isFinite(dt.getTime())) {
        next.schedule = t('cronToastScheduleRequired');
      } else if (!isValidFutureOnceSchedule(scheduleForm)) {
        next.schedule = t('cronToastSchedulePast');
      }
    }
    if (!scheduleUnchanged) {
      try {
        buildScheduleFromForm(scheduleForm);
      } catch {
        next.schedule = t('cronToastInvalidCron');
      }
    }
    try {
      buildAdvancedPayloadPatch(
        advancedForm,
        job?.payload.kind === 'agentTurn' ? job.payload : undefined,
      );
    } catch {
      next.advanced = t('cronToastInvalidAdvanced');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitError(null);
    setSaving(true);
    try {
      const originalSchedule =
        job?.schedule.kind === 'at' ||
        job?.schedule.kind === 'every' ||
        job?.schedule.kind === 'cron'
          ? job.schedule
          : undefined;
      const schedule = buildScheduleForSubmission(scheduleForm, originalSchedule);
      const execution = buildScheduledTaskExecutionInput(job, message.trim());
      const payload =
        execution.payload.kind === 'agentTurn'
          ? {
              kind: 'agentTurn' as const,
              message: message.trim(),
              ...((!job && modelRef) || (job && modelRef !== initialModel)
                ? { model: modelRef }
                : {}),
              ...buildAdvancedPayloadPatch(
                advancedForm,
                job?.payload.kind === 'agentTurn' ? job.payload : undefined,
              ),
            }
          : { kind: 'systemEvent' as const, text: message.trim() };
      const initialAdvanced = parseAdvancedTaskForm(job);
      const deleteAfterRun =
        schedule.kind === 'at'
          ? !job
            ? advancedForm.keepOnce
              ? false
              : undefined
            : job.schedule.kind !== 'at' || advancedForm.keepOnce !== initialAdvanced.keepOnce
              ? !advancedForm.keepOnce
              : undefined
          : job?.schedule.kind === 'at'
            ? false
            : undefined;
      const input: ScheduledTaskInput | ScheduledTaskUpdateInput = {
        ...(!job ||
        (job.payload.kind === 'agentTurn' &&
          permissionMode !== getScheduledTaskPermission(job.payload))
          ? { permissionMode }
          : {}),
        ...(execution.payload.kind === 'agentTurn' && (!job || agentId !== initialAgentId)
          ? { agentId, ...(job ? { sessionKey: null } : {}) }
          : {}),
        name: name.trim(),
        description: job?.description ?? '',
        enabled,
        ...(!job || !scheduleUnchanged ? { schedule } : {}),
        ...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
        sessionTarget: execution.sessionTarget,
        wakeMode: job?.wakeMode ?? 'now',
        payload,
        delivery:
          deliveryMode === 'none'
            ? job?.delivery.mode === 'none'
              ? job.delivery
              : { mode: 'none' }
            : deliveryMode === 'webhook' && job?.delivery.mode === 'webhook'
              ? job.delivery
              : deliveryMode === 'announce' && job?.delivery.mode === 'announce'
                ? { ...job.delivery, channel: deliveryChannel || undefined }
                : { mode: 'announce', channel: deliveryChannel || undefined },
      };
      await onSave(input);
      onClose();
    } catch {
      setSubmitError(t(isEdit ? 'cronToastFailedUpdate' : 'cronToastFailedCreate'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const inputClass =
    'w-full rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-secondary/60 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all';
  const labelClass = 'block text-sm font-medium text-foreground mb-1.5';
  const isCustomRecurrence = scheduleForm.recurrence === 'custom';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/10 dark:bg-black/25" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scheduled-task-edit-title"
        className="relative flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle shrink-0">
          <div>
            <h2 id="scheduled-task-edit-title" className="text-lg font-semibold text-foreground">
              {isEdit ? t('cronDialogEditTitle') : t('cronDialogCreateTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-secondary">{t('cronDialogSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
          <section className="border-b border-border-subtle pb-4">
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
            <div className="mt-3">
              <label className={labelClass}>{t('cronDialogMessage')}</label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                className={inputClass + ' resize-none'}
                placeholder={t('cronDialogMessagePlaceholder')}
                rows={3}
              />
              {errors.message && <p className="text-xs text-red-500 mt-1">{errors.message}</p>}
            </div>
          </section>

          {/* Schedule Builder */}
          <section className="border-b border-border-subtle pb-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {t('cronDialogSchedule')}
            </h3>

            {/* Mode tabs */}
            <div className="flex rounded-xl bg-black/5 dark:bg-white/5 p-1 mb-3">
              {(['recurring', 'once'] as ScheduleMode[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScheduleForm(s => ({ ...s, mode }))}
                  className={
                    'flex-1 py-1.5 text-sm font-medium rounded-lg transition-all ' +
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
                    step="0.001"
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
                    <span className="font-medium text-foreground/80">
                      {t(nativeNextRun ? 'cronCardNext' : 'cronSchedulePreview')}:
                    </span>{' '}
                    {nextRunPreview}
                    {!nativeNextRun && <p className="mt-1">{t('cronSchedulePreviewHint')}</p>}
                    {!nativeNextRun && Number(scheduleForm.staggerSeconds) > 0 && (
                      <p className="mt-1">
                        {t('cronSchedulePreviewStagger').replace(
                          '{seconds}',
                          scheduleForm.staggerSeconds,
                        )}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            {errors.schedule && <p className="text-xs text-red-500 mt-1">{errors.schedule}</p>}
          </section>

          <div className="grid grid-cols-1 gap-4 border-b border-border-subtle pb-4 sm:grid-cols-2">
            {(!job || job.payload.kind === 'agentTurn') && (
              <section className="min-w-0">
                <label htmlFor="scheduled-task-agent" className={labelClass}>
                  {t('cronDialogAgentTitle')}
                </label>
                <select
                  id="scheduled-task-agent"
                  className={inputClass}
                  value={agentId}
                  onChange={event => setAgentId(event.target.value)}
                >
                  {showFallbackMain && (
                    <option value="main">{t('scheduledTasksMainAssistant')}</option>
                  )}
                  {availableAgents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                  {!knownAgentIds.has(agentId) && (
                    <option value={agentId} disabled>
                      {getTaskAgentLabel({ agentId }, agents)}
                    </option>
                  )}
                </select>
                <p className="mt-2 text-xs text-secondary">{t('cronDialogAgentHint')}</p>
              </section>
            )}
            {(!job || job.payload.kind === 'agentTurn') && (
              <section className="min-w-0">
                <label htmlFor="scheduled-task-model" className={labelClass}>
                  {t('cronDialogModelTitle')}
                </label>
                <select
                  id="scheduled-task-model"
                  className={inputClass}
                  value={modelRef}
                  onChange={event => setModelRef(event.target.value)}
                >
                  <option value="">{t('cronDialogModelInherit')}</option>
                  {modelRef && !modelOptions.some(option => option.ref === modelRef) && (
                    <option value={modelRef}>{modelRef}</option>
                  )}
                  {modelOptions.map(option => (
                    <option key={option.ref} value={option.ref} disabled={option.disabled}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-secondary">{t('cronDialogModelHint')}</p>
              </section>
            )}
            <section className="min-w-0">
              <label htmlFor="scheduled-task-permission" className={labelClass}>
                {t('cronDialogPermissionTitle')}
              </label>
              {job?.payload.kind === 'systemEvent' ? (
                <p className="text-xs text-secondary">{t('cronDialogPermissionInheritedHint')}</p>
              ) : (
                <>
                  <select
                    id="scheduled-task-permission"
                    className={inputClass}
                    value={permissionMode}
                    onChange={event =>
                      setPermissionMode(event.target.value as ScheduledTaskPermission)
                    }
                  >
                    <option value={ScheduledTaskPermission.ReadOnly}>
                      {t('cronDialogPermissionReadOnly')}
                    </option>
                    <option value={ScheduledTaskPermission.Full}>
                      {t('cronDialogPermissionFull')}
                    </option>
                    {job &&
                      job.payload.kind === 'agentTurn' &&
                      getScheduledTaskPermission(job.payload) ===
                        ScheduledTaskPermission.Custom && (
                        <option value={ScheduledTaskPermission.Custom}>
                          {t('cronDialogPermissionCustom')}
                        </option>
                      )}
                  </select>
                  <p className="mt-2 text-xs text-secondary">
                    {t(
                      permissionMode === ScheduledTaskPermission.ReadOnly
                        ? 'cronDialogPermissionReadOnlyHint'
                        : permissionMode === ScheduledTaskPermission.Full
                          ? 'cronDialogPermissionFullHint'
                          : 'cronDialogPermissionCustomHint',
                    )}
                  </p>
                </>
              )}
            </section>
          </div>

          <details className="group border-b border-border-subtle pb-4">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              {t('cronAdvancedSettingsTitle')}
              <ChevronDownIcon className="h-4 w-4 text-secondary transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 space-y-4">
              <p className="text-xs text-secondary">{t('cronAdvancedSettingsHint')}</p>
              {(!job || job.payload.kind === 'agentTurn') && (
                <>
                  <div>
                    <label htmlFor="scheduled-task-timeout" className={labelClass}>
                      {t('cronAdvancedTimeout')}
                    </label>
                    <input
                      id="scheduled-task-timeout"
                      type="number"
                      min="1"
                      step="1"
                      value={advancedForm.timeoutSeconds}
                      className={inputClass}
                      onChange={event =>
                        setAdvancedForm(form => ({ ...form, timeoutSeconds: event.target.value }))
                      }
                    />
                    <p className="mt-1 text-xs text-secondary">{t('cronAdvancedTimeoutHint')}</p>
                  </div>
                  <div>
                    <label htmlFor="scheduled-task-fallback-mode" className={labelClass}>
                      {t('cronAdvancedFallbacks')}
                    </label>
                    <select
                      id="scheduled-task-fallback-mode"
                      value={advancedForm.fallbackMode}
                      className={inputClass}
                      onChange={event =>
                        setAdvancedForm(form => ({
                          ...form,
                          fallbackMode: event.target.value as typeof form.fallbackMode,
                        }))
                      }
                    >
                      <option value="inherit">{t('cronAdvancedFallbacksInherit')}</option>
                      <option value="none">{t('cronAdvancedFallbacksNone')}</option>
                      <option value="custom">{t('cronAdvancedFallbacksCustom')}</option>
                    </select>
                    {advancedForm.fallbackMode === 'custom' && (
                      <input
                        aria-label={t('cronAdvancedFallbacksCustom')}
                        value={advancedForm.fallbackText}
                        className={inputClass + ' mt-2'}
                        list="scheduled-task-model-references"
                        onChange={event =>
                          setAdvancedForm(form => ({ ...form, fallbackText: event.target.value }))
                        }
                      />
                    )}
                    <datalist id="scheduled-task-model-references">
                      {modelOptions
                        .filter(option => !option.disabled)
                        .map(option => (
                          <option key={option.ref} value={option.ref} />
                        ))}
                    </datalist>
                    <p className="mt-1 text-xs text-secondary">{t('cronAdvancedFallbacksHint')}</p>
                  </div>
                  <label className="flex items-start gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={advancedForm.lightContext}
                      onChange={event =>
                        setAdvancedForm(form => ({ ...form, lightContext: event.target.checked }))
                      }
                    />
                    <span>
                      {t('cronAdvancedLightContext')}
                      <span className="mt-1 block text-xs text-secondary">
                        {t('cronAdvancedLightContextHint')}
                      </span>
                    </span>
                  </label>
                </>
              )}
              {scheduleForm.mode === 'recurring' && scheduleForm.recurrence !== 'interval' && (
                <div>
                  <label htmlFor="scheduled-task-stagger" className={labelClass}>
                    {t('cronAdvancedStagger')}
                  </label>
                  <input
                    id="scheduled-task-stagger"
                    type="number"
                    min="0"
                    step="0.001"
                    value={scheduleForm.staggerSeconds}
                    className={inputClass}
                    onChange={event =>
                      setScheduleForm(form => ({ ...form, staggerSeconds: event.target.value }))
                    }
                  />
                  <p className="mt-1 text-xs text-secondary">{t('cronAdvancedStaggerHint')}</p>
                </div>
              )}
              {scheduleForm.mode === 'once' && (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={advancedForm.keepOnce}
                    onChange={event =>
                      setAdvancedForm(form => ({ ...form, keepOnce: event.target.checked }))
                    }
                  />
                  <span>
                    {t('cronAdvancedKeepOnce')}
                    <span className="mt-1 block text-xs text-secondary">
                      {t('cronAdvancedKeepOnceHint')}
                    </span>
                  </span>
                </label>
              )}
              {errors.advanced && (
                <p role="alert" className="text-xs text-red-500">
                  {errors.advanced}
                </p>
              )}
            </div>
          </details>

          {/* Delivery */}
          <div className="flex items-center gap-2 text-xs text-secondary">
            <CheckCircleIcon className="h-4 w-4 shrink-0 text-primary" />
            {t('scheduledTasksResultsRetentionAlways')}
          </div>
          <details
            open={notificationExpanded}
            onToggle={event => setNotificationExpanded(event.currentTarget.open)}
            className="group border-b border-border-subtle pb-4"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              {t('scheduledTasksExternalNotificationTitle')}
              <span className="flex items-center gap-2 text-xs font-normal text-secondary">
                {deliveryMode === 'none'
                  ? t('cronDialogDeliveryModeNone')
                  : deliveryMode === 'announce'
                    ? t('cronDialogDeliveryModeAnnounce')
                    : t('scheduledTasksWebhookPreserved')}
                <ChevronDownIcon className="h-4 w-4 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <div className="mt-3">
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
                  {errors.delivery && (
                    <p className="mt-1 text-xs text-red-500">{errors.delivery}</p>
                  )}
                </div>
              )}
            </div>
          </details>

          {/* Enable toggle */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <label htmlFor="scheduled-task-enabled" className={labelClass + ' cursor-pointer'}>
                {t('cronDialogEnableImmediately')}
              </label>
              <p className="text-xs text-secondary">{t('cronDialogEnableImmediatelyDesc')}</p>
            </div>
            <button
              id="scheduled-task-enabled"
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t('cronDialogEnableImmediately')}
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

          {submitError && (
            <div
              className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
              role="alert"
            >
              <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-3 border-t border-border-subtle shrink-0">
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
  const engine = useEngineReadiness();
  const [hasAdmittedEngine, setHasAdmittedEngine] = useState(false);
  useEffect(() => {
    if (engine.ready) setHasAdmittedEngine(true);
  }, [engine.ready]);

  const allNativeTasks = useSelector((s: RootState) => s.scheduledTask.tasks);
  const models = useSelector((s: RootState) => s.model.availableModels);
  const agents = useSelector((s: RootState) => s.agent.agents);
  const nativeTasks = allNativeTasks;
  const memoryControl = useMemoryDreamingControl(nativeTasks, engine.ready);
  const toggleMemoryDreaming = memoryControl.toggle;

  const tasks = useMemo(
    () => withMemoryDreamingCard(nativeTasks, memoryControl.settings),
    [nativeTasks, memoryControl.settings],
  );
  const loading = useSelector((s: RootState) => s.scheduledTask.loading);
  const error = useSelector((s: RootState) => s.scheduledTask.error);
  const unreadResultCount = useSelector((s: RootState) => s.scheduledTask.unreadResultCount);

  const [showDialog, setShowDialog] = useState(false);
  const [showSchedulerSettings, setShowSchedulerSettings] = useState(false);
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean>();
  const schedulerSettingsSavedRef = useRef(false);
  useEffect(() => {
    if (!engine.ready) return;
    let active = true;
    const read = window.electron.scheduledTasks.getSchedulerSettings;
    if (!read) return;
    void read()
      .then(result => {
        if (active && !schedulerSettingsSavedRef.current && result.success && result.snapshot) {
          setSchedulerEnabled(result.snapshot.settings.enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [engine.ready]);
  const [editingJob, setEditingJob] = useState<ScheduledTask | undefined>();
  const [jobToDelete, setJobToDelete] = useState<ScheduledTask | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);
  const [jobToRunId, setJobToRunId] = useState<string | null>(null);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [detailsJobId, setDetailsJobId] = useState<string | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [historyRequestRevision, setHistoryRequestRevision] = useState(0);
  const [activeTab, setActiveTab] = useState<'tasks' | 'results'>('tasks');
  const [taskQuery, setTaskQuery] = useState('');
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | 'active' | 'paused' | 'failed'>(
    'all',
  );

  const historyRuns = useSelector((s: RootState) =>
    historyTaskId
      ? (s.scheduledTask.runs[historyTaskId] ?? EMPTY_SCHEDULED_TASK_RUNS)
      : EMPTY_SCHEDULED_TASK_RUNS,
  );
  const historyJob = useSelector((s: RootState) =>
    historyTaskId ? s.scheduledTask.tasks.find(t => t.id === historyTaskId) : undefined,
  );
  const detailsJob = useSelector((s: RootState) =>
    detailsJobId ? s.scheduledTask.tasks.find(t => t.id === detailsJobId) : undefined,
  );
  const jobToRun = useSelector((s: RootState) =>
    jobToRunId ? s.scheduledTask.tasks.find(task => task.id === jobToRunId) : undefined,
  );

  useEffect(() => {
    if (engine.ready) void scheduledTaskService.loadTasks();
  }, [engine.ready]);

  useEffect(() => {
    if (!historyTaskId || !engine.ready) {
      setHistoryLoading(false);
      return;
    }
    let active = true;
    setHistoryLoadError(false);
    setHistoryLoading(true);
    void scheduledTaskService
      .loadRuns(historyTaskId)
      .catch(() => {
        if (!active) return;
        setHistoryLoadError(true);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [historyRequestRevision, historyTaskId, engine.ready]);

  useEffect(() => {
    if (editingJob && !tasks.some(task => task.id === editingJob.id)) {
      setEditingJob(undefined);
      setShowDialog(false);
    }
    if (jobToDelete && !tasks.some(task => task.id === jobToDelete.id)) {
      setJobToDelete(null);
    }
    if (detailsJobId && !nativeTasks.some(task => task.id === detailsJobId)) {
      setDetailsJobId(null);
    }
    if (jobToRunId && !tasks.some(task => task.id === jobToRunId)) {
      setJobToRunId(null);
    }
  }, [detailsJobId, editingJob, jobToDelete, jobToRunId, tasks, nativeTasks]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (jobToRunId && !runSubmitting) setJobToRunId(null);
      else if (detailsJobId) setDetailsJobId(null);
      else if (historyTaskId) setHistoryTaskId(null);
      else if (jobToDelete && !deletingTask) setJobToDelete(null);
      else if (showDialog) {
        setShowDialog(false);
        setEditingJob(undefined);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    deletingTask,
    detailsJobId,
    historyTaskId,
    jobToDelete,
    jobToRunId,
    runSubmitting,
    showDialog,
  ]);

  const handleSave = useCallback(
    async (input: ScheduledTaskInput | ScheduledTaskUpdateInput) => {
      if (!engine.ready) return;
      if (editingJob) {
        await scheduledTaskService.updateTaskById(editingJob.id, input);
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastUpdated') }));
      } else {
        // The create form supplies all required fields and no reset sentinels.
        await scheduledTaskService.createTask(input as ScheduledTaskInput);
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastCreated') }));
      }
      setEditingJob(undefined);
    },
    [editingJob, t, engine.ready],
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (!engine.ready) return;
      try {
        if (
          id === MEMORY_DREAMING_CARD_ID ||
          nativeTasks.some(task => task.id === id && isMemoryDreamingTask(task))
        ) {
          if (!(await toggleMemoryDreaming(enabled))) return;
        } else {
          await scheduledTaskService.toggleTask(id, enabled);
        }
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
    [t, nativeTasks, toggleMemoryDreaming, engine.ready],
  );

  const handleDelete = useCallback(async () => {
    if (!engine.ready || !jobToDelete || deletingTask) return;
    setDeletingTask(true);
    try {
      await scheduledTaskService.deleteTask(jobToDelete.id);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastDeleted') }));
      setJobToDelete(null);
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: t('cronToastFailedDelete') }),
      );
    } finally {
      setDeletingTask(false);
    }
  }, [deletingTask, jobToDelete, t, engine.ready]);

  const handleRunRequest = useCallback(
    async (job: ScheduledTask): Promise<boolean> => {
      if (!engine.ready) return false;
      if (requiresScheduledTaskRunConfirmation(job)) {
        setJobToRunId(job.id);
        return false;
      }
      await scheduledTaskService.runManually(job.id);
      return true;
    },
    [engine.ready],
  );

  const handleConfirmedRun = useCallback(async () => {
    if (!engine.ready || !jobToRun || runSubmitting) return;
    setRunSubmitting(true);
    try {
      await scheduledTaskService.runManually(jobToRun.id, jobToRun.configRevision ?? undefined);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('cronToastTriggered') }));
      setJobToRunId(null);
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: t('cronToastFailedTrigger') }),
      );
    } finally {
      setRunSubmitting(false);
    }
  }, [jobToRun, runSubmitting, t, engine.ready]);

  const activeJobs = tasks.filter(j => j.enabled);
  const pausedJobs = tasks.filter(j => !j.enabled);
  const failedJobs = tasks.filter(j => j.state.lastStatus === 'error');
  const visibleTasks = useMemo(() => {
    const normalizedQuery = taskQuery.trim().toLocaleLowerCase();
    return tasks.filter(task => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        getTaskDisplayName(task).toLocaleLowerCase().includes(normalizedQuery) ||
        (getTaskAgentLabel(task, agents) ?? '').toLocaleLowerCase().includes(normalizedQuery) ||
        task.name.toLocaleLowerCase().includes(normalizedQuery) ||
        getTaskPromptText(task).toLocaleLowerCase().includes(normalizedQuery);
      const matchesStatus =
        taskStatusFilter === 'all' ||
        (taskStatusFilter === 'active' && task.enabled) ||
        (taskStatusFilter === 'paused' && !task.enabled) ||
        (taskStatusFilter === 'failed' && task.state.lastStatus === 'error');
      return matchesQuery && matchesStatus;
    });
  }, [taskQuery, taskStatusFilter, tasks, agents]);
  const { userTasks, systemTasks } = useMemo(
    () => groupScheduledTasks(visibleTasks),
    [visibleTasks],
  );

  return (
    <div className="sidebar-panel flex flex-col h-full min-h-0">
      {isSidebarCollapsed && (
        <div className="flex h-[2.1875rem] items-center justify-between px-4 border-b border-border shrink-0">
          <div className="flex items-center space-x-3 h-8">
            <div className="non-draggable flex items-center gap-1">
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
          </div>
        </div>
      )}

      {/* Content */}
      <div className="sidebar-panel-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="sidebar-panel-content flex flex-col py-6 md:py-8">
          <div className="mb-7 flex items-end justify-between gap-4 border-b border-border-subtle">
            <div className="flex gap-6">
              {(['tasks', 'results'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  disabled={!engine.ready && hasAdmittedEngine}
                  className={`relative inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                    activeTab === tab
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-secondary hover:text-foreground'
                  }`}
                >
                  {tab === 'tasks' ? (
                    <ClockIcon className="h-4 w-4" />
                  ) : (
                    <InboxIcon className="h-4 w-4" />
                  )}
                  {t(tab === 'tasks' ? 'scheduledTasksTabTasks' : 'scheduledTasksTabResults')}
                  {tab === 'results' && unreadResultCount > 0 && (
                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                      {unreadResultCount > 99 ? '99+' : unreadResultCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowSchedulerSettings(true)}
              disabled={!engine.ready}
              aria-label={t('schedulerSettingsTitle')}
              title={t('schedulerSettingsTitle')}
              className="mb-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <Cog6ToothIcon className="h-4 w-4" />
            </button>
          </div>
          {!engine.ready && (
            <div className="mb-5">
              {!hasAdmittedEngine && (
                <h1 className="mb-3 text-xl font-semibold text-foreground">
                  {t('scheduledTasks')}
                </h1>
              )}
              <p role="status" className="rounded-xl bg-surface px-4 py-5 text-sm text-secondary">
                {t(engine.failed ? 'engineUnavailableContent' : 'enginePreparingContent')}
              </p>
            </div>
          )}
          <EngineInteractionBoundary disabled={!engine.ready}>
            {(engine.ready || hasAdmittedEngine) && (
              <>
                {schedulerEnabled === false && (
                  <p
                    role="status"
                    className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
                  >
                    {t('schedulerSettingsPaused')}
                  </p>
                )}
                {loading && tasks.length === 0 ? (
                  <div role="status" className="flex flex-col items-center py-16 text-secondary">
                    <ArrowPathIcon className="h-8 w-8 animate-spin" />
                    <p className="mt-3 text-sm">{t('loading')}</p>
                  </div>
                ) : activeTab === 'results' ? (
                  <ResultInbox />
                ) : (
                  <>
                    <div className="mb-5 flex flex-col gap-4 shrink-0 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h1 className="text-xl font-semibold text-foreground">
                          {t('scheduledTasksTabTasks')}
                        </h1>
                        <p className="mt-1 text-sm text-secondary">{t('cronSubtitle')}</p>
                      </div>
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

                    {memoryControl.failed && (
                      <p role="alert" className="mb-3 text-sm text-red-500">
                        {t('cronMemoryLoadFailed')}
                      </p>
                    )}
                    {/* Error */}
                    {error && (
                      <div className="mb-8 p-4 rounded-xl border border-red-500/50 bg-red-500/10 flex items-center gap-3">
                        <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
                        <span className="text-red-600 dark:text-red-400 text-sm font-medium">
                          {error}
                        </span>
                      </div>
                    )}

                    <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-border-subtle bg-surface/70 p-3 sm:flex-row sm:items-center">
                      <div className="relative min-w-0 flex-1 sm:max-w-sm">
                        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
                        <input
                          type="search"
                          value={taskQuery}
                          onChange={event => setTaskQuery(event.target.value)}
                          placeholder={t('cronSearchPlaceholder')}
                          className="h-9 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-secondary/70 focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                        />
                      </div>
                      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                        {(
                          [
                            ['all', 'cronFilterAll', tasks.length, 'bg-primary/10 text-primary'],
                            [
                              'active',
                              'cronStatsActive',
                              activeJobs.length,
                              'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                            ],
                            [
                              'paused',
                              'cronStatsPaused',
                              pausedJobs.length,
                              'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                            ],
                            [
                              'failed',
                              'cronStatsFailed',
                              failedJobs.length,
                              'bg-rose-500/10 text-rose-700 dark:text-rose-400',
                            ],
                          ] as const
                        ).map(([value, label, count, selectedClass]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setTaskStatusFilter(value)}
                            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                              taskStatusFilter === value
                                ? selectedClass
                                : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                            }`}
                          >
                            {t(label)}
                            <span className="tabular-nums opacity-70">{count}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {failedJobs.length > 0 && taskStatusFilter !== 'failed' && (
                      <button
                        type="button"
                        onClick={() => setTaskStatusFilter('failed')}
                        className="mb-6 flex w-full items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-left text-sm text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-300"
                      >
                        <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
                        <span className="flex-1">
                          {t('cronFailedAttention').replace('{count}', String(failedJobs.length))}
                        </span>
                        <span className="font-medium">{t('cronViewFailed')}</span>
                      </button>
                    )}

                    {/* Jobs Grid / Empty State */}
                    {error && tasks.length === 0 ? null : tasks.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-20 text-secondary bg-black/5 dark:bg-white/5 rounded-3xl border border-dashed border-border">
                        <ClockIcon className="h-12 w-12 mb-4 opacity-40" />
                        <h3 className="text-lg font-medium mb-2 text-foreground">
                          {t('cronEmptyTitle')}
                        </h3>
                        <p className="text-sm text-center mb-6 max-w-md">
                          {t('cronEmptyDescription')}
                        </p>
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
                    ) : visibleTasks.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-border py-16 text-center">
                        <MagnifyingGlassIcon className="mx-auto mb-3 h-8 w-8 text-secondary/50" />
                        <p className="text-sm font-medium text-foreground">{t('cronNoMatches')}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setTaskQuery('');
                            setTaskStatusFilter('all');
                          }}
                          className="mt-3 text-sm font-medium text-primary hover:text-primary-hover"
                        >
                          {t('cronClearFilters')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-8">
                        {[
                          {
                            id: 'user-scheduled-tasks',
                            tasks: userTasks,
                            title: t('cronGroupUser'),
                            description: t('cronGroupUserDescription'),
                            Icon: UserIcon,
                            tone: 'bg-gradient-to-br from-blue-500/20 to-cyan-500/10 text-blue-600 dark:text-blue-400',
                          },
                          {
                            id: 'system-scheduled-tasks',
                            tasks: systemTasks,
                            title: t('cronGroupSystem'),
                            description: t('cronGroupSystemDescription'),
                            Icon: Cog6ToothIcon,
                            tone: 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/10 text-violet-600 dark:text-violet-400',
                          },
                        ].map(group =>
                          group.tasks.length > 0 ? (
                            <section key={group.id} aria-labelledby={`${group.id}-title`}>
                              <div className="mb-3 flex items-center gap-3">
                                <div
                                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${group.tone}`}
                                >
                                  <group.Icon className="h-[18px] w-[18px]" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <h2
                                      id={`${group.id}-title`}
                                      className="text-sm font-semibold text-foreground"
                                    >
                                      {group.title}
                                    </h2>
                                    <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium tabular-nums text-secondary">
                                      {group.tasks.length}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-xs leading-4 text-secondary">
                                    {group.description}
                                  </p>
                                </div>
                              </div>
                              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(20rem,calc((100%-0.75rem)/2)),1fr))] gap-3">
                                {group.tasks.map(job => (
                                  <CronJobCard
                                    key={job.id}
                                    job={job}
                                    memoryToggleDisabled={
                                      !memoryControl.settings?.memoryAvailable ||
                                      memoryControl.busy ||
                                      memoryControl.failed
                                    }
                                    onToggle={enabled => handleToggle(job.id, enabled)}
                                    onEdit={() => {
                                      setEditingJob(job);
                                      setShowDialog(true);
                                    }}
                                    onDelete={() => setJobToDelete(job)}
                                    onTrigger={() => handleRunRequest(job)}
                                    onHistory={() => setHistoryTaskId(job.id)}
                                    onDetails={() => setDetailsJobId(job.id)}
                                  />
                                ))}
                              </div>
                            </section>
                          ) : null,
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </EngineInteractionBoundary>
        </div>
      </div>

      {/* Create/Edit Dialog */}
      <EngineInteractionBoundary disabled={!engine.ready}>
        {showSchedulerSettings && (
          <SchedulerSettingsDialog
            onClose={() => setShowSchedulerSettings(false)}
            onSaved={settings => {
              schedulerSettingsSavedRef.current = true;
              setSchedulerEnabled(settings.enabled);
            }}
          />
        )}
        <CreateEditDialog
          open={showDialog}
          job={editingJob}
          agents={agents}
          models={models}
          onClose={() => {
            setShowDialog(false);
            setEditingJob(undefined);
          }}
          onSave={handleSave}
        />

        {detailsJob && <TaskDetailsDialog job={detailsJob} onClose={() => setDetailsJobId(null)} />}

        {jobToRun && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            onClick={() => {
              if (!runSubmitting) setJobToRunId(null);
            }}
          >
            <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="scheduled-task-run-confirm-title"
              className="relative mx-4 w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <h3
                id="scheduled-task-run-confirm-title"
                className="mb-2 text-lg font-semibold text-foreground"
              >
                {t('cronRunConfirmTitle')}
              </h3>
              <p className="mb-4 text-sm leading-6 text-secondary">
                {t('cronRunConfirmDescription').replace('{name}', jobToRun.name)}
              </p>
              <pre className="mb-6 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 font-sans text-sm leading-6 text-foreground">
                {getTaskExecutionPreview(jobToRun)}
              </pre>
              {jobToRun.payload.kind === 'command' && jobToRun.payload.cwd && (
                <p className="-mt-3 mb-4 text-xs text-secondary">
                  {t('cronDetailsWorkingDirectory')}: {jobToRun.payload.cwd}
                </p>
              )}
              {jobToRun.advancedFeatures?.some(
                feature => feature === 'command-environment' || feature === 'command-input',
              ) && (
                <p className="mb-4 text-sm text-yellow-700 dark:text-yellow-300" role="alert">
                  {t('cronRunConfirmHiddenContext')}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  autoFocus
                  disabled={runSubmitting}
                  onClick={() => setJobToRunId(null)}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  disabled={runSubmitting}
                  onClick={() => void handleConfirmedRun()}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {runSubmitting && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
                  {t('cronCardRunNow')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirmation Dialog */}
        {jobToDelete && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            onClick={() => {
              if (!deletingTask) setJobToDelete(null);
            }}
          >
            <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="scheduled-task-delete-title"
              className="relative w-full max-w-sm mx-4 rounded-2xl shadow-2xl bg-background border border-border p-6"
              onClick={e => e.stopPropagation()}
            >
              <h3
                id="scheduled-task-delete-title"
                className="text-lg font-semibold text-foreground mb-2"
              >
                {t('delete')}
              </h3>
              <p className="text-sm text-secondary mb-6">
                {t('scheduledTasksDeleteConfirm').replace('{name}', jobToDelete.name)}
              </p>
              {jobToDelete.management === 'advanced' && (
                <p className="mb-6 rounded-xl bg-yellow-500/10 px-3 py-2 text-xs leading-5 text-yellow-700 dark:text-yellow-300">
                  {t('cronDetailsAdvancedDeleteWarning')}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  autoFocus
                  disabled={deletingTask}
                  onClick={() => setJobToDelete(null)}
                  className="px-4 py-2 text-sm font-medium rounded-xl text-secondary hover:bg-surface-raised transition-colors disabled:opacity-50"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  disabled={deletingTask}
                  onClick={() => void handleDelete()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                >
                  {deletingTask && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
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
              role="dialog"
              aria-modal="true"
              aria-labelledby="scheduled-task-history-title"
              className="relative w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-2xl shadow-2xl bg-background border border-border overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
                <div className="min-w-0">
                  <h2
                    id="scheduled-task-history-title"
                    className="text-lg font-semibold text-foreground"
                  >
                    {historyJob ? getTaskDisplayName(historyJob) : ''} - {t('cronCardHistory')}
                  </h2>
                  {historyJob &&
                    (isMemoryDreamingTask(historyJob) || getTaskAgentLabel(historyJob, agents)) && (
                      <p className="mt-1 flex items-center gap-2 text-xs text-secondary">
                        <UserIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">
                          {isMemoryDreamingTask(historyJob)
                            ? t('cronMemoryScope')
                            : getTaskAgentLabel(historyJob, agents)}
                        </span>
                      </p>
                    )}
                </div>
                <button
                  type="button"
                  onClick={() => setHistoryTaskId(null)}
                  aria-label={t('close')}
                  className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                <TaskRunHistory
                  taskId={historyTaskId}
                  taskName={historyJob ? getTaskDisplayName(historyJob) : undefined}
                  runs={historyRuns}
                  loading={historyLoading}
                  loadError={historyLoadError}
                  onRetry={() => setHistoryRequestRevision(revision => revision + 1)}
                />
              </div>
            </div>
          </div>
        )}
      </EngineInteractionBoundary>
    </div>
  );
};

export default CronView;
