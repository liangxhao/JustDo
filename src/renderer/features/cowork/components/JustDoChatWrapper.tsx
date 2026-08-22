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
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import ChatMessageDisplay from '@/features/cowork/components/ChatMessageDisplay';
import {
  buildGoalRunProgress,
  type GoalRunProgress,
  goalRunProgressKey,
} from '@/features/cowork/components/goalRunProgress';
import { selectCurrentSession } from '@/features/cowork/coworkSelectors';
import type { CoworkAttachmentPayload, CoworkSession } from '@/features/cowork/coworkTypes';
import { coworkMessagesToGateway } from '@/libs/openclaw-chat/conversion/cowork-to-gateway';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

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
  runTimings?: SessionRunTiming[];
}

export interface JustDoChatWrapperRef {
  sendMessage: (
    text: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayMessage?: string,
    options?: {
      propagateRequestFailure?: boolean;
      clientTurnId?: string;
      onRunBound?: (runId: string) => void | Promise<void>;
    },
  ) => Promise<void>;
  getExportSnapshot: () => {
    messages: unknown[];
    runtimeSessionId: string | null;
    isLoading: boolean;
  };
  /** Set an optimistic user message shown until gateway history loads */
  setPendingUserMessage: (text: string, attachments?: CoworkAttachmentPayload[]) => void;
  /** Clear sending state (e.g. when session start fails) */
  clearSending: () => void;
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
      runTimings = [],
    },
    ref,
  ) => {
    const currentSession = useSelector(selectCurrentSession) as CoworkSession | null;
    const currentSessionId = currentSession?.id;
    const currentSessionAgentId = currentSession?.agentId;
    const currentSessionMessages = currentSession?.messages;
    const initialSessionRef = useRef(currentSession);
    const controllerRef = useRef<ChatController | null>(null);
    const [controller, setController] = useState<ChatController | null>(null);
    const connectedRef = useRef(false);
    const onActivityChangeRef = useRef(onActivityChange);
    const lastActivityKeyRef = useRef('');
    const [connectionError, setConnectionError] = useState<string | null>(null);
    // Buffer for pending user message when the controller is not yet created
    const pendingUserMessageRef = useRef<{
      text: string;
      attachments: CoworkAttachmentPayload[];
    } | null>(null);

    useEffect(() => {
      onActivityChangeRef.current = onActivityChange;
    }, [onActivityChange]);

    // Expose sendMessage and setPendingUserMessage to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        getExportSnapshot: () => {
          const controller = controllerRef.current;
          return {
            messages: controller ? [...controller.getLoadedMessages()] : [],
            runtimeSessionId: controller?.state.currentSessionId ?? null,
            isLoading: !controller?.state.connected || controller.state.chatLoading,
          };
        },
        sendMessage: async (text: string, attachments = [], gatewayMessage, options) => {
          const controller = controllerRef.current;
          if (!controller) throw new Error('Controller not initialized');
          await controller.sendMessage(text, attachments, gatewayMessage, options);
        },
        setPendingUserMessage: (text: string, attachments = []) => {
          const controller = controllerRef.current;
          // Always buffer the prompt — survives StrictMode remounts where the
          // controller is destroyed and recreated.
          pendingUserMessageRef.current = { text, attachments };
          if (controller) {
            debugLog('[JustDoChatWrapper] setPendingUserMessage (immediate):', text.slice(0, 60));
            controller.setPendingUserMessage(text, attachments);
          } else {
            debugLog(
              '[JustDoChatWrapper] setPendingUserMessage (buffered, no controller):',
              text.slice(0, 60),
            );
          }
        },
        clearSending: () => {
          controllerRef.current?.clearSending();
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
        const progress = buildGoalRunProgress(controller.state);
        const key = goalRunProgressKey(progress);
        if (key === lastActivityKeyRef.current) return;
        lastActivityKeyRef.current = key;
        onActivityChangeRef.current?.(progress);
      };
      const unsubscribeState = controller.subscribe(publishActivity);
      const unsubscribeStream = controller.onStream(publishActivity);

      // Apply any buffered pending user message (set before controller existed)
      if (pendingUserMessageRef.current) {
        debugLog('[JustDoChatWrapper] applying buffered pendingUserMessage on mount');
        controller.setPendingUserMessage(
          pendingUserMessageRef.current.text,
          pendingUserMessageRef.current.attachments,
        );
        pendingUserMessageRef.current = null;
      }

      // Set initial sessionKey from current session BEFORE connecting
      // (avoids race with the session-switch effect)
      const initialSession = initialSessionRef.current;
      if (initialSession) {
        const agentId = initialSession.agentId?.trim() || 'main';
        const sessionKey = `agent:${agentId}:justdo:${initialSession.id}`;
        controller.state.sessionKey = sessionKey;
        controller.admitFallbackHistory(
          sessionKey,
          coworkMessagesToGateway(initialSession.messages),
        );
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
        lastActivityKeyRef.current = '';
        onActivityChangeRef.current?.(null);
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

    // Synchronize the imperative controller before the browser paints the new
    // Redux session. A passive effect leaves one frame where the chat still
    // projects the previous/partial controller transcript; for a cold session
    // that can expose an assistant-only snapshot until Gateway history arrives.
    useLayoutEffect(() => {
      const controller = controllerRef.current;
      if (!controller || !currentSessionId || !currentSessionMessages) return;

      // Build the gateway session key (same format as openclawChannelSessionSync)
      const agentId = currentSessionAgentId?.trim() || 'main';
      const sessionKey = `agent:${agentId}:justdo:${currentSessionId}`;

      if (controller.state.sessionKey !== sessionKey) {
        controller.admitFallbackHistory(
          sessionKey,
          coworkMessagesToGateway(currentSessionMessages),
        );
      }

      if (connectedRef.current && controller.state.sessionKey !== sessionKey) {
        void controller.switchSession(sessionKey);
      } else if (!connectedRef.current && controller.state.sessionKey !== sessionKey) {
        // Not yet connected — set sessionKey so connect() picks it up
        controller.state.sessionKey = sessionKey;
        controller.admitFallbackHistory(
          sessionKey,
          coworkMessagesToGateway(currentSessionMessages),
        );
      } else if (controller.state.transcript.historySource !== 'gateway') {
        controller.admitFallbackHistory(
          sessionKey,
          coworkMessagesToGateway(currentSessionMessages),
        );
      }
    }, [currentSessionAgentId, currentSessionId, currentSessionMessages]);

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
      />
    );
  },
);

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
