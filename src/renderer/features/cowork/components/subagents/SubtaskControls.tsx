import { type CoworkSubagentAction, CoworkSubagentActions } from '@shared/cowork/subagentDetails';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { isActiveSubtask, type Subtask, SUBTASK_STATUSES } from './subtaskPresentation';

/** All mutations are scoped and re-authorized by Main against the native session lineage. */
type SubtaskControlsProps = {
  sessionId: string;
  task: Subtask;
  onRefresh: (verified?: Subtask) => void;
  variant?: 'toolbar';
};

export default function SubtaskControls(props: SubtaskControlsProps) {
  return (
    <SubtaskControlsContent
      key={JSON.stringify([
        props.sessionId,
        props.task.id,
        props.task.sessionKey,
        props.task.sessionId,
      ])}
      {...props}
    />
  );
}

function SubtaskControlsContent({ sessionId, task, onRefresh, variant }: SubtaskControlsProps) {
  const [busy, setBusy] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [notice, setNotice] = useState<string>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [verified, setVerified] = useState<{ source: Subtask; value: Subtask }>();
  const currentTask = verified?.source === task ? verified.value : task;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const toolbar = variant === 'toolbar';
  const active = isActiveSubtask(currentTask.status);
  const readCurrentTask = async (): Promise<Subtask | undefined> => {
    try {
      const result = await window.electron.cowork.getSubTaskDetails(task.sessionKey, task.id);
      if (
        result.success &&
        result.subagent?.id === task.id &&
        result.subagent.sessionKey === task.sessionKey &&
        (!task.sessionId || result.subagent.sessionId === task.sessionId) &&
        result.subagent.status !== SUBTASK_STATUSES.UNKNOWN
      ) {
        return result.subagent;
      }
    } catch {
      // An unavailable snapshot leaves verification pending.
    }
    return undefined;
  };
  const act = async (action: CoworkSubagentAction) => {
    if (!active || inFlight.current || needsVerification) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await window.electron.cowork.controlSubTask(sessionId, task.id, action);
      if (!mounted.current) return;
      if (!result.success) {
        setNeedsVerification(true);
        setNotice(`${i18nService.t('subtaskControlUnknown')} ${result.error}`);
      } else {
        setNotice(
          i18nService.t(
            result.duplicateRisk
              ? 'subtaskControlDuplicateRisk'
              : toolbar
                ? 'subtaskStopAcknowledged'
                : 'subtaskControlDone',
          ),
        );
        setNeedsVerification(true);
        const latest = toolbar ? await readCurrentTask() : undefined;
        if (!mounted.current) return;
        if (latest) {
          setVerified({ source: task, value: latest });
          if (!isActiveSubtask(latest.status)) {
            setNeedsVerification(false);
            if (!result.duplicateRisk) setNotice(undefined);
          }
        }
        onRefresh(latest);
      }
    } catch {
      if (!mounted.current) return;
      setNeedsVerification(true);
      setNotice(i18nService.t('subtaskControlUnknown'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const verify = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const latest = await readCurrentTask();
      if (!mounted.current) return;
      if (latest) {
        setVerified({ source: task, value: latest });
        onRefresh(latest);
        setNeedsVerification(false);
        setNotice(undefined);
      } else setNotice(i18nService.t('subtaskControlUnknown'));
    } catch {
      if (mounted.current) setNotice(i18nService.t('subtaskControlUnknown'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (!active && !busy && !notice) return null;
  const stopLabel = i18nService.t(toolbar ? 'subtaskStop' : 'subtaskCancel');
  const buttonClass =
    'rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised disabled:opacity-50';
  return (
    <div className={toolbar ? 'relative shrink-0' : 'space-y-2 border-b border-border px-5 py-3'}>
      {active && (
        <button
          type="button"
          className={
            toolbar
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-red-600 transition-colors enabled:hover:bg-surface-raised disabled:opacity-50 dark:text-red-400'
              : buttonClass
          }
          aria-label={stopLabel}
          title={toolbar ? `${stopLabel} · ${i18nService.t('subtaskStopHint')}` : undefined}
          aria-busy={busy || undefined}
          disabled={busy || needsVerification}
          onClick={() => void act(CoworkSubagentActions.Cancel)}
        >
          {toolbar ? <span className="h-2.5 w-2.5 bg-current" aria-hidden="true" /> : stopLabel}
        </button>
      )}
      {!toolbar && active && (
        <p className="text-xs text-secondary">{i18nService.t('subtaskCancelHint')}</p>
      )}
      {(busy || notice) && (
        <div
          className={
            toolbar
              ? 'absolute -right-8 top-full z-10 mt-2 w-56 space-y-2 rounded-md border border-border bg-surface p-2.5 shadow-lg'
              : 'space-y-2'
          }
        >
          <p
            role="status"
            className={
              busy ? 'text-xs text-secondary' : 'text-xs text-amber-700 dark:text-amber-300'
            }
          >
            {busy ? i18nService.t('subtaskControlBusy') : notice}
          </p>
          {needsVerification && (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void verify()}
            >
              {i18nService.t('subtaskControlVerify')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
