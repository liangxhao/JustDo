import '@/libs/openclaw-chat/components/justdo-chat';

import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { useEffect, useRef } from 'react';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { AssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import type { GatewayMessage, UserMessageHistoryAction } from '@/libs/openclaw-chat/types';

import type { MessageQuoteHandler } from '../composer/messageQuote';

interface ChatMessageDisplayProps {
  className?: string;
  controller?: ChatController | null;
  gatewayMessages?: GatewayMessage[];
  isStreaming?: boolean;
  activeTurn?: AssistantTurn | null;
  fullWidth?: boolean;
  assistantName?: string;
  assistantId?: string;
  peerColors?: Readonly<Record<string, string>>;
  peerNames?: Readonly<Record<string, string>>;
  peerPerspective?: boolean;
  workingDirectory?: string;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  searchNavigationToken?: number;
  searchNavigationDirection?: 1 | -1;
  processSummariesExpanded?: boolean;
  onSearchMatchCountChange?: (total: number, index: number) => void;
  runTimings?: SessionRunTiming[];
  onLastUserMessageAction?: (
    action: UserMessageHistoryAction,
    entryId: string,
    editedText?: string,
  ) => boolean | Promise<boolean>;
  onMessageQuote?: MessageQuoteHandler;
  onAssistantMessageFork?: (entryId: string) => boolean | Promise<boolean>;
  onChatElementChange?: (element: JustDoChatElement | null) => void;
}

const EMPTY_PEER_NAMES: Readonly<Record<string, string>> = {};

/**
 * Shared message surface for both the primary agent and subagents.
 * It keeps the OpenClaw message pipeline, shadow-DOM theme and scrolling
 * behavior in one place while callers only provide a controller or messages.
 */
const ChatMessageDisplay: React.FC<ChatMessageDisplayProps> = ({
  className,
  controller = null,
  gatewayMessages,
  isStreaming = false,
  activeTurn = null,
  fullWidth = false,
  assistantName,
  assistantId = '',
  peerColors = EMPTY_PEER_NAMES,
  peerNames = EMPTY_PEER_NAMES,
  peerPerspective = false,
  workingDirectory = '',
  searchQuery = '',
  searchCaseSensitive = false,
  searchNavigationToken = 0,
  searchNavigationDirection = 1,
  processSummariesExpanded = false,
  onSearchMatchCountChange,
  runTimings = [],
  onLastUserMessageAction,
  onMessageQuote,
  onAssistantMessageFork,
  onChatElementChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<JustDoChatElement | null>(null);
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
    onChatElementChange?.(chat);

    const syncTheme = () => {
      chat.classList.toggle('dark', document.documentElement.classList.contains('dark'));
    };
    syncTheme();

    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    const handleSearchMatchCountChange = (event: Event) => {
      const detail = (event as CustomEvent<{ total?: number; index?: number }>).detail;
      onSearchMatchCountChange?.(detail?.total ?? 0, detail?.index ?? -1);
    };
    chat.addEventListener('search-match-count-change', handleSearchMatchCountChange);

    return () => {
      themeObserver.disconnect();
      chat.removeEventListener('search-match-count-change', handleSearchMatchCountChange);
      chat.controller = null;
      chat.remove();
      chatRef.current = null;
      onChatElementChange?.(null);
    };
  }, [assistantName, fullWidth, onChatElementChange, onSearchMatchCountChange]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    chat.controller = controller;
    if (!controller) {
      chat.messages = gatewayMessages ?? [];
      chat.isStreaming = isStreaming;
      chat.activeTurn = activeTurn;
    }
    chat.assistantName = assistantName ?? '';
    chat.assistantId = assistantId;
    chat.peerColors = peerColors;
    chat.peerNames = peerNames;
    chat.peerPerspective = peerPerspective;
    chat.workingDirectory = workingDirectory;
    chat.processSummariesExpanded = processSummariesExpanded;
    chat.runTimings = runTimings;
    chat.onLastUserMessageAction = onLastUserMessageAction;
    chat.onMessageQuote = onMessageQuote;
    chat.onAssistantMessageFork = onAssistantMessageFork;
  }, [
    assistantName,
    assistantId,
    peerColors,
    peerNames,
    peerPerspective,
    controller,
    gatewayMessages,
    isStreaming,
    activeTurn,
    processSummariesExpanded,
    workingDirectory,
    runTimings,
    onLastUserMessageAction,
    onMessageQuote,
    onAssistantMessageFork,
  ]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    chat.searchQuery = searchQuery;
    chat.searchCaseSensitive = searchCaseSensitive;
    const ownerWindow = chat.ownerDocument.defaultView ?? window;
    const frame = ownerWindow.requestAnimationFrame(() => {
      onSearchMatchCountChange?.(chat.getSearchMatchCount(), -1);
    });
    return () => ownerWindow.cancelAnimationFrame(frame);
  }, [onSearchMatchCountChange, searchCaseSensitive, searchQuery]);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat || searchNavigationToken === 0) return;
    const result = chat.navigateSearch(searchNavigationDirection);
    onSearchMatchCountChange?.(result.total, result.index);
  }, [onSearchMatchCountChange, searchNavigationDirection, searchNavigationToken]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
    />
  );
};

export default ChatMessageDisplay;
