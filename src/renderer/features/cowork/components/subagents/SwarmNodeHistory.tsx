import { useEffect, useState } from 'react';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';

import ChatMessageDisplay from '../chat/ChatMessageDisplay';
import { connectToGateway } from '../chat/JustDoChatWrapper';
import { startSubagentGatewayConnection } from './subagentGatewayConnection';

/** Reads the plugin-owned native session without copying transcripts into product state. */
export default function SwarmNodeHistory({
  sessionKey,
  workingDirectory,
  agentId,
  name,
}: {
  sessionKey: string;
  workingDirectory: string;
  agentId?: string;
  name: string;
}) {
  const [controller, setController] = useState<ChatController | null>(null);
  const [status, setStatus] = useState('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const next = new ChatController();
    next.state.sessionKey = sessionKey;
    setController(next);
    let deadline: ReturnType<typeof setTimeout>;
    const unsubscribe = next.subscribe(state => {
      if (state.chatMessages.length || state.transcript.activeTurn) setStatus('ready');
      else if (state.initialHistoryReady) setStatus(state.lastError ? 'error' : 'empty');
    });
    const disconnect = startSubagentGatewayConnection({
      controller: next,
      connect: connectToGateway,
      subscribeProgress: window.electron?.openclaw?.engine?.onProgress,
      onFailure: () => setStatus('error'),
      onConnecting: () => {
        setStatus(next.state.chatMessages.length ? 'ready' : 'loading');
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          if (
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
  }, [sessionKey, retry]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status !== 'ready' && (
        <p role="status" className="p-3 text-sm text-secondary">
          {i18nService.t('flowHistory_' + status)}
        </p>
      )}
      {status === 'error' && (
        <button
          className="self-start p-3 text-sm text-primary"
          onClick={() => setRetry(v => v + 1)}
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
