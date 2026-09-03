import './SessionProgressCard.css';

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClipboardDocumentCheckIcon,
  StopCircleIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PauseCircleIcon as PauseCircleSolidIcon } from '@heroicons/react/24/solid';
import type { SessionRunState } from '@shared/cowork/sessionRun';
import {
  type ProgressCard,
  progressCardIsComplete,
  type ProgressCardStep,
  ProgressCardStepStatus,
} from '@shared/openclaw/progressCard';
import { useEffect, useMemo, useRef, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';

interface SessionProgressCardProps {
  card: ProgressCard;
  runState: ProgressCardRunState;
  onClose: () => void;
}

export type ProgressCardRunState = SessionRunState | 'idle';

const currentProgressStep = (steps: readonly ProgressCardStep[]): ProgressCardStep | null =>
  steps.find(step => step.status === ProgressCardStepStatus.InProgress) ??
  steps.find(step => step.status === ProgressCardStepStatus.Pending) ??
  [...steps].reverse().find(step => step.status === ProgressCardStepStatus.Completed) ??
  null;

const relativeUpdatedAt = (updatedAt: number, now: number): string => {
  const deltaSeconds = Math.round((updatedAt - now) / 1_000);
  const language = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en';
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, 'second');
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, 'minute');
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, 'hour');
  return formatter.format(Math.round(deltaHours / 24), 'day');
};

const stepStatusLabel = (
  status: ProgressCardStep['status'] | 'paused' | 'waiting' | 'failed' | 'aborted',
): string => {
  if (status === 'paused') return i18nService.t('coworkProgressCardPaused');
  if (status === 'waiting') return i18nService.t('coworkProgressCardWaiting');
  if (status === 'failed') return i18nService.t('coworkProgressCardFailed');
  if (status === 'aborted') return i18nService.t('coworkProgressCardStopped');
  if (status === ProgressCardStepStatus.Completed) {
    return i18nService.t('coworkProgressCardCompleted');
  }
  if (status === ProgressCardStepStatus.InProgress) {
    return i18nService.t('coworkProgressCardInProgress');
  }
  return i18nService.t('coworkProgressCardPending');
};

const SessionProgressCard = ({ card, runState, onClose }: SessionProgressCardProps) => {
  const complete = progressCardIsComplete(card);
  const steps = card.steps ?? [];
  const completedCount = steps.filter(
    step => step.status === ProgressCardStepStatus.Completed,
  ).length;
  const current = currentProgressStep(steps);
  const initialSessionKeyRef = useRef(card.sessionKey);
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (initialSessionKeyRef.current === card.sessionKey) return;
    initialSessionKeyRef.current = card.sessionKey;
    setExpanded(true);
  }, [card.sessionKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const markdownHtml = useMemo(
    () =>
      card.markdown
        ? toSanitizedMarkdownHtml(card.markdown, {
            allowProgressElement: true,
            parseLimit: 8_192,
          })
        : '',
    [card.markdown],
  );
  const paused =
    current?.status === ProgressCardStepStatus.InProgress && runState === 'idle' && !complete;
  const summary = current?.step ?? null;
  const completedCountText =
    steps.length > 0
      ? i18nService
          .t('coworkProgressCardCompletedCount')
          .replace('{completed}', String(completedCount))
          .replace('{total}', String(steps.length))
      : null;
  const headerState = complete
    ? ProgressCardStepStatus.Completed
    : runState === 'completed'
      ? 'waiting'
      : runState === 'failed' || runState === 'aborted'
        ? runState
        : paused
          ? 'paused'
          : runState === 'running'
            ? ProgressCardStepStatus.InProgress
            : ProgressCardStepStatus.Pending;
  const headerStateLabel = stepStatusLabel(headerState);
  const summaryAccessibleLabel = [
    i18nService.t('coworkProgressCardTitle'),
    summary,
    headerStateLabel,
    completedCountText,
  ]
    .filter(Boolean)
    .join('. ');
  const updatedAtText = relativeUpdatedAt(card.updatedAt, now);
  const updatedAtTitle = new Intl.DateTimeFormat(
    i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en',
    { dateStyle: 'medium', timeStyle: 'medium' },
  ).format(card.updatedAt);
  const bodyId = `cowork-progress-card-${card.sessionKey.replace(/[^a-z0-9_-]/gi, '-')}`;

  return (
    <aside
      id="cowork-progress-card-overlay"
      className="cowork-progress-card cowork-progress-card--floating"
      aria-label={i18nService.t('coworkProgressCardTitle')}
      data-progress-card-placement="floating"
      data-progress-card-revision={card.revision}
    >
      <div className="cowork-progress-card__header">
        <button
          type="button"
          className="cowork-progress-card__summary"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={summaryAccessibleLabel}
        >
          <span
            className={`cowork-progress-card__state cowork-progress-card__state--${headerState}`}
            aria-hidden="true"
          >
            {complete ? (
              <CheckCircleIcon />
            ) : runState === 'completed' ? (
              <PauseCircleSolidIcon />
            ) : runState === 'failed' ? (
              <XCircleIcon />
            ) : runState === 'aborted' ? (
              <StopCircleIcon />
            ) : paused ? (
              <PauseCircleSolidIcon />
            ) : runState === 'running' ? (
              <ArrowPathIcon className="animate-spin" />
            ) : (
              <ClipboardDocumentCheckIcon />
            )}
          </span>
          <span className="cowork-progress-card__summary-copy">
            <span className="cowork-progress-card__title">
              {i18nService.t('coworkProgressCardTitle')}
            </span>
          </span>
          {completedCountText && (
            <span className="cowork-progress-card__count">{completedCountText}</span>
          )}
          <ChevronDownIcon
            className={`cowork-progress-card__chevron ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="cowork-progress-card__dismiss"
          onClick={onClose}
          aria-label={i18nService.t('coworkProgressCardHide')}
          title={i18nService.t('coworkProgressCardHide')}
        >
          <XMarkIcon />
        </button>
      </div>

      {expanded && (
        <div id={bodyId} className="cowork-progress-card__body">
          {markdownHtml && (
            <div
              className="cowork-progress-card__markdown"
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
          )}
          {steps.length > 0 && (
            <ol className="cowork-progress-card__steps">
              {steps.map((step, index) => {
                const presentationStatus =
                  step.status === ProgressCardStepStatus.InProgress
                    ? runState === 'completed'
                      ? 'waiting'
                      : runState === 'failed'
                        ? 'failed'
                        : runState === 'aborted'
                          ? 'aborted'
                          : runState === 'idle'
                            ? 'paused'
                            : step.status
                    : step.status;
                return (
                  <li
                    key={`${index}:${step.step}`}
                    className={`cowork-progress-card__step cowork-progress-card__step--${presentationStatus}`}
                  >
                    <span
                      className="cowork-progress-card__step-marker"
                      role="img"
                      aria-label={stepStatusLabel(presentationStatus)}
                    >
                      {presentationStatus === ProgressCardStepStatus.Completed
                        ? '✓'
                        : presentationStatus === 'failed'
                          ? '×'
                          : presentationStatus === 'aborted'
                            ? '■'
                            : presentationStatus === 'paused' || presentationStatus === 'waiting'
                              ? 'Ⅱ'
                              : index + 1}
                    </span>
                    <span className="cowork-progress-card__step-text">{step.step}</span>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="cowork-progress-card__footer" title={updatedAtTitle}>
            {i18nService.t('coworkProgressCardUpdated').replace('{time}', updatedAtText)}
          </div>
        </div>
      )}
    </aside>
  );
};

export default SessionProgressCard;
