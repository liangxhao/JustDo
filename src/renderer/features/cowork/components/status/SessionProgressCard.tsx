import './SessionProgressCard.css';

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClipboardDocumentCheckIcon,
  StopCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { PauseCircleIcon as PauseCircleSolidIcon } from '@heroicons/react/24/solid';
import type { SessionRunState } from '@shared/cowork/sessionRun';
import {
  type ProgressCard,
  progressCardIsComplete,
  type ProgressCardStep,
  ProgressCardStepStatus,
} from '@shared/openclaw/progressCard';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';

const PROGRESS_NOTE_PREVIEW_HEIGHT_PX = 279;

interface SessionProgressCardProps {
  card: ProgressCard;
  runState: ProgressCardRunState;
  onRefresh?: () => Promise<boolean>;
}

export type ProgressCardRunState = SessionRunState | 'idle';

const currentProgressStep = (steps: readonly ProgressCardStep[]): ProgressCardStep | null =>
  steps.find(step => step.status === ProgressCardStepStatus.InProgress) ??
  steps.find(step => step.status === ProgressCardStepStatus.Pending) ??
  [...steps].reverse().find(step => step.status === ProgressCardStepStatus.Completed) ??
  null;

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

function ProgressCardNote({ html, id }: { html: string; id: string }) {
  const noteRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const note = noteRef.current;
    if (!note) return;
    const measure = () => setOverflows(note.scrollHeight > PROGRESS_NOTE_PREVIEW_HEIGHT_PX + 1);
    measure();
    const ownerWindow = note.ownerDocument.defaultView;
    const observer = ownerWindow?.ResizeObserver ? new ownerWindow.ResizeObserver(measure) : null;
    observer?.observe(note);
    return () => observer?.disconnect();
  }, [html]);

  return (
    <div className="cowork-progress-card__note">
      <div
        id={id}
        className={`cowork-progress-card__note-preview${overflows && !expanded ? ' cowork-progress-card__note-preview--clamped' : ''}`}
        style={
          expanded ? undefined : { maxHeight: PROGRESS_NOTE_PREVIEW_HEIGHT_PX, overflow: 'hidden' }
        }
        onFocusCapture={() => {
          if (overflows) setExpanded(true);
        }}
      >
        <div
          ref={noteRef}
          className="cowork-progress-card__markdown"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {overflows && (
        <button
          type="button"
          className={`cowork-progress-card__note-toggle${expanded ? ' cowork-progress-card__note-toggle--collapse' : ''}`}
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {i18nService.t(
            expanded ? 'coworkProgressCardNoteCollapse' : 'coworkProgressCardNoteExpand',
          )}
          <ChevronDownIcon className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

const SessionProgressCard = ({ card, runState, onRefresh }: SessionProgressCardProps) => {
  const complete = progressCardIsComplete(card);
  const steps = card.steps ?? [];
  const completedCount = steps.filter(
    step => step.status === ProgressCardStepStatus.Completed,
  ).length;
  const current = currentProgressStep(steps);
  const initialSessionKeyRef = useRef(card.sessionKey);
  const [expanded, setExpanded] = useState(true);
  const [refreshState, setRefreshState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const refreshGeneration = useRef(0);
  useEffect(() => {
    refreshGeneration.current += 1;
    setRefreshState('idle');
    return () => {
      refreshGeneration.current += 1;
    };
  }, [card.sessionKey]);
  useEffect(() => {
    if (refreshState !== 'pending') return;
    const timer = window.setTimeout(() => {
      refreshGeneration.current += 1;
      setRefreshState('failed');
    }, 60_000);
    return () => window.clearTimeout(timer);
  }, [refreshState]);
  const refresh = async () => {
    if (!onRefresh || refreshState === 'pending') return;
    const generation = ++refreshGeneration.current;
    setRefreshState('pending');
    const refreshed = await onRefresh().catch(() => false);
    if (generation === refreshGeneration.current) setRefreshState(refreshed ? 'idle' : 'failed');
  };
  useEffect(() => {
    if (initialSessionKeyRef.current === card.sessionKey) return;
    initialSessionKeyRef.current = card.sessionKey;
    setExpanded(true);
  }, [card.sessionKey]);

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
  const bodyId = `cowork-progress-card-${card.sessionKey.replace(/[^a-z0-9_-]/gi, '-')}`;

  return (
    <section
      id="cowork-progress-card"
      className="cowork-progress-card"
      aria-label={i18nService.t('coworkProgressCardTitle')}
      data-progress-card-placement="summary"
      data-progress-card-revision={card.revision}
    >
      <div className="cowork-progress-card__header">
        <h3
          className="cowork-progress-card__heading"
          aria-label={i18nService.t('coworkProgressCardTitle')}
        >
          <button
            type="button"
            className="cowork-progress-card__summary"
            onClick={() => setExpanded(value => !value)}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={summaryAccessibleLabel}
          >
            <span className="cowork-progress-card__title">
              {i18nService.t('coworkProgressCardTitle')}
            </span>
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
            {completedCountText && (
              <span className="cowork-progress-card__count">{completedCountText}</span>
            )}
            <ChevronDownIcon
              className={`cowork-progress-card__chevron ${expanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
        </h3>
        {onRefresh && (
          <button
            type="button"
            className="cowork-progress-card__action"
            disabled={refreshState === 'pending'}
            aria-busy={refreshState === 'pending'}
            onClick={() => void refresh()}
            aria-label={i18nService.t('coworkProgressCardRefresh')}
            title={i18nService.t('coworkProgressCardRefresh')}
          >
            <ArrowPathIcon className={refreshState === 'pending' ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {refreshState === 'failed' && (
        <p className="cowork-progress-card__refresh-error" role="status">
          {i18nService.t('coworkProgressCardRefreshFailed')}
        </p>
      )}
      {expanded && (
        <div id={bodyId} className="cowork-progress-card__body">
          {markdownHtml && (
            <ProgressCardNote key={card.sessionKey} id={`${bodyId}-note`} html={markdownHtml} />
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
        </div>
      )}
    </section>
  );
};

export default SessionProgressCard;
