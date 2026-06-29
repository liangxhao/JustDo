import { CheckIcon, ChevronRightIcon, CogIcon, PhotoIcon, SparklesIcon, UserIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { getScheduledReminderDisplayText } from '../../../scheduledTask/reminderText';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { store } from '../../store';
import type { CoworkImageAttachment, CoworkMessage, CoworkMessageMetadata } from '../../types/cowork';
import type { Skill } from '../../types/skill';
import { extractCanvasShortcodes } from '../../utils/canvasShortcode';
import ExclamationTriangleIcon from '../icons/ExclamationTriangleIcon';
import InformationCircleIcon from '../icons/InformationCircleIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import TrashIcon from '../icons/TrashIcon';
import MarkdownContent from '../MarkdownContent';
import InlineCanvasPreviews from './InlineCanvasPreviews';
import MonacoDiffView, { extractDiffFromToolInput } from './MonacoDiffView';

const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getStringArray = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  const lines = value.filter(item => typeof item === 'string') as string[];
  return lines.length > 0 ? lines.join('\n') : null;
};

type TodoStatus = 'completed' | 'in_progress' | 'pending' | 'unknown';

type ParsedTodoItem = {
  primaryText: string;
  secondaryText: string | null;
  status: TodoStatus;
};

const normalizeToolName = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, '');

const TOOL_USE_ERROR_TAG_PATTERN = /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/i;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

const getToolDisplayName = (toolName: string | undefined): string => {
  if (!toolName) return 'Tool';
  const normalized = normalizeToolName(toolName);
  switch (normalized) {
    case 'cron':
      return 'Cron';
    case 'exec':
    case 'bash':
    case 'shell':
      return 'Bash';
    case 'read':
    case 'readfile':
      return 'Read';
    case 'write':
    case 'writefile':
      return 'Write';
    case 'edit':
    case 'editfile':
      return 'Edit';
    case 'multiedit':
      return 'MultiEdit';
    case 'process':
      return 'Process';
    default:
      return toolName;
  }
};

const isBashLikeToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  return normalized === 'bash' || normalized === 'exec' || normalized === 'shell';
};

const getToolInputString = (input: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
};

const truncatePreview = (value: string, maxLength = 120): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;

const normalizeToolResultText = (value: string): string => {
  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  const errorTagMatch = withoutAnsi.trim().match(TOOL_USE_ERROR_TAG_PATTERN);
  return errorTagMatch ? errorTagMatch[1].trim() : withoutAnsi;
};

const isTodoWriteToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'todowrite';
};

const isCronToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'cron';
};

const getCronToolSummary = (input: Record<string, unknown>): string | null => {
  const action = getToolInputString(input, ['action']);
  if (!action) return null;

  const job =
    input.job && typeof input.job === 'object' ? (input.job as Record<string, unknown>) : null;
  const jobName = job ? getToolInputString(job, ['name', 'id']) : null;
  const jobId =
    getToolInputString(input, ['jobId', 'id']) ?? (job ? getToolInputString(job, ['id']) : null);
  const wakeText = getToolInputString(input, ['text']);

  switch (action) {
    case 'add':
      return [action, jobName ?? jobId].filter(Boolean).join(' · ');
    case 'update':
    case 'remove':
    case 'run':
    case 'runs':
      return [action, jobId ?? jobName].filter(Boolean).join(' · ');
    case 'wake':
      return [action, wakeText].filter(Boolean).join(' · ');
    default:
      return action;
  }
};

const formatStructuredText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
};

const toTrimmedString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeTodoStatus = (value: unknown): TodoStatus => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, '_') : '';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'in_progress' || normalized === 'running') return 'in_progress';
  if (normalized === 'pending' || normalized === 'todo') return 'pending';
  return 'unknown';
};

const parseTodoWriteItems = (input: unknown): ParsedTodoItem[] | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.todos)) return null;

  const parsedItems = record.todos
    .map(rawTodo => {
      if (!rawTodo || typeof rawTodo !== 'object') {
        return null;
      }

      const todo = rawTodo as Record<string, unknown>;
      const activeForm = toTrimmedString(todo.activeForm);
      const content = toTrimmedString(todo.content);
      const primaryText = activeForm ?? content ?? i18nService.t('coworkTodoUntitled');
      const secondaryText = content && content !== primaryText ? content : null;

      return {
        primaryText,
        secondaryText,
        status: normalizeTodoStatus(todo.status),
      } satisfies ParsedTodoItem;
    })
    .filter((item): item is ParsedTodoItem => item !== null);

  return parsedItems.length > 0 ? parsedItems : null;
};

const getTodoWriteSummary = (items: ParsedTodoItem[]): string => {
  const completedCount = items.filter(item => item.status === 'completed').length;
  const inProgressCount = items.filter(item => item.status === 'in_progress').length;
  const pendingCount = items.length - completedCount - inProgressCount;

  const summary = [
    `${items.length} ${i18nService.t('coworkTodoItems')}`,
    `${completedCount} ${i18nService.t('coworkTodoCompleted')}`,
    `${inProgressCount} ${i18nService.t('coworkTodoInProgress')}`,
    `${pendingCount} ${i18nService.t('coworkTodoPending')}`,
  ];

  const activeItem = items.find(item => item.status === 'in_progress');
  if (activeItem) {
    summary.push(activeItem.primaryText);
  }

  return summary.join(' · ');
};

