import {
  ArrowPathIcon,
  BookmarkSquareIcon,
  ChatBubbleLeftEllipsisIcon,
  ChevronDownIcon,
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
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const pending = useRef<SwarmIntervention>();
  const notes = detail.interventions ?? EMPTY_NOTES;
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
      pending.current = undefined;
      setFailed(false);
      setSaved(true);
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
    setSaved(false);
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
        setSaved(true);
      }
    } catch {
      if (pending.current?.id === request.id) setFailed(true);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  if (!detail.canNote && !notes.length && !failed) return null;
  const actionButton = (
    action: SwarmInterventionAction,
    label: string,
    Icon: typeof ArrowPathIcon,
    available: boolean | undefined,
  ) => (
    <button
      type="button"
      title={t(label)}
      aria-label={t(label)}
      disabled={disabled || busy || !available || (action !== 'retry' && !text.trim())}
      onClick={() => void send(action)}
      className="shrink-0 rounded-lg p-2 text-secondary transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          title={t('flowIntervene')}
          aria-label={t('flowIntervene')}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs text-secondary hover:bg-surface-raised"
        >
          <ChatBubbleLeftEllipsisIcon className="h-4 w-4" aria-hidden="true" />
          {t('flowIntervene')}
          {!!notes.length && <span className="text-muted">{notes.length}</span>}
          <ChevronDownIcon
            className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        <div className="ml-auto">
          {detail.canRetry &&
            actionButton('retry', 'flowNodeRetry', ArrowPathIcon, detail.canRetry)}
        </div>
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
                placeholder={t('flowInterventionPlaceholder')}
                onChange={event => {
                  setText(event.target.value);
                  setSaved(false);
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
                <span id={hintId} className="sr-only">
                  {t(
                    detail.canContinue
                      ? 'flowInterventionContinueHint'
                      : 'flowInterventionNoteHint',
                  )}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted"
                  title={t(
                    detail.canContinue
                      ? 'flowInterventionContinueHint'
                      : 'flowInterventionNoteHint',
                  )}
                >
                  {t(
                    detail.canContinue
                      ? 'flowInterventionContinueMode'
                      : 'flowInterventionNoteMode',
                  )}
                </span>
                {detail.canContinue &&
                  actionButton('note', 'flowInterventionSave', BookmarkSquareIcon, detail.canNote)}
                <RunControlButton
                  isRunning={false}
                  isStopping={false}
                  canSubmit={!disabled && !busy && !!text.trim() && !!detail.revision}
                  size="normal"
                  sendLabel={t(
                    detail.canContinue ? 'flowInterventionContinue' : 'flowInterventionSave',
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
      {saved && (
        <p role="status" className="px-2 py-1 text-xs text-secondary">
          {t('flowInterventionSaved')}
        </p>
      )}
    </div>
  );
}
