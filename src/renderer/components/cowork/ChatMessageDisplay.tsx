import '../../libs/openclaw-chat/components/justdo-chat';

import { useEffect, useMemo, useRef } from 'react';

import type { JustDoChatElement } from '../../libs/openclaw-chat/components/justdo-chat';
import { coworkMessagesToGateway } from '../../libs/openclaw-chat/conversion/cowork-to-gateway';
import type { ChatController } from '../../libs/openclaw-chat/gateway/chat-controller';
import type { CoworkMessage } from '../../types/cowork';

interface ChatMessageDisplayProps {
  className?: string;
  controller?: ChatController | null;
  messages?: CoworkMessage[];
  isStreaming?: boolean;
  fullWidth?: boolean;
  assistantName?: string;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  searchNavigationToken?: number;
  searchNavigationDirection?: 1 | -1;
  onSearchMatchCountChange?: (total: number, index: number) => void;
}

/**
 * Shared message surface for both the primary agent and subagents.
 * It keeps the OpenClaw message pipeline, shadow-DOM theme and scrolling
 * behavior in one place while callers only provide a controller or messages.
 */
const ChatMessageDisplay: React.FC<ChatMessageDisplayProps> = ({
  className,
  controller = null,
  messages = [],
  isStreaming = false,
  fullWidth = false,
  assistantName,
  searchQuery = '',
  searchCaseSensitive = false,
  searchNavigationToken = 0,
  searchNavigationDirection = 1,
  onSearchMatchCountChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<JustDoChatElement | null>(null);
  const gatewayMessages = useMemo(() => coworkMessagesToGateway(messages), [messages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.classList.toggle('full-width', fullWidth);
    if (assistantName) {
      chat.assistantName = assistantName;
    }
    container.appendChild(chat);
    chatRef.current = chat;

    const syncTheme = () => {
      chat.classList.toggle('dark', document.documentElement.classList.contains('dark'));
    };
    syncTheme();

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const followLatestMessage = () => {
      const isNearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200;
      if (isNearBottom) {
        requestAnimationFrame(() => {
          chat.scrollTop = chat.scrollHeight;
        });
      }
    };
    const contentObserver = new MutationObserver(followLatestMessage);
    if (chat.shadowRoot) {
      contentObserver.observe(chat.shadowRoot, { childList: true, subtree: true });
    }

    const handleSearchMatchCountChange = (event: Event) => {
      const detail = (event as CustomEvent<{ total?: number; index?: number }>).detail;
      onSearchMatchCountChange?.(detail?.total ?? 0, detail?.index ?? -1);
    };
    chat.addEventListener('search-match-count-change', handleSearchMatchCountChange);

    return () => {
      themeObserver.disconnect();
      contentObserver.disconnect();
      chat.removeEventListener('search-match-count-change', handleSearchMatchCountChange);
      chat.controller = null;
      chat.remove();
      chatRef.current = null;
    };
  }, [assistantName, fullWidth, onSearchMatchCountChange]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    chat.controller = controller;
    if (!controller) {
      chat.messages = gatewayMessages;
      chat.isStreaming = isStreaming;
    }
    chat.assistantName = assistantName ?? '';
  }, [assistantName, controller, gatewayMessages, isStreaming]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    chat.searchQuery = searchQuery;
    chat.searchCaseSensitive = searchCaseSensitive;
    requestAnimationFrame(() => {
      onSearchMatchCountChange?.(chat.getSearchMatchCount(), -1);
    });
  }, [onSearchMatchCountChange, searchCaseSensitive, searchQuery]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat || searchNavigationToken === 0) return;
    const result = chat.navigateSearch(searchNavigationDirection);
    onSearchMatchCountChange?.(result.total, result.index);
  }, [onSearchMatchCountChange, searchNavigationDirection, searchNavigationToken]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;

    const shouldFollow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200;
    if (shouldFollow) {
      requestAnimationFrame(() => {
        chat.scrollTop = chat.scrollHeight;
      });
    }
  }, [gatewayMessages, isStreaming]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
    />
  );
};

export default ChatMessageDisplay;
