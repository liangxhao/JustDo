import { useEffect, useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import type { AppNativeHistoryState } from '../../../../../../packages/app-plugin-sdk/browser';
import { resolveAgentModelSelection } from '../composer/selection/agentModelSelection';
import { startSubagentGatewayConnection } from '../shared/subagentGatewayConnection';
import SessionSubtaskButton from '../subagents/SessionSubtaskButton';
import type { Subtask } from '../subagents/subtaskPresentation';
import ChatMessageDisplay from './ChatMessageDisplay';
import { connectToGateway } from './JustDoChatWrapper';
import { sendNativeHistoryMessage } from './nativeHistorySend';
type NativeState = AppNativeHistoryState;

/** Reads the plugin-owned native session without copying transcripts into product state. */
export default function NativeSessionHistory({
  sessionKey,
  workingDirectory,
  agentId,
  name,
  labels,
  onState,
  messages,
  receiptLoading,
  receiptError,
  onRetry,
  peerColors,
  peerNames,
  onOpenSubtask,
  productSessionId,
  assertCurrent,
  active = true,
  observeSession = false,
  showSubtaskAction = true,
  errorRole = 'status',
}: {
  sessionKey: string;
  workingDirectory: string;
  agentId?: string;
  name: string;
  labels: Record<string, string>;
  messages?: GatewayMessage[];
  receiptLoading?: boolean;
  receiptError?: boolean;
  onRetry?(): void;
  peerColors?: Readonly<Record<string, string>>;
  peerNames?: Readonly<Record<string, string>>;
  onOpenSubtask?: (task: Subtask) => void;
  productSessionId?: string;
  assertCurrent?(): void;
  active?: boolean;
  observeSession?: boolean;
  showSubtaskAction?: boolean;
  errorRole?: 'status' | 'alert';
  onState?: (state: NativeState & { readCurrent?(): NativeState | undefined }) => void;
}) {
  const [controller, setController] = useState<ChatController | null>(null);
  const [status, setStatus] = useState('loading');
  const [preparationTimedOut, setPreparationTimedOut] = useState(false);
  const [retry, setRetry] = useState(0);
  const [running, setRunning] = useState(false);
  const observe = useRef(onState);
  observe.current = onState;
  const receiptHistory = messages !== undefined;
  useEffect(() => {
    if ((receiptHistory && !observeSession) || !active) return;
    setStatus('loading');
    setPreparationTimedOut(false);
    setRunning(false);
    observe.current?.({ connected: false, sessionKey, running: false });
    const next = new ChatController();
    next.state.sessionKey = sessionKey;
    setController(next);
    let deadline: ReturnType<typeof setTimeout>;
    let disposed = false;
    const readCurrent = (): NativeState | undefined => {
      if (disposed) return undefined;
      const state = next.state;
      const turn = state.transcript.activeTurn;
      const client = state.client;
      const hello = state.hello;
      const nativeSessionId = state.currentSessionId;
      const assertMounted = () => {
        assertCurrent?.();
        if (
          disposed ||
          next.state.client !== client ||
          next.state.hello !== hello ||
          next.state.currentSessionId !== nativeSessionId ||
          next.state.sessionKey !== sessionKey
        )
          throw new Error('appPluginSubmitUnavailable');
      };
      return {
        connected: state.connected,
        sessionKey: state.sessionKey,
        nativeSessionId: turn?.sessionId ?? state.currentSessionId ?? undefined,
        runId: turn?.runId,
        running: turn?.status === 'running',
        ready:
          state.connected &&
          state.initialHistoryReady &&
          !state.historyPreparationPending &&
          !state.historyReadFailed &&
          !state.chatSending &&
          turn?.status !== 'running' &&
          !next.hasUnconfirmedQueuedInput(),
        supportsImages: () => {
          assertMounted();
          const metadata = store.getState();
          return (
            resolveAgentModelSelection({
              agentId: agentId ?? '',
              agentModel: metadata.agent.agents.find(agent => agent.id === agentId)?.model ?? '',
              sessionModel: next.state.contextUsage?.modelRef ?? undefined,
              availableModels: metadata.model.availableModels,
              fallbackModel: metadata.model.selectedModel,
            }).selectedModel?.supportsImage === true
          );
        },
        ...(productSessionId
          ? {
              send: (input: Parameters<NonNullable<NativeState['send']>>[0]) =>
                sendNativeHistoryMessage(
                  next,
                  { productSessionId, sessionKey },
                  input.message,
                  input.images,
                  input.clientTurnId,
                  () => {
                    assertMounted();
                    input.assertCurrent();
                  },
                  input.beforeSend,
                  coworkService,
                ),
            }
          : {}),
        canStop:
          state.connected &&
          turn?.status === 'running' &&
          turn.sessionKey === state.sessionKey &&
          !!turn.runId &&
          !!(turn.sessionId ?? state.currentSessionId),
      };
    };
    const update = () => {
      if (disposed) return;
      const state = next.state;
      const turn = state.transcript.activeTurn;
      setRunning(turn?.status === 'running' && turn.sessionKey === state.sessionKey);
      observe.current?.({ ...readCurrent()!, readCurrent });
      if (!receiptHistory) setPreparationTimedOut(state.historyPreparationTimedOut === true);
      if (state.historyPreparationPending) setStatus('preparing');
      else if (state.historyReadFailed) setStatus(state.chatLoading ? 'loading' : 'error');
      else if (state.chatMessages.length || state.transcript.activeTurn) setStatus('ready');
      else if (state.initialHistoryReady) setStatus(state.lastError ? 'error' : 'empty');
    };
    const unsubscribe = next.subscribe(update);
    const unsubscribeStream = next.onStream(update);
    const disconnect = startSubagentGatewayConnection({
      controller: next,
      connect: connectToGateway,
      subscribeProgress: window.electron?.openclaw?.engine?.onProgress,
      onFailure: () => setStatus('error'),
      onConnecting: () => {
        setStatus(
          next.state.historyPreparationPending
            ? 'preparing'
            : next.state.chatMessages.length
              ? 'ready'
              : 'loading',
        );
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
      disposed = true;
      clearTimeout(deadline);
      unsubscribe();
      unsubscribeStream();
      disconnect();
    };
  }, [
    sessionKey,
    retry,
    receiptHistory,
    observeSession,
    productSessionId,
    agentId,
    assertCurrent,
    active,
  ]);
  const presentation =
    messages === undefined
      ? status
      : receiptLoading
        ? 'loading'
        : receiptError
          ? 'error'
          : messages.length
            ? 'ready'
            : 'empty';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {presentation !== 'ready' && (
        <p
          role={presentation === 'error' ? errorRole : 'status'}
          className="p-3 text-sm text-secondary"
        >
          {presentation === 'preparing'
            ? i18nService.t('storageHistoryPreparing')
            : preparationTimedOut
              ? i18nService.t('storageHistoryPreparationPending')
              : (labels[presentation] ?? presentation)}
        </p>
      )}
      {(presentation === 'error' || preparationTimedOut || (presentation === 'empty' && onRetry)) &&
        (messages === undefined || onRetry) && (
          <button
            className="self-start p-3 text-sm text-primary"
            onClick={() => {
              if (preparationTimedOut && messages === undefined) {
                if (controller?.state.sessionKey === sessionKey) void controller.loadHistory(true);
              } else if (messages === undefined) setRetry(v => v + 1);
              else onRetry?.();
            }}
          >
            {labels.retry}
          </button>
        )}
      {showSubtaskAction && onOpenSubtask && productSessionId && messages === undefined && (
        <SessionSubtaskButton
          sessionId={productSessionId}
          parentRunning={running}
          onOpenSubtask={task => onOpenSubtask(task)}
        />
      )}
      <ChatMessageDisplay
        className="min-h-0 flex-1"
        controller={
          messages === undefined && controller?.state.sessionKey === sessionKey ? controller : null
        }
        gatewayMessages={messages}
        fullWidth
        peerPerspective
        assistantName={name}
        assistantId={agentId}
        workingDirectory={workingDirectory}
        peerColors={peerColors}
        peerNames={peerNames}
      />
    </div>
  );
}
