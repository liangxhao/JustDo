import {
  ArrowPathIcon,
  BookmarkSquareIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import {
  SWARM_WORKFLOW_INTERVENTION_LIMITS,
  type SwarmWorkflowDetail,
} from '../../contracts/workflow';
import { useId, useLayoutEffect, useRef } from 'react';

import { i18nService } from './ui';

import { ComposerFeatureMenu, type ComposerFeatureItem } from './ui';
import { COMPOSER_FRAME_CLASS, COMPOSER_SURFACE_CLASS, COMPOSER_TEXTAREA_CLASS } from './ui';
import { RunControlButton } from './ui';
import { useSwarmWorkflowInterventionState } from './workflowBrowserState';

export default function SwarmWorkflowNodeIntervention({
  sessionId,
  detail,
  disabled,
  onChanged,
}: {
  sessionId: string;
  detail: SwarmWorkflowDetail;
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = (key: string) => i18nService.t(key);
  const { text, setText, busy, failed, acceptedAction, setAcceptedAction, send } =
    useSwarmWorkflowInterventionState({
      sessionId,
      detail,
      disabled,
      onChanged,
    });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(144, Math.max(48, input.scrollHeight))}px`;
  }, [text, detail.canNote]);
  if (!detail.canNote && !failed) return null;
  const moreActions: ComposerFeatureItem[] = [];
  if (detail.canContinue)
    moreActions.push({
      id: 'note',
      label: t('swarmWorkflowInterventionSaveOnly'),
      description: t('swarmWorkflowInterventionSaveOnlyHint'),
      icon: <BookmarkSquareIcon className="h-4 w-4" />,
      disabled: !text.trim(),
      onSelect: () => void send('note'),
    });
  if (detail.canRetry)
    moreActions.push({
      id: 'retry',
      label: t('swarmWorkflowNodeRetry'),
      description: t('swarmWorkflowInterventionRetryHint'),
      icon: <ArrowPathIcon className="h-4 w-4" />,
      onSelect: () => void send('retry'),
    });
  return (
    <div className="shrink-0 p-3">
      {detail.canNote && (
        <div className={COMPOSER_FRAME_CLASS}>
          <div className={COMPOSER_SURFACE_CLASS}>
            <textarea
              ref={inputRef}
              value={text}
              maxLength={SWARM_WORKFLOW_INTERVENTION_LIMITS.text}
              disabled={busy || disabled}
              aria-label={t('swarmWorkflowInterventionInput')}
              aria-describedby={failed ? errorId : undefined}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              placeholder={t('swarmWorkflowInterventionPlaceholder')}
              onChange={event => {
                setText(event.target.value);
                setAcceptedAction(undefined);
              }}
              onKeyDown={event => {
                if (
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey)
                ) {
                  event.preventDefault();
                  void send(detail.canContinue ? 'continue' : 'note');
                }
              }}
              rows={1}
              className={`${COMPOSER_TEXTAREA_CLASS} block min-h-12 max-h-36 disabled:opacity-50`}
            />
            <div className="flex items-center gap-2 px-3 pb-2 pt-1.5">
              {!!moreActions.length && (
                <ComposerFeatureMenu
                  items={moreActions}
                  label={t('swarmWorkflowInterventionMore')}
                  triggerIcon={<EllipsisHorizontalIcon className="h-4 w-4" />}
                  disabled={disabled || busy || !detail.revision}
                />
              )}
              <div className="flex-1" />
              <RunControlButton
                isRunning={false}
                isStopping={false}
                canSubmit={!disabled && !busy && !!text.trim() && !!detail.revision}
                size="normal"
                sendLabel={t(
                  detail.canContinue
                    ? 'swarmWorkflowInterventionContinue'
                    : 'swarmWorkflowInterventionSave',
                )}
                sendTitle={
                  t(
                    detail.canContinue
                      ? 'swarmWorkflowInterventionContinue'
                      : 'swarmWorkflowInterventionSave',
                  ) + ' · Ctrl/⌘ + Enter'
                }
                onSend={() => void send(detail.canContinue ? 'continue' : 'note')}
              />
            </div>
          </div>
        </div>
      )}
      {failed && (
        <div
          id={errorId}
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('swarmWorkflowInterventionSendUnconfirmed')}</p>
        </div>
      )}
      {acceptedAction && (
        <span role="status" className="sr-only">
          {t('swarmWorkflowInterventionAccepted_' + acceptedAction)}
        </span>
      )}
    </div>
  );
}
