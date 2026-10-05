import {
  ArrowPathIcon,
  BookmarkSquareIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  EllipsisHorizontalIcon,
  PaperAirplaneIcon,
} from '@heroicons/react/24/outline';
import {
  SWARM_INTERVENTION_LIMITS,
  type SwarmFlowDetail,
  type SwarmIntervention,
  type SwarmInterventionAction,
  type SwarmInterventionNote,
} from '@shared/cowork/swarmFlow';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { UserMessageContent } from '../chat/UserMessageContent';
import ComposerFeatureMenu, { type ComposerFeatureItem } from '../composer/ComposerFeatureMenu';
import { COMPOSER_SURFACE_CLASS, COMPOSER_TEXTAREA_CLASS } from '../composer/composerStyles';
import { RunControlButton } from '../composer/RunControlButton';

const EMPTY_NOTES: SwarmInterventionNote[] = [];

function InterventionMessage({
  note,
  workingDirectory,
}: {
  note: SwarmInterventionNote;
  workingDirectory?: string;
}) {
  const message = useMemo(() => ({ role: 'user', content: note.text }), [note.text]);
  const date = new Date(note.createdAt);
  const label = i18nService.t('flowIntervention_' + note.action);
  const Icon =
    note.action === 'retry'
      ? ArrowPathIcon
      : note.action === 'continue'
        ? PaperAirplaneIcon
        : BookmarkSquareIcon;
  return (
    <li className="min-w-0">
      {note.text && (
        <UserMessageContent message={message} workingDirectory={workingDirectory} compact />
      )}
      <div className="mt-1 flex items-center justify-end gap-1.5 px-1 text-[11px] text-muted">
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span>{label}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
    </li>
  );
}

