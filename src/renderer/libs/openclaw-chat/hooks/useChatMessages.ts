/**
 * React hook for deriving gateway messages from Redux state.
 * Converts CoworkMessage[] to GatewayMessage[] and handles streaming.
 */
import { useMemo } from 'react';

import type { GatewayMessage } from '../types';
import { coworkMessagesToGateway } from '../conversion/cowork-to-gateway';
import type { CoworkMessage } from '../../../types/cowork';

interface UseChatMessagesResult {
  messages: GatewayMessage[];
  stream: string | null;
  streamStartedAt: number | null;
  isStreaming: boolean;
}

/**
 * Convert Redux cowork state to gateway message format for the Lit element.
 */
export function useChatMessages(
  coworkMessages: CoworkMessage[],
  isStreaming: boolean,
): UseChatMessagesResult {
  const messages = useMemo(
    () => coworkMessagesToGateway(coworkMessages),
    [coworkMessages],
  );

  // For streaming: the last assistant message with isStreaming flag
  // gets its content treated as a live stream
  const stream = useMemo(() => {
    if (!isStreaming || coworkMessages.length === 0) return null;
    // Find the last message that's being streamed
    for (let i = coworkMessages.length - 1; i >= 0; i--) {
      const msg = coworkMessages[i];
      if (msg.type === 'assistant' && msg.metadata?.isStreaming) {
        return msg.content || null;
      }
    }
    return null;
  }, [coworkMessages, isStreaming]);

  return {
    messages,
    stream,
    streamStartedAt: isStreaming ? Date.now() : null,
    isStreaming,
  };
}
