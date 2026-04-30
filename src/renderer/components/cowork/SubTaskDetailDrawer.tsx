import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkMessage } from '../../types/cowork';
import MarkdownContent from '../MarkdownContent';
import {
  buildDisplayItems,
  buildConversationTurns,
  hasRenderableAssistantContent,
  ToolCallGroup,
} from './CoworkSessionDetail';
import { extractCanvasShortcodes } from '../../utils/canvasShortcode';

// Copy button component for subagent messages
const CopyButton: React.FC<{
  content: string;
  visible: boolean;
}> = ({ content, visible }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-all duration-200 ${
        visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      title={i18nService.t('copyToClipboard')}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 text-green-500"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 text-[var(--icon-secondary)]"
          aria-hidden="true"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
        </svg>
      )}
    </button>
  );
};

interface SubTaskDetailDrawerProps {
  agentId: string;
  displayName?: string;
  parentSessionId: string;
  onClose: () => void;
  status: 'pending' | 'running' | 'done';
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
        className="w-full text-left px-3 py-2 rounded-xl bg-slate-100/60 dark:bg-slate-800/20 border border-slate-200/50 dark:border-slate-700/30"
      >
        <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
          <span>💭</span>
          <span>{i18nService.t('coworkThinking') || 'Thinking'}</span>
          <span className="ml-auto text-gray-400 dark:text-gray-500">{collapsed ? '▶' : '▼'}</span>
        </div>
      </button>
      {!collapsed && (
        <div className="mt-1 px-3 py-2 text-xs text-gray-500 dark:text-gray-500 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
};

/** Simple assistant message with thinking and content */
const SubagentAssistantMessage: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  const hasThinking = message.thinkingContent && message.thinkingContent.length > 0;
  const [isHovered, setIsHovered] = useState(false);

  // Extract canvas shortcodes for inline preview rendering
  const { text: strippedText, previews } = useMemo(() => {
    return extractCanvasShortcodes(message.content, 42879);
  }, [message.content]);

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Thinking block */}
      {hasThinking && <SubagentThinkingBlock content={message.thinkingContent!} />}

      {/* Content */}
      {(message.content || previews.length > 0) && (
        <div className="relative rounded-2xl px-4 py-2.5 bg-surface text-foreground shadow-subtle w-fit max-w-full">
          {/* Copy button — top-right inside bubble */}
          <div className="absolute top-1.5 right-1.5">
            <CopyButton content={strippedText || message.content} visible={isHovered} />
          </div>
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
  // Check if this is a Subagent Context message (initial prompt sent to subagent)
  const isSubagentContext = Boolean(message.metadata?.isSubagentContext);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="py-2 px-4"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="max-w-full">
        <div className="pl-4">
          {isSubagentContext && (
            <div className="text-xs text-muted mb-1 flex items-center gap-1">
              <span>📋</span>
              <span className="font-medium">Subagent Context</span>
            </div>
          )}
          <div
            className={`relative rounded-2xl px-4 py-2 text-foreground shadow-subtle ${
              isSubagentContext
                ? 'bg-blue-100/50 dark:bg-blue-900/30 border border-blue-200/60 dark:border-blue-800/40'
                : 'bg-muted/30'
            }`}
          >
            {/* Copy button — top-right inside bubble */}
            <div className="absolute top-1.5 right-1.5">
              <CopyButton content={message.content} visible={isHovered} />
            </div>
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
  status: initialStatus,
}) => {
  // Debug log for props
  console.log(
    '[SubTaskDetailDrawer] props: agentId=' +
      agentId +
      ' initialStatus=' +
      initialStatus +
      ' parentSessionId=' +
      parentSessionId,
  );

  const cacheKey = `${parentSessionId}:${agentId}`;
  const cached = messageCache.get(cacheKey);

  const [messages, setMessages] = useState<CoworkMessage[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached || cached.length === 0);
  const [error, setError] = useState<string | null>(null);

  // Track actual status internally (may differ from initial prop)
  const [status, setStatus] = useState<'pending' | 'running' | 'done'>(initialStatus);
  const isRunning = status === 'running' || status === 'pending';

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

  // Poll subagent status to detect completion
  useEffect(() => {
    if (!isRunning) return;

    const checkStatus = async () => {
      try {
        const result = await coworkService.getSubTaskStatus(parentSessionId);
        const currentStatus = result.statuses[agentId];
        if (currentStatus) {
          setStatus(currentStatus as 'pending' | 'running' | 'done');
          if (currentStatus === 'done') {
            // Also refresh history once when done
            fetchHistory();
          }
        }
      } catch {
        // Ignore status check errors
      }
    };

    // Check status every 3 seconds
    const statusTimer = setInterval(checkStatus, 3000);
    // Also check immediately
    checkStatus();

    return () => clearInterval(statusTimer);
  }, [isRunning, parentSessionId, agentId, fetchHistory]);

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
            {/* Status indicator synced with breathing light */}
            {status === 'running' && (
              <span className="inline-flex items-center gap-1 ml-2 text-xs text-blue-500">
                <span className="inline-block w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                {i18nService.t('subTaskRunning') || 'Running'}
              </span>
            )}
            {status === 'pending' && (
              <span className="inline-flex items-center gap-1 ml-2 text-xs text-orange-500">
                <span className="inline-block w-3 h-3 bg-orange-500 rounded-full animate-pulse" />
                {i18nService.t('subTaskPending') || 'Pending'}
              </span>
            )}
            {status === 'done' && (
              <span className="inline-flex items-center gap-1 ml-2 text-xs text-green-500">
                <span className="inline-block w-3 h-3 bg-green-500 rounded-full" />
                {i18nService.t('subTaskDone') || 'Done'}
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

          {!loading && !error && messages.length === 0 && status !== 'pending' && (
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
                  <div className="px-4 py-1">
                    <ToolCallGroup
                      group={{ type: 'tool_group', toolUse: msg }}
                      isLastInSequence={true}
                    />
                  </div>
                )}
                {msg.type === 'tool_result' &&
                  !messages.some(
                    m => m.type === 'tool_use' && m.metadata?.toolUseId === msg.metadata?.toolUseId,
                  ) && (
                    <div className="px-4 py-1">
                      <ToolCallGroup
                        group={{
                          type: 'tool_group',
                          toolUse: { ...msg, type: 'tool_use' } as CoworkMessage,
                          toolResult: msg,
                        }}
                        isLastInSequence={true}
                      />
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
                          return (
                            <div key={`tool-${item.group.toolUse.id}`} className="px-2 py-1">
                              <ToolCallGroup group={item.group} isLastInSequence={true} />
                            </div>
                          );
                        }

                        // Orphan tool result - use toolName from tool_result's metadata if available
                        if (item.type === 'tool_result') {
                          return (
                            <div key={item.message.id} className="px-2 py-1">
                              <ToolCallGroup
                                group={{
                                  type: 'tool_group',
                                  toolUse: {
                                    ...item.message,
                                    type: 'tool_use',
                                    metadata: {
                                      toolName: item.message.metadata?.toolName ?? 'Unknown Tool',
                                      toolUseId: item.message.metadata?.toolUseId,
                                      toolInput: item.message.metadata?.toolInput ?? {},
                                    },
                                  } as CoworkMessage,
                                  toolResult: item.message,
                                }}
                                isLastInSequence={true}
                              />
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
