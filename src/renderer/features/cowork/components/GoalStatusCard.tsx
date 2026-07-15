import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
} from '@heroicons/react/24/outline';
import { FlagIcon } from '@heroicons/react/24/solid';
import { type SessionGoal, SessionGoalStatus } from '@shared/sessionGoal';
import React from 'react';

import {
  formatGoalTokenCount,
  getGoalBudgetPercentage,
  getGoalPresentation,
  type GoalTone,
} from '@/features/cowork/components/goalPresentation';
import { i18nService } from '@/services/i18n';

interface GoalStatusCardProps {
  goal: SessionGoal;
  disabled?: boolean;
  onCommand: (command: string) => void;
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

const GoalStatusCard: React.FC<GoalStatusCardProps> = ({ goal, disabled = false, onCommand }) => {
  const presentation = getGoalPresentation(goal.status);
  const tone = TONE_CLASSES[presentation.tone];
  const percentage = getGoalBudgetPercentage(goal);
  const primaryAction = getPrimaryAction(goal.status);
  const usage =
    goal.tokensUsed <= 0
      ? null
      : goal.tokenBudget === undefined
        ? i18nService
            .t('coworkGoalTokensUsed')
            .replace('{count}', formatGoalTokenCount(goal.tokensUsed))
        : `${formatGoalTokenCount(goal.tokensUsed)} / ${formatGoalTokenCount(goal.tokenBudget)}`;

  return (
    <section
      className={`mb-2 overflow-hidden rounded-xl border px-3 py-2.5 shadow-subtle ${tone.card}`}
      aria-label={i18nService.t('coworkGoalTitle')}
    >
      <div className="flex items-start gap-2.5">
        <div className={`mt-0.5 rounded-md p-1.5 ${tone.badge}`}>
          <GoalStatusIcon status={goal.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-semibold ${tone.label}`}>
              {i18nService.t(presentation.labelKey)}
            </span>
            {usage && (
              <span className="ml-auto text-[10px] tabular-nums text-secondary">{usage}</span>
            )}
          </div>
          <div
            className="mt-0.5 truncate text-sm font-medium text-foreground"
            title={goal.objective}
          >
            {goal.objective}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-secondary">
              {goal.lastStatusNote || i18nService.t(presentation.hintKey)}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onCommand(primaryAction.command)}
              className="flex-shrink-0 rounded-md border border-border/70 bg-surface/70 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              {primaryAction.label}
            </button>
            {goal.status === SessionGoalStatus.Active && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCommand('/goal complete')}
                className="flex-shrink-0 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {i18nService.t('coworkGoalCompleteAction')}
              </button>
            )}
          </div>
        </div>
      </div>
      {percentage !== null && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border/50">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${tone.bar}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </section>
  );
};

export default GoalStatusCard;
