import { type CoworkSubagentAction, CoworkSubagentActions } from '@shared/cowork/subagentDetails';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { isActiveSubtask, type Subtask } from './subtaskPresentation';

/** All mutations are scoped and re-authorized by Main against the native task ledger. */
type SubtaskControlsProps = {
  sessionId: string;
  task: Subtask;
  onRefresh: (verified?: Subtask) => void;
};

export default function SubtaskControls(props: SubtaskControlsProps) {
  return (
    <SubtaskControlsContent
      key={JSON.stringify([props.sessionId, props.task.id, props.task.sessionKey])}
      {...props}
    />
  );
}

function SubtaskControlsContent({ sessionId, task, onRefresh }: SubtaskControlsProps) {
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
  const active = isActiveSubtask(currentTask.status);
  const recoverable =
    !active &&
    (currentTask.deliveryStatus === 'pending' ||
      currentTask.deliveryStatus === 'failed' ||
      currentTask.deliveryStatus === 'parent_missing');
  const act = async (action: CoworkSubagentAction) => {
    if (inFlight.current || needsVerification) return;
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
            result.duplicateRisk ? 'subtaskControlDuplicateRisk' : 'subtaskControlDone',
          ),
        );
        // Refresh before allowing a second mutation, even after a successful RPC.
        setNeedsVerification(true);
        onRefresh();
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
      const result = await window.electron.cowork.getSubTaskDetails(task.sessionKey, task.id);
      if (!mounted.current) return;
      if (
        result.success &&
        result.subagent?.id === task.id &&
        result.subagent.sessionKey === task.sessionKey
      ) {
        setVerified({ source: task, value: result.subagent });
        onRefresh(result.subagent);
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
  if (!active && !recoverable && !notice) return null;
  const buttonClass =
    'rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised disabled:opacity-50';
  return (
    <div className="space-y-2 border-b border-border px-5 py-3">
      <div className="flex flex-wrap gap-2">
        {active && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy || needsVerification}
            onClick={() => void act(CoworkSubagentActions.Cancel)}
          >
            {i18nService.t('subtaskCancel')}
          </button>
        )}
        {recoverable && (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || needsVerification}
              onClick={() => void act(CoworkSubagentActions.RetryDelivery)}
            >
              {i18nService.t('subtaskRetryDelivery')}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || needsVerification}
              onClick={() => void act(CoworkSubagentActions.DismissDelivery)}
            >
              {i18nService.t('subtaskDismissDelivery')}
            </button>
          </>
        )}
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
      <p className="text-xs text-secondary">
        {i18nService.t(active ? 'subtaskCancelHint' : 'subtaskRecoveryHint')}
      </p>
      {busy && (
        <p role="status" className="text-xs text-secondary">
          {i18nService.t('subtaskControlBusy')}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          {notice}
        </p>
      )}
    </div>
  );
}
