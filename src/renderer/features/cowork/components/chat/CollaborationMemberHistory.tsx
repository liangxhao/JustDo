import type { CollaborationRoom } from '@shared/cowork/collaboration';
import { useEffect, useState } from 'react';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import SessionSubtaskButton from '../subagents/SessionSubtaskButton';
import type { Subtask } from '../subagents/subtaskPresentation';
import ChatMessageDisplay from './ChatMessageDisplay';
import { connectToGateway } from './JustDoChatWrapper';

/** Independent read-only native history; never changes the main conversation. */
export default function CollaborationMemberHistory({
  member,
  anchorSessionId = member.sessionId,
  name,
  workingDirectory,
  receipt,
  peerNames,
  peerColors,
  onOpenSubtask,
}: {
  member: CollaborationRoom['members'][number];
  anchorSessionId?: string;
  name: string;
  workingDirectory: string;
  receipt?: { deliveryId: string; id: string };
  peerColors?: Readonly<Record<string, string>>;
  peerNames?: Readonly<Record<string, string>>;
  onOpenSubtask?: (task: Subtask, parentSessionId: string) => void;
}) {
  const receiptId = receipt?.id;
  const receiptDeliveryId = receipt?.deliveryId;
  const [controller, setController] = useState<ChatController | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [running, setRunning] = useState(false);
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
      setRunning(state.transcript.activeTurn !== null);
      const hasVisibleTranscript =
        state.chatMessages.length > 0 || state.transcript.activeTurn !== null;
      if (hasVisibleTranscript) setStatus('ready');
      else if (state.initialHistoryReady) setStatus(state.lastError ? 'error' : 'empty');
    };
    const unsubscribe = next.subscribe(syncState);
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
      next.disconnect();
    };
  }, [anchorSessionId, member.sessionKey, receiptDeliveryId, receiptId, receiptKey, receiptRetry]);
  return (
    <div className="flex h-full min-h-[300px] flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold">{name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-secondary">
            {i18nService.t(
              running && !receipt ? 'collaborationWorking' : 'collaborationHistoryReadOnly',
            )}
          </span>
          {!receipt && onOpenSubtask && (
            <SessionSubtaskButton
              key={member.sessionId}
              sessionId={member.sessionId}
              parentRunning={running}
              onOpenSubtask={onOpenSubtask}
            />
          )}
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