const getToolInputSummary = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>,
): string | null => {
  if (!toolName || !toolInput) return null;
  const input = toolInput as Record<string, unknown>;

  // Handle _display key from announce-format tool events
  if (typeof input._display === 'string' && Object.keys(input).length === 1) {
    return input._display as string;
  }

  if (isTodoWriteToolName(toolName)) {
    const items = parseTodoWriteItems(input);
    return items ? getTodoWriteSummary(items) : null;
  }

  const normalizedToolName = normalizeToolName(toolName);

  switch (normalizedToolName) {
    case 'cron':
      return getCronToolSummary(input);
    case 'bash':
    case 'exec':
    case 'shell':
      return (
        getToolInputString(input, ['command', 'cmd', 'script']) ?? getStringArray(input.commands)
      );
    case 'read':
    case 'readfile':
    case 'write':
    case 'writefile':
    case 'edit':
    case 'editfile':
    case 'multiedit':
      return (
        getToolInputString(input, ['file_path', 'path', 'filePath', 'target_file', 'targetFile']) ??
        (typeof input.content === 'string' && input.content.trim()
          ? truncatePreview(input.content.split('\n')[0].trim())
          : null)
      );
    case 'glob':
    case 'grep':
      return getToolInputString(input, ['pattern', 'query']);
    case 'task':
      return getToolInputString(input, ['description', 'task']);
    case 'webfetch':
      return getToolInputString(input, ['url']);
    case 'process': {
      const action = getToolInputString(input, ['action']);
      const sessionId = getToolInputString(input, ['sessionId', 'session_id']);
      if (action && sessionId) return `${action} · ${sessionId}`;
      return action ?? sessionId;
    }
    default:
      return null;
  }
};

const formatToolInput = (
  toolName: string | undefined,
  toolInput?: Record<string, unknown>,
): string | null => {
  if (!toolInput) return null;
  const summary = getToolInputSummary(toolName, toolInput);
  if (summary && summary.trim()) {
    return summary;
  }
  return formatUnknown(toolInput);
};

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const getToolResultDisplay = (message: CoworkMessage): string => {
  const formatResultText = (value: string): string => {
    return formatStructuredText(normalizeToolResultText(value));
  };

  if (hasText(message.content)) {
    return formatResultText(message.content);
  }
  if (hasText(message.metadata?.toolResult)) {
    return formatResultText(message.metadata?.toolResult ?? '');
  }
  if (hasText(message.metadata?.error)) {
    return formatResultText(message.metadata?.error ?? '');
  }
  return '';
};
export type ToolGroupItem = {
  type: 'tool_group';
  toolUse: CoworkMessage;
  toolResult?: CoworkMessage | null;
};

export type TranscriptItem =
  | { type: 'user'; message: CoworkMessage }
  | { type: 'assistant'; message: CoworkMessage }
  | { type: 'system'; message: CoworkMessage }
  | { type: 'tool_group'; group: ToolGroupItem }
  | { type: 'tool_result'; message: CoworkMessage }
  | { type: 'subagent_completion'; message: CoworkMessage };

export const buildTranscriptItems = (messages: CoworkMessage[]): TranscriptItem[] => {
  const items: TranscriptItem[] = [];
  const groupsByToolUseId = new Map<string, ToolGroupItem>();
  let pendingAdjacentGroup: ToolGroupItem | null = null;

  for (const message of messages) {
    if (message.type === 'tool_use') {
      const group: ToolGroupItem = { type: 'tool_group', toolUse: message };
      items.push({ type: 'tool_group', group });

      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && toolUseId.trim()) {
        groupsByToolUseId.set(toolUseId, group);
      }
      pendingAdjacentGroup = group;
      continue;
    }

    if (message.type === 'tool_result') {
      let matched = false;
      const toolUseId = message.metadata?.toolUseId;
      if (typeof toolUseId === 'string' && groupsByToolUseId.has(toolUseId)) {
        const group = groupsByToolUseId.get(toolUseId);
        if (group) {
          group.toolResult = message;
          matched = true;
        }
      } else if (pendingAdjacentGroup && !pendingAdjacentGroup.toolResult) {
        pendingAdjacentGroup.toolResult = message;
        matched = true;
      }

      pendingAdjacentGroup = null;
      if (!matched) {
        items.push({ type: 'tool_result', message });
      }
      continue;
    }

    pendingAdjacentGroup = null;
    if (message.type === 'assistant') {
      items.push({ type: 'assistant', message });
      continue;
    }

    if (message.type === 'system') {
      items.push({ type: 'system', message });
      continue;
    }

    if (message.type === 'subagent_completion') {
      items.push({ type: 'subagent_completion', message });
      continue;
    }

    if (message.type === 'user') {
      items.push({ type: 'user', message });
    }
  }

  return items;
};

