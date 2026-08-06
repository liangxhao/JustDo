import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
} from '@heroicons/react/24/outline';
import { FlagIcon } from '@heroicons/react/24/solid';
import {
  GoalExecutionFailureReason,
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type SessionGoal,
  SessionGoalStatus,
} from '@shared/sessionGoal';
import React from 'react';

import { getGoalPresentation, type GoalTone } from '@/features/cowork/components/goalPresentation';
import { i18nService } from '@/services/i18n';

interface GoalStatusCardProps {
  goal: SessionGoal | null;
  pendingObjective?: string | null;
  execution?: GoalExecutionSnapshot | null;
  isRunning?: boolean;
  disabled?: boolean;
  onCommand: (command: string) => void;
  onContinue?: () => void;
  onPause?: () => void;
  onComplete?: () => void;
}

const TONE_CLASSES: Record<GoalTone, { card: string; badge: string; label: string; bar: string }> =
  {
    active: {
      card: 'border-primary/25 bg-primary/5',
      badge: 'bg-primary/10 text-primary',
      label: 'text-primary',
      bar: 'bg-primary',
    },
    muted: {
      card: 'border-border bg-surface-raised/55',
      badge: 'bg-secondary/10 text-secondary',
      label: 'text-secondary',
      bar: 'bg-secondary',
    },
    warning: {
      card: 'border-amber-400/35 bg-amber-500/5',
      badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      label: 'text-amber-600 dark:text-amber-400',
      bar: 'bg-amber-500',
    },
    danger: {
      card: 'border-red-400/35 bg-red-500/5',
      badge: 'bg-red-500/10 text-red-600 dark:text-red-400',
      label: 'text-red-600 dark:text-red-400',
      bar: 'bg-red-500',
    },
    success: {
      card: 'border-emerald-400/35 bg-emerald-500/5',
      badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      label: 'text-emerald-600 dark:text-emerald-400',
      bar: 'bg-emerald-500',
    },
  };

const GoalStatusIcon = ({ status }: { status: SessionGoal['status'] }) => {
  if (status === SessionGoalStatus.Complete) return <CheckCircleIcon className="h-4 w-4" />;
  if (status === SessionGoalStatus.Paused) return <PauseCircleIcon className="h-4 w-4" />;
  if (
    status === SessionGoalStatus.Blocked ||
    status === SessionGoalStatus.UsageLimited ||
    status === SessionGoalStatus.BudgetLimited
  ) {
    return <ExclamationTriangleIcon className="h-4 w-4" />;
  }
  return <FlagIcon className="h-4 w-4" />;
};

const getPrimaryAction = (status: SessionGoal['status']) => {
  switch (status) {
    case SessionGoalStatus.Active:
      return { command: '/goal pause', label: i18nService.t('coworkGoalPause') };
    case SessionGoalStatus.Paused:
    case SessionGoalStatus.Blocked:
    case SessionGoalStatus.UsageLimited:
    case SessionGoalStatus.BudgetLimited:
      return { command: '/goal resume', label: i18nService.t('coworkGoalResume') };
    case SessionGoalStatus.Complete:
      return { command: '/goal clear', label: i18nService.t('coworkGoalClear') };
  }
};

