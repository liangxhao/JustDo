import { ChatBubbleLeftEllipsisIcon } from '@heroicons/react/24/outline';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { useEffect, useMemo, useRef } from 'react';

import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import CoworkPromptInput, {
  type CoworkPromptInputRef,
} from '@/features/cowork/components/composer/CoworkPromptInput';
import type { AssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

export interface SideChatMessage {
  runId: string;
  question: string;
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  activeTurn?: AssistantTurn;
  modelRef?: string;
  startedAt?: number;
  status: 'pending' | 'complete' | 'error';
}

interface SideChatPanelProps {
  assistantName?: string;
  disabled?: boolean;
  draftKey: string;
  isObscured?: boolean;
  messages: SideChatMessage[];
  modelAgentId?: string;
  onSubmit: (question: string) => boolean | Promise<boolean>;
  sessionId: string;
  sessionModelRef?: string;
  workingDirectory?: string;
}

const SideChatPanel = ({
  assistantName,
  disabled = false,
  draftKey,
  isObscured = false,
  messages,
  modelAgentId,
  onSubmit,
  sessionId,
  sessionModelRef,
  workingDirectory,
}: SideChatPanelProps) => {
  const ownerWindow = useOwnerWindow();
  const inputRef = useRef<CoworkPromptInputRef>(null);
  const panelRef = useRef<HTMLElement>(null);
  const pending = messages.some(message => message.status === 'pending');
  const pendingMessage = messages.find(message => message.status === 'pending');
  const activeTurn = useMemo(() => {
    const turn = pendingMessage?.activeTurn;
    if (!turn) return null;
    const modelRef = turn.modelRef ?? pendingMessage.modelRef;
    return modelRef === turn.modelRef ? turn : { ...turn, modelRef };
  }, [pendingMessage]);
  const gatewayMessages = useMemo<GatewayMessage[]>(
    () =>
      messages.flatMap(message => {
        const userMessage: GatewayMessage = {
          id: `${message.runId}:user`,
          role: 'user',
          content: message.question,
          timestamp: message.askedAt,
          __openclaw: { runId: message.runId },
        };
        if (message.status === 'pending') return [userMessage];
        const assistantMessage: GatewayMessage = {
          id: `${message.runId}:assistant`,
          role: 'assistant',
          content: message.answer ?? '',
          timestamp: message.answeredAt ?? message.askedAt,
          ...(message.modelRef ? { modelName: message.modelRef } : {}),
          __openclaw: { runId: message.runId },
        };
        return [userMessage, assistantMessage];
      }),
    [messages],
  );
  const runTimings = useMemo<SessionRunTiming[]>(
    () =>
      messages.flatMap(message => {
        if (message.status === 'pending' || message.answeredAt === undefined) return [];
        return [
          {
            id: `side-chat:${message.runId}`,
            sessionId,
            clientTurnId: message.runId,
            rootRunId: message.runId,
            ...(message.modelRef ? { modelRef: message.modelRef } : {}),
            startedAt: message.startedAt ?? message.askedAt,
            endedAt: message.answeredAt,
            state: message.status === 'complete' ? 'completed' : 'failed',
          },
        ];
      }),
    [messages, sessionId],
  );

  useEffect(() => {
    if (panelRef.current) {
      (panelRef.current as HTMLElement & { inert: boolean }).inert = isObscured;
    }
    if (isObscured || pending) return;
    const frameId = ownerWindow.requestAnimationFrame(() => inputRef.current?.focus());
    return () => ownerWindow.cancelAnimationFrame(frameId);
  }, [isObscured, pending, ownerWindow]);

  return (
    <section
      ref={panelRef}
      className={`absolute inset-0 flex min-h-0 flex-col bg-background ${
        isObscured ? 'invisible pointer-events-none' : ''
      }`}
      aria-label={i18nService.t('sideChatTitle')}
      aria-hidden={isObscured || undefined}
    >
      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center">
          <ChatBubbleLeftEllipsisIcon className="mb-3 h-8 w-8 text-muted" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">
            {i18nService.t('sideChatTitle')}
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-secondary">
            {i18nService.t('sideChatDescription')}
          </p>
        </div>
      ) : (
        <ChatMessageDisplay
          className="min-h-0 flex-1"
          gatewayMessages={gatewayMessages}
          isStreaming={pending}
          activeTurn={activeTurn}
          assistantName={assistantName}
          runTimings={runTimings}
          workingDirectory={workingDirectory}
        />
      )}
      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="mx-auto w-full max-w-2xl rounded-2xl shadow-glow-accent">
          <CoworkPromptInput
            ref={inputRef}
            onSubmit={async prompt => onSubmit(prompt)}
            disabled={disabled || pending}
            placeholder={i18nService.t('sideChatPlaceholder')}
            size="large"
            showModelSelector={true}
            sessionId={sessionId}
            workingDirectory={workingDirectory}
            draftKeyOverride={draftKey}
            modelAgentId={modelAgentId}
            sessionModelRef={sessionModelRef}
            mode="side-chat"
          />
        </div>
        <p className="mt-1.5 px-1 text-center text-[11px] font-light leading-4 text-muted">
          {i18nService.t('aiGeneratedDisclaimer')}
        </p>
      </div>
    </section>
  );
};

export default SideChatPanel;
