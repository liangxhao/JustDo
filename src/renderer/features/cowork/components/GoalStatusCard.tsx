import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
} from '@heroicons/react/24/outline';
import { FlagIcon } from '@heroicons/react/24/solid';
import { extractGoalFollowUpRequest } from '@shared/prompts/goalFollowUpPrompt';
import {
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
  completionFeedbackActive?: boolean;
  disabled?: boolean;
  onCommand: (command: string) => void;
  onPause?: () => void;
  onContinue?: () => void;
  onContinueImproving?: () => void;
  onCancelContinueImproving?: () => void;
  onEnd?: () => void;
}

const TONE_CLASSES: Record<GoalTone, { card: string; badge: string; label: string; bar: string }> =
  {
    active: {
      card: 'border-primary/20 bg-gradient-to-br from-primary/[0.07] via-surface to-surface',
      badge: 'bg-primary/10 text-primary',
      label: 'text-primary',
      bar: 'bg-primary',
    },
    muted: {
      card: 'border-border/80 bg-gradient-to-br from-secondary/[0.06] via-surface to-surface',
      badge: 'bg-secondary/10 text-secondary',
      label: 'text-secondary',
      bar: 'bg-secondary',
    },
    warning: {
      card: 'border-amber-400/30 bg-gradient-to-br from-amber-500/[0.08] via-surface to-surface',
      badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      label: 'text-amber-600 dark:text-amber-400',
      bar: 'bg-amber-500',
    },
    danger: {
      card: 'border-red-400/30 bg-gradient-to-br from-red-500/[0.08] via-surface to-surface',
      badge: 'bg-red-500/10 text-red-600 dark:text-red-400',
      label: 'text-red-600 dark:text-red-400',
      bar: 'bg-red-500',
    },
    success: {
      card: 'border-emerald-400/30 bg-gradient-to-br from-emerald-500/[0.09] via-surface to-surface',
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
      return { command: '/goal clear', label: i18nService.t('coworkGoalMarkComplete') };
  }
};

