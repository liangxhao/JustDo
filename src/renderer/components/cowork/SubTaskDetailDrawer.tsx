import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { extractCanvasShortcodes } from '../../utils/canvasShortcode';
import MarkdownContent from '../MarkdownContent';
import {
  buildTranscriptItems,
  ToolCallGroup,
} from './CoworkSessionDetail';

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
  sessionKey?: string;
  displayName?: string;
  parentSessionId: string;
  onClose: () => void;
  status: 'pending' | 'running' | 'done' | 'failed';
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
  sessionKey,
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

  const subagentKey = sessionKey || agentId;
  const cacheKey = `${parentSessionId}:${subagentKey}`;
  const cached = messageCache.get(cacheKey);

  const [messages, setMessages] = useState<CoworkMessage[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached || cached.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [subagentErrorInfo, setSubagentErrorInfo] = useState<{
    state?: string;
    status?: string;
    outcome?: string;
    endedAt?: number;
    errorMessage?: string;
    lastMessage?: string;
  } | null>(null);

  // Track actual status internally (may differ from initial prop)
  const [status, setStatus] = useState<'pending' | 'running' | 'done' | 'failed'>(initialStatus);
  const isRunning = status === 'running' || status === 'pending';
  const isFailed = status === 'failed';
  const isCurrentSubagent = useCallback(
    (streamAgentId: string) =>
      streamAgentId === agentId ||
      streamAgentId === subagentKey ||
      Boolean(sessionKey && streamAgentId === sessionKey),
    [agentId, sessionKey, subagentKey],
  );

  // Width state for resizable drawer
  // Default: 40% of the main content area width (excluding sidebar)
  // Recalculates on window resize, maximize/restore, sidebar toggle
  const [drawerWidth, setDrawerWidth] = useState(400);
  const defaultWidthRef = useRef(400);
  const userOffsetRef = useRef(0); // drawerWidth - defaultWidth, set on user drag
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  const isFirstLoad = useRef(!cached || cached.length === 0);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(messages.length);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  // Prevent double fetch when status transitions to 'done'
  const hasFetchedOnCompletion = useRef(false);
  // Reset completion flag when switching to a different subagent
  useEffect(() => {
    hasFetchedOnCompletion.current = false;
    setStatus(initialStatus);
  }, [cacheKey, initialStatus]);

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
        sessionKey,
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
  }, [parentSessionId, agentId, sessionKey, cacheKey, messages.length]);

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
          if (isCurrentSubagent(streamAgentId)) {
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
          if (!isCurrentSubagent(streamAgentId)) return;
          setMessages(prev => {
            const updated = prev.map(message =>
              message.id === messageId ? { ...message, content } : message,
            );
            messageCache.set(cacheKey, updated);
            return updated;
          });
        },
        onThinkingUpdate: (streamAgentId, messageId, thinkingDelta) => {
          if (!isCurrentSubagent(streamAgentId)) return;
          setMessages(prev => {
            const updated = prev.map(message =>
              message.id === messageId
                ? {
                    ...message,
                    thinkingContent: `${message.thinkingContent || ''}${thinkingDelta}`,
                  }
                : message,
            );
            messageCache.set(cacheKey, updated);
            return updated;
          });
        },
        onMessageMetadataUpdate: (streamAgentId, messageId, metadata) => {
          if (!isCurrentSubagent(streamAgentId)) return;
          setMessages(prev => {
            const updated = prev.map(message =>
              message.id === messageId
                ? { ...message, metadata: { ...message.metadata, ...metadata } }
                : message,
            );
            messageCache.set(cacheKey, updated);
            return updated;
          });
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
  }, [isRunning, parentSessionId, agentId, cacheKey, isCurrentSubagent]);

  // Poll subagent status to detect completion
  useEffect(() => {
    if (!isRunning) return;

    const checkStatus = async () => {
      try {
        const result = await coworkService.getSubTaskStatus(parentSessionId);
        const currentStatus =
          result.statuses[agentId] ||
          result.statuses[subagentKey] ||
          (sessionKey ? result.statuses[sessionKey] : undefined);
        if (currentStatus) {
          setStatus(currentStatus);
          if (currentStatus === 'done' && !hasFetchedOnCompletion.current) {
            // Fetch history once when done — prevent double-fetch via the isRunning effect below
            hasFetchedOnCompletion.current = true;
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
  }, [isRunning, parentSessionId, agentId, sessionKey, subagentKey, fetchHistory]);

  // Fetch error info when subagent is failed
  useEffect(() => {
    if (!isFailed) return;

    const fetchErrorInfo = async () => {
      try {
        const errorInfo = await coworkService.getSubagentError({
          parentSessionId,
          agentId,
          sessionKey,
        });
        setSubagentErrorInfo(errorInfo);
      } catch {
        // Ignore error info fetch failures
      }
    };

    fetchErrorInfo();
  }, [isFailed, parentSessionId, agentId, sessionKey]);

  // Initial load and final refresh when subagent completes
  useEffect(() => {
    if (!isRunning) {
      // Subagent finished — fetch final history if we haven't already from the completion effect
      if (!hasFetchedOnCompletion.current) {
        hasFetchedOnCompletion.current = true;
        fetchHistory();
      }
    } else if (messages.length === 0) {
      // Running but no messages yet — initial load
      fetchHistory();
    }
  }, [isRunning, messages.length, fetchHistory]);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Auto-size: default to 40% of main content area width (excluding sidebar)
  // Recalculates on window resize, maximize/restore. Preserves user drag offset.
  const DEFAULT_RATIO = 0.4;
  const MIN_WIDTH = 320;

  // Measure the content panel width (the flex-1 div containing the session UI)
  const measureContentWidth = useCallback((): number => {
    // The content area is the flex-1 sibling of the sidebar inside the
    // `flex.flex-1` container at App.tsx:497.
    // It has padding: py-1.5 pr-1.5 (6px on top/bottom, 6px right).
    // Its computed width = full container width - sidebar width - 6px(pr).
    // But the simplest reliable approach: find the div with class containing
    // "flex-1 min-w-0 py-1.5 pr-1.5" and read its clientWidth.
    const candidates = document.querySelectorAll('.flex-1.min-w-0.py-1\\.5.pr-1\\.5');
    if (candidates.length > 0) {
      const el = candidates[candidates.length - 1] as HTMLElement;
      return el.clientWidth;
    }
    // Fallback: assume sidebar is w-60 (240px) or w-0 (collapsed),
    // content = window.innerWidth - sidebar - padding
    const isSidebarCollapsed = !!document.querySelector('.w-0')?.matches(':scope');
    const sidebarWidth = isSidebarCollapsed ? 0 : 240;
    return window.innerWidth - sidebarWidth - 6; // 6px for pr-1.5
  }, []);

  // Calculate and apply default width from current content area
  const recalcDefaultWidth = useCallback(() => {
    const contentWidth = measureContentWidth();
    const newDefault = Math.max(MIN_WIDTH, Math.round(contentWidth * DEFAULT_RATIO));
    defaultWidthRef.current = newDefault;
    // If user has dragged, preserve offset; otherwise use default
    setDrawerWidth(newDefault + userOffsetRef.current);
  }, [measureContentWidth]);

  // Initial calc + listen for window resize (covers maximize/restore, drag resize)
  useEffect(() => {
    recalcDefaultWidth();
    window.addEventListener('resize', recalcDefaultWidth);
    return () => window.removeEventListener('resize', recalcDefaultWidth);
  }, [recalcDefaultWidth]);

  // Resize handlers for draggable width adjustment
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX;
      setDrawerWidth(Math.max(MIN_WIDTH, newWidth));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Record user offset so recalcDefaultWidth preserves it
      userOffsetRef.current = drawerWidth - defaultWidthRef.current;
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
  }, [isResizing, drawerWidth]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
  }, []);

  const transcriptItems = useMemo(() => buildTranscriptItems(messages), [messages]);

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
            {status === 'failed' && (
              <span className="inline-flex items-center gap-1 ml-2 text-xs text-red-500">
                <span className="inline-block w-3 h-3 bg-red-500 rounded-full" />
                {i18nService.t('subTaskFailed') || 'Failed'}
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
          {/* Error info for failed subagent */}
          {isFailed && subagentErrorInfo && (
            <div className="mb-3 px-3 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30">
              <div className="flex items-start gap-2">
                <svg
                  className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs font-semibold text-red-700 dark:text-red-400 mb-1">
                    {i18nService.t('subagentFailedReason') || 'Failure Reason'}
                  </h4>
                  <div className="text-xs text-red-600 dark:text-red-300 space-y-1">
                    {subagentErrorInfo.errorMessage && (
                      <p className="font-medium">{subagentErrorInfo.errorMessage}</p>
                    )}
                    {!subagentErrorInfo.errorMessage && subagentErrorInfo.outcome && (
                      <p className="font-medium">
                        Outcome: <span className="uppercase">{subagentErrorInfo.outcome}</span>
                      </p>
                    )}
                    {!subagentErrorInfo.errorMessage &&
                      !subagentErrorInfo.outcome &&
                      subagentErrorInfo.state && (
                        <p className="font-medium">
                          State: <span className="uppercase">{subagentErrorInfo.state}</span>
                        </p>
                      )}
                    {subagentErrorInfo.endedAt && (
                      <p className="text-red-500/70 dark:text-red-400/70">
                        Ended at: {new Date(subagentErrorInfo.endedAt).toLocaleString()}
                      </p>
                    )}
                    {subagentErrorInfo.lastMessage && (
                      <div className="mt-2 pt-2 border-t border-red-200/50 dark:border-red-700/30">
                        <p className="text-red-500/60 dark:text-red-400/60 text-[11px] mb-1">
                          {i18nService.t('lastMessage') || 'Last message'}:
                        </p>
                        <p className="whitespace-pre-wrap break-words text-[11px] max-h-32 overflow-y-auto">
                          {subagentErrorInfo.lastMessage}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

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
            transcriptItems.map(item => {
              if (item.type === 'user') {
                return <SubagentUserMessage key={item.message.id} message={item.message} />;
              }
              if (item.type === 'assistant') {
                return <SubagentAssistantMessage key={item.message.id} message={item.message} />;
              }
              if (item.type === 'tool_group') {
                return (
                  <div key={`tool-${item.group.toolUse.id}`} className="px-4 py-1">
                    <ToolCallGroup group={item.group} isLastInSequence={true} />
                  </div>
                );
              }
              if (item.type === 'tool_result') {
                return (
                  <div key={item.message.id} className="px-4 py-1">
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
          {!loading && !error && isRunning && transcriptItems.length > 0 && (
            <div className="pl-4">
              <TypingDots />
            </div>
          )}
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