const TodoWriteInputView: React.FC<{ items: ParsedTodoItem[] }> = ({ items }) => {
  const getStatusCheckboxClass = (status: TodoStatus): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 border-green-500 text-green-500';
      case 'in_progress':
        return 'bg-transparent border-blue-500';
      case 'pending':
      case 'unknown':
      default:
        return 'bg-transparent border-border';
    }
  };

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={`todo-item-${index}`} className="flex items-start gap-2">
          <span
            className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center ${getStatusCheckboxClass(item.status)}`}
          >
            {item.status === 'completed' && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className={`text-xs whitespace-pre-wrap break-words leading-5 ${
                item.status === 'completed' ? 'text-muted' : 'text-foreground'
              }`}
            >
              {item.primaryText}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// Module-level Map to persist tool expand state across re-renders
const toolExpandStateMap = new Map<string, boolean>();

const ToolDetailBox: React.FC<{
  title: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <div className="rounded-lg overflow-hidden border border-border">
    <div className="px-3 py-1.5 bg-surfaceInset text-[10px] font-medium text-secondary uppercase tracking-wider">
      {title}
    </div>
    <div className="bg-surface-inset px-3 py-3 max-h-72 overflow-y-auto">{children}</div>
  </div>
);

export const ToolCallGroup: React.FC<{
  group: ToolGroupItem;
  isLastInSequence?: boolean;
  mapDisplayText?: (value: string) => string;
  forceExpanded?: boolean;
}> = ({ group, isLastInSequence = true, mapDisplayText, forceExpanded = false }) => {
  const { toolUse, toolResult } = group;
  const rawToolName =
    typeof toolUse.metadata?.toolName === 'string' ? toolUse.metadata.toolName : 'Tool';
  const toolName = getToolDisplayName(rawToolName);
  const toolInput = toolUse.metadata?.toolInput;
  const isCronTool = isCronToolName(rawToolName);
  const isTodoWriteTool = isTodoWriteToolName(rawToolName);
  const todoItems = isTodoWriteTool ? parseTodoWriteItems(toolInput) : null;
  const mapText = mapDisplayText ?? ((value: string) => value);
  const toolInputDisplayRaw = formatToolInput(rawToolName, toolInput);
  const toolInputDisplay = mapText(toolInputDisplayRaw ?? formatUnknown(toolInput ?? {}));
  const toolInputSummaryRaw = getToolInputSummary(rawToolName, toolInput) ?? toolInputDisplayRaw;
  const toolInputSummary = toolInputSummaryRaw ? mapText(toolInputSummaryRaw) : null;
  const toolResultDisplayRaw = toolResult ? getToolResultDisplay(toolResult) : '';
  const toolResultDisplay = mapText(toolResultDisplayRaw);
  const hasToolResultText = hasText(toolResultDisplay);
  const isToolError = Boolean(toolResult?.metadata?.isError || toolResult?.metadata?.error);
  const showNoDetailError = isToolError && !hasToolResultText;
  const toolResultFallback = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
  const displayToolResult = hasToolResultText ? toolResultDisplay : toolResultFallback;

  // Use metadata.toolUseId as stable key (persists across refreshes), fallback to toolUse.id
  // This is critical for subagent drawer which refreshes messages periodically
  const toolKey = (toolUse.metadata?.toolUseId as string) ?? toolUse.id;
  const persistedExpanded = toolExpandStateMap.get(toolKey) ?? false;
  const [isExpanded, setIsExpanded] = useState(persistedExpanded);
  const toolResultSummary =
    isCronTool && hasToolResultText
      ? truncatePreview(toolResultDisplay.replace(/\s+/g, ' '))
      : null;

  // Check if this is a Bash-like tool that should show terminal style
  const isBashTool = isBashLikeToolName(rawToolName);

  // Check if this is an Edit/MultiEdit tool with diff data
  const diffDataList = useMemo(
    () => extractDiffFromToolInput(rawToolName, toolInput as Record<string, unknown> | undefined),
    [rawToolName, toolInput],
  );
  const isEditWithDiff = diffDataList !== null && diffDataList.length > 0;

  useEffect(() => {
    if (!forceExpanded || isExpanded) return;
    setIsExpanded(true);
    toolExpandStateMap.set(toolKey, true);
  }, [forceExpanded, isExpanded, toolKey]);

  return (
    <div className="relative py-1">
      {/* Vertical connecting line to next tool group */}
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px bg-border" />
      )}
      <button
        onClick={() => {
          const newExpanded = !isExpanded;
          setIsExpanded(newExpanded);
          toolExpandStateMap.set(toolKey, newExpanded);
        }}
        className="w-full max-w-[calc(100%-44px)] flex items-start gap-2 text-left group relative z-10"
      >
        <span
          className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
            !toolResult ? 'bg-blue-500 animate-pulse' : isToolError ? 'bg-red-500' : 'bg-green-500'
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0 max-w-full">
            <span className="text-sm font-medium text-secondary flex-shrink-0">{toolName}</span>
            {toolInputSummary && (
              <code
                className="text-xs text-muted font-mono truncate min-w-0 flex-1 max-w-full"
                title={toolInputSummary}
              >
                {toolInputSummary}
              </code>
            )}
          </div>
          {toolResult && !isTodoWriteTool && (toolResultSummary || showNoDetailError) && (
            <div
              className={`text-xs mt-0.5 ${
                toolResultSummary
                  ? 'text-muted'
                  : showNoDetailError
                    ? 'text-red-500/80'
                    : 'text-muted'
              }`}
            >
              {toolResultSummary || toolResultFallback}
            </div>
          )}
          {!toolResult && (
            <div className="text-xs text-muted mt-0.5">{i18nService.t('coworkToolRunning')}</div>
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="ml-4 mt-2 space-y-2">
          <ToolDetailBox title={i18nService.t('coworkToolInput')}>
            {isTodoWriteTool && todoItems ? (
              <TodoWriteInputView items={todoItems} />
            ) : isEditWithDiff && diffDataList ? (
              <MonacoDiffView diffDataList={diffDataList} />
            ) : (
              <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                {isBashTool && <span className="text-primary select-none">$ </span>}
                {toolInputDisplay}
              </pre>
            )}
          </ToolDetailBox>
          <ToolDetailBox title={i18nService.t('coworkToolResult')}>
            {toolResult ? (
              <pre
                className={`text-xs whitespace-pre-wrap break-words font-mono ${
                  isToolError
                    ? 'text-red-500'
                    : hasToolResultText
                      ? 'text-foreground'
                      : 'text-secondary italic'
                }`}
              >
                {displayToolResult}
              </pre>
            ) : (
              <div className="text-xs text-muted italic">
                {i18nService.t('coworkToolRunning')}
              </div>
            )}
          </ToolDetailBox>
        </div>
      )}
    </div>
  );
};

// Copy button component
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
      type="button"
      onClick={handleCopy}
      aria-label={i18nService.t('copyToClipboard')}
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

// Format epoch-ms timestamp to absolute time like "2026-06-01 10:30"
const formatTimestamp = (ts: number): string => {
  const date = new Date(ts);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
};

// Format token count to compact display (e.g., 128000 -> "128k", 4200 -> "4.2k")
const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
};

const hasPositiveUsage = (
  usage?: CoworkMessage['usage'],
): usage is NonNullable<CoworkMessage['usage']> =>
  !!usage && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0);

export const UserMessageItem: React.FC<{
  message: CoworkMessage;
  skills: Skill[];
  sessionId?: string;
}> = React.memo(({ message, skills, sessionId }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  const handleDelete = useCallback(() => {
    if (!sessionId) return;
    void coworkService.deleteMessagesFrom(sessionId, message.id);
  }, [sessionId, message.id]);

  // Get skills used for this message
  const messageSkillIds = (message.metadata as CoworkMessageMetadata)?.skillIds || [];
  const messageSkills = messageSkillIds
    .map(id => skills.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  // Get image attachments from metadata
  const imageAttachments = ((message.metadata as CoworkMessageMetadata)?.imageAttachments ??
    []) as CoworkImageAttachment[];

  return (
    <div
      className="py-2 px-4"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="max-w-5xl mx-auto">
        <div className="pl-4 sm:pl-8 md:pl-12">
          <div className="flex items-start gap-3 flex-row-reverse">
            {/* User avatar */}
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <UserIcon className="h-4 w-4 text-primary" />
            </div>
            <div className="w-full min-w-0 flex flex-col items-end">
              {/* User message bubble: w-fit for adaptive width, max-w for right boundary */}
              <div className="relative w-fit max-w-[calc(100%-44px)] rounded-2xl pl-4 pr-10 py-2.5 bg-chat-user text-foreground">
                {/* Copy button — top-right inside bubble */}
                <div className="absolute top-1.5 right-1.5">
                  <CopyButton content={message.content} visible={isHovered} />
                </div>
                {message.content?.trim() && (
                  <MarkdownContent content={message.content} className="max-w-none break-words" />
                )}
                {imageAttachments.length > 0 && (
                  <div className={`flex flex-wrap gap-2 ${message.content?.trim() ? 'mt-2' : ''}`}>
                    {imageAttachments.map((img, idx) => (
                      <div key={idx} className="relative group">
                        <img
                          src={`data:${img.mimeType};base64,${img.base64Data}`}
                          alt={img.name}
                          className="max-h-48 max-w-[16rem] rounded-lg object-contain cursor-pointer border border-border hover:border-primary transition-colors"
                          title={img.name}
                          onClick={() =>
                            setExpandedImage(`data:${img.mimeType};base64,${img.base64Data}`)
                          }
                        />
                        <div className="absolute bottom-1 left-1 right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/50 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity truncate pointer-events-none">
                          <PhotoIcon className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{img.name}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1 pl-4 sm:pl-8 md:pl-12">
                {messageSkills.length > 0 && (
                  <div className="flex items-center gap-1.5 mr-1.5">
                    {messageSkills.map(skill => (
                      <div
                        key={skill.id}
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary-muted"
                        title={skill.description}
                      >
                        <PuzzleIcon className="h-2.5 w-2.5 text-primary" />
                        <span className="text-[10px] font-medium text-primary max-w-[60px] truncate">
                          {skill.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1 pl-4 sm:pl-8 md:pl-12">
                {message.modelName && (
                  <span className="text-[10px] text-secondary">{message.modelName}</span>
                )}
                <span className="text-[10px] text-muted">{formatTimestamp(message.timestamp)}</span>
                <button
                  onClick={handleDelete}
                  className={`p-0.5 rounded transition-colors ${
                    isHovered
                      ? 'text-red-400 hover:bg-red-500/10'
                      : 'text-transparent pointer-events-none'
                  }`}
                  title={i18nService.t('coworkDeleteFromMessage')}
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Image lightbox overlay */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Preview"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
});

const AssistantMessageItem: React.FC<{
  message: CoworkMessage;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showCopyButton?: boolean;
  sessionId?: string;
  forceThinkingExpanded?: boolean;
}> = ({
  message,
  resolveLocalFilePath,
  mapDisplayText,
  showCopyButton = false,
  sessionId,
  forceThinkingExpanded = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleDelete = useCallback(() => {
    if (!sessionId) return;
    void coworkService.deleteMessagesFrom(sessionId, message.id);
  }, [sessionId, message.id]);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;

  // Extract canvas shortcodes for inline preview rendering
  // Use default gateway port for [embed] URLs; MEDIA: paths don't need it
  const { text: strippedText, previews } = useMemo(() => {
    return extractCanvasShortcodes(displayContent, 42879);
  }, [displayContent]);

  // Check if thinking content exists
  const hasThinking = message.thinkingContent && message.thinkingContent.length > 0;
  const hasVisibleContent = Boolean(message.content || previews.length > 0);

  // Decide bubble width based on content:
  // - w-fit: bubble width follows content (adaptive)
  // - max-w-[calc(100%-44px)]: never exceeds the right boundary (aligned with avatar)
  const bubbleWidthClass = 'w-fit max-w-[calc(100%-44px)]';

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Thinking block - use direct Redux subscription for real-time updates */}
      {hasThinking && (
        <ThinkingStreamBlock messageId={message.id} forceExpanded={forceThinkingExpanded} />
      )}

      {/* Normal content */}
      {hasVisibleContent && (
        <div
          className={`relative rounded-2xl pl-4 pr-10 py-2.5 bg-chat-bot text-foreground ${bubbleWidthClass}`}
        >
          {/* Copy button — top-right inside bubble */}
          {showCopyButton && (
            <div className="absolute top-1.5 right-1.5">
              <CopyButton content={displayContent} visible={isHovered} />
            </div>
          )}
          {/* Inline canvas previews from MEDIA: paths */}
          {previews.length > 0 && <InlineCanvasPreviews previews={previews} />}
          {/* Markdown content with MEDIA: stripped */}
          {strippedText && (
            <MarkdownContent
              content={strippedText}
              className="max-w-none break-words"
              resolveLocalFilePath={resolveLocalFilePath}
              showRevealInFolderAction
            />
          )}
        </div>
      )}
      {hasVisibleContent && (
        <div className="flex items-center gap-1.5 pl-4">
          {message.modelName && (
            <span className="text-[10px] text-secondary">{message.modelName}</span>
          )}
          <span className="text-[10px] text-muted">{formatTimestamp(message.timestamp)}</span>
          {hasPositiveUsage(message.usage) && (
            <span className="text-[10px] text-muted tabular-nums">
              {message.usage.input != null && message.usage.input > 0 && (
                <>
                  <span title={`Input tokens: ${message.usage.input}`}>
                    ↑{formatTokenCount(message.usage.input)}
                  </span>
                  {message.usage.output != null && message.usage.output > 0 && (
                    <span className="mx-0.5">·</span>
                  )}
                </>
              )}
              {message.usage.output != null && message.usage.output > 0 && (
                <span title={`Output tokens: ${message.usage.output}`}>
                  ↓{formatTokenCount(message.usage.output)}
                </span>
              )}
            </span>
          )}
          <button
            onClick={handleDelete}
            className={`p-0.5 rounded transition-colors ${
              isHovered
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-transparent pointer-events-none'
            }`}
            title={i18nService.t('coworkDeleteFromMessage')}
          >
            <TrashIcon className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Subagent completion message item - displays when a subagent completes its task.
 * Uses a distinct avatar (CogIcon) to differentiate from main assistant messages.
 */
const SubagentCompletionMessageItem: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
}> = ({ message, mapDisplayText }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;

  // For collapsed view: extract only the first line so multi-line content
  // shows just the first line (not all lines compressed into one).
  const collapsedContent = React.useMemo(() => {
    const text = mapDisplayText ? mapDisplayText(message.content) : message.content;
    const firstLine = text.split('\n')[0]?.trim() || '';
    return firstLine;
  }, [mapDisplayText, message.content]);

  // Extract subagent info from metadata
  const taskLabel = (message.metadata?.taskLabel as string) || 'Subagent Task';
  const sessionKey = (message.metadata?.sessionKey as string) || '';

  return (
    <div
      className="relative px-4 py-2"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start gap-3">
          {/* Subagent avatar - CogIcon in teal/green color */}
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-teal-500/10 flex items-center justify-center">
            <CogIcon className="h-4 w-4 text-teal-500" />
          </div>
          {/* Content area */}
          <div className="w-full min-w-0">
            {/* Header row when collapsed: name+id on left, single-line markdown bubble on right */}
            {!isExpanded && (
              <div className="flex items-center gap-2 mb-1.5 max-w-[calc(100%-44px)]">
                {/* Subagent name + id — two-line stack on the left */}
                <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="flex flex-col shrink-0 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
                  title={`${taskLabel}${sessionKey ? '\n' + sessionKey : ''}`}
                >
                  <span
                    className="text-xs font-medium text-teal-600 truncate max-w-[140px]"
                    title={taskLabel}
                  >
                    {taskLabel}
                  </span>
                  {sessionKey && (
                    <span
                      className="text-[10px] text-muted truncate max-w-[140px]"
                      title={sessionKey}
                    >
                      {sessionKey}
                    </span>
                  )}
                </button>
                {/* Bubble-wrapped single-line markdown with right-edge fade */}
                <div
                  className="relative w-fit min-w-0 max-w-[calc(100%-48px)] cursor-pointer rounded-2xl px-4 py-2 bg-surface text-secondary shadow-subtle hover:text-foreground transition-colors"
                  onClick={() => setIsExpanded(true)}
                >
                  <div className="single-line-markdown mask-fade-right">
                    <MarkdownContent content={collapsedContent} className="max-w-none" />
                  </div>
                  {/* Chevron icon at right edge — visual affordance for "click to expand" */}
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
                    ›
                  </span>
                </div>
              </div>
            )}
            {/* Header row when expanded: collapse on left, detail entry on right */}
            {isExpanded && (
              <div className="flex items-start gap-1 mb-1.5">
                <button
                  type="button"
                  onClick={() => setIsExpanded(false)}
                  className="flex flex-col cursor-pointer hover:opacity-80 transition-opacity shrink-0"
                  title={`${taskLabel}${sessionKey ? '\n' + sessionKey : ''} (click to collapse)`}
                >
                <span
                  className="text-xs font-medium text-teal-600 truncate max-w-[200px]"
                  title={taskLabel}
                >
                  {taskLabel}
                </span>
                {sessionKey && (
                  <span
                    className="text-[10px] text-muted truncate max-w-[200px]"
                    title={sessionKey}
                  >
                    {sessionKey}
                  </span>
                )}
                <span className="text-[10px] text-muted">▼</span>
                </button>
              </div>
            )}
            {/* Expanded full content — shown below the header when expanded */}
            {isExpanded && displayContent && (
              <div className="relative rounded-2xl px-4 py-2 bg-surface text-foreground shadow-subtle w-fit max-w-[calc(100%-44px)] mt-1">
                <div className="absolute top-1.5 right-1.5">
                  <CopyButton content={displayContent} visible={isHovered} />
                </div>
                <MarkdownContent
                  content={displayContent}
                  className="max-w-none break-words text-sm"
                />
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-1 pl-4">
              {message.modelName && (
                <span className="text-[10px] text-secondary">{message.modelName}</span>
              )}
              <span className="text-[10px] text-muted">{formatTimestamp(message.timestamp)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const TypingDots: React.FC = () => (
  <div className="flex items-center space-x-1.5 py-1">
    <div
      className="w-2 h-2 rounded-full bg-primary animate-bounce"
      style={{ animationDelay: '0ms' }}
    />
    <div
      className="w-2 h-2 rounded-full bg-primary animate-bounce"
      style={{ animationDelay: '150ms' }}
    />
    <div
      className="w-2 h-2 rounded-full bg-primary animate-bounce"
      style={{ animationDelay: '300ms' }}
    />
  </div>
);

// Embedded thinking block for displaying thinking content at top of assistant message
// Uses useSyncExternalStore to bypass React-Redux batching and get real-time updates
const ThinkingStreamBlock: React.FC<{
  messageId: string;
  forceExpanded?: boolean;
}> = ({ messageId, forceExpanded = false }) => {
  // Local collapsed state - can be toggled independently per block
  const [localCollapsed, setLocalCollapsed] = useState(false);
  // Cache the snapshot result to avoid infinite loops
  const snapshotCacheRef = useRef<{
    content: string;
    isStreaming: boolean;
    globalExpanded: boolean;
  }>({
    content: '',
    isStreaming: true,
    globalExpanded: true,
  });

  // Subscribe directly to Redux store for real-time thinking content and status updates
  // This bypasses the useMemo caching in parent components
  const thinkingState = useSyncExternalStore(
    // subscribe function: called when component mounts/unmounts
    onStoreChange => {
      return store.subscribe(() => {
        const state = store.getState();
        const session = state.cowork.currentSession;
        const globalExpanded = state.cowork.thinkingExpanded;
        if (session) {
          const msg = session.messages.find(m => m.id === messageId);
          const newContent = msg?.thinkingContent || '';
          const newIsStreaming = msg?.metadata?.isStreaming ?? true;
          // Check if the snapshot would change
          if (
            newContent !== snapshotCacheRef.current.content ||
            newIsStreaming !== snapshotCacheRef.current.isStreaming ||
            globalExpanded !== snapshotCacheRef.current.globalExpanded
          ) {
            onStoreChange();
          }
        }
      });
    },
    // Get snapshot: returns cached thinking content and streaming status
    // Must return the same object reference if data hasn't changed
    () => {
      const state = store.getState();
      const session = state.cowork.currentSession;
      const globalExpanded = state.cowork.thinkingExpanded;
      if (session) {
        const msg = session.messages.find(m => m.id === messageId);
        const content = msg?.thinkingContent || '';
        const isStreaming = msg?.metadata?.isStreaming ?? true;

        // Only create new object if values actually changed
        if (
          content !== snapshotCacheRef.current.content ||
          isStreaming !== snapshotCacheRef.current.isStreaming ||
          globalExpanded !== snapshotCacheRef.current.globalExpanded
        ) {
          snapshotCacheRef.current = { content, isStreaming, globalExpanded };
        }
        return snapshotCacheRef.current;
      }
      // Return cached empty state (don't create new object)
      return snapshotCacheRef.current;
    },
  );

  const thinkingContent = thinkingState.content;
  const isStreaming = thinkingState.isStreaming;
  const globalExpanded = thinkingState.globalExpanded;

  // Sync local state with global state and streaming status
  // When global collapsed: keep blocks expanded while actively streaming,
  // collapse them once streaming completes. When global expanded: show all.
  const wasStreamingRef = useRef<boolean>(isStreaming);
  useEffect(() => {
    if (forceExpanded) {
      setLocalCollapsed(false);
    } else if (globalExpanded) {
      setLocalCollapsed(false);
    } else if (isStreaming) {
      // Globally collapsed but currently streaming — show until done
      setLocalCollapsed(false);
      wasStreamingRef.current = true;
    } else if (wasStreamingRef.current && !isStreaming) {
      // Streaming just finished while globally collapsed — fold it
      setLocalCollapsed(true);
      wasStreamingRef.current = false;
    } else {
      // Already done, not streaming — collapse per global setting
      setLocalCollapsed(true);
      wasStreamingRef.current = false;
    }
  }, [forceExpanded, globalExpanded, isStreaming]);

  if (!thinkingContent || thinkingContent.length === 0) return null;

  // Local toggle handler - only affects this block
  const handleToggle = () => {
    setLocalCollapsed(prev => !prev);
  };

  return (
    <div className="mt-4 mb-0">
      <div
        className="flex items-center gap-1.5 w-fit max-w-[calc(100%-44px)] text-[10px] text-muted-foreground cursor-pointer select-none"
        onClick={handleToggle}
      >
        <ChevronRightIcon
          className={`h-2.5 w-2.5 flex-shrink-0 transition-transform ${localCollapsed ? '' : 'rotate-90'}`}
        />
        <span>Thinking</span>
        {isStreaming && (
          <span className="flex items-center gap-0.5 ml-1">
            <span
              className="w-1 h-1 rounded-full bg-primary animate-bounce"
              style={{ animationDelay: '0ms' }}
            />
            <span
              className="w-1 h-1 rounded-full bg-primary animate-bounce"
              style={{ animationDelay: '150ms' }}
            />
            <span
              className="w-1 h-1 rounded-full bg-primary animate-bounce"
              style={{ animationDelay: '300ms' }}
            />
          </span>
        )}
      </div>
      {!localCollapsed && (
        <div className="mt-1.5 w-fit max-w-[calc(100%-44px)] p-2.5 rounded-md bg-slate-100/60 dark:bg-slate-800/20 border border-slate-200/50 dark:border-slate-700/30 max-h-64 overflow-y-auto">
          <div className="text-xs text-gray-500 [&_.markdown-content]:text-xs [&_.markdown-content_p]:!text-gray-500 [&_.markdown-content_strong]:!text-gray-600 [&_.markdown-content_li]:!text-gray-500 [&_.markdown-content_ul]:!text-gray-500 [&_.markdown-content_ol]:!text-gray-500 [&_p]:my-0 [&_p]:leading-5 [&_div.my-0.5]:my-0 [&_div.my-0.5]:mt-0.5 [&_code]:text-[0.85em] [&_pre]:my-0 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0">
            <MarkdownContent content={thinkingContent} className="max-w-none" />
          </div>
        </div>
      )}
    </div>
  );
};

export const AssistantTranscriptBlock: React.FC<{
  item?: Exclude<TranscriptItem, { type: 'user' }>;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  mapDisplayText?: (value: string) => string;
  showTypingIndicator?: boolean;
  showCopyButtons?: boolean;
  showAvatar?: boolean;
  compactWithPrevious?: boolean;
  compactWithNext?: boolean;
  isLastInToolSequence?: boolean;
  sessionId?: string;
  toolExpanded?: boolean;
  activeSearchItemId?: string | null;
}> = ({
  item,
  resolveLocalFilePath,
  mapDisplayText,
  showTypingIndicator = false,
  showCopyButtons = true,
  showAvatar = true,
  compactWithPrevious = false,
  compactWithNext = false,
  isLastInToolSequence = true,
  sessionId,
  toolExpanded = true,
  activeSearchItemId = null,
}) => {
  const renderSystemMessage = (message: CoworkMessage) => {
    const isError = !hasText(message.content) && typeof message.metadata?.error === 'string';
    const rawContent = hasText(message.content)
      ? message.content
      : typeof message.metadata?.error === 'string'
        ? message.metadata.error
        : '';
    const normalizedContent = getScheduledReminderDisplayText(rawContent) ?? rawContent;
    const content = mapDisplayText ? mapDisplayText(normalizedContent) : normalizedContent;
    if (!content.trim()) return null;

    return (
      <div className="rounded-lg border border-border bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          {isError ? (
            <ExclamationTriangleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
          ) : (
            <InformationCircleIcon className="h-4 w-4 text-secondary flex-shrink-0" />
          )}
          <div className="text-xs whitespace-pre-wrap text-secondary">{content}</div>
        </div>
      </div>
    );
  };

  const renderOrphanToolResult = (message: CoworkMessage) => {
    const toolResultDisplayRaw = getToolResultDisplay(message);
    const toolResultDisplay = mapDisplayText
      ? mapDisplayText(toolResultDisplayRaw)
      : toolResultDisplayRaw;
    const isToolError = Boolean(message.metadata?.isError || message.metadata?.error);
    const hasToolResultText = hasText(toolResultDisplay);
    const showNoDetailError = isToolError && !hasToolResultText;
    const fallbackText = showNoDetailError ? i18nService.t('coworkToolNoErrorDetail') : '';
    const displayText = hasToolResultText ? toolResultDisplay : fallbackText;
    return (
      <div className="py-1">
        <div className="flex items-start gap-2">
          <span
            className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
              isToolError ? 'bg-red-500' : 'bg-surface-raised'
            }`}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-secondary">
              {i18nService.t('coworkToolResult')}
            </div>
            {showNoDetailError && (
              <div className={`text-xs mt-0.5 ${isToolError ? 'text-red-500/80' : 'text-muted'}`}>
                {fallbackText}
              </div>
            )}
            {(hasToolResultText || showNoDetailError) && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-raised max-h-64 overflow-y-auto">
                <pre
                  className={`text-xs whitespace-pre-wrap break-words font-mono ${
                    isToolError
                      ? 'text-red-500'
                      : hasToolResultText
                        ? 'text-foreground'
                        : 'text-secondary italic'
                  }`}
                >
                  {displayText}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (!item) return null;
    if (!toolExpanded && (item.type === 'tool_group' || item.type === 'tool_result')) {
      return null;
    }

    if (item.type === 'assistant') {
      return (
        <AssistantMessageItem
          message={item.message}
          resolveLocalFilePath={resolveLocalFilePath}
          mapDisplayText={mapDisplayText}
          showCopyButton={showCopyButtons}
          sessionId={sessionId}
          forceThinkingExpanded={activeSearchItemId === item.message.id}
        />
      );
    }

    if (item.type === 'tool_group') {
      return (
        <ToolCallGroup
          group={item.group}
          isLastInSequence={isLastInToolSequence}
          mapDisplayText={mapDisplayText}
          forceExpanded={activeSearchItemId === `tool-${item.group.toolUse.id}`}
        />
      );
    }

    if (item.type === 'system') {
      return renderSystemMessage(item.message);
    }

    if (item.type === 'subagent_completion') {
      return (
        <SubagentCompletionMessageItem
          message={item.message}
          mapDisplayText={mapDisplayText}
        />
      );
    }

    return renderOrphanToolResult(item.message);
  };

  const content = renderContent();
  if (!content && !showTypingIndicator) return null;

  const blockPaddingClass = compactWithPrevious
    ? compactWithNext
      ? 'px-4 py-0'
      : 'px-4 pt-0 pb-2'
    : compactWithNext
      ? 'px-4 pt-2 pb-0'
      : 'px-4 py-2';
  const contentPaddingClass = compactWithPrevious
    ? compactWithNext
      ? 'py-0'
      : 'pt-0 pb-3'
    : compactWithNext
      ? 'pt-3 pb-0'
      : 'py-3';

  return (
    <div className={blockPaddingClass}>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start gap-3">
          {/* Assistant avatar */}
          {showAvatar ? (
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center">
              <SparklesIcon className="h-4 w-4 text-purple-500" />
            </div>
          ) : (
            <div className="flex-shrink-0 w-8" aria-hidden="true" />
          )}
          {/* Content area with fixed width to prevent layout shift */}
          <div className={`w-full min-w-0 px-0 ${contentPaddingClass} space-y-3`}>
            {content}
            {showTypingIndicator && <TypingDots />}
          </div>
        </div>
      </div>
    </div>
  );
};