export default function SwarmNodeIntervention({
  sessionId,
  detail,
  disabled,
  onChanged,
}: {
  sessionId: string;
  detail: SwarmFlowDetail;
  disabled: boolean;
  onChanged: () => void;
}) {
  const t = (key: string) => i18nService.t(key);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [acceptedAction, setAcceptedAction] = useState<SwarmInterventionAction>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const pending = useRef<SwarmIntervention>();
  const notes = detail.interventions ?? EMPTY_NOTES;
  useEffect(() => {
    if (detail.canContinue) setExpanded(true);
  }, [detail.canContinue]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(144, Math.max(48, input.scrollHeight))}px`;
  }, [text, expanded, detail.canNote]);
  useEffect(() => {
    if (notesRef.current) notesRef.current.scrollTop = notesRef.current.scrollHeight;
  }, [notes.length, expanded]);
  useEffect(() => {
    // A response can be lost after acceptance. Reconcile using the persisted ID.
    if (pending.current && notes.some(note => note.id === pending.current?.id)) {
      if (text.trim() === pending.current.text) setText('');
      setAcceptedAction(pending.current.action);
      pending.current = undefined;
      setFailed(false);
    }
  }, [notes, text]);
  const send = async (action: SwarmInterventionAction) => {
    if (
      busy ||
      disabled ||
      !detail.revision ||
      (action === 'note' && !detail.canNote) ||
      (action === 'continue' && !detail.canContinue) ||
      (action === 'retry' && !detail.canRetry) ||
      (action !== 'retry' && !text.trim())
    )
      return;
    const body = text.trim();
    const request =
      pending.current?.action === action && pending.current.text === body
        ? pending.current
        : { id: crypto.randomUUID(), action, text: body };
    pending.current = request;
    setBusy(true);
    setFailed(false);
    setAcceptedAction(undefined);
    try {
      const result = await window.electron.cowork.interveneSwarmFlow(
        sessionId,
        detail.flowId,
        detail.nodeId,
        detail.revision,
        request,
      );
      // Polling may have confirmed persistence before this reply arrives.
      if (!result.success) {
        if (pending.current?.id === request.id) setFailed(true);
      } else {
        setText('');
        pending.current = undefined;
        setAcceptedAction(action);
      }
    } catch {
      if (pending.current?.id === request.id) setFailed(true);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  if (!detail.canNote && !notes.length && !failed) return null;
  const moreActions: ComposerFeatureItem[] = [];
  if (detail.canContinue)
    moreActions.push({
      id: 'note',
      label: t('flowInterventionSaveOnly'),
      description: t('flowInterventionSaveOnlyHint'),
      icon: <BookmarkSquareIcon className="h-4 w-4" />,
      disabled: !text.trim(),
      onSelect: () => void send('note'),
    });
  if (detail.canRetry)
    moreActions.push({
      id: 'retry',
      label: t('flowNodeRetry'),
      description: t('flowInterventionRetryHint'),
      icon: <ArrowPathIcon className="h-4 w-4" />,
      onSelect: () => void send('retry'),
    });
  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="flex items-center">
        <button
          type="button"
          title={t('flowIntervene')}
          aria-label={t('flowIntervene')}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-xs font-medium text-secondary hover:bg-surface-raised"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ChatBubbleLeftEllipsisIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span className="shrink-0 whitespace-nowrap">{t('flowIntervene')}</span>
          {!!notes.length && (
            <span className="shrink-0 rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-normal text-muted">
              {notes.length}
            </span>
          )}
          {expanded && detail.canNote && (
            <span
              id={hintId}
              title={t(
                detail.canContinue ? 'flowInterventionContinueHint' : 'flowInterventionNoteHint',
              )}
              className="min-w-0 flex-1 truncate text-left text-[11px] font-normal text-muted"
            >
              {t(detail.canContinue ? 'flowInterventionContinueHint' : 'flowInterventionNoteHint')}
            </span>
          )}
          <ChevronDownIcon
            className={`ml-auto h-3 w-3 shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {expanded && (
        <>
          {!!notes.length && (
            <ul
              ref={notesRef}
              aria-label={t('flowInterventionHistory')}
              className="my-3 max-h-44 space-y-3 overflow-y-auto overscroll-contain pr-1"
            >
              {notes.map(note => (
                <InterventionMessage
                  key={note.id}
                  note={note}
                  workingDirectory={detail.workingDirectory}
                />
              ))}
            </ul>
          )}
          {detail.canNote && (
            <div className={`${COMPOSER_SURFACE_CLASS} mt-2`}>
              <textarea
                ref={inputRef}
                value={text}
                maxLength={SWARM_INTERVENTION_LIMITS.text}
                disabled={busy || disabled}
                aria-label={t('flowInterventionInput')}
                aria-describedby={hintId}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                placeholder={t('flowInterventionPlaceholder')}
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
              <div className="flex items-center gap-2 px-3 pb-2 pt-1">
                {!!moreActions.length && (
                  <ComposerFeatureMenu
                    items={moreActions}
                    label={t('flowInterventionMore')}
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
                    detail.canContinue ? 'flowInterventionContinue' : 'flowInterventionSave',
                  )}
                  sendText={t(
                    detail.canContinue
                      ? 'flowInterventionSendContinue'
                      : 'flowInterventionSendNote',
                  )}
                  sendTitle={
                    t(detail.canContinue ? 'flowInterventionContinue' : 'flowInterventionSave') +
                    ' · Ctrl/⌘ + Enter'
                  }
                  onSend={() => void send(detail.canContinue ? 'continue' : 'note')}
                />
              </div>
            </div>
          )}
        </>
      )}
      {failed && (
        <p role="alert" className="px-2 py-1 text-xs text-red-600">
          {t('flowControlFailed')}
        </p>
      )}
      {acceptedAction && (
        <p role="status" className="mt-2 flex items-center gap-1.5 px-1 text-xs text-secondary">
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          {t('flowInterventionAccepted_' + acceptedAction)}
        </p>
      )}
    </div>
  );
}
