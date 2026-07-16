import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  PauseCircleIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { FlagIcon } from '@heroicons/react/24/solid';
import { type SessionGoal, SessionGoalStatus } from '@shared/sessionGoal';
import React, { useEffect, useState } from 'react';

import {
  formatGoalTokenCount,
  getGoalBudgetPercentage,
  getGoalPresentation,
  type GoalTone,
} from '@/features/cowork/components/goalPresentation';
import type { GoalRunProgress } from '@/features/cowork/components/goalRunProgress';
import { i18nService } from '@/services/i18n';

interface GoalStatusCardProps {
  goal: SessionGoal | null;
  pendingObjective?: string | null;
  progress?: GoalRunProgress | null;
  isRunning?: boolean;
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

const getProgressLabel = (progress: GoalRunProgress | null): string => {
  switch (progress?.phase) {
    case 'thinking':
      return i18nService.t('coworkGoalPhaseThinking');
    case 'tool':
      return progress.toolName
        ? i18nService.t('coworkGoalPhaseToolNamed').replace('{tool}', progress.toolName)
        : i18nService.t('coworkGoalPhaseTool');
    case 'responding':
      return i18nService.t('coworkGoalPhaseResponding');
    default:
      return i18nService.t('coworkGoalPhaseStarting');
  }
};

const formatElapsed = (startedAt: number | undefined, now: number): string => {
  if (!startedAt) return '00:00';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const GoalStatusCard: React.FC<GoalStatusCardProps> = ({
  goal,
  pendingObjective,
  progress = null,
  isRunning = false,
  disabled = false,
  onCommand,
}) => {
  const status = goal?.status ?? SessionGoalStatus.Active;
  const objective = goal?.objective ?? pendingObjective ?? '';
  const presentation = getGoalPresentation(status);
  const tone = TONE_CLASSES[presentation.tone];
  const percentage = goal ? getGoalBudgetPercentage(goal) : null;
  const primaryAction = goal ? getPrimaryAction(goal.status) : null;
  const usage =
    !goal || goal.tokensUsed <= 0
      ? null
      : goal.tokenBudget === undefined
        ? i18nService
            .t('coworkGoalTokensUsed')
            .replace('{count}', formatGoalTokenCount(goal.tokensUsed))
        : `${formatGoalTokenCount(goal.tokensUsed)} / ${formatGoalTokenCount(goal.tokenBudget)}`;
  const [now, setNow] = useState(Date.now());
  const live = isRunning && status === SessionGoalStatus.Active;
  const activityLabel = getProgressLabel(progress);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [live]);

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
                {goal
                  ? i18nService.t(presentation.labelKey)
                  : i18nService.t('coworkGoalCreating')}
              </span>
              {live && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/15 bg-primary/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  {i18nService.t('coworkGoalLive')}
                </span>
              )}
              {usage && (
                <span className="ml-auto text-[10px] tabular-nums text-secondary">{usage}</span>
              )}
            </div>
            <div className="mt-1 line-clamp-2 break-words text-sm font-semibold leading-5 text-foreground">
              {objective}
            </div>
          </div>
        </div>

        {live ? (
          <div className="mt-3 rounded-xl border border-primary/15 bg-surface/65 px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {activityLabel}
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-secondary">
                <ClockIcon className="h-3 w-3" />
                {formatElapsed(progress?.startedAt, now)}
              </span>
              {(progress?.toolCount ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-secondary">
                  <WrenchScrewdriverIcon className="h-3 w-3" />
                  {i18nService
                    .t('coworkGoalToolCount')
                    .replace('{count}', String(progress?.toolCount ?? 0))}
                </span>
              )}
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/10">
              <div className="h-full w-1/3 animate-[goal-progress_1.4s_ease-in-out_infinite] rounded-full bg-primary motion-reduce:animate-pulse" />
            </div>
          </div>
        ) : (
          <div className="mt-2.5 flex items-center gap-2 text-[11px] text-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${tone.bar}`} />
            <span className="min-w-0 flex-1 truncate">
              {goal?.lastStatusNote || i18nService.t(presentation.hintKey)}
            </span>
          </div>
        )}

        {primaryAction && (
          <div className="mt-3 flex justify-end gap-2 border-t border-border/50 pt-2.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onCommand(primaryAction.command)}
              className="flex-shrink-0 rounded-md border border-border/70 bg-surface/70 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              {primaryAction.label}
            </button>
            {goal?.status === SessionGoalStatus.Active && (
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
        )}
        {percentage !== null && (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-border/50">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${tone.bar}`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        )}
      </div>
    </section>
  );
};

export default GoalStatusCard;
