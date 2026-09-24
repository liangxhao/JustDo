/**
 * JustDoChatWrapper — React component that manages the <justdo-chat> Lit element.
 *
 * Creates a ChatController that connects directly to the OpenClaw gateway
 * (same approach as the webchat). Passes the controller to the Lit element.
 *
 * This replaces the Redux → CoworkMessage → gateway conversion approach
 * with a direct gateway connection, identical to OpenClaw's webchat.
 */
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import type { ProgressCardViewState } from '@shared/openclaw/progressCard';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import {
  buildGoalRunProgress,
  type GoalRunProgress,
  goalRunProgressKey,
} from '@/features/cowork/components/goals/goalRunProgress';
import { selectCurrentSession } from '@/features/cowork/coworkSelectors';
import type { CoworkAttachmentPayload, CoworkSession } from '@/features/cowork/coworkTypes';
import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import {
  type ChatContextUsageSnapshot,
  ChatController,
  type RewindEditorDraft,
  type SideChatResult,
  type SideChatStreamUpdate,
} from '@/libs/openclaw-chat/gateway/chat-controller';
import type { UserMessageHistoryAction } from '@/libs/openclaw-chat/types';

const DEBUG_CHAT_WRAPPER =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_CHAT_WRAPPER === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_CHAT_WRAPPER) {
    console.debug(...args);
  }
}

interface JustDoChatWrapperProps {
  className?: string;
  assistantName?: string;
  workingDirectory?: string;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  searchNavigationToken?: number;
  searchNavigationDirection?: 1 | -1;
  processSummariesExpanded?: boolean;
  onSearchMatchCountChange?: (total: number, index: number) => void;
  onActivityChange?: (progress: GoalRunProgress | null) => void;
  onContextUsageChange?: (usage: ChatContextUsageSnapshot | null) => void;
  onProgressCardChange?: (state: ProgressCardViewState | null) => void;
  onSessionKeyChange?: (sessionKey: string) => void;
  runTimings?: SessionRunTiming[];
  onLastUserMessageAction?: (
    action: UserMessageHistoryAction,
    entryId: string,
    editedText?: string,
  ) => boolean | Promise<boolean>;
  onAssistantMessageFork?: (entryId: string) => boolean | Promise<boolean>;
  onSideChatResult?: (result: SideChatResult) => void;
  onSideChatStream?: (update: SideChatStreamUpdate) => void;
}

export interface JustDoChatWrapperRef {
  sendMessage: (
    text: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayMessage?: string,
    options?: {
      propagateRequestFailure?: boolean;
      expectedSessionKey?: string;
      isCancelled?: () => boolean;
      onRequestUnknown?: (runId: string) => void | Promise<void>;
      clientTurnId?: string;
      onRunBound?: (runId: string) => void | Promise<void>;
    },
  ) => Promise<void>;
  getExportSnapshot: () => {
    messages: unknown[];
    runtimeSessionId: string | null;
    sessionKey: string | null;
    isLoading: boolean;
  };
  preparePlanImplementationReset: (request: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }) => void;
  cancelPlanImplementationReset: (requestId: string) => void;
  /** Set an optimistic user message shown until gateway history loads */
  setPendingUserMessage: (
    text: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayMessage?: string,
  ) => void;
  /** Register the exact temporary/canonical pair created for a new session. */
  registerSessionPromotion: (sourceSessionKey: string, targetSessionKey: string) => void;
  /** Clear sending state (e.g. when session start fails) */
  cancelManualCompaction: (sessionKey: string) => Promise<void>;
  settleConfirmedRun: (
    sessionKey: string,
    runId: string,
    state: 'completed' | 'failed' | 'aborted',
  ) => void;
  getSendingRunId: () => string | null;
  clearSending: (expectedSessionKey?: string, expectedRunId?: string | null) => void;
  /** Adopt an accepted Goal resume before its first stream event arrives. */
  beginGoalResume: (sessionKey: string, runId: string) => void;
  /** Clear the current card only if its completed revision is still current. */
  dismissProgressCard: () => Promise<boolean>;
  refreshProgressCard: () => Promise<boolean>;
  rewindToUserMessage: (entryId: string) => Promise<RewindEditorDraft>;
  revealMessage: (entryId: string) => Promise<boolean>;
  sendSideQuestion: (question: string, runId: string) => Promise<string>;
}