const GoalStatusCard: React.FC<GoalStatusCardProps> = ({
  goal,
  pendingObjective,
  execution = null,
  isRunning = false,
  disabled = false,
  onCommand,
  onContinue,
  onPause,
  onComplete,
}) => {
  const status = goal?.status ?? SessionGoalStatus.Active;
  const objective = goal?.objective ?? pendingObjective ?? '';
  const presentation = getGoalPresentation(status);
  const tone = TONE_CLASSES[presentation.tone];
  const matchedExecution = goal && execution?.goalId === goal.id ? execution : null;
  const executionRunning =
    matchedExecution?.phase === GoalExecutionPhase.Running ||
    matchedExecution?.phase === GoalExecutionPhase.Continuing;
  const live = (executionRunning || (!goal && isRunning)) && status === SessionGoalStatus.Active;
  const idleExecutionHint =
    matchedExecution?.phase === GoalExecutionPhase.Stopped
      ? i18nService.t('coworkGoalStoppedHint')
      : matchedExecution?.phase === GoalExecutionPhase.Failed
        ? matchedExecution.failureReason === GoalExecutionFailureReason.StalledNoProgress
          ? i18nService.t('coworkGoalStalledHint')
          : matchedExecution.error || i18nService.t('coworkGoalFailedHint')
        : goal?.lastStatusNote || i18nService.t(presentation.hintKey);
  const goalActions = !goal ? null : live ? (
    <button
      type="button"
      disabled={disabled || !onPause}
      onClick={onPause}
      className="flex-shrink-0 rounded-md border border-border/70 bg-surface/70 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
    >
      {i18nService.t('coworkGoalPause')}
    </button>
  ) : goal.status === SessionGoalStatus.Active ? (
    <>
      <button
        type="button"
        disabled={disabled || !onContinue}
        onClick={onContinue}
        className="flex-shrink-0 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {matchedExecution?.phase === GoalExecutionPhase.Failed
          ? i18nService.t('coworkGoalRetry')
          : i18nService.t('coworkGoalContinue')}
      </button>
      <button
        type="button"
        disabled={disabled || !onComplete}
        onClick={onComplete}
        className="flex-shrink-0 rounded-md border border-border/70 bg-surface/70 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
      >
        {i18nService.t('coworkGoalMarkComplete')}
      </button>
    </>
  ) : (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onCommand(getPrimaryAction(goal.status).command)}
      className="flex-shrink-0 rounded-md border border-border/70 bg-surface/70 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
    >
      {getPrimaryAction(goal.status).label}
    </button>
  );

  return (
    <section
      className={`mb-2 overflow-hidden rounded-2xl border shadow-subtle ${tone.card}`}
      aria-label={i18nService.t('coworkGoalTitle')}
    >
      <div className={`h-0.5 w-full ${tone.bar} ${live ? 'animate-pulse' : ''}`} />
      <div className="px-3.5 py-3">
        <div className="flex items-start gap-3">
          <div className={`relative mt-0.5 rounded-xl p-2 ${tone.badge}`}>
            {live && (
              <span className="absolute inset-0 animate-ping rounded-xl bg-primary/15 motion-reduce:animate-none" />
            )}
            <span className="relative block">
              <GoalStatusIcon status={status} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span
                role="status"
                aria-live="polite"
                className={`text-[11px] font-semibold ${tone.label}`}
              >
                {goal ? i18nService.t(presentation.labelKey) : i18nService.t('coworkGoalCreating')}
              </span>
              {live && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/15 bg-primary/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  {i18nService.t('coworkGoalLive')}
                </span>
              )}
              {matchedExecution && matchedExecution.continuationCount > 0 && (
                <span className="text-[10px] tabular-nums text-secondary">
                  {i18nService
                    .t('coworkGoalContinuationCount')
                    .replace('{count}', String(matchedExecution.continuationCount))}
                </span>
              )}
            </div>
            <div className="mt-1 line-clamp-2 break-words text-sm font-semibold leading-5 text-foreground">
              {objective}
            </div>
          </div>
          {goalActions && (
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">{goalActions}</div>
          )}
        </div>

        {live ? (
          <div className="mt-2.5 flex items-center gap-2 text-[11px] text-secondary">
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
            <span>{i18nService.t('coworkGoalPhaseRunning')}</span>
          </div>
        ) : (
          <div className="mt-2.5 flex items-center gap-2 text-[11px] text-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${tone.bar}`} />
            <span className="min-w-0 flex-1 truncate">
              {idleExecutionHint}
            </span>
          </div>
        )}

      </div>
    </section>
  );
};

export default GoalStatusCard;
