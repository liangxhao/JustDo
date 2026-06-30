/**
 * JustDoChatWrapper — React component that manages the <justdo-chat> Lit element.
 *
 * Creates a ChatController that connects directly to the OpenClaw gateway
 * (same approach as the webchat). Passes the controller to the Lit element.
 *
 * This replaces the Redux → CoworkMessage → gateway conversion approach
 * with a direct gateway connection, identical to OpenClaw's webchat.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { ChatController } from '../../libs/openclaw-chat/gateway/chat-controller';
import { selectCurrentSession } from '../../store/selectors/coworkSelectors';
import type { CoworkSession } from '../../types/cowork';
import ChatMessageDisplay from './ChatMessageDisplay';

interface JustDoChatWrapperProps {
  className?: string;
}

export interface JustDoChatWrapperRef {
  sendMessage: (text: string) => Promise<void>;
  /** Set an optimistic user message shown until gateway history loads */
  setPendingUserMessage: (text: string) => void;
  /** Clear sending state (e.g. when session start fails) */
  clearSending: () => void;
}

const JustDoChatWrapper = forwardRef<JustDoChatWrapperRef, JustDoChatWrapperProps>(({ className }, ref) => {
  const currentSession = useSelector(selectCurrentSession) as CoworkSession | null;
  const controllerRef = useRef<ChatController | null>(null);
  const [controller, setController] = useState<ChatController | null>(null);
  const connectedRef = useRef(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // Buffer for pending user message when the controller is not yet created
  const pendingUserMessageRef = useRef<string | null>(null);

  // Expose sendMessage and setPendingUserMessage to parent via ref
  useImperativeHandle(ref, () => ({
    sendMessage: async (text: string) => {
      const controller = controllerRef.current;
      if (!controller) throw new Error('Controller not initialized');
      await controller.sendMessage(text);
    },
    setPendingUserMessage: (text: string) => {
      const controller = controllerRef.current;
      // Always buffer the prompt — survives StrictMode remounts where the
      // controller is destroyed and recreated.
      pendingUserMessageRef.current = text;
      if (controller) {
        console.log('[JustDoChatWrapper] setPendingUserMessage (immediate):', text.slice(0, 60));
        controller.setPendingUserMessage(text);
      } else {
        console.log('[JustDoChatWrapper] setPendingUserMessage (buffered, no controller):', text.slice(0, 60));
      }
    },
    clearSending: () => {
      controllerRef.current?.clearSending();
    },
  }), []);

  // Create the Lit element and controller on mount
  useEffect(() => {
    const controller = new ChatController();
    controllerRef.current = controller;
    setController(controller);

    // Apply any buffered pending user message (set before controller existed)
    if (pendingUserMessageRef.current) {
      console.log('[JustDoChatWrapper] applying buffered pendingUserMessage on mount');
      controller.setPendingUserMessage(pendingUserMessageRef.current);
      pendingUserMessageRef.current = null;
    }

    // Set initial sessionKey from current session BEFORE connecting
    // (avoids race with the session-switch effect)
    if (currentSession) {
      const agentId = currentSession.agentId?.trim() || 'main';
      controller.state.sessionKey = `agent:${agentId}:justdo:${currentSession.id}`;
    }

    // Cancellation flag: React StrictMode double-fires mount effects.
    // If the cleanup runs before connectToGateway resolves, we must
    // disconnect the zombie controller that would otherwise survive.
    let cancelled = false;

    // Connect to gateway with proper error state tracking
    connectToGateway(controller)
      .then(success => {
        if (cancelled) {
          console.log('[JustDoChatWrapper] connectToGateway resolved after cleanup — disconnecting zombie');
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
      console.log('[JustDoChatWrapper] cleanup — disconnecting controller');
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

  // Handle session switching
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !currentSession) return;

    // Build the gateway session key (same format as openclawChannelSessionSync)
    const agentId = currentSession.agentId?.trim() || 'main';
    const sessionKey = `agent:${agentId}:justdo:${currentSession.id}`;

    if (connectedRef.current) {
      controller.switchSession(sessionKey);
    } else {
      // Not yet connected — set sessionKey so connect() picks it up
      controller.state.sessionKey = sessionKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id, currentSession?.agentId]);

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

  return <ChatMessageDisplay className={className} controller={controller} />;
});

// ─── Gateway Connection ─────────────────────────────────────────────────────

/** Typed access to the Electron preload bridge for OpenClaw engine info. */
interface OpenClawEngineBridge {
  getPort: () => Promise<{ success: boolean; port?: number }>;
  getToken: () => Promise<{ success: boolean; token?: string }>;
}

function getEngineBridge(): OpenClawEngineBridge | undefined {
  const electron = (window as unknown as Record<string, unknown>).electron as
    | Record<string, unknown>
    | undefined;
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