const JustDoChatWrapper = forwardRef<JustDoChatWrapperRef, JustDoChatWrapperProps>(
  (
    {
      className,
      assistantName,
      workingDirectory,
      searchQuery,
      searchCaseSensitive,
      searchNavigationToken,
      searchNavigationDirection,
      processSummariesExpanded,
      onSearchMatchCountChange,
      onActivityChange,
      onContextUsageChange,
      onProgressCardChange,
      onSessionKeyChange,
      onLastUserMessageAction,
      onAssistantMessageFork,
      onSideChatResult,
      onSideChatStream,
      runTimings = [],
    },
    ref,
  ) => {
    const currentSession = useSelector(selectCurrentSession) as CoworkSession | null;
    const currentSessionId = currentSession?.id;
    const currentSessionAgentId = currentSession?.agentId;
    const canonicalSessionKey = currentSessionId
      ? currentSession.external?.sessionKey ||
        `agent:${currentSessionAgentId?.trim() || 'main'}:justdo:${currentSessionId}`
      : null;
    const externalSessionRefreshRevision = currentSession?.external
      ? `${currentSession.external.status}:${currentSession.updatedAt}`
      : '';
    const initialSessionRef = useRef(currentSession);
    const controllerRef = useRef<ChatController | null>(null);
    const chatElementRef = useRef<JustDoChatElement | null>(null);
    const handleChatElementChange = useCallback((element: JustDoChatElement | null) => {
      chatElementRef.current = element;
    }, []);
    const [controller, setController] = useState<ChatController | null>(null);
    const connectedRef = useRef(false);
    const onActivityChangeRef = useRef(onActivityChange);
    const onContextUsageChangeRef = useRef(onContextUsageChange);
    const onProgressCardChangeRef = useRef(onProgressCardChange);
    const onSessionKeyChangeRef = useRef(onSessionKeyChange);
    const onSideChatResultRef = useRef(onSideChatResult);
    const onSideChatStreamRef = useRef(onSideChatStream);
    const lastActivityKeyRef = useRef('');
    const lastContextUsageKeyRef = useRef('');
    const lastProgressCardKeyRef = useRef('');
    const [connectionError, setConnectionError] = useState<string | null>(null);
    // Buffer for pending user message when the controller is not yet created
    const pendingUserMessageRef = useRef<{
      text: string;
      attachments: CoworkAttachmentPayload[];
      gatewayMessage?: string;
    } | null>(null);
    const promotionSourceByTargetRef = useRef(new Map<string, string>());
    const lastReportedSessionKeyRef = useRef('');

    onSideChatResultRef.current = onSideChatResult;
    onSideChatStreamRef.current = onSideChatStream;

    useEffect(() => {
      onActivityChangeRef.current = onActivityChange;
    }, [onActivityChange]);

    useEffect(() => {
      onContextUsageChangeRef.current = onContextUsageChange;
    }, [onContextUsageChange]);

    useEffect(() => {
      onProgressCardChangeRef.current = onProgressCardChange;
    }, [onProgressCardChange]);

    useEffect(() => {
      onSessionKeyChangeRef.current = onSessionKeyChange;
    }, [onSessionKeyChange]);

    // Expose sendMessage and setPendingUserMessage to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        getExportSnapshot: () => {
          const controller = controllerRef.current;
          return {
            messages: controller ? [...controller.getLoadedMessages()] : [],
            runtimeSessionId: controller?.state.currentSessionId ?? null,
            sessionKey: controller?.state.sessionKey ?? null,
            isLoading: !controller?.state.connected || controller.state.chatLoading,
          };
        },
        preparePlanImplementationReset: request => {
          controllerRef.current?.preparePlanImplementationReset(request);
        },
        cancelPlanImplementationReset: requestId => {
          controllerRef.current?.cancelPlanImplementationReset(requestId);
        },
        sendMessage: async (text: string, attachments = [], gatewayMessage, options) => {
          const controller = controllerRef.current;
          if (!controller) throw new Error('Controller not initialized');
          await controller.sendMessage(text, attachments, gatewayMessage, options);
        },
        setPendingUserMessage: (text: string, attachments = [], gatewayMessage) => {
          const controller = controllerRef.current;
          // Always buffer the prompt — survives StrictMode remounts where the
          // controller is destroyed and recreated.
          pendingUserMessageRef.current = { text, attachments, gatewayMessage };
          if (controller) {
            debugLog('[JustDoChatWrapper] setPendingUserMessage (immediate):', text.slice(0, 60));
            controller.setPendingUserMessage(text, attachments, gatewayMessage);
          } else {
            debugLog(
              '[JustDoChatWrapper] setPendingUserMessage (buffered, no controller):',
              text.slice(0, 60),
            );
          }
        },
        registerSessionPromotion: (sourceSessionKey: string, targetSessionKey: string) => {
          promotionSourceByTargetRef.current.set(targetSessionKey, sourceSessionKey);
        },
        cancelManualCompaction: async sessionKey => {
          await controllerRef.current?.cancelManualCompaction(sessionKey);
        },
        settleConfirmedRun: (sessionKey, runId, state) => {
          controllerRef.current?.settleConfirmedRun(sessionKey, runId, state);
        },
        getSendingRunId: () => {
          const state = controllerRef.current?.state;
          return (
            state?.chatRunId ??
            (state?.transcript.activeTurn?.status === 'running'
              ? state.transcript.activeTurn.runId
              : null)
          );
        },
        clearSending: (expectedSessionKey, expectedRunId) => {
          controllerRef.current?.clearSending(expectedSessionKey, expectedRunId);
        },
        beginGoalResume: (sessionKey: string, runId: string) => {
          controllerRef.current?.beginGoalResume(sessionKey, runId);
        },
        refreshProgressCard: async () => controllerRef.current?.refreshProgressCard() ?? false,
        dismissProgressCard: async () => controllerRef.current?.dismissProgressCard() ?? false,
        rewindToUserMessage: async entryId => {
          const controller = controllerRef.current;
          if (!controller) throw new Error('Controller not initialized');
          return controller.rewindToUserMessage(entryId);
        },
        revealMessage: async entryId => {
          const normalizedEntryId = entryId.trim();
          const controller = controllerRef.current;
          if (!normalizedEntryId || !controller) return false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const chat = chatElementRef.current;
            if (chat) {
              await chat.updateComplete;
              if (chat.revealMessage(normalizedEntryId)) return true;
            }
            if (!controller.state.chatLoading && !controller.state.historyLoadingOlder) {
              const advanced = await controller.showOlderHistory();
              const entryLoaded = hasEntryId(controller.getLoadedMessages(), normalizedEntryId);
              if (!advanced && !controller.state.historyHasMore && !entryLoaded) return false;
            }
            await new Promise<void>(resolve => window.setTimeout(resolve, 25));
          }
          return false;
        },
        sendSideQuestion: async (question, runId) => {
          const controller = controllerRef.current;
          if (!controller) throw new Error('Controller not initialized');
          return controller.sendSideQuestion(question, runId);
        },
      }),
      [],
    );

    // Create the Lit element and controller on mount
    useEffect(() => {
      const controller = new ChatController();
      controllerRef.current = controller;
      setController(controller);

      const publishActivity = () => {
        if (controller.state.sessionKey !== lastReportedSessionKeyRef.current) {
          lastReportedSessionKeyRef.current = controller.state.sessionKey;
          onSessionKeyChangeRef.current?.(controller.state.sessionKey);
        }
        const progress = buildGoalRunProgress(controller.state);
        const key = goalRunProgressKey(progress);
        if (key !== lastActivityKeyRef.current) {
          lastActivityKeyRef.current = key;
          onActivityChangeRef.current?.(progress);
        }
        const usage = controller.state.contextUsage;
        const contextKey = usage
          ? [
              usage.sessionKey,
              usage.sessionId ?? '',
              usage.totalTokens,
              usage.contextTokens ?? '',
              usage.totalTokensFresh,
              usage.updatedAt ?? '',
              usage.modelRef ?? '',
            ].join(':')
          : '';
        if (contextKey !== lastContextUsageKeyRef.current) {
          lastContextUsageKeyRef.current = contextKey;
          onContextUsageChangeRef.current?.(usage);
        }
        const progressCardKey = [
          controller.state.sessionKey,
          controller.state.progressCard?.revision ?? 'none',
          controller.state.progressCardLoading,
          controller.state.progressCardAvailable,
          controller.state.progressCardError ?? '',
        ].join(':');
        if (progressCardKey !== lastProgressCardKeyRef.current) {
          lastProgressCardKeyRef.current = progressCardKey;
          onProgressCardChangeRef.current?.({
            sessionKey: controller.state.sessionKey,
            card: controller.state.progressCard,
            loading: controller.state.progressCardLoading,
            available: controller.state.progressCardAvailable,
            error: controller.state.progressCardError,
          });
        }
      };
      const unsubscribeState = controller.subscribe(publishActivity);
      const unsubscribeStream = controller.onStream(publishActivity);
      const unsubscribeSideChat = controller.onSideChatResult(result =>
        onSideChatResultRef.current?.(result),
      );
      const unsubscribeSideChatStream = controller.onSideChatStream(update =>
        onSideChatStreamRef.current?.(update),
      );

      // Apply any buffered pending user message (set before controller existed)
      if (pendingUserMessageRef.current) {
        debugLog('[JustDoChatWrapper] applying buffered pendingUserMessage on mount');
        controller.setPendingUserMessage(
          pendingUserMessageRef.current.text,
          pendingUserMessageRef.current.attachments,
          pendingUserMessageRef.current.gatewayMessage,
        );
        pendingUserMessageRef.current = null;
      }

      // Set initial sessionKey from current session BEFORE connecting
      // (avoids race with the session-switch effect)
      const initialSession = initialSessionRef.current;
      if (initialSession) {
        const agentId = initialSession.agentId?.trim() || 'main';
        const sessionKey =
          initialSession.external?.sessionKey || `agent:${agentId}:justdo:${initialSession.id}`;
        controller.state.sessionKey = sessionKey;
      }

      // Cancellation flag: React StrictMode double-fires mount effects.
      // If the cleanup runs before connectToGateway resolves, we must
      // disconnect the zombie controller that would otherwise survive.
      let cancelled = false;

      // Connect to gateway with proper error state tracking
      connectToGateway(controller)
        .then(success => {
          if (cancelled) {
            debugLog(
              '[JustDoChatWrapper] connectToGateway resolved after cleanup — disconnecting zombie',
            );
            controller.disconnect();
            return;
          }
          if (success) {
            connectedRef.current = true;
            setConnectionError(null);
          } else {
            setConnectionError('Failed to connect to OpenClaw gateway');
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setConnectionError(err instanceof Error ? err.message : 'Unknown connection error');
        });

      return () => {
        cancelled = true;
        unsubscribeState();
        unsubscribeStream();
        unsubscribeSideChat();
        unsubscribeSideChatStream();
        lastActivityKeyRef.current = '';
        lastContextUsageKeyRef.current = '';
        lastProgressCardKeyRef.current = '';
        lastReportedSessionKeyRef.current = '';
        onActivityChangeRef.current?.(null);
        onContextUsageChangeRef.current?.(null);
        onProgressCardChangeRef.current?.(null);
        debugLog('[JustDoChatWrapper] cleanup — disconnecting controller');
        try {
          controller.disconnect();
        } catch {
          // Cleanup errors are non-fatal
        }
        controllerRef.current = null;
        setController(null);
        connectedRef.current = false;
      };
    }, []);

    useEffect(() => {
      const controller = controllerRef.current;
      if (
        !controller ||
        !connectedRef.current ||
        !canonicalSessionKey ||
        !externalSessionRefreshRevision ||
        controller.state.sessionKey !== canonicalSessionKey
      ) {
        return;
      }
      void controller.loadHistory(true);
    }, [canonicalSessionKey, externalSessionRefreshRevision]);

    // Synchronize the imperative controller before the browser paints the new
    // Redux session. A passive effect leaves one frame where the chat still
    // projects the previous/partial controller transcript; for a cold session
    // that can expose an assistant-only snapshot until Gateway history arrives.
    useLayoutEffect(() => {
      const controller = controllerRef.current;
      if (!controller || !currentSessionId) return;

      // Build the gateway session key (same format as the main-process session-key helpers).
      const sessionKey = canonicalSessionKey;
      if (!sessionKey) return;

      if (connectedRef.current && controller.state.sessionKey !== sessionKey) {
        const promoteFromSessionKey = promotionSourceByTargetRef.current.get(sessionKey);
        promotionSourceByTargetRef.current.delete(sessionKey);
        void controller.switchSession(sessionKey, { promoteFromSessionKey });
      } else if (!connectedRef.current && controller.state.sessionKey !== sessionKey) {
        const promoteFromSessionKey = promotionSourceByTargetRef.current.get(sessionKey);
        if (promoteFromSessionKey) {
          promotionSourceByTargetRef.current.delete(sessionKey);
          void controller.switchSession(sessionKey, { promoteFromSessionKey });
        } else {
          // Not yet connected — set sessionKey so connect() picks it up.
          controller.state.sessionKey = sessionKey;
        }
      }
    }, [canonicalSessionKey, currentSessionId]);

    if (connectionError) {
      return (
        <div
          className={`${className ?? ''} flex items-center justify-center`}
          style={{ flex: 1, minHeight: 0 }}
        >
          <div className="text-center space-y-3">
            <div className="text-red-500 text-sm">{connectionError}</div>
            <button
              type="button"
              onClick={() => {
                setConnectionError(null);
                const controller = controllerRef.current;
                if (controller) {
                  connectToGateway(controller)
                    .then(success => {
                      if (success) connectedRef.current = true;
                      else setConnectionError('Retry failed');
                    })
                    .catch(() => setConnectionError('Retry failed'));
                }
              }}
              className="px-3 py-1.5 text-xs rounded bg-surface-raised hover:bg-surface-raised/80 transition-colors"
            >
              Retry Connection
            </button>
          </div>
        </div>
      );
    }

    return (
      <ChatMessageDisplay
        className={className}
        controller={controller}
        assistantName={assistantName}
        workingDirectory={workingDirectory}
        searchQuery={searchQuery}
        searchCaseSensitive={searchCaseSensitive}
        searchNavigationToken={searchNavigationToken}
        searchNavigationDirection={searchNavigationDirection}
        processSummariesExpanded={processSummariesExpanded}
        onSearchMatchCountChange={onSearchMatchCountChange}
        runTimings={runTimings}
        onLastUserMessageAction={onLastUserMessageAction}
        onAssistantMessageFork={onAssistantMessageFork}
        onChatElementChange={handleChatElementChange}
      />
    );
  },
);

