import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import type { CollaborationRoom } from '@shared/cowork/agent-team/collaboration';
import { type ReactNode, useEffect, useState } from 'react';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import ChatMessageDisplay from '../chat/ChatMessageDisplay';
import { connectToGateway } from '../chat/JustDoChatWrapper';
import SessionSubtaskButton from '../subagents/SessionSubtaskButton';
import type { Subtask } from '../subagents/subtaskPresentation';
import CollaborationStopButton from './CollaborationStopButton';

/** Native member history never changes the main selection or submits chat messages. */
export default function CollaborationMemberHistory({
  member,
  anchorSessionId = member.sessionId,
  roomId,
  name,
  workingDirectory,
  receipt,
  peerNames,
  peerColors,
  onOpenSubtask,
  headerAction,
  backAction,
  headerMenu,
}: {
  member: CollaborationRoom['members'][number];
  anchorSessionId?: string;
  roomId?: string;
  name: string;
  workingDirectory: string;
  receipt?: { deliveryId: string; id: string };
  peerColors?: Readonly<Record<string, string>>;
  peerNames?: Readonly<Record<string, string>>;
  onOpenSubtask?: (task: Subtask, parentSessionId: string) => void;
  headerAction?: ReactNode;
  backAction?: { label: string; onClick: () => void };
  headerMenu?: ReactNode;
}) {
  const receiptId = receipt?.id;
  const receiptDeliveryId = receipt?.deliveryId;
  const [controller, setController] = useState<ChatController | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [running, setRunning] = useState(false);
  const [canStopMemberRun, setCanStopMemberRun] = useState(false);
  const [receiptRetry, setReceiptRetry] = useState(0);
  const receiptKey = JSON.stringify([member.sessionKey, receiptDeliveryId, receiptId]);
  const [receiptResult, setReceiptResult] = useState<{ key: string; messages: GatewayMessage[] }>({
    key: receiptKey,
    messages: [],
  });
  // Props change before effects run; never attribute the previous receipt to a new selection.
  const receiptMessages = receiptResult.key === receiptKey ? receiptResult.messages : [];
  useEffect(() => {
    let disposed = false;
    setController(null);
    setStatus('loading');
    setRunning(false);
    setCanStopMemberRun(false);
    setReceiptResult({ key: receiptKey, messages: [] });
    if (receiptDeliveryId) {
      void window.electron?.collaboration
        ?.readMessages(anchorSessionId, [receiptDeliveryId])
        .then(result => {
          if (disposed) return;
          const message = result.success
            ? result.value.find(item => item.deliveryId === receiptDeliveryId)?.message
            : undefined;
          const messages =
            message && typeof message === 'object' ? [message as GatewayMessage] : [];
          setReceiptResult({ key: receiptKey, messages });
          setStatus(messages.length ? 'ready' : result.success ? 'empty' : 'error');
        })
        .catch(() => {
          if (!disposed) setStatus('error');
        });
      return () => {
        disposed = true;
      };
    }
    // Peers are ordinary sessions; subagent task-boundary discovery would hide
    // or repeatedly rescan their independent history.
    const next = new ChatController();
    next.state.sessionKey = member.sessionKey;
    setController(next);
    const syncState = (state: ChatController['state']) => {
      if (disposed) return;
      const turn = state.transcript.activeTurn;
      setRunning(turn?.status === 'running');
      setCanStopMemberRun(
        state.connected &&
          turn?.status === 'running' &&
          Boolean(turn?.runId && (turn.sessionId ?? state.currentSessionId)) &&
          turn?.sessionKey === member.sessionKey &&
          state.sessionKey === member.sessionKey,
      );
      const hasVisibleTranscript =
        state.chatMessages.length > 0 || state.transcript.activeTurn !== null;
      if (hasVisibleTranscript) setStatus('ready');
      else if (state.initialHistoryReady) setStatus(state.lastError ? 'error' : 'empty');
    };
    const unsubscribe = next.subscribe(syncState);
    const unsubscribeStream = next.onStream(() => syncState(next.state));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resetHistoryDeadline = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (
          !disposed &&
          !next.state.initialHistoryReady &&
          next.state.chatMessages.length === 0 &&
          next.state.transcript.activeTurn === null
        )
          setStatus('error');
      }, 15000);
    };
    const retryDelays = [1000, 2000, 4000];
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let connecting = false;
    let transportStarted = false;
    let reconnectRequested = false;
    let previousPhase: string | undefined;
    const connect = async () => {
      if (disposed || connecting || transportStarted) return;
      connecting = true;
      try {
        transportStarted = await connectToGateway(next);
      } catch {
        transportStarted = false;
      } finally {
        connecting = false;
      }
      if (disposed) {
        next.disconnect();
        return;
      }
      if (reconnectRequested) {
        reconnectRequested = false;
        next.disconnect();
        transportStarted = false;
        void connect();
        return;
      }
      // Once started, GatewayClient owns transport reconnects to this endpoint. Retry only failures before
      // transport creation (for example a cold Gateway with no port yet).
      if (!transportStarted) {
        const delay = retryDelays[attempt++];
        if (delay !== undefined) retryTimer = setTimeout(() => void connect(), delay);
        else setStatus('error');
      }
    };
    const unsubscribeProgress = window.electron?.openclaw?.engine?.onProgress?.(engine => {
      if (disposed || engine.phase === previousPhase) return;
      const endpointMayHaveChanged = previousPhase !== undefined && previousPhase !== 'running';
      previousPhase = engine.phase;
      if (engine.phase !== 'running' || (transportStarted && !endpointMayHaveChanged)) return;
      clearTimeout(retryTimer);
      attempt = 0;
      setStatus(
        next.state.chatMessages.length || next.state.transcript.activeTurn ? 'ready' : 'loading',
      );
      resetHistoryDeadline();
      // A restarted Gateway can publish a different port/token. Serialize the
      // endpoint refresh behind any in-flight connection so old setup cannot win.
      if (connecting) {
        reconnectRequested = true;
        return;
      }
      next.disconnect();
      transportStarted = false;
      void connect();
    });
    resetHistoryDeadline();
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      clearTimeout(retryTimer);
      unsubscribeProgress?.();
      unsubscribe();
      unsubscribeStream();
      next.disconnect();
    };
  }, [anchorSessionId, member.sessionKey, receiptDeliveryId, receiptId, receiptKey, receiptRetry]);
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
            {i18nService.t(
              running && !receipt ? 'collaborationWorking' : 'collaborationHistoryReadOnly',
            )}
          </span>
          {roomId && running && !receipt && (
            <CollaborationStopButton
              key={`${roomId}:${member.sessionKey}`}
              label={i18nService.t('collaborationStopMember')}
              disabled={!canStopMemberRun}
              stop={async () => {
                const state = controller?.state;
                const turn = state?.transcript.activeTurn;
                const nativeSessionId = turn?.sessionId ?? state?.currentSessionId;
                if (
                  turn?.status !== 'running' ||
                  !turn.runId ||
                  !nativeSessionId ||
                  turn.sessionKey !== member.sessionKey ||
                  state?.sessionKey !== member.sessionKey ||
                  !state.connected
                )
                  return { success: false, error: 'collaborationStateConflict' };
                return window.electron.collaboration.stopMember({
                  sourceSessionId: anchorSessionId,
                  roomId,
                  targetSessionKey: member.sessionKey,
                  nativeSessionId,
                  runId: turn.runId,
                });
              }}
            />
          )}
          {!receipt && onOpenSubtask && (
            <SessionSubtaskButton
              key={`subtasks:${member.sessionId}`}
              sessionId={member.sessionId}
              parentRunning={running}
              onOpenSubtask={onOpenSubtask}
            />
          )}
          {headerMenu}
        </div>
      </div>
      {status !== 'ready' && (
        <p role={status === 'error' ? 'alert' : 'status'} className="p-3 text-sm text-secondary">
          {i18nService.t(
            status === 'loading'
              ? 'collaborationHistoryLoading'
              : status === 'empty'
                ? receipt
                  ? 'collaborationReceiptUnavailable'
                  : 'collaborationHistoryEmpty'
                : receipt
                  ? 'collaborationMessageUnavailable'
                  : 'collaborationHistoryError',
          )}
        </p>
      )}
      {receipt && (status === 'error' || status === 'empty') && (
        <button
          type="button"
          className="mb-3 self-start text-sm text-primary"
          onClick={() => setReceiptRetry(value => value + 1)}
        >
          {i18nService.t('sessionDetailsRetry')}
        </button>
      )}
      <ChatMessageDisplay
        className="min-h-0 flex-1"
        controller={receipt ? null : controller}
        gatewayMessages={receipt ? receiptMessages : undefined}
        fullWidth
        assistantName={name}
        peerNames={peerNames}
        peerColors={peerColors}
        assistantId={member.agentId}
        peerPerspective
        workingDirectory={workingDirectory}
      />
    </div>
  );
}
