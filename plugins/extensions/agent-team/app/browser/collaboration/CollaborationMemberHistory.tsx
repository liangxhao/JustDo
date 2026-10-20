import type { AppNativeHistoryState } from '@app-plugin/sdk/browser';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CollaborationRoom } from '../../../contracts/collaboration';
import type { Subtask, GatewayMessage } from '@app-plugin/sdk/rendering';

import { browserHost, teamApi } from '../ports';
import { SessionSubtaskButton } from '../ui';
import CollaborationStopButton from './CollaborationStopButton';

type NativeState = AppNativeHistoryState;
/** Native history is a host primitive; receipts, controls and presentation belong to Team. */
export default function CollaborationMemberHistory({
  member,
  anchorSessionId = member.sessionId,
  roomId,
  name,
  workingDirectory,
  receipt,
  headerAction,
  backAction,
  headerMenu,
  peerNames,
  peerColors,
  onOpenSubtask,
  onSessionChange,
}: {
  onSessionChange?(state: AppNativeHistoryState | null): void;
  member: CollaborationRoom['members'][number];
  anchorSessionId?: string;
  roomId?: string;
  name: string;
  workingDirectory: string;
  receipt?: { deliveryId: string; id: string };
  headerAction?: ReactNode;
  backAction?: { label: string; onClick(): void };
  headerMenu?: ReactNode;
  peerNames?: Readonly<Record<string, string>>;
  peerColors?: Readonly<Record<string, string>>;
  onOpenSubtask?: (task: Subtask, parentSessionId: string) => void;
}) {
  const host = browserHost();
  const [native, setNative] = useState<NativeState>();
  const latestNative = useRef<NativeState>();
  useEffect(() => {
    onSessionChange?.(native?.ready && native.connected ? native : null);
  }, [native, onSessionChange]);
  useEffect(() => () => onSessionChange?.(null), [onSessionChange, member.sessionKey]);
  const [reload, setReload] = useState(0);
  const [receiptResult, setReceiptResult] = useState<{
    key: string;
    messages: GatewayMessage[];
    error?: boolean;
  }>();
  const key = JSON.stringify([member.sessionKey, receipt?.deliveryId, receipt?.id]);
  useEffect(() => {
    if (!receipt) return;
    let current = true;
    void teamApi.collaboration
      .readMessages(anchorSessionId, [receipt.deliveryId])
      .then(result => {
        if (!current) return;
        const message = result.success
          ? result.value.find(item => item.deliveryId === receipt.deliveryId)?.message
          : undefined;
        setReceiptResult({
          key,
          messages: message ? [message as GatewayMessage] : [],
          error: !result.success,
        });
      })
      .catch(() => {
        if (current) setReceiptResult({ key, messages: [], error: true });
      });
    return () => {
      current = false;
    };
  }, [anchorSessionId, key, reload]);
  const canStop =
    !receipt &&
    roomId &&
    native?.canStop &&
    native.runId &&
    native.nativeSessionId &&
    native.sessionKey === member.sessionKey;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={
          backAction
            ? '-mx-3 -mt-3 mb-2 flex min-h-10 min-w-0 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-background px-3 py-1'
            : 'mb-3 flex min-w-0 shrink-0 items-center justify-between gap-2'
        }
      >
        {backAction && (
          <button
            type="button"
            onClick={backAction.onClick}
            aria-label={backAction.label}
            title={backAction.label}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={name}>
          {name}
        </h3>
        <div className={`flex shrink-0 items-center ${backAction ? 'gap-1.5' : 'gap-2'}`}>
          {headerAction}
          <span className="whitespace-nowrap text-xs text-secondary">
            {host.t(
              !receipt && native?.running ? 'collaborationWorking' : 'collaborationHistoryReadOnly',
            )}
          </span>
          {roomId && !receipt && native?.running && native.sessionKey === member.sessionKey && (
            <CollaborationStopButton
              key={`${roomId}:${member.sessionKey}`}
              label={host.t('collaborationStopMember')}
              disabled={!canStop}
              stop={async () => {
                const state = latestNative.current?.readCurrent
                  ? latestNative.current.readCurrent()
                  : latestNative.current;
                if (
                  host.signal.aborted ||
                  !state?.canStop ||
                  state.sessionKey !== member.sessionKey ||
                  !state.runId ||
                  !state.nativeSessionId
                )
                  throw new Error('collaborationStateConflict');
                return teamApi.collaboration.stopMember({
                  sourceSessionId: anchorSessionId,
                  roomId,
                  targetSessionKey: member.sessionKey,
                  runId: state.runId,
                  nativeSessionId: state.nativeSessionId,
                });
              }}
            />
          )}
          {!receipt && onOpenSubtask && (
            <SessionSubtaskButton
              key={`subtasks:${member.sessionId}`}
              sessionId={member.sessionId}
              parentRunning={native?.running === true}
              onOpenSubtask={onOpenSubtask}
            />
          )}
          {headerMenu}
        </div>
      </div>
      {host.renderHistory({
        showSubtaskAction: false,
        observeSession: Boolean(onSessionChange),
        sessionKey: member.sessionKey,
        workingDirectory,
        agentId: member.agentId,
        name,
        ...(receipt
          ? {
              messages: receiptResult?.key === key ? receiptResult.messages : [],
              receiptLoading: receiptResult?.key !== key,
              receiptError: receiptResult?.key === key && receiptResult.error,
              onRetry: () => {
                setReceiptResult(undefined);
                setReload(value => value + 1);
              },
            }
          : {}),
        peerNames,
        peerColors,
        productSessionId: member.sessionId,
        ...(onOpenSubtask
          ? { onOpenSubtask: (task: Subtask) => onOpenSubtask(task, member.sessionId) }
          : {}),
        onState: (state: NativeState) => {
          latestNative.current = state;
          setNative(state);
        },
        errorRole: 'alert',
        labels: {
          loading: host.t('collaborationHistoryLoading'),
          empty: host.t(receipt ? 'collaborationReceiptUnavailable' : 'collaborationHistoryEmpty'),
          error: host.t(receipt ? 'collaborationMessageUnavailable' : 'collaborationHistoryError'),
          retry: host.t('sessionDetailsRetry'),
        },
      })}
    </div>
  );
}
