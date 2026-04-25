import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkMessage } from '../../types/cowork';
import MarkdownContent from '../MarkdownContent';
import {
  buildDisplayItems,
  buildConversationTurns,
  hasRenderableAssistantContent,
} from './CoworkSessionDetail';
import { extractCanvasShortcodes } from '../../utils/canvasShortcode';

interface SubTaskDetailDrawerProps {
  agentId: string;
  displayName?: string;
  parentSessionId: string;
  onClose: () => void;
  isRunning?: boolean;
}

/** Module-level cache so re-opening a drawer doesn't flash "loading" */
const messageCache = new Map<string, CoworkMessage[]>();

/** Simple thinking block for subagent - reads from local state instead of Redux */
const SubagentThinkingBlock: React.FC<{ content: string }> = ({ content }) => {
  const [collapsed, setCollapsed] = useState(false);

  if (!content || content.length === 0) return null;

  return (
    <div className="relative mb-2">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full text-left px-3 py-2 rounded-xl bg-blue-50/50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/50"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-blue-600 dark:text-blue-400">
          <span>💭</span>
          <span>{i18nService.t('coworkThinking') || 'Thinking'}</span>
          <span className="ml-auto text-blue-400 dark:text-blue-500">{collapsed ? '▶' : '▼'}</span>
        </div>
      </button>
      {!collapsed && (
        <div className="mt-1 px-3 py-2 text-xs text-blue-700/80 dark:text-blue-300/80 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
};

/** Simple assistant message with thinking and content */
const SubagentAssistantMessage: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  const hasThinking = message.thinkingContent && message.thinkingContent.length > 0;

  // Extract canvas shortcodes for inline preview rendering
  const { text: strippedText, previews } = useMemo(() => {
    return extractCanvasShortcodes(message.content, 42879);
  }, [message.content]);

  return (
    <div className="relative">
      {/* Thinking block */}
      {hasThinking && <SubagentThinkingBlock content={message.thinkingContent!} />}

      {/* Content */}
      {(message.content || previews.length > 0) && (
        <div className="relative rounded-2xl px-4 py-2.5 bg-surface text-foreground shadow-subtle w-fit max-w-full">
          {previews.length > 0 && (
            <div className="mb-2">
              {previews.map((preview, idx) => (
                <img
                  key={idx}
                  src={preview.url}
                  alt={preview.title || 'Preview'}
                  className="max-w-full rounded-lg"
                />
              ))}
            </div>
          )}
          {strippedText && (
            <MarkdownContent
              content={strippedText}
              className="max-w-none break-words prose prose-sm dark:prose-invert"
            />
          )}
        </div>
      )}
    </div>
  );
};

/** Simple user message display */
const SubagentUserMessage: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  return (
    <div className="py-2 px-4">
      <div className="max-w-full">
        <div className="pl-4">
          <div className="relative rounded-2xl px-4 py-2 bg-muted/30 text-foreground shadow-subtle">
            <MarkdownContent
              content={message.content}
              className="max-w-none break-words prose prose-sm dark:prose-invert"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

/** Typing indicator dots */
const TypingDots: React.FC = () => (
  <div className="flex items-center gap-1 px-4 py-2">
    <span
      className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse"
      style={{ animationDelay: '0ms' }}
    />
    <span
      className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse"
      style={{ animationDelay: '150ms' }}
    />
    <span
      className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse"
      style={{ animationDelay: '300ms' }}
    />
  </div>
);

const SubTaskDetailDrawer: React.FC<SubTaskDetailDrawerProps> = ({
  agentId,
  displayName,
  parentSessionId,
  onClose,
  isRunning,
}) => {
  // Debug log for isRunning
  console.log(
    '[SubTaskDetailDrawer] props: agentId=' +
      agentId +
      ' isRunning=' +
      isRunning +
      ' parentSessionId=' +
      parentSessionId,
  );

  const cacheKey = `${parentSessionId}:${agentId}`;
  const cached = messageCache.get(cacheKey);

  const [messages, setMessages] = useState<CoworkMessage[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached || cached.length === 0);
  const [error, setError] = useState<string | null>(null);

  // Width state for resizable drawer
  const [drawerWidth, setDrawerWidth] = useState(480);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  const isFirstLoad = useRef(!cached || cached.length === 0);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(messages.length);
  const streamCleanupRef = useRef<(() => void) | null>(null);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // Load initial history
  const fetchHistory = useCallback(async () => {
    if (isFirstLoad.current && messages.length === 0) {
      setLoading(true);
    }
    try {
      const fetchedMessages = await coworkService.getSubTaskHistory({
        parentSessionId,
        agentId,
      });
      if (fetchedMessages.length > 0) {
        setMessages(fetchedMessages);
        messageCache.set(cacheKey, fetchedMessages);
        setError(null);
      } else if (isFirstLoad.current && messages.length === 0) {
        setError(i18nService.t('subTaskNoHistory') || 'No conversation history');
      }
    } catch (err) {
      if (isFirstLoad.current && messages.length === 0) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      setLoading(false);
      isFirstLoad.current = false;
    }
  }, [parentSessionId, agentId, cacheKey, messages.length]);

  // Set up streaming listeners when running
  useEffect(() => {
    if (isRunning) {
      // Clean up any existing listeners
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
      }

      // Set up new streaming listeners
      streamCleanupRef.current = coworkService.setupSubagentListeners(parentSessionId, {
        onMessage: (streamAgentId, message) => {
          if (streamAgentId === agentId) {
            setMessages(prev => {
              // Avoid duplicates
              if (prev.some(m => m.id === message.id)) {
                return prev;
              }
              const newMessages = [...prev, message];
              messageCache.set(cacheKey, newMessages);
              return newMessages;
            });
          }
        },
        onMessageUpdate: (streamAgentId, messageId, content) => {
          if (streamAgentId === agentId) {
            setMessages(prev => {
              const updated = prev.map(m => (m.id === messageId ? { ...m, content } : m));
              messageCache.set(cacheKey, updated);
              return updated;
            });
          }
        },
        onThinkingUpdate: (streamAgentId, messageId, thinkingDelta) => {
          if (streamAgentId === agentId) {
            setMessages(prev => {
              const updated = prev.map(m =>
                m.id === messageId
                  ? { ...m, thinkingContent: (m.thinkingContent || '') + thinkingDelta }
                  : m,
              );
              messageCache.set(cacheKey, updated);
              return updated;
            });
          }
        },
        onToolResult: (streamAgentId, toolUseId, result, isError) => {
          if (streamAgentId === agentId) {
            setMessages(prev => {
              // Find tool_use message and add result
              const updated = prev.map(m => {
                if (m.type === 'tool_use' && m.metadata?.toolUseId === toolUseId) {
                  // Find the corresponding tool_result or create one
                  return m;
                }
                return m;
              });
              // Add tool_result message
              const toolResultMsg: CoworkMessage = {
                id: `tool-result-${toolUseId}-${Date.now()}`,
                type: 'tool_result',
                content: result,
                timestamp: Date.now(),
                metadata: {
                  toolUseId,
                  isError,
                  isFinal: true,
                },
              };
              const newMessages = [...updated, toolResultMsg];
              messageCache.set(cacheKey, newMessages);
              return newMessages;
            });
          }
        },
      });

      return () => {
        if (streamCleanupRef.current) {
          streamCleanupRef.current();
          streamCleanupRef.current = null;
        }
      };
    }
    return () => {};
  }, [isRunning, parentSessionId, agentId, cacheKey]);

  // Initial load (only if not running or no cached data)
  useEffect(() => {
    if (!isRunning || messages.length === 0) {
      fetchHistory();
    }
  }, [fetchHistory, isRunning, messages.length]);

  // Polling when running (for fallback if streaming misses anything)
  useEffect(() => {
    if (isRunning) {
      const timer = setInterval(fetchHistory, 5000);
      return () => clearInterval(timer);
    }
    return () => {};
  }, [fetchHistory, isRunning]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Resize handlers for draggable width adjustment
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      // Calculate new width from right edge (drawer is right-aligned)
      const newWidth = window.innerWidth - e.clientX;
      // Clamp width between min (320) and max (90% of viewport)
      const minWidth = 320;
      const maxWidth = window.innerWidth * 0.9;
      setDrawerWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
  }, []);

  // Build display items and conversation turns
  const displayItems = useMemo(() => buildDisplayItems(messages), [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);

  return (
    <div className="fixed inset-0 top-12 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div
        className="relative flex flex-col dark:bg-claude-darkBg bg-claude-bg shadow-2xl animate-slide-in-right"
        style={{ width: drawerWidth, maxWidth: '90vw' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Resize handle - draggable edge on the left */}
        <div
          ref={resizeRef}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-claude-accent/30 active:bg-claude-accent/50 transition-colors z-10"
          onMouseDown={startResize}
        />

        <div className="flex items-center justify-between px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm">🔍</span>
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">
              {i18nService.t('subTaskDetail') || 'Sub-task Detail'} — {displayName || agentId}
            </h3>
            {isRunning && (
              <span className="inline-flex items-center gap-1 ml-2 text-xs text-blue-500">
                <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                {i18nService.t('subTaskRunning') || 'Running'}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div ref={contentRef} className="flex-1 overflow-y-auto px-2 py-3 space-y-2">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-claude-accent border-t-transparent rounded-full animate-spin" />
              <span className="ml-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('loading') || 'Loading...'}
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="text-center py-8">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {error}
              </p>
              <button
                onClick={fetchHistory}
                className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
              >
                {i18nService.t('retry') || 'Retry'}
              </button>
            </div>
          )}

          {!loading && !error && messages.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('subTaskNoHistory') || 'No conversation history'}
              </p>
            </div>
          )}

          {!loading &&
            !error &&
            turns.length === 0 &&
            messages.length > 0 &&
            // Render raw messages if turns can't be built
            messages.map((msg, idx) => (
              <div key={msg.id || idx} className="space-y-2">
                {msg.type === 'user' && <SubagentUserMessage message={msg} />}
                {msg.type === 'assistant' && <SubagentAssistantMessage message={msg} />}
                {msg.type === 'tool_use' && (
                  <div className="px-4 py-2 bg-amber-50/60 dark:bg-amber-950/20 rounded-lg">
                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
                      🔧 {msg.metadata?.toolName || 'Tool Call'}
                    </div>
                    <div className="text-xs text-muted">
                      {msg.metadata?.toolInput
                        ? JSON.stringify(msg.metadata.toolInput, null, 2)
                        : msg.content}
                    </div>
                  </div>
                )}
                {msg.type === 'tool_result' && (
                  <div
                    className={`px-4 py-2 rounded-lg ${msg.metadata?.isError ? 'bg-red-50/60 dark:bg-red-950/20' : 'bg-green-50/60 dark:bg-green-950/20'}`}
                  >
                    <div
                      className={`text-xs font-medium mb-1 ${msg.metadata?.isError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}
                    >
                      {msg.metadata?.isError ? '❌ Error' : '✅ Result'}
                    </div>
                    <div className="text-xs text-muted whitespace-pre-wrap">
                      {msg.content || msg.metadata?.toolResult || ''}
                    </div>
                  </div>
                )}
              </div>
            ))}

          {!loading &&
            !error &&
            turns.length > 0 &&
            turns.map((turn, index) => {
              const isLastTurn = index === turns.length - 1;
              const showTypingIndicator =
                isRunning && isLastTurn && !hasRenderableAssistantContent(turn);

              return (
                <div key={turn.id} className="space-y-2">
                  {/* User message */}
                  {turn.userMessage && <SubagentUserMessage message={turn.userMessage} />}

                  {/* Assistant turn content */}
                  {turn.assistantItems.length > 0 && (
                    <div className="pl-4 space-y-2">
                      {turn.assistantItems.map(item => {
                        if (item.type === 'assistant') {
                          return (
                            <SubagentAssistantMessage
                              key={item.message.id}
                              message={item.message}
                            />
                          );
                        }

                        if (item.type === 'tool_group') {
                          const { toolUse, toolResult } = item.group;
                          return (
                            <div key={`tool-${toolUse.id}`} className="space-y-1">
                              {/* Tool use */}
                              <div className="px-3 py-2 bg-amber-50/60 dark:bg-amber-950/20 rounded-lg">
                                <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
                                  🔧 {toolUse.metadata?.toolName || 'Tool'}
                                </div>
                                {toolUse.metadata?.toolInput && (
                                  <div className="text-xs text-muted overflow-x-auto">
                                    <pre className="whitespace-pre-wrap">
                                      {JSON.stringify(toolUse.metadata.toolInput, null, 2)}
                                    </pre>
                                  </div>
                                )}
                              </div>

                              {/* Tool result */}
                              {toolResult && (
                                <div
                                  className={`px-3 py-2 rounded-lg ${toolResult.metadata?.isError ? 'bg-red-50/60 dark:bg-red-950/20' : 'bg-green-50/60 dark:bg-green-950/20'}`}
                                >
                                  <div
                                    className={`text-xs font-medium mb-1 ${toolResult.metadata?.isError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}
                                  >
                                    {toolResult.metadata?.isError ? '❌ Error' : '✅ Result'}
                                  </div>
                                  <div className="text-xs text-muted whitespace-pre-wrap overflow-x-auto max-h-48">
                                    {toolResult.content || toolResult.metadata?.toolResult || ''}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        }

                        // Orphan tool result
                        if (item.type === 'tool_result') {
                          return (
                            <div
                              key={item.message.id}
                              className={`px-3 py-2 rounded-lg ${item.message.metadata?.isError ? 'bg-red-50/60 dark:bg-red-950/20' : 'bg-green-50/60 dark:bg-green-950/20'}`}
                            >
                              <div
                                className={`text-xs font-medium mb-1 ${item.message.metadata?.isError ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}
                              >
                                {item.message.metadata?.isError ? '❌ Error' : '✅ Result'}
                              </div>
                              <div className="text-xs text-muted whitespace-pre-wrap">
                                {item.message.content || ''}
                              </div>
                            </div>
                          );
                        }

                        // System message
                        if (item.type === 'system') {
                          return (
                            <div
                              key={item.message.id}
                              className="px-3 py-2 bg-gray-50/60 dark:bg-gray-800/20 rounded-lg"
                            >
                              <div className="text-xs text-muted">{item.message.content}</div>
                            </div>
                          );
                        }

                        return null;
                      })}
                      {showTypingIndicator && <TypingDots />}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        <div className="px-4 py-2.5 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center justify-between">
            <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {messages.length > 0
                ? `${messages.length} ${i18nService.t('subTaskMessages') || 'messages'}`
                : ''}
            </span>
            <button
              onClick={fetchHistory}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors"
              title={i18nService.t('refresh') || 'Refresh'}
            >
              🔄
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubTaskDetailDrawer;