const GoalActionButton = ({
  disabled,
  label,
  onClick,
  primary = false,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={
      primary
        ? 'flex-shrink-0 whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50'
        : 'flex-shrink-0 whitespace-nowrap rounded-md border border-border/70 bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50'
    }
  >
    {label}
  </button>
);

const GoalStatusCard: React.FC<GoalStatusCardProps> = ({
  goal,
  pendingObjective,
  execution = null,
  isRunning = false,
  completionFeedbackActive = false,
  disabled = false,
  onCommand,
  onPause,
  onContinue,
  onContinueImproving,
  onCancelContinueImproving,
  onEnd,
}) => {
  const status = goal?.status ?? SessionGoalStatus.Active;
  const rawObjective = goal?.objective ?? pendingObjective ?? '';
  const objective = extractGoalFollowUpRequest(`/goal start ${rawObjective}`) ?? rawObjective;
  const matchedExecution =
    goal && execution && (!execution.goalId || execution.goalId === goal.id) ? execution : null;
  const effectiveStatus =
    matchedExecution?.phase === GoalExecutionPhase.AwaitingConfirmation
      ? SessionGoalStatus.Complete
      : matchedExecution?.phase === GoalExecutionPhase.AwaitingInput
        ? SessionGoalStatus.Blocked
        : status;
  const presentation = getGoalPresentation(effectiveStatus);
  const tone = TONE_CLASSES[presentation.tone];
  const executionRunning =
    matchedExecution?.phase === GoalExecutionPhase.Running ||
    matchedExecution?.phase === GoalExecutionPhase.Continuing;
  const retrying = matchedExecution?.phase === GoalExecutionPhase.Retrying;
  const stopped = matchedExecution?.phase === GoalExecutionPhase.Stopped;
  const live =
    !stopped &&
    (executionRunning || retrying || isRunning) &&
    effectiveStatus === SessionGoalStatus.Active;
  const idleExecutionHint = completionFeedbackActive
    ? i18nService.t('coworkGoalCompletionFeedbackHint')
    : retrying
      ? i18nService.t('coworkGoalRetryingHint')
      : matchedExecution?.phase === GoalExecutionPhase.Stopped
        ? i18nService.t('coworkGoalStoppedHint')
        : goal?.lastStatusNote || i18nService.t(presentation.hintKey);
  const goalActions = !goal ? null : stopped && effectiveStatus === SessionGoalStatus.Active ? (
    <GoalActionButton
      disabled={disabled || !onContinue}
      label={i18nService.t('coworkGoalContinue')}
      onClick={() => onContinue?.()}
      primary
    />
  ) : live ? (
    <GoalActionButton
      disabled={disabled || !onPause}
      label={i18nService.t('coworkGoalPause')}
      onClick={() => onPause?.()}
    />
  ) : effectiveStatus === SessionGoalStatus.Active ? (
    <GoalActionButton
      disabled={disabled || !onPause}
      label={i18nService.t('coworkGoalPause')}
      onClick={() => onPause?.()}
    />
  ) : effectiveStatus !== SessionGoalStatus.Complete ? (
    <>
      <GoalActionButton
        disabled={disabled}
        label={getPrimaryAction(effectiveStatus).label}
        onClick={() => onCommand(getPrimaryAction(effectiveStatus).command)}
        primary
      />
      <GoalActionButton
        disabled={disabled || !onEnd}
        label={i18nService.t('coworkGoalEnd')}
        onClick={() => onEnd?.()}
      />
    </>
  ) : (
    <>
      <GoalActionButton
        disabled={disabled || (!onContinueImproving && !onCancelContinueImproving)}
        label={i18nService.t(
          completionFeedbackActive ? 'coworkGoalCancelImproving' : 'coworkGoalContinueImproving',
        )}
        onClick={() =>
          completionFeedbackActive ? onCancelContinueImproving?.() : onContinueImproving?.()
        }
      />
      {!completionFeedbackActive && (
        <GoalActionButton
          disabled={disabled}
          label={getPrimaryAction(effectiveStatus).label}
          onClick={() => onCommand(getPrimaryAction(effectiveStatus).command)}
          primary
        />
      )}
    </>
  );

  return (
    <section
      className={`relative mb-2 overflow-hidden rounded-xl border shadow-subtle ${tone.card}`}
      aria-label={i18nService.t('coworkGoalTitle')}
    >
      <div className={`absolute inset-y-0 left-0 w-0.5 ${tone.bar}`} />
      <div className="py-2.5 pl-3.5 pr-3">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={`relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${tone.badge}`}
          >
            {live && (
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/15 motion-reduce:animate-none" />
            )}
            <span className="relative block">
              <GoalStatusIcon status={effectiveStatus} />
            </span>
          </div>
          <span
            role="status"
            aria-live="polite"
            className={`min-w-0 truncate text-[11px] font-semibold ${tone.label}`}
          >
            {goal ? i18nService.t(presentation.labelKey) : i18nService.t('coworkGoalCreating')}
          </span>
          {live && (
            <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-primary/15 bg-primary/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {i18nService.t('coworkGoalLive')}
            </span>
          )}
          {matchedExecution && matchedExecution.continuationCount > 0 && (
            <span className="flex-shrink-0 rounded-full border border-foreground/[0.06] bg-surface/60 px-2 py-0.5 text-[10px] tabular-nums text-secondary">
              {i18nService
                .t('coworkGoalContinuationCount')
                .replace('{count}', String(matchedExecution.continuationCount))}
            </span>
          )}
          {live ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-secondary">
              <ArrowPathIcon className="h-3 w-3 flex-shrink-0 animate-spin text-primary motion-reduce:animate-none" />
              <span className="truncate">
                {retrying
                  ? i18nService.t('coworkGoalRetryingHint')
                  : i18nService.t('coworkGoalPhaseRunning')}
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-secondary">
              <span className={`h-1 w-1 flex-shrink-0 rounded-full ${tone.bar}`} />
              <span className="truncate">{idleExecutionHint}</span>
            </span>
          )}
        </div>

        <div className="mt-1.5 flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 pl-8">
          <div className="min-w-32 flex-1 basis-40 break-words text-sm font-semibold leading-5 text-foreground">
            <span className="line-clamp-2">{objective}</span>
          </div>
          {goalActions && (
            <div className="ml-auto flex max-w-full flex-shrink-0 flex-wrap items-center justify-end gap-2">
              {goalActions}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default GoalStatusCard;
