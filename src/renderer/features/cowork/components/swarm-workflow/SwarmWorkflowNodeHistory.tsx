import { useEffect, useState } from 'react';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';

import ChatMessageDisplay from '../chat/ChatMessageDisplay';
import { connectToGateway } from '../chat/JustDoChatWrapper';
import { startSubagentGatewayConnection } from '../shared/subagentGatewayConnection';

/** Reads the plugin-owned native session without copying transcripts into product state. */
export default function SwarmWorkflowNodeHistory({
  sessionKey,
  workingDirectory,
  agentId,
  name,
  active = true,
}: {
  sessionKey: string;
  workingDirectory: string;
  agentId?: string;
  name: string;
  active?: boolean;
}) {
  const [controller, setController] = useState<ChatController | null>(null);
  const [status, setStatus] = useState('loading');
  const [preparationTimedOut, setPreparationTimedOut] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    const next = new ChatController();
    next.state.sessionKey = sessionKey;
    setController(next);
    setStatus('loading');
    setPreparationTimedOut(false);
    let deadline: ReturnType<typeof setTimeout>;
    const unsubscribe = next.subscribe(state => {
      setPreparationTimedOut(state.historyPreparationTimedOut === true);
      if (state.historyPreparationPending) setStatus('preparing');
      else if (state.historyReadFailed) setStatus(state.chatLoading ? 'loading' : 'error');
      else if (state.chatMessages.length || state.transcript.activeTurn) setStatus('ready');
      else if (state.initialHistoryReady) setStatus(state.lastError ? 'error' : 'empty');
    });
    const disconnect = startSubagentGatewayConnection({
      controller: next,
      connect: connectToGateway,
      subscribeProgress: window.electron?.openclaw?.engine?.onProgress,
      onFailure: () => setStatus('error'),
      onConnecting: () => {
        setStatus(next.state.historyPreparationPending ? 'preparing' : next.state.chatMessages.length ? 'ready' : 'loading');
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          if (
            !next.state.historyPreparationPending &&
            !next.state.initialHistoryReady &&
            !next.state.chatMessages.length &&
            !next.state.transcript.activeTurn
          )
            setStatus('error');
        }, 15000);
      },
    });
    return () => {
      clearTimeout(deadline);
      unsubscribe();
      disconnect();
    };
  }, [sessionKey, retry, active]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status !== 'ready' && (
        <p role="status" className="p-3 text-sm text-secondary">
          {i18nService.t(status === 'preparing' ? 'storageHistoryPreparing' : preparationTimedOut
            ? 'storageHistoryPreparationPending' : 'swarmWorkflowHistory_' + status)}
        </p>
      )}
      {status === 'error' && (
        <button
          className="self-start p-3 text-sm text-primary"
          onClick={() => {
            if (preparationTimedOut) {
              if (controller?.state.sessionKey === sessionKey) void controller.loadHistory(true);
            } else setRetry(v => v + 1);
          }}
        >
          {i18nService.t('sessionDetailsRetry')}
        </button>
      )}
      <ChatMessageDisplay
        className="min-h-0 flex-1"
        controller={controller}
        fullWidth
        peerPerspective
        assistantName={name}
        assistantId={agentId}
        workingDirectory={workingDirectory}
      />
    </div>
  );
}