function hasEntryId(messages: readonly unknown[], entryId: string): boolean {
  return messages.some(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    const metadata = record.__openclaw;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
    return (metadata as Record<string, unknown>).id === entryId;
  });
}

// ─── Gateway Connection ─────────────────────────────────────────────────────

/** Typed access to the Electron preload bridge for OpenClaw engine info. */
interface OpenClawEngineBridge {
  getPort: () => Promise<{ success: boolean; port?: number }>;
  getToken: () => Promise<{ success: boolean; token?: string }>;
}

function getEngineBridge(): OpenClawEngineBridge | undefined {
  const electron = (window as unknown as Record<string, unknown>).electron as
    Record<string, unknown> | undefined;
  const openclaw = electron?.openclaw as Record<string, unknown> | undefined;
  return openclaw?.engine as OpenClawEngineBridge | undefined;
}

export async function connectToGateway(controller: ChatController): Promise<boolean> {
  const engine = getEngineBridge();
  if (!engine) {
    console.error('[JustDoChatWrapper] openclaw.engine API not available');
    return false;
  }

  const portResult = await engine.getPort();
  const tokenResult = await engine.getToken();

  if (!portResult?.success || !portResult.port) {
    console.error('[JustDoChatWrapper] Gateway port not available:', portResult);
    return false;
  }

  const url = `ws://127.0.0.1:${portResult.port}`;
  const token = tokenResult?.success ? tokenResult.token : undefined;

  // Use sessionKey already set on the controller (set by session-switch effect)
  const sessionKey = controller.state.sessionKey || 'agent:main:justdo:default';

  await controller.connect(url, token ?? '', sessionKey);
  return true;
}

export default JustDoChatWrapper;
