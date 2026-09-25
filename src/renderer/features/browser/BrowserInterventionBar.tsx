import { ArrowPathIcon, PlayIcon, StopIcon } from '@heroicons/react/24/outline';
import type { BrowserAgentTabReference } from '@shared/browser/browser';
import {
  type BrowserContinueResult,
  BrowserInterventionAction as Action,
  BrowserInterventionPhase as Phase,
  type BrowserInterventionSnapshot,
} from '@shared/browser/browserIntervention';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Tooltip from '@/shared/components/ui/Tooltip';

import { BrowserInterventionFloat } from './BrowserInterventionFloat';

type Props = {
  reference: BrowserAgentTabReference;
  active: boolean;
  browserOperationRunning: boolean;
  buttonClassName?: string;
  detailsHost?: HTMLElement | null;
  onStop: () => Promise<boolean>;
  onCheckStopped?: () => Promise<boolean>;
  onContinue: (prompt: string) => Promise<BrowserContinueResult>;
  onBlockedChange: (blocked: boolean) => void;
};

export function BrowserInterventionBar({
  reference,
  active,
  browserOperationRunning,
  buttonClassName,
  detailsHost,
  onStop,
  onCheckStopped,
  onContinue,
  onBlockedChange,
}: Props) {
  const [snapshot, setSnapshot] = useState<BrowserInterventionSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(false);
  const [readError, setReadError] = useState(false);
  const [mutationUnconfirmed, setMutationUnconfirmed] = useState(false);
  const [note, setNote] = useState('');
  const checkStopped = useRef(onCheckStopped);
  checkStopped.current = onCheckStopped;
  const busy = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(true);
  const { sessionId, targetId, profile } = reference;
  const t = i18nService.t.bind(i18nService);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let nextStopCheck = 0;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const version = epoch.current;
      try {
        if (!busy.current) {
          try {
            let result = await window.electron.browser.intervention({
              sessionId,
              targetId,
              profile,
              action: Action.Read,
            });
            if (!disposed && version === epoch.current && !busy.current) {
              if (!result.success) throw new Error(result.error);
              // Restore the interaction fence before awaiting a Gateway status read.
              setSnapshot(result.value);
              if (
                result.value?.phase === Phase.Stopping &&
                !result.value.stopConfirmed &&
                checkStopped.current &&
                Date.now() >= nextStopCheck
              ) {
                nextStopCheck = Date.now() + 2000;
                const hold = result.value;
                const stopped = await checkStopped.current();
                if (disposed || version !== epoch.current || busy.current) return;
                if (stopped) {
                  result = await window.electron.browser.intervention({
                    sessionId,
                    targetId,
                    profile,
                    action: Action.ConfirmStop,
                    token: hold.token,
                  });
                  if (disposed || version !== epoch.current || busy.current) return;
                  if (!result.success) throw new Error(result.error);
                }
              }
              if (result.value?.stopConfirmed || result.value?.phase === Phase.Manual)
                setError(false);
              setSnapshot(result.value);
              setChecking(false);
              setReadError(false);
              setMutationUnconfirmed(false);
            }
          } catch {
            if (!disposed && version === epoch.current) {
              setChecking(true);
              setReadError(true);
            }
          }
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, sessionId, targetId, profile]);

  const blocked =
    working ||
    mutationUnconfirmed ||
    snapshot?.phase === Phase.Stopping ||
    snapshot?.phase === Phase.Resuming;
  useEffect(() => {
    onBlockedChange(blocked);
  }, [blocked, onBlockedChange]);
  useEffect(() => () => onBlockedChange(false), [onBlockedChange]);

  const request = async (action: (typeof Action)[keyof typeof Action], token?: string) => {
    const result = await window.electron.browser.intervention({ ...reference, action, token });
    if (!result.success) throw new Error(result.error);
    if (mounted.current) {
      setSnapshot(result.value);
      setMutationUnconfirmed(false);
    }
    return result.value;
  };
  const stop = async () => {
    if (busy.current || !active || (!snapshot && (!browserOperationRunning || checking))) return;
    busy.current = true;
    epoch.current++;
    setWorking(true);
    setMutationUnconfirmed(true);
    setError(false);
    try {
      const hold = await request(Action.Begin);
      if (!hold || !(await onStop())) throw new Error('stop unconfirmed');
      await request(Action.ConfirmStop, hold.token);
      setChecking(false);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  const resume = async () => {
    if (busy.current || !active || snapshot?.phase !== Phase.Manual) return;
    busy.current = true;
    epoch.current++;
    setWorking(true);
    setMutationUnconfirmed(true);
    setError(false);
    try {
      const hold = await request(Action.Resume, snapshot.token);
      if (!hold) throw new Error('missing hold');
      if (!mounted.current) throw new Error('view changed');
      const prompt = t('browserInterventionPrompt')
        .replace('{target}', hold.targetId)
        .replace('{note}', note.trim() || t('browserInterventionNoNote'));
      const result = await onContinue(prompt);
      if (result === 'sent') {
        await request(Action.Complete, hold.token);
        if (mounted.current) setNote('');
      } else if (result === 'failed') {
        const renewed = await request(Action.Begin);
        if (renewed && (await onStop())) await request(Action.ConfirmStop, renewed.token);
        throw new Error('send failed');
      } else throw new Error('send unknown');
    } catch {
      if (mounted.current) setError(true);
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const manual = snapshot?.phase === Phase.Manual;
  if (!snapshot && !working && !mutationUnconfirmed && !browserOperationRunning) return null;
  const status = t(
    checking
      ? 'browserInterventionChecking'
      : snapshot?.phase === Phase.Stopping
        ? 'browserInterventionStopping'
        : snapshot?.phase === Phase.Resuming
          ? 'browserInterventionUncertain'
          : manual
            ? 'browserInterventionManual'
            : 'browserInterventionReady',
  );
  const stopLabel = t(snapshot ? 'browserInterventionRetryStop' : 'browserInterventionStop');
  const continueLabel = t('browserInterventionContinue');
  const details =
    snapshot || working || error || readError ? (
      <BrowserInterventionFloat>
        <span role="status" className="text-secondary">
          {status}
        </span>
        {manual && (
          <textarea
            rows={3}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            aria-label={t('browserInterventionNote')}
            placeholder={t('browserInterventionNote')}
            maxLength={2000}
            value={note}
            onChange={event => setNote(event.target.value)}
            disabled={working || !active}
          />
        )}
        {manual && snapshot.targetId !== targetId && (
          <span role="status">{t('browserInterventionTargetChanged')}</span>
        )}
        {(error || readError) && (
          <span role="alert" className="text-error">
            {t(
              snapshot?.phase === Phase.Stopping
                ? 'browserInterventionStopPending'
                : 'browserInterventionError',
            )}
          </span>
        )}
      </BrowserInterventionFloat>
    ) : null;
  return (
    <>
      <div
        data-browser-intervention
        data-testid="browser-intervention-bar"
        className="relative z-[110] ml-1 flex shrink-0 items-center gap-0.5 rounded-lg border border-border/70 bg-surface-raised/60 p-0.5"
      >
        <Tooltip
          content={working || checking ? status : stopLabel}
          position="bottom"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className={buttonClassName}
            disabled={working || !active || !targetId || (!snapshot && checking)}
            aria-label={stopLabel}
            onClick={() => void stop()}
          >
            {working || checking ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <StopIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        {manual && (
          <Tooltip content={continueLabel} position="bottom" renderInPortal dismissOnClick>
            <button
              type="button"
              className={buttonClassName}
              disabled={working || !active}
              aria-label={continueLabel}
              onClick={() => void resume()}
            >
              <PlayIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      {detailsHost
        ? createPortal(details, detailsHost)
        : detailsHost === undefined
          ? details
          : null}
    </>
  );
}
