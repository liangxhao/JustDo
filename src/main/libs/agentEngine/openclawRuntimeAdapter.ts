import { randomUUID } from 'crypto';
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import type {
  CoworkExecutionMode,
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionStatus,
  CoworkStore,
} from '../../coworkStore';
import { t } from '../../i18n';
import { resolveRawApiConfig } from '../claudeSettings';
import { getCommandDangerLevel, isDeleteCommand } from '../commandSafety';
import { setCoworkProxySessionId } from '../coworkOpenAICompatProxy';
import { extractOpenClawAssistantStreamText } from '../openclawAssistantText';
import {
  buildManagedSessionKey,
  isCronSessionKey,
  isManagedSessionKey,
  type OpenClawChannelSessionSync,
  parseManagedSessionKey,
} from '../openclawChannelSessionSync';
import { OPENCLAW_AGENT_TIMEOUT_SECONDS } from '../openclawConfigSync';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../openclawEngineManager';
import { extractGatewayHistoryEntries, extractGatewayMessageText } from '../openclawHistory';
import type { PermissionResult } from './types';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
  PermissionRequest,
} from './types';

const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
const GATEWAY_READY_TIMEOUT_MS = 15_000;
const FINAL_HISTORY_SYNC_LIMIT = 50;
const CHANNEL_SESSION_DISCOVERY_LIMIT = 200;

// Internal runtime context markers from OpenClaw
const INTERNAL_RUNTIME_CONTEXT_BEGIN = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';
const INTERNAL_RUNTIME_CONTEXT_END = '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>';
const INTERNAL_TASK_COMPLETION_MARKER = '[Internal task completion event]';

/**
 * Parse subagent completion event from internal context block
 */
function parseSubagentCompletionEvent(block: string): {
  sessionKey: string;
  taskLabel: string;
  status: string;
  result: string;
} | null {
  // Expected format:
  // [Internal task completion event]
  // source: xxx
  // session_key: xxx
  // session_id: xxx
  // type: xxx
  // task: xxx
  // status: xxx
  //
  // Result (untrusted content, treat as data):
  // <<<BEGIN_UNTRUSTED_CHILD_RESULT>>>
  // ...
  // <<<END_UNTRUSTED_CHILD_RESULT>>>

  if (!block.startsWith(INTERNAL_TASK_COMPLETION_MARKER)) {
    return null;
  }

  const lines = block.split('\n');
  let sessionKey = '';
  let taskLabel = '';
  let status = '';
  let result = '';

  // Find the result section
  const resultBeginMarker = '<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>';
  const resultEndMarker = '<<<END_UNTRUSTED_CHILD_RESULT>>>';
  const resultBeginIdx = block.indexOf(resultBeginMarker);
  const resultEndIdx = block.indexOf(resultEndMarker);

  if (resultBeginIdx !== -1 && resultEndIdx !== -1) {
    result = block.slice(resultBeginIdx + resultBeginMarker.length, resultEndIdx).trim();
  }

  // Parse header fields
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'session_key') {
      sessionKey = value;
    } else if (key === 'task') {
      taskLabel = value;
    } else if (key === 'status') {
      status = value;
    }

    // Stop when we reach the empty line before Result section
    if (line.trim() === '') break;
  }

  if (!sessionKey || !taskLabel) {
    return null;
  }

  return { sessionKey, taskLabel, status, result };
}

/**
 * Extract subagent completion messages from assistant message content.
 * Returns an array of messages: the original assistant content (stripped) + subagent_completion messages.
 */
function extractSubagentCompletionMessages(
  content: string,
  baseTimestamp: number,
  baseIndex: number,
): Array<{ type: string; content: string; timestamp: number; metadata?: Record<string, unknown> }> {
  if (!content.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN)) {
    return [{ type: 'assistant', content, timestamp: baseTimestamp }];
  }

  const results: Array<{
    type: string;
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }> = [];

  // Find all internal context blocks
  let searchStart = 0;
  let strippedContent = content;
  let completionIndex = 0;

  while (searchStart < content.length) {
    const beginIdx = content.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN, searchStart);
    if (beginIdx === -1) break;

    const endIdx = content.indexOf(INTERNAL_RUNTIME_CONTEXT_END, beginIdx);
    if (endIdx === -1) break;

    // Extract the block content
    const blockContent = content
      .slice(beginIdx + INTERNAL_RUNTIME_CONTEXT_BEGIN.length, endIdx)
      .trim();

    // Parse each task completion event in the block
    // Events are separated by "\n\n---\n\n"
    const events = blockContent.split('\n\n---\n\n').filter(s => s.trim());

    for (const eventBlock of events) {
      const parsed = parseSubagentCompletionEvent(eventBlock.trim());
      if (parsed) {
        results.push({
          type: 'subagent_completion',
          content: parsed.result,
          timestamp: baseTimestamp + completionIndex, // Slight offset for ordering
          metadata: {
            sessionKey: parsed.sessionKey,
            taskLabel: parsed.taskLabel,
            status: parsed.status,
            isSubagentCompletion: true,
          },
        });
        completionIndex++;
      }
    }

    searchStart = endIdx + INTERNAL_RUNTIME_CONTEXT_END.length;
  }

  // Strip the internal context from the assistant content
  // Use a regex-based approach to remove all blocks
  let finalContent = content;
  const beginPattern = INTERNAL_RUNTIME_CONTEXT_BEGIN;
  const endPattern = INTERNAL_RUNTIME_CONTEXT_END;

  while (finalContent.includes(beginPattern)) {
    const start = finalContent.indexOf(beginPattern);
    const end = finalContent.indexOf(endPattern, start);
    if (end === -1) break;
    finalContent =
      finalContent.slice(0, start).trimEnd() +
      '\n\n' +
      finalContent.slice(end + endPattern.length).trimStart();
  }

  finalContent = finalContent.trim();
  if (finalContent) {
    // Insert the stripped assistant message at the beginning
    results.unshift({ type: 'assistant', content: finalContent, timestamp: baseTimestamp });
  }

  return results;
}

type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
};

type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  /** Alternative field name used by some gateway events (e.g., agent lifecycle events) */
  session?: string;
  stream?: string;
  data?: unknown;
  /** Gateway tool event fields: tool='result:sessions_spawn', call='toolCallId', meta='label xxx' */
  tool?: string;
  call?: string;
  meta?: string;
  err?: boolean;
};

/**
 * Generate stable message id from entry data
 * Uses toolUseId for tool messages, otherwise uses role + content hash
 */
function generateStableMessageId(
  entry: { role: string; text: string; metadata?: Record<string, unknown> },
  index: number,
): string {
  // For tool_use and tool_result, use toolUseId from metadata (stable across refreshes)
  if (entry.role === 'tool_use' || entry.role === 'tool_result') {
    const toolUseId = entry.metadata?.toolUseId;
    if (typeof toolUseId === 'string' && toolUseId) {
      return `subagent-${entry.role}-${toolUseId}`;
    }
  }
  // For other messages, use role + index + content prefix (stable if order unchanged)
  const contentPrefix = entry.text.slice(0, 50).replace(/\s+/g, '-');
  return `subagent-msg-${entry.role}-${index}-${contentPrefix}`;
}

/**
 * Convert GatewayHistoryEntry array to CoworkMessage array
 * Handles extraction of subagent completion messages from assistant content.
 */
function convertEntriesToCoworkMessages(
  entries: Array<{ role: string; text: string; metadata?: Record<string, unknown> }>,
): CoworkMessage[] {
  const now = Date.now();
  const results: CoworkMessage[] = [];
  let subIdx = 0;

  for (const entry of entries) {
    // For assistant messages, check for internal context blocks
    if (entry.role === 'assistant' && entry.text.includes(INTERNAL_RUNTIME_CONTEXT_BEGIN)) {
      const extracted = extractSubagentCompletionMessages(entry.text, now, subIdx);
      for (const msg of extracted) {
        const id =
          msg.type === 'subagent_completion'
            ? `subagent-completion-${msg.metadata?.sessionKey}-${subIdx}`
            : generateStableMessageId(
                { role: msg.type, text: msg.content, metadata: entry.metadata },
                subIdx,
              );
        results.push({
          id,
          type: msg.type as CoworkMessage['type'],
          content: msg.content,
          timestamp: msg.timestamp,
          metadata: msg.metadata ?? entry.metadata,
        });
        subIdx++;
      }
    } else {
      results.push({
        id: generateStableMessageId(entry, subIdx),
        type: entry.role as CoworkMessage['type'],
        content: entry.text,
        timestamp: now,
        metadata: entry.metadata,
      });
      subIdx++;
    }
  }

  return results;
}

/**
 * Mark the first user message as Subagent Context if it starts with [Subagent Context].
 * Used when memory is cleared after restart to restore the blue background styling.
 */
function markSubagentContextMessage(messages: CoworkMessage[]): CoworkMessage[] {
  if (messages.length === 0) return messages;
  const firstUserIndex = messages.findIndex(m => m.type === 'user');
  if (firstUserIndex === -1) return messages;

  const firstUserMsg = messages[firstUserIndex];
  const content = firstUserMsg.content;

  // Check if content starts with [Subagent Context] marker
  if (!content || !content.startsWith('[Subagent Context]')) return messages;
  if (firstUserMsg.metadata?.isSubagentContext) return messages; // Already marked

  // Only mark the flag, keep original content
  messages[firstUserIndex] = {
    ...firstUserMsg,
    metadata: {
      ...firstUserMsg.metadata,
      isSubagentContext: true,
    },
  };
  console.log('[markSubagentContextMessage] marked first user message as Subagent Context');
  return messages;
}

/**
 * Convert simple role/content format to CoworkMessage format
 */
function convertToCoworkMessage(
  msg: { role: string; content: string; metadata?: Record<string, unknown> },
  index: number,
): CoworkMessage {
  const msgType: CoworkMessage['type'] =
    msg.role === 'assistant'
      ? 'assistant'
      : msg.role === 'user'
        ? 'user'
        : msg.role === 'tool_use'
          ? 'tool_use'
          : msg.role === 'tool_result'
            ? 'tool_result'
            : 'system';
  const now = Date.now();
  // Generate stable id using metadata.toolUseId or content prefix
  const toolUseId = msg.metadata?.toolUseId;
  const stableId =
    typeof toolUseId === 'string' && toolUseId
      ? `subagent-${msg.role}-${toolUseId}`
      : `subagent-msg-${msg.role}-${index}-${msg.content.slice(0, 50).replace(/\s+/g, '-')}`;
  return {
    id: stableId,
    type: msgType,
    content: msg.content,
    timestamp: now,
    metadata: msg.metadata,
  };
}

/**
 * Convert array of simple role/content messages to CoworkMessage[]
 */
function convertToCoworkMessages(
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>,
): CoworkMessage[] {
  return messages.map((msg, idx) => convertToCoworkMessage(msg, idx));
}

type ExecApprovalRequestedPayload = {
  id?: string;
  request?: {
    command?: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

type ExecApprovalResolvedPayload = {
  id?: string;
};

type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

type ActiveTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  turnToken: number;
  knownRunIds: Set<string>;
  assistantMessageId: string | null;
  committedAssistantText: string;
  currentAssistantSegmentText: string;
  currentText: string;
  /** Highest text length from agent assistant events (immune to chat delta noise). */
  agentAssistantTextLength: number;
  currentContentText: string;
  currentContentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  textStreamMode: TextStreamMode;
  toolUseMessageIdByToolCallId: Map<string, string>;
  toolResultMessageIdByToolCallId: Map<string, string>;
  toolResultTextByToolCallId: Map<string, string>;
  stopRequested: boolean;
  /** True while async user message prefetch is in progress for channel sessions. */
  pendingUserSync: boolean;
  /** Chat events buffered while pendingUserSync is true. */
  bufferedChatPayloads: BufferedChatEvent[];
  /** Agent events buffered while pendingUserSync is true. */
  bufferedAgentPayloads: BufferedAgentEvent[];
  /** Client-side timeout watchdog timer (fallback for missing gateway abort events). */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Message ID for current thinking stream (created on first thinking event). */
  currentThinkingMessageId: string | null;
  /** Accumulated thinking content for current stream. */
  currentThinkingContent: string;
  /** True when thinking stream has ended (first text or non-thinking event received). */
  thinkingStreamEnded: boolean;
  /** Model name for this turn's assistant messages (captured at turn start). */
  modelName: string;
};

type BufferedChatEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type BufferedAgentEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

type PendingApprovalEntry = {
  requestId: string;
  sessionId: string;
  /** When true, use 'allow-always' decision so OpenClaw adds the command to its allowlist. */
  allowAlways?: boolean;
};

type ChannelHistorySyncEntry = {
  role: 'user' | 'assistant';
  text: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const isSameChannelHistoryEntry = (
  left: ChannelHistorySyncEntry,
  right: ChannelHistorySyncEntry,
): boolean => {
  return left.role === right.role && left.text === right.text;
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

/** Strip Discord mention markup: <@userId>, <@!userId>, <#channelId>, <@&roleId> */
const stripDiscordMentions = (text: string): string =>
  text
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .trim();

const extractMessageText = extractGatewayMessageText;

const summarizeGatewayMessageShape = (message: unknown): string => {
  if (!isRecord(message)) {
    return `non-record:${typeof message}`;
  }

  const role = typeof message.role === 'string' ? message.role : '?';
  const content = message.content;
  if (typeof content === 'string') {
    return `role=${role} content=string(${content.length}) text="${truncate(content, 120)}"`;
  }
  if (Array.isArray(content)) {
    const parts = content.map(item => {
      if (!isRecord(item)) return typeof item;
      const type = typeof item.type === 'string' ? item.type : 'object';
      const text = typeof item.text === 'string' ? `:${truncate(item.text, 60)}` : '';
      return `${type}${text}`;
    });
    return `role=${role} content=[${parts.join(', ')}]`;
  }
  if (isRecord(content)) {
    return `role=${role} contentKeys=${Object.keys(content).join(',')}`;
  }
  if (typeof message.text === 'string') {
    return `role=${role} text=${truncate(message.text, 120)}`;
  }
  return `role=${role} keys=${Object.keys(message).join(',')}`;
};

const extractTextBlocksAndSignals = (
  message: unknown,
): { textBlocks: string[]; sawNonTextContentBlocks: boolean } => {
  if (!isRecord(message)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const content = message.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return {
      textBlocks: [],
      sawNonTextContentBlocks: false,
    };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof block.type === 'string' && block.type !== 'thinking') {
      sawNonTextContentBlocks = true;
      console.log(
        '[Debug:extractBlocks] non-text block type:',
        block.type,
        'content:',
        JSON.stringify(block).slice(0, 500),
      );
    }
  }

  return {
    textBlocks,
    sawNonTextContentBlocks,
  };
};

/**
 * Extract thinking (reasoning) content from a gateway message.
 * Gateway messages may have content as an array of blocks, where
 * thinking blocks have type='thinking' with a 'thinking' or 'text' field.
 */
const extractThinkingContent = (message: unknown): string => {
  if (!isRecord(message)) return '';
  const content = message.content;
  if (!Array.isArray(content)) return '';

  const thinkingParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'thinking') {
      const thinking =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : '';
      if (thinking) {
        thinkingParts.push(thinking);
      }
    }
  }
  return thinkingParts.join('\n');
};

/**
 * Extract file paths from assistant "message" tool calls in chat.history.
 * Only scans messages after the last user message (current turn).
 * The model sends files to Telegram using: toolCall { name: "message", arguments: { action: "send", filePath: "..." } }
 */
const extractSentFilePathsFromHistory = (messages: unknown[]): string[] => {
  // Find the last user message index to scope to current turn only
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const filePaths: string[] = [];
  const seen = new Set<string>();
  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!isRecord(block)) continue;
      if (block.type !== 'toolCall' || block.name !== 'message') continue;
      const args = block.arguments;
      if (!isRecord(args)) continue;
      const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        filePaths.push(filePath);
      }
    }
  }
  return filePaths;
};

/**
 * Extract and concatenate all assistant text from the current turn in chat.history.
 * The current turn starts after the last user message.
 */
const extractCurrentTurnAssistantText = (messages: unknown[]): string => {
  // Find the last user message index (turn boundary)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isRecord(msg) && (msg as Record<string, unknown>).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const textParts: string[] = [];
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
    if (role !== 'assistant') continue;
    const text = extractMessageText(msg).trim();
    if (text) {
      textParts.push(text);
    }
  }
  return textParts.join('\n\n');
};

const isDroppedBoundaryTextBlockSubset = (
  streamedTextBlocks: string[],
  finalTextBlocks: string[],
): boolean => {
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }
  if (finalTextBlocks.every((block, index) => streamedTextBlocks[index] === block)) {
    return true;
  }
  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
};

const extractToolText = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const lines = payload.map(item => extractToolText(item).trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }

  if (!isRecord(payload)) {
    if (payload === undefined || payload === null) return '';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text;
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    return payload.output;
  }
  if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
    const chunks = [
      typeof payload.stdout === 'string' ? payload.stdout : '',
      typeof payload.stderr === 'string' ? payload.stderr : '',
    ].filter(Boolean);
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  // Check for error field (common in error responses)
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  // Also check for message field (common in error objects)
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }

  const content = payload.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) {
        chunks.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && item.text.trim()) {
        chunks.push(item.text);
        continue;
      }
      if (typeof item.content === 'string' && item.content.trim()) {
        chunks.push(item.content);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const toToolInputRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
};

const computeSuffixPrefixOverlap = (left: string, right: string): number => {
  const leftProbe = left.slice(-256);
  const rightProbe = right.slice(0, 256);
  const maxOverlap = Math.min(leftProbe.length, rightProbe.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftProbe.slice(-size) === rightProbe.slice(0, size)) {
      return size;
    }
  }
  return 0;
};

const mergeStreamingText = (
  previousText: string,
  incomingText: string,
  mode: TextStreamMode,
): { text: string; mode: TextStreamMode } => {
  if (!incomingText) {
    return { text: previousText, mode };
  }
  if (!previousText) {
    return { text: incomingText, mode };
  }
  if (incomingText === previousText) {
    return { text: previousText, mode };
  }

  if (mode === 'snapshot') {
    if (previousText.startsWith(incomingText) && incomingText.length < previousText.length) {
      return { text: previousText, mode };
    }
    return { text: incomingText, mode };
  }

  if (mode === 'delta') {
    if (incomingText.startsWith(previousText)) {
      return { text: incomingText, mode: 'snapshot' };
    }
    const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
    return { text: previousText + incomingText.slice(overlap), mode };
  }

  if (incomingText.startsWith(previousText)) {
    return { text: incomingText, mode: 'snapshot' };
  }
  if (previousText.startsWith(incomingText)) {
    return { text: previousText, mode: 'snapshot' };
  }
  if (incomingText.includes(previousText) && incomingText.length > previousText.length) {
    return { text: incomingText, mode: 'snapshot' };
  }

  const overlap = computeSuffixPrefixOverlap(previousText, incomingText);
  if (overlap > 0) {
    return { text: previousText + incomingText.slice(overlap), mode: 'delta' };
  }

  return { text: previousText + incomingText, mode: 'delta' };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`OpenClaw gateway client connect timeout after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export class OpenClawRuntimeAdapter extends EventEmitter implements CoworkRuntime {
  private readonly store: CoworkStore;
  private readonly engineManager: OpenClawEngineManager;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sessionIdBySessionKey = new Map<string, string>();
  private readonly sessionIdByRunId = new Map<string, string>();
  private readonly pendingAgentEventsByRunId = new Map<string, AgentEventPayload[]>();
  private readonly lastChatSeqByRunId = new Map<string, number>();
  /** Track processed announce runId finals to prevent duplicate message creation. */
  private readonly processedAnnounceRunIds = new Set<string>();
  /** Accumulated thinking content from subagent announce runs, keyed by runId. */
  private readonly subagentThinkingByRunId = new Map<string, string>();
  /**
   * Buffered tool events from announce runIds, keyed by runId.
   * Tool events (session.tool) from announcing subagents arrive before the chat
   * final text message. We buffer them so the announce text displays first.
   */
  private readonly bufferedToolEventsByRunId = new Map<string, { payload: unknown }[]>();
  /** Timeout handles for buffered tool events (safety net if chat final never arrives). */
  private readonly bufferedToolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastAgentSeqByRunId = new Map<string, number>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly pendingTurns = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly confirmationModeBySession = new Map<string, 'modal' | 'text'>();
  private readonly gatewayHistoryCountBySession = new Map<string, number>();
  private readonly latestTurnTokenBySession = new Map<string, number>();

  /**
   * Sessions that were manually stopped by the user via stopSession().
   * Maps sessionId → timestamp of when stop was requested.
   * Used to suppress automatic ActiveTurn re-creation from late-arriving
   * OpenClaw Gateway events (e.g. POPO/Telegram channel events that arrive
   * after the user clicked Stop).  Entries expire after STOP_COOLDOWN_MS.
   */
  private readonly stoppedSessions = new Map<string, number>();
  private static readonly STOP_COOLDOWN_MS = 10_000; // 10 seconds

  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  /** Holds the client between start() and onHelloOk so stopGatewayClient can clean it up. */
  private pendingGatewayClient: GatewayClientLike | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  /** Serializes concurrent calls to ensureGatewayClientReady to prevent duplicate clients. */
  private gatewayClientInitLock: Promise<void> | null = null;
  private channelSessionSync: OpenClawChannelSessionSync | null = null;
  private readonly knownChannelSessionIds = new Set<string>();
  private readonly fullySyncedSessions = new Set<string>();
  /** Per-session cursor: number of gateway history entries (user+assistant) already synced locally. */
  private readonly channelSyncCursor = new Map<string, number>();
  /** Sessions re-created after user deletion — use latestOnly sync to avoid replaying old history. */
  private readonly reCreatedChannelSessionIds = new Set<string>();
  /** Channel sessionKeys explicitly deleted by the user. Polling will not re-create these. */
  private readonly deletedChannelKeys = new Set<string>();
  /** Sessions that were manually stopped by the user. Used to suppress the timeout hint
   *  when the gateway sends back a late 'aborted' event after stopSession() already cleaned up the turn. */
  private readonly manuallyStoppedSessions = new Set<string>();
  /** Session keys whose origin is "heartbeat" — discovered via polling, used to filter real-time events. */
  private readonly heartbeatSessionKeys = new Set<string>();
  private channelPollingTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly CHANNEL_POLL_INTERVAL_MS = 10_000;
  private static readonly FULL_HISTORY_SYNC_LIMIT = 50;
  private browserPrewarmAttempted = false;

  /** Gateway WS auto-reconnect state */
  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  /** Set to true before intentionally stopping the client (e.g. version upgrade) to suppress auto-reconnect. */
  private gatewayStoppingIntentionally = false;
  private static readonly GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000]; // ms

  /** Gateway tick heartbeat watchdog state */
  private lastTickTimestamp = 0;
  /** Last time we received any agent event — used to detect false tick timeout during heavy activity. */
  private lastAgentActivityTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly TICK_WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
  private static readonly TICK_TIMEOUT_MS = 90_000; // 3 tick cycles (30s each) without response → dead
  /** Agent activity within this window proves connection is alive even without tick. */
  private static readonly AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000; // 60s

  /** Throttle state for messageUpdate IPC emissions during streaming */
  private lastMessageUpdateEmitTime: Map<string, number> = new Map();
  private pendingMessageUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly MESSAGE_UPDATE_THROTTLE_MS = 200;

  /** Throttle state for SQLite store writes during streaming */
  private lastStoreUpdateTime: Map<string, number> = new Map();
  private pendingStoreUpdateTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly STORE_UPDATE_THROTTLE_MS = 250;

  /**
   * Server-side agent timeout in seconds (mirrors agents.defaults.timeoutSeconds in openclaw config).
   * Used to set a client-side fallback timer that fires slightly after the server timeout,
   * so GucciAI can recover even when the gateway fails to deliver the abort event.
   */
  agentTimeoutSeconds = OPENCLAW_AGENT_TIMEOUT_SECONDS;
  private static readonly CLIENT_TIMEOUT_GRACE_MS = 30_000;

  /** 子 Agent 消息历史: agentId/label → 消息数组 */
  private readonly subagentMessages = new Map<
    string,
    Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
  >();

  // Track which non-thinking stream types we've already logged (avoid spam)
  private readonly _loggedThinkingStreamTypes = new Set<string>();
  /** Dedup set for tool events: same (phase + toolCallId) arriving via stream=tool and stream=item. */
  private readonly _processedToolEvents = new Set<string>();
  /** Track toolUseIds created from subagent handler to avoid duplicate messages in main session */
  private readonly _announceToolMessages = new Set<string>();
  /** 子 Agent 完成状态: agentId/label → 'pending' | 'running' | 'done' | 'failed' */
  private readonly subagentStatus = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
  /** 失败的子 Agent toolCallId 集合（启动失败，应从显示列表中移除） */
  private readonly failedSubagentIds = new Set<string>();
  /** 成功 spawn 的子 Agent toolCallId 集合（spawn 返回 isError=false），生命周期 error 不标记这些为失败 */
  private readonly successfulSpawnToolCallIds = new Set<string>();
  /** Per-session orchestration tracking: sessionId -> true. Replaces single-value orchestrationParentSessionId to support concurrent sessions. */
  private readonly orchestrationSessionIds = new Set<string>();
  /** @deprecated Use orchestrationSessionIds instead. Kept for backward compat with getSubagentStatuses caller. */
  private orchestrationParentSessionId: string | null = null;
  /** 主 agent 生命周期是否已结束（用于不同 runId final 事件后的完成检查） */
  private mainAgentLifecycleEnded = false;
  /** childSessionKey → label 反向映射（用于显示） */
  private readonly sessionKeyToLabel = new Map<string, string>();
  /** toolCallId → childSessionKey 映射，用于通过 toolUseId 查找子会话 */
  private readonly toolCallIdToSessionKey = new Map<string, string>();
  /** childSessionKey → toolCallId 反向映射 */
  private readonly sessionKeyToToolCallId = new Map<string, string>();
  /** toolCallId → parentSessionId 映射，用于判断subagent属于哪个主session */
  private readonly toolCallIdToParentSessionId = new Map<string, string>();
  /** toolCallId → args 映射，用于在 result 阶段获取 sessions_spawn 的参数 */
  private readonly toolCallArgs = new Map<string, Record<string, unknown>>();
  /** toolCallId → label 映射，用于显示名称 */
  private readonly toolCallIdToLabel = new Map<string, string>();
  /** subagent UUID → label mapping (for nested subagents identified by sessionKey UUID) */
  private readonly subagentUuidToLabel = new Map<string, string>();
  /** 正在等待 sessionKey 的 toolCallId 集合 */
  private readonly pendingToolCallIds = new Set<string>();
  /** Pending subagent timeout: toolCallId → timestamp when it entered pending state */
  private readonly pendingEntryTimestamps = new Map<string, number>();
  private static readonly PENDING_TIMEOUT_MS = 30_000; // 30s without lifecycle events → failed
  /** Subagent idle timeout: if a subagent in 'running' state has no activity for this duration,
   *  mark it as failed. This catches cases where the gateway stops sending events (e.g. quota
   *  exceeded as the last event) but the subagent internally completed. 10 minutes is conservative
   *  enough to avoid false positives for legitimate long-running tasks with intermittent activity. */
  private static readonly SUBAGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  /** Subagent activity tracker: toolCallId → last seen activity timestamp.
   *  Used to detect stuck subagents — if no activity within the timeout window,
   *  the subagent is marked as failed regardless of its 'running' status. */
  private readonly subagentLastActivity = new Map<string, number>();

  /** Track toolCallIds that were created via item-level handler (stream=item).
   *  These spawns come from announce runs and may not have lifecycle events.
   *  Used for orphan detection in getSubagentStatuses. */
  private readonly itemLevelSpawnedToolCallIds = new Set<string>();

  /** Cross-reference: UUID → call_... toolCallId.
   *  Nested lifecycle phase=start uses sessionKey UUID as key, but context messages
   *  are stored under call_... keys by the sessions_spawn handler. This map bridges
   *  the gap so getSubTaskHistory can find context when queried by UUID. */
  private readonly uuidToToolCallId = new Map<string, string>();

  constructor(store: CoworkStore, engineManager: OpenClawEngineManager) {
    super();
    this.store = store;
    this.engineManager = engineManager;
  }

  setChannelSessionSync(sync: OpenClawChannelSessionSync): void {
    this.channelSessionSync = sync;
  }

  /**
   * Resolve the correct parent session ID for a subagent.
   * Uses per-subagent mapping (toolCallIdToParentSessionId) when available,
   * falling back to orchestrationParentSessionId for compatibility.
   * This prevents cross-session message leakage when multiple sessions
   * have active subagents concurrently.
   */
  private resolveSubagentParentSessionId(agentId: string): string | null {
    // Prefer per-subagent mapping — this is the authoritative source
    const mappedParent = this.toolCallIdToParentSessionId.get(agentId);
    if (mappedParent) return mappedParent;
    // Fallback: if only one orchestration session exists, use it safely
    if (this.orchestrationSessionIds.size === 1) {
      return Array.from(this.orchestrationSessionIds)[0];
    }
    // Multiple concurrent sessions — do NOT guess, return null
    return this.orchestrationParentSessionId;
  }

  /**
   * Fetch session history from OpenClaw by sessionKey and return a transient
   * CoworkSession object (not persisted to local database).
   * First checks if a local session already exists via channel sync.
   * Returns a CoworkSession if successful, or null.
   */
  async fetchSessionByKey(sessionKey: string): Promise<CoworkSession | null> {
    const managedSession = parseManagedSessionKey(sessionKey);
    if (managedSession) {
      return this.store.getSession(managedSession.sessionId) ?? null;
    }

    // 1. Try existing local session via channel/main-agent resolution
    if (this.channelSessionSync) {
      const existingId = this.channelSessionSync.resolveSession(sessionKey);
      if (existingId) {
        const session = this.store.getSession(existingId);
        if (session && session.messages.length > 0) {
          return session;
        }
      }
    }

    // 2. Fetch history from OpenClaw server and build a transient session object
    const client = this.gatewayClient;
    if (!client) return null;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        return this.readFromDeletedTranscript(sessionKey);
      }

      const now = Date.now();
      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const entry of extractGatewayHistoryEntries(history.messages)) {
        messages.push({
          id: `transient-${msgIndex++}`,
          type: entry.role,
          content: entry.text,
          timestamp: now,
          metadata: entry.role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
        });
      }

      if (messages.length === 0) return null;

      // Return a transient session (not saved to database)
      return {
        id: `transient-${sessionKey}`,
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        agentId: 'main',
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      console.error('[OpenClawRuntime] fetchSessionByKey: failed to fetch history:', error);
      return null;
    }
  }

  /**
   * Fallback for fetchSessionByKey when chat.history returns no messages.
   *
   * openclaw's maintenance logic may archive a session transcript by renaming
   * `{sessionId}.jsonl` → `{sessionId}.jsonl.deleted.{timestamp}` while the
   * session entry remains in sessions.json. In that case chat.history cannot
   * find the file (it only looks for the plain `.jsonl` path) and returns [].
   * This method reads the archived file directly from disk.
   */
  private async readFromDeletedTranscript(sessionKey: string): Promise<CoworkSession | null> {
    try {
      // Extract agentId from "agent:{agentId}:..." pattern
      const agentMatch = sessionKey.match(/^agent:([^:]+):/);
      const agentId = agentMatch?.[1] ?? 'main';

      // Extract sessionId from "...run:{uuid}" pattern (runId equals sessionId)
      const runMatch = sessionKey.match(/(?:^|:)run:([0-9a-f-]{36})(?:$|:)/i);
      const sessionId = runMatch?.[1];
      if (!sessionId) return null;

      const stateDir = this.engineManager.getStateDir();
      const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions');

      const files = await fs.promises.readdir(sessionsDir).catch(() => [] as string[]);
      const deletedFile = files.find(f => f.startsWith(`${sessionId}.jsonl.deleted.`));
      if (!deletedFile) {
        console.log(
          '[OpenClawRuntime] readFromDeletedTranscript: no archived transcript found for sessionId:',
          sessionId,
        );
        return null;
      }

      console.log(
        '[OpenClawRuntime] readFromDeletedTranscript: reading archived transcript:',
        deletedFile,
      );
      const filePath = path.join(sessionsDir, deletedFile);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);

      const messages: CoworkMessage[] = [];
      let msgIndex = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed?.type !== 'message' || !parsed.message) continue;
          const msg = parsed.message as { role?: string; content?: unknown; timestamp?: number };
          const role = msg.role;
          if (role !== 'user' && role !== 'assistant') continue;

          const msgContent = msg.content;
          const text = Array.isArray(msgContent)
            ? (msgContent as Array<Record<string, unknown>>)
                .filter(b => b?.type === 'text')
                .map(b => b.text as string)
                .join('\n')
            : typeof msgContent === 'string'
              ? msgContent
              : '';

          if (!text.trim()) continue;

          const timestamp =
            typeof msg.timestamp === 'number'
              ? msg.timestamp
              : typeof parsed.timestamp === 'string'
                ? Date.parse(parsed.timestamp)
                : Date.now();

          messages.push({
            id: `transient-${msgIndex++}`,
            type: role as 'user' | 'assistant',
            content: text,
            timestamp,
            metadata: role === 'assistant' ? { isStreaming: false, isFinal: true } : {},
          });
        } catch {
          // skip malformed lines
        }
      }

      if (messages.length === 0) return null;

      const firstTimestamp = messages[0]?.timestamp ?? Date.now();
      return {
        id: `transient-${sessionKey}`,
        agentId: '',
        title: sessionKey.split(':').pop() || 'Cron Session',
        claudeSessionId: null,
        status: 'completed' as CoworkSessionStatus,
        pinned: false,
        cwd: '',
        executionMode: 'local' as CoworkExecutionMode,
        activeSkillIds: [],
        messages,
        createdAt: firstTimestamp,
        updatedAt: firstTimestamp,
      };
    } catch (error) {
      console.warn('[OpenClawRuntime] readFromDeletedTranscript failed:', error);
      return null;
    }
  }

  /**
   * Ensure the gateway WebSocket client is connected.
   * Called when IM channels (e.g. Telegram) are enabled in OpenClaw mode
   * so that channel-originated events can be received without waiting
   * for a GucciAI-initiated session.
   */
  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) {
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client already exists, skipping');
      return;
    }
    console.log('[ChannelSync] connectGatewayIfNeeded: no gateway client, initializing...');
    try {
      await this.ensureGatewayClientReady();
      console.log(
        '[ChannelSync] connectGatewayIfNeeded: gateway client ready, starting channel polling',
      );
      this.startChannelPolling();
    } catch (error) {
      console.error(
        '[ChannelSync] connectGatewayIfNeeded: failed to initialize gateway client:',
        error,
      );
      throw error;
    }
  }

  /**
   * Force-reconnect the gateway WebSocket client.
   * Used after the OpenClaw gateway process has been restarted (e.g. after config sync).
   * Unlike `connectGatewayIfNeeded`, this always tears down the old client first
   * to avoid a race where the old client's `onClose` fires after a new client is created.
   */
  async reconnectGateway(): Promise<void> {
    console.log('[ChannelSync] reconnectGateway: tearing down old client and reconnecting...');
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] reconnectGateway: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] reconnectGateway: failed to initialize gateway client:', error);
      throw error;
    }
  }

  /**
   * Explicitly disconnect the gateway WebSocket client.
   * Called before the OpenClaw gateway process is restarted so that the old
   * client's async `onClose` handler cannot interfere with a subsequently
   * created client.
   */
  disconnectGatewayClient(): void {
    console.log('[ChannelSync] disconnectGatewayClient: explicitly tearing down gateway client');
    this.stopGatewayClient();
  }

  /**
   * Start periodic polling for channel-originated sessions (e.g. Telegram).
   * Uses the gateway `sessions.list` RPC to discover sessions that may not
   * have been delivered via WebSocket events.
   */
  startChannelPolling(): void {
    if (!this.channelSessionSync) {
      console.warn('[ChannelSync] startChannelPolling: no channelSessionSync set, skipping');
      return;
    }
    // Already running
    if (this.channelPollingTimer) {
      console.log('[ChannelSync] startChannelPolling: already running, skipping');
      return;
    }

    console.log('[ChannelSync] startChannelPolling: starting periodic channel session discovery');
    // Run once immediately, then at interval
    void this.pollChannelSessions();
    this.channelPollingTimer = setInterval(() => {
      void this.pollChannelSessions();
    }, OpenClawRuntimeAdapter.CHANNEL_POLL_INTERVAL_MS);
  }

  stopChannelPolling(): void {
    if (this.channelPollingTimer) {
      clearInterval(this.channelPollingTimer);
      this.channelPollingTimer = null;
    }
  }

  private async pollChannelSessions(): Promise<void> {
    if (!this.gatewayClient || !this.channelSessionSync) {
      console.warn(
        '[ChannelSync] pollChannelSessions: skipped — gatewayClient:',
        !!this.gatewayClient,
        'channelSessionSync:',
        !!this.channelSessionSync,
      );
      return;
    }
    try {
      const params = { activeMinutes: 60, limit: CHANNEL_SESSION_DISCOVERY_LIMIT };
      const result = await this.gatewayClient.request('sessions.list', params);
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) {
        console.warn(
          '[ChannelSync] pollChannelSessions: sessions.list returned non-array sessions:',
          typeof sessions,
          'full result keys:',
          Object.keys(result as Record<string, unknown>),
        );
        return;
      }
      let hasNew = false;
      let channelCount = 0;
      const newSessionsToSync: Array<{ sessionId: string; sessionKey: string }> = [];
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;
        // Skip heartbeat-originated sessions (origin.label === 'heartbeat')
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.heartbeatSessionKeys.add(key);
            continue;
          }
        }
        const isChannel = this.channelSessionSync.isChannelSessionKey(key);
        if (!isChannel) continue;
        // Skip keys that were explicitly deleted by the user — only real-time events re-create them
        if (this.deletedChannelKeys.has(key)) continue;
        // Skip gateway sessions belonging to a previously-bound agent.
        // After an agent binding change, the gateway retains old sessions under the old agentId.
        // Only process sessions matching the current platformAgentBindings.
        if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
        channelCount++;
        // Use resolveOrCreateSession so new channel sessions are auto-created
        const sessionId = this.channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && !this.knownChannelSessionIds.has(sessionId)) {
          this.knownChannelSessionIds.add(sessionId);
          this.rememberSessionKey(sessionId, key);
          hasNew = true;
          // Queue full history sync for newly discovered sessions
          if (!this.fullySyncedSessions.has(sessionId)) {
            newSessionsToSync.push({ sessionId, sessionKey: key });
          }
        }
      }
      if (hasNew) {
        let notified = 0;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:sessions:changed');
            notified++;
          }
        }
        console.log(
          '[ChannelSync] discovered',
          channelCount,
          'channel sessions, notified',
          notified,
          'windows',
        );
      }
      // Sync full history for newly discovered sessions
      for (const { sessionId, sessionKey } of newSessionsToSync) {
        await this.syncFullChannelHistory(sessionId, sessionKey);
      }

      // Incremental sync for already-known sessions: check if the gateway has messages
      // that weren't picked up during initial sync or real-time events.
      if (channelCount > 0) {
        const syncedThisCycle = new Set<string>();
        for (const row of sessions) {
          const key = typeof row?.key === 'string' ? row.key : '';
          if (!key) continue;
          if (!this.channelSessionSync.isChannelSessionKey(key)) continue;
          if (this.deletedChannelKeys.has(key)) continue;
          if (this.heartbeatSessionKeys.has(key)) continue;
          // Skip sessions belonging to a previously-bound agent
          if (!this.channelSessionSync.isCurrentBindingKey(key)) continue;
          const sessionId = this.sessionIdBySessionKey.get(key);
          if (!sessionId || !this.fullySyncedSessions.has(sessionId)) continue;
          // Safety net: only sync each sessionId once per poll cycle
          if (syncedThisCycle.has(sessionId)) continue;
          syncedThisCycle.add(sessionId);
          // Skip sessions with an active turn (they handle their own sync)
          if (this.activeTurns.has(sessionId)) continue;
          try {
            await this.incrementalChannelSync(sessionId, key);
          } catch (err) {
            console.warn('[ChannelSync] incremental sync failed for', key, err);
          }
        }
      }
    } catch (error) {
      console.error('[ChannelSync] pollChannelSessions: error during polling:', error);
    }
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: CoworkStartOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: options.skipInitialUserMessage,
      skillIds: options.skillIds,
      confirmationMode: options.confirmationMode,
      imageAttachments: options.imageAttachments,
      agentId: options.agentId,
    });
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: CoworkContinueOptions = {},
  ): Promise<void> {
    await this.runTurn(sessionId, prompt, {
      skipInitialUserMessage: false,
      skillIds: options.skillIds,
      imageAttachments: options.imageAttachments,
    });
  }

  stopSession(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.stopRequested = true;
      this.manuallyStoppedSessions.add(sessionId);
      const client = this.gatewayClient;
      if (client) {
        void client
          .request('chat.abort', {
            sessionKey: turn.sessionKey,
            runId: turn.runId,
          })
          .catch(error => {
            console.warn('[OpenClawRuntime] Failed to abort chat run:', error);
          });
      }
    }

    // Record the stop timestamp so that late-arriving gateway events
    // (e.g. from POPO/Telegram channels) don't re-create the ActiveTurn.
    this.stoppedSessions.set(sessionId, Date.now());

    // 清理编排状态（per-session tracking）
    this.orchestrationSessionIds.delete(sessionId);
    if (this.orchestrationParentSessionId === sessionId) {
      this.orchestrationParentSessionId =
        this.orchestrationSessionIds.size > 0 ? Array.from(this.orchestrationSessionIds)[0] : null;
      // 保留消息和状态一段时间供 UI 查询，延迟清理
      // CRITICAL: Only clear transient data, keep subagentStatus and mappings
      // for other sessions to display their subagent status correctly
      setTimeout(() => {
        this.subagentMessages.clear();
        // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel
        // These are needed for other sessions' subagent status display
        this.sessionKeyToLabel.clear();
        this.toolCallArgs.clear();
        this._announceToolMessages.clear();
        // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel
      }, 60000);
    }

    this.cleanupSessionTurn(sessionId);
    this.clearPendingApprovalsBySession(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
    this.emit('sessionStopped', sessionId);
    this.resolveTurn(sessionId);
  }

  stopAllSessions(): void {
    const activeSessionIds = Array.from(this.activeTurns.keys());
    activeSessionIds.forEach(sessionId => {
      this.stopSession(sessionId);
    });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      return;
    }

    const decision =
      result.behavior !== 'allow' ? 'deny' : pending.allowAlways ? 'allow-always' : 'allow-once';
    const client = this.gatewayClient;
    if (!client) {
      this.pendingApprovals.delete(requestId);
      return;
    }

    const sessionId = pending.sessionId;
    // Only schedule continuation for user-initiated approvals (desktop modal),
    // not for auto-approved commands (allowAlways).
    const needsContinuation = !pending.allowAlways;

    void client
      .request('exec.approval.resolve', {
        id: requestId,
        decision,
      })
      .then(() => {
        if (!needsContinuation) return;
        // Continue the session so the model can see the command result.
        const prompt = decision !== 'deny' ? t('execApprovalApproved') : t('execApprovalDenied');
        const tryContinue = (retries: number) => {
          if (!this.store.getSession(sessionId)) return; // session deleted
          if (!this.isSessionActive(sessionId)) {
            void this.continueSession(sessionId, prompt).catch(error => {
              console.warn('[OpenClawRuntime] failed to continue session after approval:', error);
            });
            return;
          }
          // Session still active (user approved before run ended). Retry after delay.
          if (retries > 0) {
            setTimeout(() => tryContinue(retries - 1), 1000);
          }
        };
        tryContinue(10);
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', sessionId, `Failed to resolve OpenClaw approval: ${message}`);
      })
      .finally(() => {
        this.pendingApprovals.delete(requestId);
      });
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasActiveSessions(): boolean {
    return this.activeTurns.size > 0;
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.confirmationModeBySession.get(sessionId) ?? null;
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
      agentId?: string;
    },
  ): Promise<void> {
    if (!prompt.trim() && (!options.imageAttachments || options.imageAttachments.length === 0)) {
      throw new Error('Prompt is required.');
    }
    // Clear stop cooldown when user explicitly starts/continues a session
    this.stoppedSessions.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // 设置编排父会话 ID（per-session tracking）
    // 注意：不清空之前的子 Agent 数据，因为同一会话可能有多个 turn，
    // 每个 turn 可能启动新的 subagent，之前的 subagent 状态应保留
    this.orchestrationSessionIds.add(sessionId);
    this.orchestrationParentSessionId = sessionId; // backward compat for getSubagentStatuses

    // CRITICAL: Do NOT clear subagentStatus, toolCallIdToSessionKey, toolCallIdToLabel, toolCallIdToParentSessionId
    // These mappings are needed by getSubagentStatuses to filter subagents by session.
    // Clearing them would cause other sessions' subagents to lose their 'done' status
    // and default to 'running' when displayed.
    //
    // Only clear transient data used for real-time message streaming:
    // - subagentMessages: only for streaming new messages
    // - sessionKeyToLabel: for routing messages to subagent sessions
    // - toolCallArgs: temporary args storage
    // Only clear if there are other tracked sessions (switching between concurrent sessions)
    if (this.orchestrationSessionIds.size > 1) {
      this.subagentMessages.clear();
      this.sessionKeyToLabel.clear();
      this.toolCallArgs.clear();
      // Keep: subagentStatus, toolCallIdToSessionKey, sessionKeyToToolCallId, toolCallIdToLabel, toolCallIdToParentSessionId
      // These are needed to correctly display subagent status for OTHER sessions
    }

    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Session ${sessionId} is still running.`);
    }

    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const confirmationMode =
      options.confirmationMode ?? this.confirmationModeBySession.get(sessionId) ?? 'modal';
    this.confirmationModeBySession.set(sessionId, confirmationMode);

    if (!options.skipInitialUserMessage) {
      const metadata =
        options.skillIds?.length || options.imageAttachments?.length
          ? {
              ...(options.skillIds?.length ? { skillIds: options.skillIds } : {}),
              ...(options.imageAttachments?.length
                ? { imageAttachments: options.imageAttachments }
                : {}),
            }
          : undefined;
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata,
      });
      this.emit('message', sessionId, userMessage);
    }

    const agentId = options.agentId || session.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    let modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    // Fallback to config default model if agent model is empty
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) {
        modelName = providerMetadata?.modelName || configModel;
      }
    }
    const sessionKey = this.toSessionKey(sessionId, agentId);
    this.rememberSessionKey(sessionId, sessionKey);

    this.store.updateSession(sessionId, { status: 'running' });
    setCoworkProxySessionId(sessionId);
    await this.ensureGatewayClientReady();
    this.startChannelPolling();

    const runId = randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const outboundMessage = await this.buildOutboundPrompt(sessionId, prompt, agentId);
    const completionPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurns.set(sessionId, { resolve, reject });
    });
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId,
      turnToken,
      knownRunIds: new Set([runId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: false,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    this.sessionIdByRunId.set(runId, sessionId);

    // Start client-side timeout watchdog.
    // OpenClaw gateway has a known issue where embedded run timeouts may not
    // produce a WS abort/final event (the subscription is torn down before the
    // lifecycle event fires). This timer fires slightly after the server-side
    // timeout to recover the UI from a stuck "running" state.
    this.startTurnTimeoutWatchdog(sessionId);

    const client = this.requireGatewayClient();
    try {
      console.log('[OpenClawRuntime] chat.send params:', {
        sessionKey,
        messageLength: outboundMessage.length,
        runId,
      });
      console.log(
        '[OpenClawRuntime] chat.send message content (first 500 chars):',
        outboundMessage.slice(0, 500),
      );
      const attachments = options.imageAttachments?.length
        ? options.imageAttachments.map(img => ({
            type: 'image',
            mimeType: img.mimeType,
            content: img.base64Data,
          }))
        : undefined;
      if (attachments) {
        console.log(
          '[OpenClawRuntime] chat.send with attachments:',
          attachments.length,
          'images,',
          attachments.map(a => ({
            type: a.type,
            mimeType: a.mimeType,
            contentLength: a.content?.length ?? 0,
          })),
        );
      }
      const sendResult = await client.request<Record<string, unknown>>('chat.send', {
        sessionKey,
        message: outboundMessage,
        deliver: false,
        idempotencyKey: runId,
        ...(attachments ? { attachments } : {}),
      });
      // OpenClaw: runId is set only at send time, never changed by returned value
    } catch (error) {
      this.cleanupSessionTurn(sessionId);
      this.store.updateSession(sessionId, { status: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', sessionId, message);
      this.rejectTurn(sessionId, new Error(message));
      throw error;
    }

    await completionPromise;
  }

  private async buildOutboundPrompt(
    _sessionId: string,
    prompt: string,
    _agentId?: string,
  ): Promise<string> {
    // 纯透传：直接返回用户消息，不注入任何 GucciAI 上下文
    return prompt.trim();
  }

  private async ensureGatewayClientReady(): Promise<void> {
    // Serialize concurrent calls: if another init is already in progress, wait for it.
    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
    } finally {
      this.gatewayClientInitLock = null;
    }
  }

  private async _ensureGatewayClientReadyImpl(): Promise<void> {
    console.log('[ChannelSync] ensureGatewayClientReady: starting engine gateway...');
    const engineStatus = await this.engineManager.startGateway();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: engine phase=',
      engineStatus.phase,
      'message=',
      engineStatus.message,
    );
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: connection info — url=',
      connection.url ? '✓' : '✗',
      'token=',
      connection.token ? '✓' : '✗',
      'version=',
      connection.version,
      'clientEntryPath=',
      connection.clientEntryPath ? '✓' : '✗',
    );
    const missing: string[] = [];
    if (!connection.url) missing.push('url');
    if (!connection.token) missing.push('token');
    if (!connection.version) missing.push('version');
    if (!connection.clientEntryPath) missing.push('clientEntryPath');
    if (missing.length > 0) {
      throw new Error(
        `OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`,
      );
    }

    const needsNewClient =
      !this.gatewayClient ||
      this.gatewayClientVersion !== connection.version ||
      this.gatewayClientEntryPath !== connection.clientEntryPath;
    console.log(
      '[ChannelSync] ensureGatewayClientReady: needsNewClient=',
      needsNewClient,
      'hasExistingClient=',
      !!this.gatewayClient,
    );
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: creating gateway client, url=',
      connection.url,
    );
    await this.createGatewayClient(connection);
    console.log(
      '[ChannelSync] ensureGatewayClientReady: createGatewayClient returned, waiting for handshake...',
    );
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }
    console.log('[ChannelSync] ensureGatewayClientReady: gateway client created and ready');

    // Browser pre-warm disabled: the empty browser window is disruptive.
    // The browser will start on-demand when the AI agent first calls the browser tool.
    // this.prewarmBrowserIfNeeded(connection);
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) {
      throw new Error('Gateway client entry path is not available');
    }
    const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);

    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    let settled = false;

    this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolveReady?.();
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectReady?.(error);
    };

    const client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      clientDisplayName: 'GucciAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        console.log('[ChannelSync] GatewayClient: onHelloOk — handshake succeeded');
        // Expose the client only after the connect handshake completes.
        // Setting gatewayClient earlier would let concurrent code send
        // request frames before the connect frame, causing 1008 rejection.
        this.gatewayClient = client;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.lastTickTimestamp = Date.now();
        this.startTickWatchdog();
      },
      onConnectError: (error: Error) => {
        console.error('[ChannelSync] GatewayClient: onConnectError —', error.message);
        settleReject(error);
      },
      onClose: (_code: number, reason: string) => {
        console.log(
          '[ChannelSync] GatewayClient: onClose — code:',
          _code,
          'reason:',
          reason,
          'settled:',
          settled,
        );
        if (!settled) {
          // Handshake never completed — clean up the pending client so the next
          // ensureGatewayClientReady call creates a fresh one instead of reusing
          // this broken instance forever.
          this.pendingGatewayClient = null;
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          return;
        }

        // If stopGatewayClient() triggered this onClose, don't do anything —
        // the caller is already handling cleanup and may be creating a new client.
        if (this.gatewayStoppingIntentionally) {
          return;
        }

        console.warn('[OpenClawRuntime] gateway WS disconnected — code:', _code, 'reason:', reason);
        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        const activeSessionIds = Array.from(this.activeTurns.keys());
        activeSessionIds.forEach(sessionId => {
          this.store.updateSession(sessionId, { status: 'error' });
          this.emit('error', sessionId, disconnectedError.message);
          this.cleanupSessionTurn(sessionId);
          this.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; auto-reconnect will re-establish
        });

        // Auto-reconnect after unexpected disconnect
        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => {
        this.handleGatewayEvent(event);
      },
    });

    // gatewayClient/version/entryPath are now set inside onHelloOk,
    // after the connect handshake succeeds. We only keep a local ref
    // for stopGatewayClient() cleanup if start() fails synchronously.
    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.stopChannelPolling();
    this.cancelGatewayReconnect();
    this.stopTickWatchdog();
    // Stop whichever client exists — the promoted one or the pending one.
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.channelSessionSync?.clearCache();
    this.knownChannelSessionIds.clear();
    this.heartbeatSessionKeys.clear();
    this.stoppedSessions.clear();
    this.browserPrewarmAttempted = false;
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
    // Clear messageUpdate throttle state
    for (const timer of this.pendingMessageUpdateTimer.values()) {
      clearTimeout(timer);
    }
    this.pendingMessageUpdateTimer.clear();
    this.lastMessageUpdateEmitTime.clear();
    this.gatewayStoppingIntentionally = false;
  }

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  /**
   * Throttled emit for messageUpdate during streaming.
   * OpenClaw sends full-replacement deltas, so intermediate updates can be safely skipped.
   * Uses leading + trailing pattern: emit immediately if enough time has passed,
   * otherwise schedule a trailing emit to deliver the latest content.
   */
  private throttledEmitMessageUpdate(sessionId: string, messageId: string, content: string): void {
    const now = Date.now();
    const lastEmit = this.lastMessageUpdateEmitTime.get(messageId) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS) {
      this.clearPendingMessageUpdate(messageId);
      this.lastMessageUpdateEmitTime.set(messageId, now);
      this.emit('messageUpdate', sessionId, messageId, content);
      return;
    }

    // Schedule a trailing emit to ensure the latest content is delivered
    this.clearPendingMessageUpdate(messageId);
    this.pendingMessageUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingMessageUpdateTimer.delete(messageId);
        this.lastMessageUpdateEmitTime.set(messageId, Date.now());
        this.emit('messageUpdate', sessionId, messageId, content);
      }, OpenClawRuntimeAdapter.MESSAGE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingMessageUpdate(messageId: string): void {
    const timer = this.pendingMessageUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingMessageUpdateTimer.delete(messageId);
    }
  }

  /**
   * Throttled SQLite store write for streaming message updates.
   * Uses leading + trailing pattern identical to throttledEmitMessageUpdate.
   * Final correctness is guaranteed by syncFinalAssistantWithHistory.
   */
  private throttledStoreUpdateMessage(
    sessionId: string,
    messageId: string,
    content: string,
    metadata: { isStreaming: boolean; isFinal: boolean },
  ): void {
    const now = Date.now();
    const lastUpdate = this.lastStoreUpdateTime.get(messageId) ?? 0;
    const elapsed = now - lastUpdate;

    if (elapsed >= OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS) {
      this.clearPendingStoreUpdate(messageId);
      this.lastStoreUpdateTime.set(messageId, now);
      this.store.updateMessage(sessionId, messageId, { content, metadata });
      return;
    }

    // Schedule a trailing write to ensure the latest content is persisted
    this.clearPendingStoreUpdate(messageId);
    this.pendingStoreUpdateTimer.set(
      messageId,
      setTimeout(() => {
        this.pendingStoreUpdateTimer.delete(messageId);
        this.lastStoreUpdateTime.set(messageId, Date.now());
        // Guard: skip write if the session turn has already been cleaned up
        const activeTurn = this.activeTurns.get(sessionId);
        if (activeTurn?.assistantMessageId === messageId) {
          this.store.updateMessage(sessionId, messageId, { content, metadata });
        }
      }, OpenClawRuntimeAdapter.STORE_UPDATE_THROTTLE_MS - elapsed),
    );
  }

  private clearPendingStoreUpdate(messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.pendingStoreUpdateTimer.delete(messageId);
    }
  }

  /** Flush any pending throttled store write immediately (e.g. before segment split or final sync). */
  private flushPendingStoreUpdate(sessionId: string, messageId: string): void {
    const timer = this.pendingStoreUpdateTimer.get(messageId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingStoreUpdateTimer.delete(messageId);
    this.lastStoreUpdateTime.set(messageId, Date.now());
    // Persist the latest in-memory content only; caller is responsible for metadata.
    const turn = this.activeTurns.get(sessionId);
    if (turn?.assistantMessageId === messageId && turn.currentAssistantSegmentText) {
      this.store.updateMessage(sessionId, messageId, {
        content: turn.currentAssistantSegmentText,
      });
    }
  }

  private startTickWatchdog(): void {
    this.stopTickWatchdog();
    console.log('[TickWatchdog] started');
    this.tickWatchdogTimer = setInterval(() => {
      this.checkTickHealth();
    }, OpenClawRuntimeAdapter.TICK_WATCHDOG_INTERVAL_MS);
  }

  private stopTickWatchdog(): void {
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
  }

  private checkTickHealth(): void {
    if (this.lastTickTimestamp <= 0) return;
    const now = Date.now();
    const tickElapsed = now - this.lastTickTimestamp;
    const agentElapsed = now - this.lastAgentActivityTimestamp;

    // If we received agent events recently, the connection is alive even without tick.
    // This handles the case where tick events are dropped due to dropIfSlow during heavy activity.
    if (agentElapsed <= OpenClawRuntimeAdapter.AGENT_ACTIVITY_ALIVE_WINDOW_MS) {
      // Connection is alive — update tick timestamp to prevent false timeout trigger
      this.lastTickTimestamp = now;
      console.log(
        `[TickWatchdog] tick missing for ${Math.round(tickElapsed / 1000)}s but agent activity detected (${Math.round(agentElapsed / 1000)}s ago) — connection is alive, suppressing reconnect`,
      );
      return;
    }

    if (tickElapsed <= OpenClawRuntimeAdapter.TICK_TIMEOUT_MS) return;

    console.warn(
      `[TickWatchdog] no tick received for ${Math.round(tickElapsed / 1000)}s (threshold: ${OpenClawRuntimeAdapter.TICK_TIMEOUT_MS / 1000}s) and no agent activity for ${Math.round(agentElapsed / 1000)}s — connection is likely dead, triggering reconnect`,
    );
    this.cancelGatewayReconnect();
    this.stopGatewayClient();
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  /**
   * Called when the system resumes from sleep/suspend.
   * Resets the reconnect counter and triggers an immediate reconnect or health check.
   */
  onSystemResume(): void {
    console.log('[GatewayReconnect] system resumed from sleep');
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.checkTickHealth();
    }
  }

  /**
   * Schedule an automatic gateway WS reconnection attempt with exponential backoff.
   * Called from onClose when the connection drops unexpectedly after a successful handshake.
   */
  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectAttempt >= OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      console.error(
        '[GatewayReconnect] max attempts reached (' +
          OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS +
          '), giving up. Restart the app to reconnect.',
      );
      return;
    }

    const delays = OpenClawRuntimeAdapter.GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;

    console.log(
      `[GatewayReconnect] scheduling reconnect attempt ${this.gatewayReconnectAttempt}/${OpenClawRuntimeAdapter.GATEWAY_RECONNECT_MAX_ATTEMPTS} in ${delay}ms`,
    );

    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  private async attemptGatewayReconnect(): Promise<void> {
    console.log(
      `[GatewayReconnect] attempting reconnect (attempt ${this.gatewayReconnectAttempt})`,
    );
    try {
      // connectGatewayIfNeeded checks if client already exists, so safe to call
      await this.connectGatewayIfNeeded();
      console.log('[GatewayReconnect] reconnected successfully');
      this.gatewayReconnectAttempt = 0; // reset counter on success
    } catch (error) {
      console.warn('[GatewayReconnect] reconnect failed:', error);
      this.scheduleGatewayReconnect(); // retry with next backoff
    }
  }

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(
      `[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`,
    );
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.engineManager.getGatewayConnectionInfo();
    if (!connection.port || !connection.token) {
      console.log(
        `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): no gateway connection info`,
      );
      return;
    }
    const browserControlPort = connection.port + 2;
    const token = connection.token;
    const probeStartTime = Date.now();
    console.log(
      `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): checking port ${browserControlPort} ...`,
    );

    // Probe multiple endpoints to diagnose reachability
    const endpoints = [
      `http://127.0.0.1:${browserControlPort}/status`,
      `http://127.0.0.1:${browserControlPort}/`,
    ];
    for (const probeUrl of endpoints) {
      fetch(probeUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then(async response => {
          const body = await response.text().catch(() => '');
          console.log(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → HTTP ${response.status} (${Date.now() - probeStartTime}ms) body=${body.slice(0, 500)}`,
          );
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → FAILED (${Date.now() - probeStartTime}ms) error=${message}`,
          );
        });
    }
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    console.warn(
      '[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)',
    );
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    // Use require() with file path directly. TypeScript's CJS output downgrades
    // dynamic import() to require(), which doesn't support file:// URLs.
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
      const proto = maybeCtor.prototype;
      if (
        proto &&
        typeof proto.start === 'function' &&
        typeof proto.stop === 'function' &&
        typeof proto.request === 'function'
      ) {
        return candidate as GatewayClientCtor;
      }
    }

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  private handleGatewayEvent(event: GatewayEventFrame): void {
    if (event.event === 'tick') {
      this.lastTickTimestamp = Date.now();
      return;
    }

    if (event.event === 'chat') {
      this.handleChatEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'agent') {
      // Agent events prove the connection is alive even when tick is dropped due to dropIfSlow.
      this.lastAgentActivityTimestamp = Date.now();
      // Process thinking events first (before assistant text) to ensure correct display order.
      // Thinking should appear in UI before or alongside the reply text.
      this.processAgentThinkingEvent(event.payload);
      // Process assistant text updates (may be enqueued if session not ready).
      this.processAgentAssistantText(event.payload);
      // Handle other agent events (tool, lifecycle, etc.)
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'exec.approval.requested') {
      this.handleApprovalRequested(event.payload);
      return;
    }

    if (event.event === 'exec.approval.resolved') {
      this.handleApprovalResolved(event.payload);
    }

    // session.tool events are mirror of agent stream=tool events for late-joining subscribers.
    // They have the same payload format: runId, stream='tool', sessionKey, data.
    // Handle announce runId sessions_spawn that don't trigger agent stream=tool events.
    if (event.event === 'session.tool') {
      // Update activity timestamp since this proves the connection is alive
      this.lastAgentActivityTimestamp = Date.now();
      // Process the tool event using the same handler as agent stream=tool
      this.handleAgentEvent(event.payload, event.seq);
      return;
    }

    if (event.event === 'cron') {
      console.debug('[OpenClawRuntime] received cron event:', JSON.stringify(event));
    }
  }

  private handleAgentEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const agentPayload = payload as AgentEventPayload;
    const runId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
    // Support both sessionKey and session fields (gateway uses 'session' for agent events)
    // Also normalize subagent sessionKey format: 'subagent:xxx' → 'agent:main:subagent:xxx'
    let sessionKey =
      typeof agentPayload.sessionKey === 'string'
        ? agentPayload.sessionKey.trim()
        : typeof agentPayload.session === 'string'
          ? agentPayload.session.trim()
          : '';
    // Normalize subagent sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
    // This is needed because gateway agent events use 'subagent:xxx' format
    // but sessionKeyToLabel mapping stores 'agent:main:subagent:xxx' format
    if (sessionKey && sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
      sessionKey = 'agent:main:' + sessionKey;
    }
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream : '';

    // Extract phase from lifecycle events to check for end states
    const data = isRecord(agentPayload.data) ? agentPayload.data : {};
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';
    const isLifecycleEnd =
      stream === 'lifecycle' &&
      (phase === 'end' || phase === 'fallback' || phase === 'completed' || phase === 'stopped');

    const sessionIdByRunId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    const sessionIdBySessionKey = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;
    let sessionId = sessionIdByRunId ?? sessionIdBySessionKey;

    // Re-create ActiveTurn for channel session follow-up turns.
    // Exclude:
    // - stream=error events (seq gap notifications) — diagnostic alerts, not new runs
    // - lifecycle end events (phase=end/fallback/completed/stopped) — turn already cleaned up
    if (
      sessionId &&
      !this.activeTurns.has(sessionId) &&
      sessionKey &&
      stream !== 'error' &&
      !isLifecycleEnd
    ) {
      console.log(
        '[Debug:handleAgentEvent] re-creating ActiveTurn for follow-up turn, sessionId:',
        sessionId,
      );
      // OpenClaw: runId is set only at send time, events never modify it
      this.ensureActiveTurn(sessionId, sessionKey, '');
    }

    // Try to resolve channel-originated sessions (e.g. Telegram via OpenClaw)
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      console.log('[Debug:handleAgentEvent] channel resolve — channelSessionId:', channelSessionId);
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.log(
            '[Debug:handleAgentEvent] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
        // OpenClaw: runId is set only at send time, events never modify it
        this.ensureActiveTurn(channelSessionId, sessionKey, '');
      }
    }

    if (!sessionId) {
      // 即使没有 sessionId，也处理子 Agent 的生命周期事件
      // 使用 sessionKeyToLabel 映射获取 agentId/label
      if (sessionKey && stream === 'lifecycle') {
        // Try to get toolCallId from sessionKeyToToolCallId mapping first
        // toolCallId is the unique identifier, label is only for display
        let toolCallId = this.sessionKeyToToolCallId.get(sessionKey);
        // Also try with 'subagent:' prefix (gateway might use short format)
        if (!toolCallId && sessionKey.startsWith('subagent:')) {
          const fullSessionKey = 'agent:main:' + sessionKey;
          toolCallId = this.sessionKeyToToolCallId.get(fullSessionKey);
        }
        // Final fallback: if sessionKey is a subagent and we have pending toolCallIds,
        // use the first UNMAPPED pending toolCallId and establish the mapping.
        // This handles cases where gateway strips result.childSessionKey from tool events.
        if (!toolCallId && sessionKey.includes(':subagent:') && this.pendingToolCallIds.size > 0) {
          // Filter to only pending toolCallIds that haven't been mapped to a childSessionKey.
          // NOTE: toolCallIdToSessionKey may contain temporary mappings to parentSessionKey
          // (set during sessions_spawn start), which should NOT count as "mapped" here.
          // We only consider a toolCallId as mapped when it maps to a childSessionKey (contains :subagent:).
          const unmappedPendingIds = Array.from(this.pendingToolCallIds).filter(id => {
            const mappedSessionKey = this.toolCallIdToSessionKey.get(id);
            // Unmapped if: no mapping OR mapping points to parent session (not child subagent)
            return !mappedSessionKey || !mappedSessionKey.includes(':subagent:');
          });
          if (unmappedPendingIds.length > 0) {
            const pendingId = unmappedPendingIds[0];
            console.log(
              '[OpenClawRuntime] subagent lifecycle fallback: assigning pending toolCallId=' +
                pendingId +
                ' to sessionKey=' +
                sessionKey +
                ' (unmapped pending count: ' +
                unmappedPendingIds.length +
                ')',
            );
            toolCallId = pendingId;
            // Establish bidirectional mapping
            this.toolCallIdToSessionKey.set(toolCallId, sessionKey);
            this.sessionKeyToToolCallId.set(sessionKey, toolCallId);
            // Remove from pending since mapping is now established
            this.pendingToolCallIds.delete(toolCallId);
            this.pendingEntryTimestamps.delete(toolCallId);
          } else {
            console.log(
              '[OpenClawRuntime] subagent lifecycle fallback: no unmapped pending toolCallIds available for sessionKey=' +
                sessionKey +
                ' (all ' +
                this.pendingToolCallIds.size +
                ' pending IDs are already mapped)',
            );
          }
        }
        // Get display label for logging only (not used as key)
        const displayLabel = this.toolCallIdToLabel.get(toolCallId || '') || '';
        // phase already extracted above for logging
        if (toolCallId) {
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no sessionId): toolCallId=' +
              toolCallId +
              ' label=' +
              (displayLabel || '(none)') +
              ' phase=' +
              phase +
              ' sessionKey=' +
              sessionKey,
          );
          if (phase === 'start' || phase === 'running') {
            // If previously marked as failed (e.g. by pending timeout firing before
            // lifecycle events arrived), recover: the subagent is actually running.
            if (this.failedSubagentIds.has(toolCallId)) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: recovering from failed status, toolCallId=' +
                  toolCallId +
                  ' (lifecycle start event arrived late)',
              );
              this.failedSubagentIds.delete(toolCallId);
            }
            // Skip if already done (don't override completion with late start/running event)
            if (this.subagentStatus.get(toolCallId) === 'done') {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: ignoring start/running for completed toolCallId=' +
                  toolCallId,
              );
              return;
            }
            // Remove from pending since subagent is now running
            this.pendingToolCallIds.delete(toolCallId);
            this.pendingEntryTimestamps.delete(toolCallId);
            this.subagentStatus.set(toolCallId, 'running');
            this.subagentLastActivity.set(toolCallId, Date.now());
          } else if (phase === 'end' || phase === 'completed' || phase === 'stopped') {
            // If previously marked as failed (e.g. by pending timeout firing before
            // lifecycle events arrived), recover: the subagent actually completed.
            if (this.failedSubagentIds.has(toolCallId)) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle: recovering from failed status, toolCallId=' +
                  toolCallId +
                  ' (lifecycle event arrived late)',
              );
              this.failedSubagentIds.delete(toolCallId);
            }
            console.log(
              '[OpenClawRuntime] subagent lifecycle: setting done for toolCallId=' +
                toolCallId +
                ' sessionKey=' +
                sessionKey,
            );
            this.subagentStatus.set(toolCallId, 'done');
            this.persistSubagentStatus(toolCallId, 'done');
            this.subagentLastActivity.delete(toolCallId);
            this.checkAllSubagentsDone();

            // Also clean up any parallel UUID entry created by the nested lifecycle handler.
            // The phase=start for nested subagents goes through the nested handler (line 2563)
            // which uses sessionKey's UUID as key, while phase=end comes through this main
            // handler with a resolved toolCallId. This leaves a dangling 'running' UUID entry
            // that gets incorrectly killed by the idle timeout.
            if (sessionKey && sessionKey.includes(':subagent:')) {
              const subagentUuid = sessionKey.split(':subagent:')[1] || '';
              if (subagentUuid && subagentUuid !== toolCallId) {
                const uuidStatus = this.subagentStatus.get(subagentUuid);
                if (uuidStatus === 'running') {
                  console.log(
                    '[OpenClawRuntime] subagent lifecycle: cleaning up dangling UUID entry uuid=' +
                      subagentUuid +
                      ' toolCallId=' +
                      toolCallId,
                  );
                  this.subagentStatus.delete(subagentUuid);
                  this.subagentLastActivity.delete(subagentUuid);
                }
              }
            }

            // Emit subagent_completion message to parent session
            // Use per-session mapping to avoid cross-session contamination
            const completionParentId =
              this.toolCallIdToParentSessionId.get(toolCallId) || this.orchestrationParentSessionId;
            if (completionParentId) {
              const label = this.toolCallIdToLabel.get(toolCallId) || displayLabel || 'Subagent';
              const childSessionKey = this.toolCallIdToSessionKey.get(toolCallId) || '';

              // Get result content from subagentMessages - find last assistant message
              const storageKey = childSessionKey || toolCallId;
              const msgs = this.subagentMessages.get(storageKey) || [];
              const lastAssistantMsg = msgs.filter(m => m.role === 'assistant').pop();
              const resultContent = lastAssistantMsg?.content || '';

              console.log(
                '[OpenClawRuntime] subagent lifecycle: emitting completion for toolCallId=' +
                  toolCallId +
                  ' label=' +
                  label +
                  ' sessionKey=' +
                  childSessionKey +
                  ' resultLength=' +
                  resultContent.length,
              );

              const completionMessage = {
                id: `subagent-completion-${toolCallId}-${Date.now()}`,
                type: 'subagent_completion',
                role: 'assistant',
                content: resultContent || `Subagent "${label}" completed successfully.`,
                timestamp: Date.now(),
                metadata: {
                  taskLabel: label,
                  status: phase === 'stopped' ? 'stopped' : 'completed',
                  sessionKey: childSessionKey,
                  toolCallId,
                },
              };

              const parentSessionId = this.resolveSubagentParentSessionId(toolCallId);
              if (parentSessionId) {
                this.emit('message', parentSessionId, completionMessage);
              }
            }
          } else if (phase === 'error') {
            // Subagent lifecycle error: only mark as failed if spawn itself failed.
            // If the spawn result was successful (isError=false), a transient lifecycle error
            // should not remove the subagent from the list.
            // The toolCallId in lifecycle events may differ from the spawn toolCallId
            // (lifecycle uses UUID while spawn uses call_ ID). Check label mapping to bridge.
            const lifecycleLabel = this.toolCallIdToLabel.get(toolCallId) || displayLabel || '';
            const spawnSucceeded =
              this.successfulSpawnToolCallIds.has(toolCallId) ||
              (lifecycleLabel &&
                Array.from(this.successfulSpawnToolCallIds).some(
                  spawnId => this.toolCallIdToLabel.get(spawnId) === lifecycleLabel,
                ));
            if (spawnSucceeded) {
              console.log(
                '[OpenClawRuntime] subagent lifecycle error but spawn succeeded, keeping in list: toolCallId=' +
                  toolCallId +
                  ' label=' +
                  (displayLabel || '(none)'),
              );
              // Keep status as 'running' — the subagent hasn't actually finished.
              // Transient lifecycle errors (e.g. quota exceeded) should not mark
              // the subagent as done, otherwise later retry start events are ignored.
              this.pendingToolCallIds.delete(toolCallId);
              this.checkAllSubagentsDone();
            } else {
              // Spawn failed - keep in list with 'failed' status for frontend display
              console.log(
                '[OpenClawRuntime] subagent lifecycle error: marking failed toolCallId=' +
                  toolCallId +
                  ' label=' +
                  (displayLabel || '(none)'),
              );
              this.failedSubagentIds.add(toolCallId);
              this.subagentStatus.set(toolCallId, 'failed');
              this.pendingToolCallIds.delete(toolCallId);
              this.pendingEntryTimestamps.delete(toolCallId);
              this.subagentLastActivity.delete(toolCallId);
              this.toolCallIdToSessionKey.delete(toolCallId);
              this.toolCallIdToParentSessionId.delete(toolCallId);
              this.toolCallIdToLabel.delete(toolCallId);
              this.subagentMessages.delete(toolCallId);
            }
          }
        } else if (sessionKey && sessionKey.includes(':subagent:')) {
          // No toolCallId but this is a subagent (spawned by a subagent, not directly by main agent).
          // Use the subagent UUID portion as the tracking key.
          const subagentUuid = sessionKey.split(':subagent:')[1] || sessionKey;
          const emitAgentId = subagentUuid;

          if (phase === 'start' || phase === 'running') {
            // Skip if already running or done (don't override completion with late start/running)
            const existingStatus = this.subagentStatus.get(emitAgentId);
            if (existingStatus === 'running' || existingStatus === 'done') return;
            // Skip if already marked as failed
            if (this.failedSubagentIds.has(emitAgentId)) return;

            this.pendingToolCallIds.delete(emitAgentId);
            this.pendingEntryTimestamps.delete(emitAgentId);
            this.subagentStatus.set(emitAgentId, 'running');
            this.subagentLastActivity.set(emitAgentId, Date.now());
            this.sessionKeyToToolCallId.set(sessionKey, emitAgentId);
            this.toolCallIdToSessionKey.set(emitAgentId, sessionKey);

            // Also try to find a matching call_... toolCallId from pending entries
            // that has the same sessionKey mapping. This lets us cross-reference
            // context messages stored under call_... keys when queried by UUID.
            for (const [pendingId, pendingKey] of this.toolCallIdToSessionKey.entries()) {
              if (pendingKey && pendingKey.includes(':subagent:') && pendingKey === sessionKey) {
                this.uuidToToolCallId.set(emitAgentId, pendingId);
                console.log(
                  '[OpenClawRuntime] subagent lifecycle (nested): linked UUID=' +
                    emitAgentId +
                    ' to toolCallId=' +
                    pendingId,
                );
                break;
              }
            }
            // Nested subagents: find the correct parent session by looking up
            // which GUI session the spawning subagent belongs to.
            // Do NOT use the global orchestrationParentSessionId — it can be
            // contaminated by concurrent sessions.
            const nestedParentSessionId = this.findParentSessionIdForNested(
              emitAgentId,
              sessionKey,
            );
            if (nestedParentSessionId) {
              this.toolCallIdToParentSessionId.set(emitAgentId, nestedParentSessionId);
            }

            // Extract label from multiple sources for nested subagents
            // 1. sessionKeyToLabel (set by sessions_spawn result from parent)
            // 2. subagentUuidToLabel (from previous sessions.list query or tool event)
            // 3. emitAgentId's existing label (may have been set by tool event)
            // 4. event data.meta (format: 'label xxx, task yyy')
            // 5. event data.name or data.label field
            // 6. UUID fallback
            let nestedLabel: string | null = this.sessionKeyToLabel.get(sessionKey) || null;
            if (!nestedLabel) {
              nestedLabel = this.subagentUuidToLabel.get(subagentUuid) || null;
            }
            if (!nestedLabel) {
              nestedLabel = this.toolCallIdToLabel.get(emitAgentId) || null;
            }
            if (!nestedLabel) {
              const metaField = typeof data.meta === 'string' ? data.meta.trim() : '';
              if (metaField) {
                const labelMatch = metaField.match(/label\s+([^,]+)/);
                if (labelMatch && labelMatch[1]) {
                  nestedLabel = labelMatch[1].trim();
                }
              }
            }
            if (!nestedLabel) {
              const dataName = typeof data.name === 'string' ? data.name.trim() : '';
              const dataLabel = typeof data.label === 'string' ? data.label.trim() : '';
              nestedLabel = dataLabel || dataName || null;
            }
            const displayLabel = nestedLabel || subagentUuid;
            if (!this.toolCallIdToLabel.has(emitAgentId)) {
              this.toolCallIdToLabel.set(emitAgentId, displayLabel);
            }
            // Store UUID → label mapping for direct lookup by lifecycle events
            if (nestedLabel) {
              this.subagentUuidToLabel.set(subagentUuid, nestedLabel);
            }
            // Persist nested spawn to parent session so it survives restart
            this.persistNestedSubagentSpawn(emitAgentId, displayLabel, sessionKey);
            // If no label found, query sessions.list to resolve
            if (!nestedLabel && this.gatewayClient) {
              // Construct the correct parent session key for the query.
              // Prefer per-session lookup over global to avoid cross-session contamination.
              let queryParentKey: string | null = null;
              // First try: extract from sessionKey directly (for nested format)
              if (sessionKey) {
                const gucciaiMatch = sessionKey.match(/^agent:main:gucciai:([^:]+):subagent:/);
                if (gucciaiMatch) {
                  queryParentKey = 'agent:main:gucciai:' + gucciaiMatch[1];
                }
              }
              // Second try: use the per-session parent mapping we just established
              if (!queryParentKey && nestedParentSessionId) {
                queryParentKey = 'agent:main:gucciai:' + nestedParentSessionId;
              }
              // Fallback: global (only if no per-session info available)
              if (!queryParentKey && this.orchestrationParentSessionId) {
                queryParentKey = 'agent:main:gucciai:' + this.orchestrationParentSessionId;
              }
              if (queryParentKey) {
                console.log(
                  '[OpenClawRuntime] nested subagent: no label for UUID=' +
                    subagentUuid +
                    ', querying sessions.list with parentKey=' +
                    queryParentKey,
                );
                void this.queryNestedSubagentLabel(subagentUuid, queryParentKey, emitAgentId);
              }
            }
            console.log(
              '[OpenClawRuntime] subagent lifecycle (nested): START toolCallId=' +
                emitAgentId +
                ' label=' +
                displayLabel +
                ' sessionKey=' +
                sessionKey,
            );
          } else if (phase === 'end' || phase === 'completed' || phase === 'stopped') {
            if (this.failedSubagentIds.has(emitAgentId)) return;
            this.subagentStatus.set(emitAgentId, 'done');
            this.persistSubagentStatus(emitAgentId, 'done');
            this.subagentLastActivity.delete(emitAgentId);
            this.checkAllSubagentsDone();
            console.log(
              '[OpenClawRuntime] subagent lifecycle (nested): DONE toolCallId=' +
                emitAgentId +
                ' sessionKey=' +
                sessionKey,
            );
          } else if (phase === 'error') {
            // Nested subagent lifecycle error: if already marked done from a prior
            // completed/stopped event, don't overwrite with failure.
            if (this.subagentStatus.get(emitAgentId) === 'done') {
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): error but already done, keeping: emitAgentId=' +
                  emitAgentId +
                  ' sessionKey=' +
                  sessionKey,
              );
            } else {
              this.failedSubagentIds.add(emitAgentId);
              this.subagentStatus.delete(emitAgentId);
              this.pendingToolCallIds.delete(emitAgentId);
              this.pendingEntryTimestamps.delete(emitAgentId);
              this.subagentLastActivity.delete(emitAgentId);
              this.toolCallIdToSessionKey.delete(emitAgentId);
              this.sessionKeyToToolCallId.delete(sessionKey);
              this.toolCallIdToParentSessionId.delete(emitAgentId);
              this.toolCallIdToLabel.delete(emitAgentId);
              this.subagentMessages.delete(sessionKey);
              console.log(
                '[OpenClawRuntime] subagent lifecycle (nested): ERROR toolCallId=' +
                  emitAgentId +
                  ' sessionKey=' +
                  sessionKey,
              );
            }
          }
        } else {
          // No toolCallId and not a subagent — lifecycle event for an agent not spawned via sessions_spawn.
          // These are not tracked in the subagent list; they run as implicit children.
          console.log(
            '[OpenClawRuntime] subagent lifecycle (no toolCallId): ignoring untracked sessionKey=' +
              sessionKey +
              ' phase=' +
              phase,
          );
        }
      }

      // 处理子 Agent 的 thinking/assistant/tool/user/item/command_output 事件（无 sessionId）
      if (
        sessionKey &&
        sessionKey.includes(':subagent:') &&
        (stream === 'thinking' ||
          stream === 'assistant' ||
          stream === 'tool' ||
          stream === 'tools' ||
          stream === 'user' ||
          stream === 'item' ||
          stream === 'command_output')
      ) {
        const mappedLabel = this.sessionKeyToLabel.get(sessionKey);
        const storageKey = sessionKey || mappedLabel;
        // Get the toolCallId for IPC emission (frontend expects toolCallId as agentId)
        // The frontend SubTaskDetailDrawer uses toolCallId (toolUseId) as agentId
        // Priority: 1. direct sessionKey → toolCallId mapping
        //           2. label → toolCallId mapping via toolCallIdToLabel
        //           3. reverse lookup from parent session
        //           4. pending toolCallIds with matching label
        //           5. final fallback: use toolCallId from lifecycle fallback mapping
        let emitAgentId =
          (storageKey ? this.sessionKeyToToolCallId.get(storageKey) : undefined) || '';
        // If no direct mapping, try reverse lookup
        if (!emitAgentId && storageKey && this.orchestrationParentSessionId) {
          emitAgentId = this.findToolCallIdByChildSessionKey(storageKey) || '';
        }
        // Try to find by label from toolCallIdToLabel
        if (!emitAgentId && mappedLabel) {
          for (const [tcId, tcLabel] of this.toolCallIdToLabel) {
            if (tcLabel === mappedLabel) {
              emitAgentId = tcId;
              // Also establish the mapping for future events
              this.sessionKeyToToolCallId.set(storageKey, tcId);
              this.toolCallIdToSessionKey.set(tcId, storageKey);
              console.log(
                '[OpenClawRuntime] subagent event: established mapping via label match. label=' +
                  mappedLabel +
                  ' toolCallId=' +
                  tcId +
                  ' sessionKey=' +
                  storageKey,
              );
              break;
            }
          }
        }
        // Check pendingToolCallIds - try to match with label or use FIFO for multiple pending
        if (!emitAgentId && this.pendingToolCallIds.size > 0) {
          const unmappedPendingIds = Array.from(this.pendingToolCallIds).filter(id => {
            const mappedSessionKey = this.toolCallIdToSessionKey.get(id);
            return !mappedSessionKey || !mappedSessionKey.includes(':subagent:');
          });
          // First try label matching with pending IDs
          if (mappedLabel && unmappedPendingIds.length > 0) {
            for (const pendingId of unmappedPendingIds) {
              const pendingLabel = this.toolCallIdToLabel.get(pendingId);
              if (pendingLabel === mappedLabel) {
                emitAgentId = pendingId;
                this.sessionKeyToToolCallId.set(storageKey, emitAgentId);
                this.toolCallIdToSessionKey.set(emitAgentId, storageKey);
                console.log(
                  '[OpenClawRuntime] subagent event: established mapping via pending label match. label=' +
                    mappedLabel +
                    ' toolCallId=' +
                    emitAgentId +
                    ' sessionKey=' +
                    storageKey,
                );
                break;
              }
            }
          }
          // If still no match and only one unmapped pending, use it
          if (!emitAgentId && unmappedPendingIds.length === 1) {
            emitAgentId = unmappedPendingIds[0];
            this.sessionKeyToToolCallId.set(storageKey, emitAgentId);
            this.toolCallIdToSessionKey.set(emitAgentId, storageKey);
            console.log(
              '[OpenClawRuntime] subagent event: established mapping via single pending. toolCallId=' +
                emitAgentId +
                ' sessionKey=' +
                storageKey,
            );
          }
          // If multiple unmapped pending but no label match, log warning
          if (!emitAgentId && unmappedPendingIds.length > 1) {
            console.log(
              '[OpenClawRuntime] subagent event: multiple unmapped pending (' +
                unmappedPendingIds.length +
                '), cannot determine which one for sessionKey=' +
                storageKey +
                ' label=' +
                (mappedLabel || '(none)'),
            );
          }
        }
        // Final fallback: use storageKey (sessionKey) - log this as potential mismatch
        if (!emitAgentId) {
          emitAgentId = storageKey || '';
          console.log(
            '[OpenClawRuntime] subagent event: using storageKey as fallback emitAgentId=' +
              emitAgentId +
              ' (may not match frontend toolCallId)',
          );
        }
        // 只处理 subagent sessionKey（格式: agent:*:subagent:*）
        // 使用直接匹配而非排除逻辑，更健壮且能处理未来边缘情况
        if (sessionKey?.includes(':subagent:')) {
          // Record activity to reset idle timeout for this subagent
          if (emitAgentId) {
            this.touchSubagentActivity(emitAgentId);
          }

          console.log(
            '[OpenClawRuntime] subagent event (no sessionId): capturing ' +
              stream +
              ' for storageKey=' +
              storageKey +
              ' mappedLabel=' +
              (mappedLabel || '(none)') +
              ' emitAgentId=' +
              emitAgentId +
              ' data=' +
              JSON.stringify(agentPayload.data).slice(0, 200),
          );
          // 初始化存储结构 - 只存储到 storageKey（避免重复）
          // 注意：当 sessions_spawn 结束时，会将消息从 toolCallId 复制到 sessionKey 或反之
          if (!this.subagentMessages.has(storageKey)) {
            this.subagentMessages.set(storageKey, []);
          }
          const msgs = this.subagentMessages.get(storageKey)!;
          const subData = isRecord(agentPayload.data)
            ? (agentPayload.data as Record<string, unknown>)
            : null;
          const eventText = typeof subData?.text === 'string' ? subData.text : '';

          if (stream === 'user' && eventText) {
            const msgId = `subagent-user-${Date.now()}-${msgs.length}`;
            const newMsg = { role: 'user', content: eventText };
            msgs.push(newMsg);
            // Emit IPC event for streaming
            const parentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
            if (parentSessionId) {
              this.emit('subagentMessage', parentSessionId, emitAgentId, {
                id: msgId,
                type: 'user',
                content: eventText,
                timestamp: Date.now(),
              });
            }
          } else if (stream === 'assistant' && eventText) {
            // Check for truncated NO_REPLY markers (OpenClaw special marker)
            // When detected, query chat.history to get complete text before showing
            const trimmedEventText = eventText.trim();
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = /^NO_REPLY$/i.test(trimmedEventText);
            if (isFullNoReply) {
              // Full NO_REPLY confirmed - skip entirely
              return;
            }
            const isPossibleNoReply =
              trimmedEventText.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(trimmedEventText) &&
              trimmedEventText.length > 0;

            if (isPossibleNoReply) {
              // Possible truncated prefix - query history to resolve
              if (this.orchestrationParentSessionId && emitAgentId && this.gatewayClient) {
                console.log(
                  '[OpenClawRuntime] subagent assistant: possible truncated NO_REPLY="' +
                    trimmedEventText +
                    '", syncing with history',
                );
                const subagentSessionKey = sessionKey;
                void this.syncSubagentNoReply(
                  storageKey,
                  emitAgentId,
                  subagentSessionKey,
                  msgs,
                  trimmedEventText,
                );
              }
              return;
            }

            // Normal text - proceed with message creation

            // Check if the last message is tool_result - if so, start a new assistant message
            const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            const isAfterToolResult = lastMsg && lastMsg.role === 'tool_result';

            // Find last assistant message (but only if we're not after a tool_result)
            const lastAssistant = isAfterToolResult
              ? null
              : msgs.filter(m => m.role === 'assistant').pop();

            const msgId = lastAssistant
              ? `subagent-assistant-${Date.now()}-${msgs.length - 1}`
              : `subagent-assistant-${Date.now()}-${msgs.length}`;

            if (lastAssistant && !isAfterToolResult) {
              // Continue appending to existing assistant message (streaming)
              const prevContent = lastAssistant.content;
              lastAssistant.content = eventText.startsWith(prevContent)
                ? eventText
                : prevContent + eventText;
              // Emit update event
              const parentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
              if (parentSessionId) {
                this.emit(
                  'subagentMessageUpdate',
                  parentSessionId,
                  emitAgentId,
                  msgId,
                  lastAssistant.content,
                );
              }
            } else {
              // Create new assistant message (after tool_result or no existing assistant)
              const newMsg = { role: 'assistant', content: eventText };
              msgs.push(newMsg);
              // Emit new message event
              const parentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
              if (parentSessionId) {
                this.emit('subagentMessage', parentSessionId, emitAgentId, {
                  id: msgId,
                  type: 'assistant',
                  content: eventText,
                  timestamp: Date.now(),
                });
              }
            }
          } else if (stream === 'thinking') {
            const thinkingDelta = typeof subData?.delta === 'string' ? subData.delta : '';
            const thinkingText = typeof subData?.text === 'string' ? subData.text : '';
            const msgId = `subagent-thinking-${Date.now()}`;
            // 将 thinking 添加到最后一个 assistant 消息
            const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
            const thinkingContent = thinkingDelta || thinkingText;
            if (lastAssistant) {
              lastAssistant.content = thinkingContent;
            } else {
              msgs.push({ role: 'assistant', content: thinkingContent });
            }
            // Emit thinking update event
            const thinkingParentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
            if (thinkingParentSessionId && thinkingContent) {
              this.emit(
                'subagentThinkingUpdate',
                thinkingParentSessionId,
                emitAgentId,
                msgId,
                thinkingContent,
              );
            }
          } else if (stream === 'tool' || stream === 'tools') {
            const toolPhase = typeof subData?.phase === 'string' ? subData.phase : '';
            const toolName = typeof subData?.name === 'string' ? subData.name : '';
            const toolCallId = typeof subData?.toolCallId === 'string' ? subData.toolCallId : '';
            if (toolPhase === 'start' && toolName) {
              const msgId = `subagent-tool-${toolCallId || Date.now()}`;
              const toolContent = `Using tool: ${toolName}\n\nInput: ${JSON.stringify(subData?.args || {}, null, 2)}`;
              const toolMsg = {
                role: 'tool_use',
                content: toolContent,
                metadata: {
                  toolName,
                  toolUseId: toolCallId,
                  toolInput: subData?.args,
                },
              };
              msgs.push(toolMsg);
              // Emit tool_use message
              const toolParentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
              if (toolParentSessionId) {
                this.emit('subagentMessage', toolParentSessionId, emitAgentId, {
                  id: msgId,
                  type: 'tool_use',
                  content: toolContent,
                  timestamp: Date.now(),
                  metadata: {
                    toolName,
                    toolUseId: toolCallId,
                    toolInput: subData?.args,
                  },
                });
                // Also add to main session's store so it appears in the conversation
                if (
                  toolName === 'sessions_spawn' ||
                  toolName === 'sessions_resume' ||
                  toolName === 'sessions_read'
                ) {
                  const mainToolUseId = toolCallId || emitAgentId;
                  if (mainToolUseId && !this._announceToolMessages.has(mainToolUseId + ':use')) {
                    this._announceToolMessages.add(mainToolUseId + ':use');
                    this.store.addMessage(toolParentSessionId, {
                      type: 'tool_use',
                      content: `Using tool: ${toolName}`,
                      metadata: {
                        toolName,
                        toolInput: isRecord(subData?.args)
                          ? (subData.args as Record<string, unknown>)
                          : {},
                        toolUseId: mainToolUseId,
                      },
                    });
                  }
                }
              }
            } else if (toolPhase === 'result' && toolCallId) {
              const resultText = typeof subData?.result === 'string' ? subData.result : '';
              const isError = Boolean(subData?.isError);
              const resultMsg = {
                role: 'tool_result',
                content: resultText,
                metadata: {
                  toolUseId: toolCallId,
                  isError,
                  toolResult: subData?.result,
                },
              };
              msgs.push(resultMsg);
              // Emit tool_result
              const resultParentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
              if (resultParentSessionId) {
                this.emit(
                  'subagentToolResult',
                  this.orchestrationParentSessionId,
                  emitAgentId,
                  toolCallId,
                  resultText,
                  isError,
                );
                // Also add to main session's store for sessions_spawn results
                if (
                  toolName === 'sessions_spawn' ||
                  toolName === 'sessions_resume' ||
                  toolName === 'sessions_read'
                ) {
                  const mainToolUseId = toolCallId || emitAgentId;
                  if (mainToolUseId && !this._announceToolMessages.has(mainToolUseId + ':result')) {
                    this._announceToolMessages.add(mainToolUseId + ':result');
                    this.store.addMessage(resultParentSessionId, {
                      type: 'tool_result',
                      content: resultText,
                      metadata: {
                        toolUseId: mainToolUseId,
                        toolName,
                        toolResult:
                          typeof subData?.result === 'string'
                            ? subData.result
                            : JSON.stringify(subData?.result ?? ''),
                        isError,
                      },
                    });
                  }
                }
              }
            }
          } else if (stream === 'item') {
            // item stream 包含 tool 执行的详细信息
            // 数据结构: { itemId, phase: 'start'|'update'|'end', kind: 'tool'|'command', title, status, name, meta (string), toolCallId }
            const itemKind = typeof subData?.kind === 'string' ? subData.kind : '';
            const itemPhase = typeof subData?.phase === 'string' ? subData.phase : '';
            const itemId = typeof subData?.itemId === 'string' ? subData.itemId : '';
            const itemName = typeof subData?.name === 'string' ? subData.name : '';
            const itemStatus = typeof subData?.status === 'string' ? subData.status : '';
            const itemTitle = typeof subData?.title === 'string' ? subData.title : '';
            const itemToolCallId =
              typeof subData?.toolCallId === 'string' ? subData.toolCallId : itemId;
            // meta is a string in OpenClaw AgentItemEventData, parse it as JSON if possible
            const metaRaw = typeof subData?.meta === 'string' ? subData.meta : '';
            let itemMeta: Record<string, unknown> = {};
            if (metaRaw) {
              try {
                itemMeta = JSON.parse(metaRaw) as Record<string, unknown>;
              } catch {
                // meta may not be JSON, use it as plain text
              }
            }
            // Also check if meta is already an object (legacy/alternative format)
            if (!Object.keys(itemMeta).length && isRecord(subData?.meta)) {
              itemMeta = subData.meta as Record<string, unknown>;
            }

            console.log(
              '[OpenClawRuntime] item event: kind=' +
                itemKind +
                ' phase=' +
                itemPhase +
                ' name=' +
                itemName +
                ' title=' +
                itemTitle +
                ' toolCallId=' +
                itemToolCallId +
                ' status=' +
                itemStatus +
                ' metaRaw=' +
                metaRaw.slice(0, 100),
            );

            if (itemKind === 'tool') {
              const effectiveToolCallId = itemToolCallId || itemId;
              if (itemPhase === 'start') {
                // 工具开始执行
                const msgId = `subagent-tool-${effectiveToolCallId || Date.now()}`;
                const toolInput = isRecord(itemMeta?.args)
                  ? itemMeta.args
                  : isRecord(itemMeta?.input)
                    ? itemMeta.input
                    : {};
                const toolContent = `Using tool: ${itemName}\n${itemTitle}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
                const toolMsg = {
                  role: 'tool_use',
                  content: toolContent,
                  metadata: {
                    toolName: itemName,
                    toolUseId: effectiveToolCallId,
                    toolInput,
                    status: itemStatus,
                  },
                };
                msgs.push(toolMsg);
                // Emit tool_use message
                const itemParentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
                if (itemParentSessionId) {
                  this.emit('subagentMessage', itemParentSessionId, emitAgentId, {
                    id: msgId,
                    type: 'tool_use',
                    content: toolContent,
                    timestamp: Date.now(),
                    metadata: {
                      toolName: itemName,
                      toolUseId: effectiveToolCallId,
                      toolInput,
                      status: itemStatus,
                    },
                  });
                  // Also add to main session's store for sessions_spawn
                  if (
                    itemName === 'sessions_spawn' ||
                    itemName === 'sessions_resume' ||
                    itemName === 'sessions_read'
                  ) {
                    const mainToolUseId = effectiveToolCallId || emitAgentId;
                    if (mainToolUseId && !this._announceToolMessages.has(mainToolUseId + ':use')) {
                      this._announceToolMessages.add(mainToolUseId + ':use');
                      this.store.addMessage(itemParentSessionId, {
                        type: 'tool_use',
                        content: `Using tool: ${itemName}`,
                        metadata: {
                          toolName: itemName,
                          toolInput,
                          toolUseId: mainToolUseId,
                        },
                      });
                    }
                  }
                }

                // Track nested sessions_spawn (subagent spawning another subagent)
                // This is for nested subagent spawns that use stream=item format instead of stream=tool
                // The main sessions_spawn tracking in handleAgentToolEvent only handles stream=tool events
                if (itemName === 'sessions_spawn') {
                  const nestedArgs = isRecord(toolInput) ? toolInput : {};

                  // Extract displayLabel from args
                  const nestedDisplayLabel =
                    typeof nestedArgs.label === 'string' && nestedArgs.label
                      ? nestedArgs.label
                      : typeof nestedArgs.agentId === 'string' && nestedArgs.agentId
                        ? nestedArgs.agentId
                        : '';

                  // Extract promptText from args.task or args.prompt
                  let nestedPromptText = '';
                  if (typeof nestedArgs.task === 'string' && nestedArgs.task) {
                    nestedPromptText = nestedArgs.task;
                  } else if (typeof nestedArgs.prompt === 'string' && nestedArgs.prompt) {
                    nestedPromptText = nestedArgs.prompt;
                  }

                  console.log(
                    '[OpenClawRuntime] nested sessions_spawn start (stream=item): TRACKING toolCallId=' +
                      effectiveToolCallId +
                      ' parentSessionKey=' +
                      sessionKey +
                      ' displayLabel=' +
                      (nestedDisplayLabel || '(none)') +
                      ' emitAgentId=' +
                      emitAgentId +
                      ' orchestrationParentSessionId=' +
                      (this.orchestrationParentSessionId || '(none)'),
                  );

                  // Set status to pending
                  this.subagentStatus.set(effectiveToolCallId, 'pending');
                  this.pendingToolCallIds.add(effectiveToolCallId);
                  this.pendingEntryTimestamps.set(effectiveToolCallId, Date.now());

                  // Map to parent's sessionKey (temporary, will be updated when tool result arrives)
                  if (sessionKey) {
                    this.toolCallIdToSessionKey.set(effectiveToolCallId, sessionKey);
                  }

                  // Extract main sessionId from sessionKey (format: agent:main:gucciai:sessionId:subagent:xxx)
                  // Or use orchestrationParentSessionId as fallback
                  const sessionIdFromKey = sessionKey?.split(':')[3];
                  const parentSessionId =
                    sessionIdFromKey || this.orchestrationParentSessionId || '';
                  if (parentSessionId) {
                    this.toolCallIdToParentSessionId.set(effectiveToolCallId, parentSessionId);
                  }

                  // Store display label
                  if (nestedDisplayLabel) {
                    this.toolCallIdToLabel.set(effectiveToolCallId, nestedDisplayLabel);
                  }

                  // Save args for result phase
                  this.toolCallArgs.set(effectiveToolCallId, {
                    ...nestedArgs,
                    _extractedPrompt: nestedPromptText,
                  });

                  // Initialize subagent messages array
                  if (!this.subagentMessages.has(effectiveToolCallId)) {
                    this.subagentMessages.set(effectiveToolCallId, []);
                  }

                  // Add context message if promptText exists
                  if (nestedPromptText) {
                    const nestedMsgs = this.subagentMessages.get(effectiveToolCallId)!;
                    const nestedContextMsg = {
                      role: 'user',
                      content: `[Nested Subagent Context]\n\n${nestedPromptText}`,
                      metadata: {
                        isSubagentContext: true,
                        label: nestedDisplayLabel,
                      },
                    };
                    nestedMsgs.push(nestedContextMsg);
                    console.log(
                      '[OpenClawRuntime] nested sessions_spawn: added context message, key=' +
                        effectiveToolCallId +
                        ' content starts with "' +
                        nestedContextMsg.content.slice(0, 60) +
                        '" msgsLen=' +
                        nestedMsgs.length,
                    );
                  }
                }
              } else if (itemPhase === 'end') {
                // 工具执行结束
                // 从 meta.result/output 获取结果，或使用 title/summary
                const resultContent =
                  typeof itemMeta?.result === 'string'
                    ? itemMeta.result
                    : typeof itemMeta?.output === 'string'
                      ? itemMeta.output
                      : typeof subData?.summary === 'string'
                        ? subData.summary
                        : itemTitle;
                const isError =
                  itemStatus === 'failed' || itemStatus === 'error' || Boolean(itemMeta?.is_error);
                const resultText = isError ? `Error: ${resultContent}` : resultContent;
                const resultMsg = {
                  role: 'tool_result',
                  content: resultText,
                  metadata: {
                    toolUseId: effectiveToolCallId,
                    isError,
                    toolResult: resultContent,
                  },
                };
                msgs.push(resultMsg);
                // Emit tool_result
                const resultParentSessionId2 = this.resolveSubagentParentSessionId(emitAgentId);
                if (resultParentSessionId2) {
                  this.emit(
                    'subagentToolResult',
                    resultParentSessionId2,
                    emitAgentId,
                    effectiveToolCallId,
                    resultContent,
                    isError,
                  );
                  // Also add to main session's store for sessions_spawn results
                  if (
                    itemName === 'sessions_spawn' ||
                    itemName === 'sessions_resume' ||
                    itemName === 'sessions_read'
                  ) {
                    const mainToolUseId = effectiveToolCallId || emitAgentId;
                    if (
                      mainToolUseId &&
                      !this._announceToolMessages.has(mainToolUseId + ':result')
                    ) {
                      this._announceToolMessages.add(mainToolUseId + ':result');
                      this.store.addMessage(resultParentSessionId2, {
                        type: 'tool_result',
                        content: resultText,
                        metadata: {
                          toolUseId: mainToolUseId,
                          toolName: itemName,
                          toolResult: resultContent,
                          isError,
                        },
                      });
                    }
                  }
                }
              }
            }
            // 兼容旧数据结构: type === 'tool_use'|'tool_result'
            const itemType = typeof subData?.type === 'string' ? subData.type : '';
            const toolUseId =
              typeof subData?.tool_use_id === 'string' ? subData.tool_use_id : itemId;

            if (itemType === 'tool_use' && itemName) {
              const toolInput = isRecord(subData?.input) ? subData.input : {};
              const toolContent = `Using tool: ${itemName}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
              msgs.push({
                role: 'tool_use',
                content: toolContent,
              });
              // Emit tool_use message
              const itemParentSessionId2 = this.resolveSubagentParentSessionId(emitAgentId);
              if (itemParentSessionId2) {
                this.emit('subagentMessage', itemParentSessionId2, emitAgentId, {
                  id: `subagent-item-${itemId || Date.now()}`,
                  type: 'tool_use',
                  content: toolContent,
                  timestamp: Date.now(),
                  metadata: {
                    toolName: itemName,
                    toolUseId: itemId,
                    toolInput,
                  },
                });
              }
            } else if (itemType === 'tool_result' && toolUseId) {
              const resultContent = typeof subData?.content === 'string' ? subData.content : '';
              const isError = Boolean(subData?.is_error);
              const resultText = isError ? `Error: ${resultContent}` : resultContent;
              msgs.push({
                role: 'tool_result',
                content: resultText,
              });
              // Emit tool_result
              if (this.orchestrationParentSessionId) {
                this.emit(
                  'subagentToolResult',
                  this.orchestrationParentSessionId,
                  emitAgentId,
                  toolUseId,
                  resultContent,
                  isError,
                );
              }
            }
          } else if (stream === 'command_output') {
            // command_output 是工具执行的输出，追加到最后一个 tool_result
            const outputText = typeof subData?.text === 'string' ? subData.text : '';
            // toolCallId is in subData.toolCallId (from Gateway command_output event)
            const commandToolCallId =
              typeof subData?.toolCallId === 'string' ? subData.toolCallId : undefined;
            if (outputText) {
              const lastToolResult = msgs.filter(m => m.role === 'tool_result').pop();
              if (lastToolResult) {
                lastToolResult.content = lastToolResult.content + '\n' + outputText;
                // Emit update for tool_result content
                if (this.orchestrationParentSessionId) {
                  // Use toolCallId from subData (Gateway sends it in command_output event)
                  const toolUseId =
                    commandToolCallId || (lastToolResult.metadata?.toolUseId as string | undefined);
                  if (toolUseId) {
                    this.emit(
                      'subagentToolResult',
                      this.orchestrationParentSessionId,
                      emitAgentId,
                      toolUseId,
                      lastToolResult.content,
                      false,
                    );
                  }
                }
              }
            }
          }
        }
      }

      // If we processed subagent events above, return early to avoid dropping them
      if (
        sessionKey &&
        (stream === 'user' ||
          stream === 'assistant' ||
          stream === 'thinking' ||
          stream === 'tool' ||
          stream === 'tools' ||
          stream === 'item' ||
          stream === 'command_output' ||
          stream === 'lifecycle')
      ) {
        // Event was handled above, no need to drop
        return;
      }

      console.log(
        '[Debug:handleAgentEvent] no sessionId, dropping event. runId:',
        runId,
        'sessionKey:',
        sessionKey,
      );
      if (runId) {
        this.enqueuePendingAgentEvent(runId, agentPayload, seq);
      }
      return;
    }
    if (sessionIdByRunId && sessionIdBySessionKey && sessionIdByRunId !== sessionIdBySessionKey) {
      console.log(
        '[Debug:handleAgentEvent] sessionId mismatch, dropping. byRunId:',
        sessionIdByRunId,
        'bySessionKey:',
        sessionIdBySessionKey,
      );
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log('[Debug:handleAgentEvent] no active turn for sessionId:', sessionId);
      return;
    }

    // Allow subagent events through even if sessionKey doesn't match turn's sessionKey.
    // Subagent sessionKey format: agent:${agentId}:subagent:${uuid}
    const isSubagentEvent = sessionKey?.includes(':subagent:');
    if (sessionKey && !runId && turn.sessionKey !== sessionKey && !isSubagentEvent) {
      console.log(
        '[Debug:handleAgentEvent] sessionKey mismatch, dropping. event:',
        sessionKey,
        'turn:',
        turn.sessionKey,
      );
      return;
    }

    if (runId) {
      const mappedSessionId = this.sessionIdByRunId.get(runId);
      if (mappedSessionId && mappedSessionId !== sessionId) {
        console.log(
          '[Debug:handleAgentEvent] runId mapped to different session, dropping. mapped:',
          mappedSessionId,
          'current:',
          sessionId,
        );
        return;
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
    }

    // Buffer agent events while user messages are being prefetched for channel sessions.
    // Must be checked BEFORE seq dedup so that replayed events are not dropped.
    if (turn.pendingUserSync) {
      console.log(
        '[Debug:handleAgentEvent] buffering agent event (pendingUserSync), sessionId:',
        sessionId,
        'buffered:',
        turn.bufferedAgentPayloads.length + 1,
      );
      turn.bufferedAgentPayloads.push({ payload: agentPayload, seq, bufferedAt: Date.now() });
      return;
    }

    // Sequence-based dedup (placed after buffer check to match handleChatEvent pattern)
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastAgentSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastAgentSeqByRunId.set(runId, seq);
    }

    // 捕获子 Agent 事件 (stream 格式: 'assistant' | 'user' | 'tool' | 'tools' | 'item' | 'command_output')
    // sessionKey 格式: agent:${agentId}:subagent:${uuid} 或 channel:main-agent
    if (
      stream === 'assistant' ||
      stream === 'user' ||
      stream === 'tool' ||
      stream === 'tools' ||
      stream === 'item' ||
      stream === 'command_output'
    ) {
      // 从 sessionKey 中提取 agentId: agent:${agentId}:subagent:${uuid} -> ${agentId}
      const agentIdMatch = sessionKey?.match(/^agent:([^:]+):/);
      const extractedAgentId = agentIdMatch ? agentIdMatch[1] : null;

      // 使用 sessionKey → label 映射找到正确的 label
      const mappedLabel = sessionKey ? this.sessionKeyToLabel.get(sessionKey) : null;
      // 优先使用映射的 label，否则使用提取的 agentId
      const storageKey = mappedLabel || extractedAgentId || sessionKey;
      // Get toolCallId for IPC emission (frontend expects toolCallId as agentId)
      // Priority: 1. direct sessionKey → toolCallId mapping
      //           2. storageKey → toolCallId mapping
      //           3. label → toolCallId mapping (if we have mappedLabel)
      //           4. reverse lookup from parent session
      //           5. pending toolCallIds check (for events before sessionKey mapping established)
      let emitAgentId =
        (sessionKey ? this.sessionKeyToToolCallId.get(sessionKey) : undefined) ||
        (storageKey ? this.sessionKeyToToolCallId.get(storageKey) : undefined) ||
        '';
      if (!emitAgentId) {
        emitAgentId = storageKey || '';
        console.log(
          '[OpenClawRuntime] emitAgentId final fallback: using storageKey=' + emitAgentId,
        );
      }

      console.log(
        '[OpenClawRuntime] emitAgentId result: sessionKey=' +
          (sessionKey || '(none)') +
          ' storageKey=' +
          (storageKey || '(none)') +
          ' emitAgentId=' +
          emitAgentId +
          ' sessionKeyToToolCallId=' +
          JSON.stringify(Array.from(this.sessionKeyToToolCallId.entries()).slice(0, 5)),
      );

      // 调试日志
      if (sessionKey && sessionKey.includes('subagent')) {
        console.log(
          '[OpenClawRuntime] subagent event: sessionKey=' +
            sessionKey +
            ' extractedAgentId=' +
            extractedAgentId +
            ' mappedLabel=' +
            mappedLabel +
            ' storageKey=' +
            storageKey +
            ' emitAgentId=' +
            emitAgentId +
            ' stream=' +
            stream,
        );
      }

      // 只处理 subagent sessionKey（格式: agent:*:subagent:*）
      // 使用直接匹配而非排除逻辑，更健壮且能处理未来边缘情况
      if (sessionKey?.includes(':subagent:')) {
        if (!this.subagentMessages.has(storageKey)) {
          this.subagentMessages.set(storageKey, []);
        }
        const msgs = this.subagentMessages.get(storageKey)!;
        const subData = isRecord(agentPayload.data)
          ? (agentPayload.data as Record<string, unknown>)
          : null;
        const eventText = typeof subData?.text === 'string' ? subData.text : '';

        if ((stream === 'assistant' || stream === 'user') && eventText.length > 0) {
          const role = stream;

          // Check for truncated NO_REPLY markers (OpenClaw special marker)
          // When detected, query chat.history to get complete text before showing
          if (role === 'assistant') {
            const trimmedEventText = eventText.trim();
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = /^NO_REPLY$/i.test(trimmedEventText);
            if (isFullNoReply) {
              return;
            }
            const isPossibleNoReply =
              trimmedEventText.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(trimmedEventText) &&
              trimmedEventText.length > 0;

            if (isPossibleNoReply) {
              // Possible truncated prefix - query history to resolve
              if (emitAgentId && this.gatewayClient) {
                console.log(
                  '[OpenClawRuntime] subagent assistant (sessionId): possible truncated NO_REPLY="' +
                    trimmedEventText +
                    '", syncing with history',
                );
                void this.syncSubagentNoReply(
                  storageKey,
                  emitAgentId,
                  sessionKey,
                  msgs,
                  trimmedEventText,
                );
              }
              return;
            }
          }

          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          if (lastMsg && lastMsg.role === role) {
            if (
              eventText.length >= lastMsg.content.length &&
              eventText.startsWith(lastMsg.content)
            ) {
              lastMsg.content = eventText;
              // Emit update event
              if (this.orchestrationParentSessionId && emitAgentId) {
                this.emit(
                  'subagentMessageUpdate',
                  this.orchestrationParentSessionId,
                  emitAgentId,
                  `subagent-${role}-${Date.now()}`,
                  eventText,
                );
              }
            } else if (!lastMsg.content.startsWith(eventText)) {
              const newMsg = { role, content: eventText };
              msgs.push(newMsg);
              // Emit new message event
              const sessParentId1 = this.resolveSubagentParentSessionId(emitAgentId);
              if (sessParentId1 && emitAgentId) {
                this.emit('subagentMessage', sessParentId1, emitAgentId, {
                  id: `subagent-${role}-${Date.now()}-${msgs.length}`,
                  type: role,
                  content: eventText,
                  timestamp: Date.now(),
                });
              }
            }
          } else {
            const newMsg = { role, content: eventText };
            msgs.push(newMsg);
            // Emit new message event
            const sessParentId2 = this.resolveSubagentParentSessionId(emitAgentId);
            if (sessParentId2 && emitAgentId) {
              this.emit('subagentMessage', sessParentId2, emitAgentId, {
                id: `subagent-${role}-${Date.now()}-${msgs.length}`,
                type: role,
                content: eventText,
                timestamp: Date.now(),
              });
            }
          }
        } else if (stream === 'tool' || stream === 'tools') {
          if (subData) {
            const toolPhase = typeof subData.phase === 'string' ? subData.phase : '';
            const toolName = typeof subData.name === 'string' ? subData.name : '';
            if (toolPhase === 'start' && toolName) {
              let toolSummary = `🔧 **${toolName}**`;
              if (isRecord(subData.args)) {
                const args = subData.args as Record<string, unknown>;
                const command = typeof args.command === 'string' ? args.command : '';
                const filePath =
                  typeof args.file_path === 'string'
                    ? args.file_path
                    : typeof args.path === 'string'
                      ? args.path
                      : '';
                if (command) toolSummary += `\n\`\`\`\n${command.slice(0, 500)}\n\`\`\``;
                else if (filePath) toolSummary += `: ${filePath}`;
              }
              const toolCallId = typeof subData?.toolCallId === 'string' ? subData.toolCallId : '';
              const toolMsg = {
                role: 'tool_use',
                content: toolSummary,
                metadata: {
                  toolName,
                  toolUseId: toolCallId,
                  toolInput: subData.args,
                },
              };
              msgs.push(toolMsg);
              // Emit tool_use message
              const toolParentSessionId3 = this.resolveSubagentParentSessionId(emitAgentId);
              if (toolParentSessionId3 && emitAgentId) {
                this.emit('subagentMessage', toolParentSessionId3, emitAgentId, {
                  id: `subagent-tool-${toolCallId || Date.now()}`,
                  type: 'tool_use',
                  content: toolSummary,
                  timestamp: Date.now(),
                  metadata: {
                    toolName,
                    toolUseId: toolCallId,
                    toolInput: subData.args,
                  },
                });
              }
            }
          }
        } else if (stream === 'item') {
          // item stream: tool execution details
          // Data structure: { itemId, phase: 'start'|'update'|'end', kind: 'tool'|'command', title, status, name, meta (string), toolCallId }
          if (subData) {
            const itemKind = typeof subData.kind === 'string' ? subData.kind : '';
            const itemPhase = typeof subData.phase === 'string' ? subData.phase : '';
            const itemId = typeof subData.itemId === 'string' ? subData.itemId : '';
            const itemName = typeof subData.name === 'string' ? subData.name : '';
            const itemStatus = typeof subData.status === 'string' ? subData.status : '';
            const itemTitle = typeof subData.title === 'string' ? subData.title : '';
            const itemToolCallId =
              typeof subData.toolCallId === 'string' ? subData.toolCallId : itemId;
            // meta is a string in OpenClaw AgentItemEventData, parse it as JSON if possible
            const metaRaw = typeof subData.meta === 'string' ? subData.meta : '';
            let itemMeta: Record<string, unknown> = {};
            if (metaRaw) {
              try {
                itemMeta = JSON.parse(metaRaw) as Record<string, unknown>;
              } catch {
                // meta may not be JSON, ignore
              }
            }
            if (!Object.keys(itemMeta).length && isRecord(subData.meta)) {
              itemMeta = subData.meta as Record<string, unknown>;
            }

            console.log(
              '[OpenClawRuntime] subagent item event (with sessionId): kind=' +
                itemKind +
                ' phase=' +
                itemPhase +
                ' name=' +
                itemName +
                ' title=' +
                itemTitle +
                ' toolCallId=' +
                itemToolCallId +
                ' status=' +
                itemStatus,
            );

            if (itemKind === 'tool') {
              const effectiveToolCallId = itemToolCallId || itemId;
              if (itemPhase === 'start') {
                const msgId = `subagent-tool-${effectiveToolCallId || Date.now()}`;
                const toolInput = isRecord(itemMeta?.args)
                  ? itemMeta.args
                  : isRecord(itemMeta?.input)
                    ? itemMeta.input
                    : {};
                const toolContent = `Using tool: ${itemName}\n${itemTitle}\n\nInput: ${JSON.stringify(toolInput, null, 2)}`;
                const toolMsg = {
                  role: 'tool_use',
                  content: toolContent,
                  metadata: {
                    toolName: itemName,
                    toolUseId: effectiveToolCallId,
                    toolInput,
                    status: itemStatus,
                  },
                };
                msgs.push(toolMsg);
                const itemParentSessionId4 = this.resolveSubagentParentSessionId(emitAgentId);
                if (itemParentSessionId4 && emitAgentId) {
                  this.emit('subagentMessage', itemParentSessionId4, emitAgentId, {
                    id: msgId,
                    type: 'tool_use',
                    content: toolContent,
                    timestamp: Date.now(),
                    metadata: {
                      toolName: itemName,
                      toolUseId: effectiveToolCallId,
                      toolInput,
                      status: itemStatus,
                    },
                  });
                }
              } else if (itemPhase === 'end') {
                const resultContent =
                  typeof itemMeta?.result === 'string'
                    ? itemMeta.result
                    : typeof itemMeta?.output === 'string'
                      ? itemMeta.output
                      : typeof subData.summary === 'string'
                        ? subData.summary
                        : itemTitle;
                const isError =
                  itemStatus === 'failed' || itemStatus === 'error' || Boolean(itemMeta?.is_error);
                const resultText = isError ? `Error: ${resultContent}` : resultContent;
                const resultMsg = {
                  role: 'tool_result',
                  content: resultText,
                  metadata: {
                    toolUseId: effectiveToolCallId,
                    isError,
                    toolResult: resultContent,
                  },
                };
                msgs.push(resultMsg);
                if (this.orchestrationParentSessionId && emitAgentId) {
                  this.emit(
                    'subagentToolResult',
                    this.orchestrationParentSessionId,
                    emitAgentId,
                    effectiveToolCallId,
                    resultContent,
                    isError,
                  );
                }
              }
            }
          }
        }
      }
    }

    // Fast-path: skip assistant-stream events — they carry the same text as
    // chat deltas and dispatchAgentEvent() has no handler for stream=assistant.
    if (stream === 'assistant') {
      return;
    }

    this.dispatchAgentEvent(sessionId, turn, {
      ...agentPayload,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
  }

  private dispatchAgentEvent(
    sessionId: string,
    turn: ActiveTurn,
    agentPayload: AgentEventPayload,
  ): void {
    const stream = typeof agentPayload.stream === 'string' ? agentPayload.stream.trim() : '';
    const hasToolShape =
      isRecord(agentPayload.data) && typeof agentPayload.data.toolCallId === 'string';

    // Extract sessionKey from payload for lifecycle events
    let sessionKey =
      typeof agentPayload.sessionKey === 'string'
        ? agentPayload.sessionKey.trim()
        : typeof (agentPayload as Record<string, unknown>).session === 'string'
          ? ((agentPayload as Record<string, unknown>).session as string).trim()
          : '';
    // Normalize subagent sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
    if (sessionKey && sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
      sessionKey = 'agent:main:' + sessionKey;
    }

    // End thinking stream when we receive non-thinking streams (tool/lifecycle)
    if (stream !== 'thinking' && !turn.thinkingStreamEnded && turn.currentThinkingMessageId) {
      turn.thinkingStreamEnded = true;
      // Reset assistantMessageId so response text creates a new message
      // instead of reusing the thinking message. This ensures correct
      // display order: thinking → tools → response.
      turn.assistantMessageId = null;
      // Update thinking message metadata to mark streaming as ended
      // Pass the final accumulated thinking content to save to database
      this.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
    }

    // Skip thinking events - they are processed earlier in processAgentThinkingEvent
    if (stream === 'thinking') {
      return;
    }

    // Handle stream=item events at the main dispatch level.
    // session.tool events often carry stream=item data with tool info (especially sessions_spawn
    // from subagent-announced spawns). Without this, second batch spawns from announcing subagents
    // are never tracked in subagentStatus.
    if (stream === 'item') {
      const subData = isRecord(agentPayload.data)
        ? (agentPayload.data as Record<string, unknown>)
        : null;
      if (subData) {
        const itemKind = typeof subData.kind === 'string' ? subData.kind : '';
        const itemPhase = typeof subData.phase === 'string' ? subData.phase : '';
        const itemName = typeof subData.name === 'string' ? subData.name : '';
        const itemToolCallId = typeof subData.toolCallId === 'string' ? subData.toolCallId : '';
        const itemMetaRaw = typeof subData.meta === 'string' ? subData.meta : '';

        if (
          itemKind === 'tool' &&
          itemPhase === 'start' &&
          itemToolCallId &&
          itemName === 'sessions_spawn'
        ) {
          // Extract label and task from meta or item data
          let itemLabel = '';
          let itemTask = '';
          if (itemMetaRaw) {
            try {
              const itemMetaParsed = JSON.parse(itemMetaRaw) as Record<string, unknown>;
              itemLabel = typeof itemMetaParsed.label === 'string' ? itemMetaParsed.label : '';
              itemTask = typeof itemMetaParsed.task === 'string' ? itemMetaParsed.task : '';
            } catch {
              // meta may not be JSON, try regex for gateway format: 'label xxx, task yyy'
              const labelMatch = itemMetaRaw.match(/label\s+([^,]+)/);
              if (labelMatch && labelMatch[1]) itemLabel = labelMatch[1].trim();
              const taskMatch = itemMetaRaw.match(/task\s+(.+)$/i);
              if (taskMatch && taskMatch[1]) itemTask = taskMatch[1].trim();
            }
          }
          if (!itemLabel && typeof subData.label === 'string') itemLabel = subData.label;
          if (!itemTask && typeof subData.task === 'string') itemTask = subData.task;

          // Track the spawn in subagentStatus
          const displayLabel = itemLabel || itemTask.slice(0, 30) || itemName || itemToolCallId;
          console.log(
            '[OpenClawRuntime] item-level sessions_spawn: toolCallId=' +
              itemToolCallId +
              ' label=' +
              displayLabel +
              ' sessionKey=' +
              (sessionKey || '(none)'),
          );

          if (!this.subagentStatus.has(itemToolCallId)) {
            this.subagentStatus.set(itemToolCallId, 'pending');
            this.pendingToolCallIds.add(itemToolCallId);
            this.pendingEntryTimestamps.set(itemToolCallId, Date.now());
            this.toolCallIdToLabel.set(itemToolCallId, displayLabel);
            this.toolCallIdToParentSessionId.set(itemToolCallId, sessionId);
            if (sessionKey) this.toolCallIdToSessionKey.set(itemToolCallId, sessionKey);
            this.toolCallArgs.set(itemToolCallId, {
              label: itemLabel,
              task: itemTask,
            });
            // Track as item-level spawn for orphan detection
            this.itemLevelSpawnedToolCallIds.add(itemToolCallId);

            // Initialize subagentMessages for this toolCallId
            if (!this.subagentMessages.has(itemToolCallId)) {
              this.subagentMessages.set(itemToolCallId, []);
            }

            // Create a tool_use message so the spawn appears in the main message list
            // Matches the format used by handleAgentToolEvent (line ~5155)
            const effectiveArgs: Record<string, unknown> = {
              label: itemLabel,
              task: itemTask,
            };
            const toolUseMessage = this.store.addMessage(sessionId, {
              type: 'tool_use',
              content: `Using tool: sessions_spawn`,
              metadata: {
                toolName: 'sessions_spawn',
                toolInput: effectiveArgs,
                toolUseId: itemToolCallId,
              },
            });
            turn.toolUseMessageIdByToolCallId.set(itemToolCallId, toolUseMessage.id);
            this.emit('message', sessionId, toolUseMessage);

            console.log(
              '[OpenClawRuntime] item-level sessions_spawn: created tool_use message toolCallId=' +
                itemToolCallId +
                ' messageId=' +
                toolUseMessage.id,
            );

            // Emit subagent context message (matches stream=tool path at line ~4830)
            if (itemTask) {
              const contextMsg = {
                role: 'user',
                content: `[Subagent Context]\n\n${itemTask}`,
                metadata: {
                  isSubagentContext: true,
                  label: displayLabel,
                },
              };
              const msgs = this.subagentMessages.get(itemToolCallId)!;
              msgs.push(contextMsg);

              // Emit IPC event for the context message
              this.emit('subagentMessage', sessionId, itemToolCallId, {
                id: `subagent-context-${Date.now()}`,
                type: 'user',
                content: contextMsg.content,
                timestamp: Date.now(),
                metadata: contextMsg.metadata,
              });

              console.log(
                '[OpenClawRuntime] item-level sessions_spawn: emitted subagent context toolCallId=' +
                  itemToolCallId,
              );
            }
          }
        }

        // Handle item-level sessions_spawn result (phase=end)
        // Create tool_result message matching handleAgentToolEvent format (line ~5187)
        if (itemKind === 'tool' && itemPhase === 'end' && itemToolCallId && itemMetaRaw) {
          // Update childSessionKey mapping when result contains it
          try {
            const itemMetaParsed = JSON.parse(itemMetaRaw) as Record<string, unknown>;
            const childSessionKey =
              typeof itemMetaParsed.childSessionKey === 'string'
                ? itemMetaParsed.childSessionKey
                : '';
            if (childSessionKey && this.toolCallIdToSessionKey.get(itemToolCallId)) {
              this.toolCallIdToSessionKey.set(itemToolCallId, childSessionKey);
            }

            // Check if spawn succeeded (no error in result)
            const isError =
              typeof itemMetaParsed.isError === 'boolean' ? itemMetaParsed.isError : false;

            if (!isError && this.itemLevelSpawnedToolCallIds.has(itemToolCallId)) {
              // Build result content for the tool_result message
              const resultContent = JSON.stringify({
                childSessionKey: childSessionKey || '(unknown)',
                status: 'ok',
              });

              const toolInputForResult: Record<string, unknown> = {};
              if (this.toolCallArgs.has(itemToolCallId)) {
                const saved = this.toolCallArgs.get(itemToolCallId);
                if (saved) {
                  Object.assign(toolInputForResult, saved);
                }
              }

              const existingResultMessageId =
                turn.toolResultMessageIdByToolCallId.get(itemToolCallId);
              if (existingResultMessageId) {
                // Update existing streaming result
                this.store.updateMessage(sessionId, existingResultMessageId, {
                  content: resultContent,
                  metadata: {
                    toolResult: resultContent,
                    toolUseId: itemToolCallId,
                    toolName: 'sessions_spawn',
                    toolInput: toolInputForResult,
                    isError: false,
                    isStreaming: false,
                    isFinal: true,
                  },
                });
              } else {
                // Create new tool_result message
                const resultMessage = this.store.addMessage(sessionId, {
                  type: 'tool_result',
                  content: resultContent,
                  metadata: {
                    toolResult: resultContent,
                    toolUseId: itemToolCallId,
                    toolName: 'sessions_spawn',
                    toolInput: toolInputForResult,
                    isError: false,
                    isStreaming: false,
                    isFinal: true,
                  },
                });
                turn.toolResultMessageIdByToolCallId.set(itemToolCallId, resultMessage.id);
                this.emit('message', sessionId, resultMessage);
              }

              // Mark as running since spawn succeeded and lifecycle events may follow
              if (this.subagentStatus.get(itemToolCallId) === 'pending') {
                this.subagentStatus.set(itemToolCallId, 'running');
                this.subagentLastActivity.set(itemToolCallId, Date.now());
              }

              console.log(
                '[OpenClawRuntime] item-level sessions_spawn result: created tool_result toolCallId=' +
                  itemToolCallId +
                  ' childSessionKey=' +
                  (childSessionKey || '(unknown)'),
              );
            }
          } catch {
            // meta may not be JSON
          }
        }
      }
    }

    // Buffer tool events from announce runIds so the chat final text message
    // (announce text) displays before tool events. The gateway sends session.tool
    // events before chat final for announce runs.
    const isToolStream = stream === 'tool' || stream === 'tools' || (!stream && hasToolShape);
    const eventRunId = typeof agentPayload.runId === 'string' ? agentPayload.runId.trim() : '';
    if (isToolStream && eventRunId && turn.runId && eventRunId !== turn.runId) {
      let buffered = this.bufferedToolEventsByRunId.get(eventRunId) || [];
      buffered.push({ payload: agentPayload });
      this.bufferedToolEventsByRunId.set(eventRunId, buffered);

      // Safety timeout: flush after 2s if chat final never arrives
      if (!this.bufferedToolTimeouts.has(eventRunId)) {
        const timeout = setTimeout(() => {
          this.bufferedToolTimeouts.delete(eventRunId);
          const events = this.bufferedToolEventsByRunId.get(eventRunId);
          this.bufferedToolEventsByRunId.delete(eventRunId);
          if (events) {
            for (const ev of events) {
              this.handleAgentToolEvent(sessionId, turn, ev.payload);
            }
          }
        }, 2000);
        this.bufferedToolTimeouts.set(eventRunId, timeout);
      }
      return;
    }

    if (isToolStream) {
      // Gateway format check: tool events may have 'tool', 'call', 'meta' directly in payload
      // (not nested in 'data'). Example: { stream: 'tool', tool: 'result:sessions_spawn', call: 'xxx', meta: 'label xxx' }
      // Also check for session.tool gateway format where data carries { tool, call, meta }
      const hasGatewayToolShape =
        typeof (agentPayload as Record<string, unknown>).tool === 'string' ||
        (isRecord(agentPayload.data) &&
          typeof (agentPayload.data as Record<string, unknown>).tool === 'string');

      if (Array.isArray(agentPayload.data)) {
        for (const entry of agentPayload.data) {
          this.handleAgentToolEvent(sessionId, turn, entry);
        }
      } else if (hasGatewayToolShape) {
        // Gateway format: pass entire payload (contains tool, call, meta)
        this.handleAgentToolEvent(sessionId, turn, agentPayload);
      } else {
        this.handleAgentToolEvent(sessionId, turn, agentPayload.data);
      }
      return;
    }

    if (stream === 'lifecycle') {
      this.handleAgentLifecycleEvent(sessionId, sessionKey, agentPayload.data);
    }
  }

  private enqueuePendingAgentEvent(runId: string, payload: AgentEventPayload, seq?: number): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const stream = typeof payload.stream === 'string' ? payload.stream.trim() : '';
    const hasToolShape = isRecord(payload.data) && typeof payload.data.toolCallId === 'string';
    const isSupportedStream =
      stream === 'tool' ||
      stream === 'tools' ||
      stream === 'lifecycle' ||
      stream === 'thinking' ||
      (!stream && hasToolShape);
    if (!isSupportedStream) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId) ?? [];
    queued.push({
      runId: normalizedRunId,
      sessionKey: payload.sessionKey,
      stream: payload.stream,
      data: payload.data,
      ...(typeof seq === 'number' && Number.isFinite(seq) ? { seq } : {}),
    });
    if (queued.length > 240) {
      queued.shift();
    }
    this.pendingAgentEventsByRunId.set(normalizedRunId, queued);

    if (this.pendingAgentEventsByRunId.size > 400) {
      const oldestRunId = this.pendingAgentEventsByRunId.keys().next().value as string | undefined;
      if (oldestRunId) {
        this.pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  }

  private flushPendingAgentEvents(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;

    const queued = this.pendingAgentEventsByRunId.get(normalizedRunId);
    if (!queued || queued.length === 0) return;
    this.pendingAgentEventsByRunId.delete(normalizedRunId);

    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    for (const event of queued) {
      this.dispatchAgentEvent(sessionId, turn, event);
    }
  }

  /**
   * Flush buffered tool events for a specific announce runId.
   * Called after the chat final text message is emitted, so tool events
   * display in the correct order (text first, then tools).
   */
  private flushBufferedToolEventsForRunId(
    sessionId: string,
    turn: ActiveTurn,
    runId: string,
  ): void {
    // Cancel safety timeout
    const timeout = this.bufferedToolTimeouts.get(runId);
    if (timeout) {
      clearTimeout(timeout);
      this.bufferedToolTimeouts.delete(runId);
    }

    const buffered = this.bufferedToolEventsByRunId.get(runId);
    if (!buffered || buffered.length === 0) {
      this.bufferedToolEventsByRunId.delete(runId);
      return;
    }
    this.bufferedToolEventsByRunId.delete(runId);

    console.log(
      '[OpenClawRuntime] flushing buffered tool events for runId=' +
        runId.slice(0, 20) +
        ' count=' +
        buffered.length,
    );
    for (const ev of buffered) {
      this.handleAgentToolEvent(sessionId, turn, ev.payload);
    }
  }

  private rememberSessionKey(sessionId: string, sessionKey: string): void {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    this.sessionIdBySessionKey.set(normalizedSessionKey, sessionId);
  }

  private resolveSessionIdBySessionKey(sessionKey: string): string | null {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return null;

    const mappedSessionId = this.sessionIdBySessionKey.get(normalizedSessionKey);
    if (mappedSessionId) {
      return mappedSessionId;
    }

    const parsedManagedSession = parseManagedSessionKey(normalizedSessionKey);
    if (!parsedManagedSession) {
      return null;
    }

    const session = this.store.getSession(parsedManagedSession.sessionId);
    if (!session) {
      return null;
    }

    this.rememberSessionKey(session.id, normalizedSessionKey);
    this.rememberSessionKey(session.id, this.toSessionKey(session.id, session.agentId));
    return session.id;
  }

  private nextTurnToken(sessionId: string): number {
    const nextToken = (this.latestTurnTokenBySession.get(sessionId) ?? 0) + 1;
    this.latestTurnTokenBySession.set(sessionId, nextToken);
    return nextToken;
  }

  private isCurrentTurnToken(sessionId: string, turnToken: number): boolean {
    return (this.latestTurnTokenBySession.get(sessionId) ?? 0) === turnToken;
  }

  private reuseFinalAssistantMessage(sessionId: string, content: string): string | null {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return null;
    }

    const session = this.store.getSession(sessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    if (!lastMessage || lastMessage.type !== 'assistant') {
      return null;
    }
    if (lastMessage.content.trim() !== normalizedContent) {
      return null;
    }

    this.store.updateMessage(sessionId, lastMessage.id, {
      content,
      metadata: {
        isStreaming: false,
        isFinal: true,
      },
    });
    return lastMessage.id;
  }

  private handleAgentLifecycleEvent(sessionId: string, sessionKey: string, data: unknown): void {
    if (!isRecord(data)) return;
    const phase = typeof data.phase === 'string' ? data.phase.trim() : '';

    // 捕获子 Agent 生命周期事件
    // Use sessionKey to find toolCallId (unique), NOT agentId/label (not unique across sessions)
    const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
    const isMainAgent = !agentId || agentId === 'main-agent';

    if (!isMainAgent && sessionKey) {
      // Normalize sessionKey: if it starts with 'subagent:', add 'agent:main:' prefix
      let normalizedSessionKey = sessionKey;
      if (sessionKey.startsWith('subagent:') && !sessionKey.startsWith('agent:')) {
        normalizedSessionKey = 'agent:main:' + sessionKey;
      }

      // Try to find toolCallId by sessionKey (unique identifier)
      let toolCallId = this.sessionKeyToToolCallId.get(normalizedSessionKey);

      // Fallback 1: Try with 'subagent:' short prefix (gateway might use short format)
      if (!toolCallId && normalizedSessionKey.startsWith('agent:main:subagent:')) {
        const shortSessionKey = normalizedSessionKey.slice('agent:main:'.length);
        toolCallId = this.sessionKeyToToolCallId.get(shortSessionKey);
      }

      // Fallback 2: Extract UUID from sessionKey and search subagentStatus keys
      if (!toolCallId && normalizedSessionKey.includes(':subagent:')) {
        const uuidPart = normalizedSessionKey.split(':subagent:')[1];
        if (uuidPart) {
          for (const [key, _status] of this.subagentStatus) {
            if (key === uuidPart || key.includes(uuidPart)) {
              toolCallId = key;
              // Establish mapping for future lookups
              this.sessionKeyToToolCallId.set(normalizedSessionKey, toolCallId);
              this.toolCallIdToSessionKey.set(toolCallId, normalizedSessionKey);
              break;
            }
          }
        }
      }

      // Fallback 3: For end/completed/stopped phases, try to find any unmapped
      // running subagent — the most likely candidate for a completion event.
      if (!toolCallId && (phase === 'end' || phase === 'completed' || phase === 'stopped')) {
        for (const [key, status] of this.subagentStatus) {
          if (status === 'running' && !this.sessionKeyToToolCallId.has(normalizedSessionKey)) {
            // Verify this key isn't already mapped to a different sessionKey
            const mappedKey = this.toolCallIdToSessionKey.get(key);
            if (!mappedKey || mappedKey === normalizedSessionKey) {
              toolCallId = key;
              this.sessionKeyToToolCallId.set(normalizedSessionKey, toolCallId);
              this.toolCallIdToSessionKey.set(toolCallId, normalizedSessionKey);
              console.log(
                '[OpenClawRuntime] subagent lifecycle: fallback matched running toolCallId=' +
                  toolCallId +
                  ' to sessionKey=' +
                  normalizedSessionKey +
                  ' phase=' +
                  phase,
              );
              break;
            }
          }
        }
      }

      if (toolCallId) {
        // Update status using toolCallId as key (unique)
        if (phase === 'start' || phase === 'running') {
          // Never overwrite 'done' — a completed subagent stays completed
          const existingStatus = this.subagentStatus.get(toolCallId);
          if (existingStatus !== 'done') {
            this.subagentStatus.set(toolCallId, 'running');
            this.subagentLastActivity.set(toolCallId, Date.now());
          }
        } else if (
          phase === 'end' ||
          phase === 'completed' ||
          phase === 'stopped' ||
          phase === 'error'
        ) {
          this.subagentStatus.set(toolCallId, 'done');
          this.persistSubagentStatus(toolCallId, 'done');
          if (phase !== 'error') {
            this.checkAllSubagentsDone();
          }
        }
      }
    }

    // Main agent lifecycle events control session status
    // Only set status on lifecycle start to ensure running state when main agent begins.
    // Do NOT set 'completed' on lifecycle end - let handleChatFinal decide the final status.
    // This prevents status flicker (lifecycle end -> completed -> chat final -> running)
    // when main agent has follow-up runs after processing subagent results.
    if (isMainAgent && phase === 'start') {
      this.store.updateSession(sessionId, { status: 'running' });
      this.mainAgentLifecycleEnded = false;
    }
    if (isMainAgent && phase === 'end') {
      this.mainAgentLifecycleEnded = true;
      // Check if all subagents are already done. If so, finalize immediately.
      // If not, checkAllSubagentsDone will handle it when subagents complete.
      // This also covers the case where the last chat event comes from a different
      // runId (subagent announce) and returns early without calling handleChatFinal.
      this.checkAllSubagentsDone();
    }
  }

  /**
   * Finalize a thinking message when the thinking stream ends.
   * Updates metadata to mark streaming as complete while preserving isThinking flag
   * so the message remains visible in the UI.
   * Also saves the final accumulated thinking content to the database.
   */
  private finalizeThinkingMessage(
    sessionId: string,
    messageId: string,
    finalThinkingContent?: string,
  ): void {
    const session = this.store.getSession(sessionId);
    const message = session?.messages.find(m => m.id === messageId);
    if (!message) return;

    // Preserve isThinking but mark streaming as ended
    const isThinking = message.metadata?.isThinking ?? true;
    const newMetadata = { isStreaming: false, isFinal: true, isThinking };

    // Update both metadata and thinkingContent in the database
    // If finalThinkingContent is provided, use it; otherwise keep existing content
    const updates: { metadata: typeof newMetadata; thinkingContent?: string } = {
      metadata: newMetadata,
    };
    if (finalThinkingContent !== undefined) {
      updates.thinkingContent = finalThinkingContent;
    }

    this.store.updateMessage(sessionId, messageId, updates);
    // Emit metadata update so UI reflects the finalized state (isStreaming: false)
    this.emit('messageMetadataUpdate', sessionId, messageId, newMetadata);
  }

  private handleAgentThinkingEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    const text = typeof data.text === 'string' ? data.text : '';
    const delta = typeof data.delta === 'string' ? data.delta : '';

    // If thinking stream was previously ended (tool event received), reset state
    // to create a new thinking message for the subsequent thinking events
    // Also reset assistantMessageId so the next assistant stream creates a new text message
    if (turn.thinkingStreamEnded) {
      turn.currentThinkingMessageId = null;
      turn.currentThinkingContent = '';
      turn.thinkingStreamEnded = false;
      // Reset assistantMessageId to null so next assistant stream creates new message
      // instead of continuing to write to the previous text message
      turn.assistantMessageId = null;
      // Reset segment text tracking for the new response segment
      turn.currentAssistantSegmentText = '';
      turn.agentAssistantTextLength = 0;
      // Reset committedAssistantText and currentText so chat delta events
      // for the new assistant segment don't get confused with old content
      turn.committedAssistantText = '';
      turn.currentText = '';
      turn.currentContentText = '';
      turn.currentContentBlocks = [];
      turn.textStreamMode = 'unknown';
    }

    // First thinking event: create the assistant message if not exists
    if (!turn.currentThinkingMessageId) {
      // If we already have an assistantMessageId, check if it's a thinking message
      // Only reuse it if it's specifically a thinking message (isThinking: true)
      // Otherwise, create a new message to avoid mixing thinking content with text content
      if (turn.assistantMessageId) {
        const session = this.store.getSession(sessionId);
        const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);
        const isThinkingMsg = existingMsg?.metadata?.isThinking === true;

        if (isThinkingMsg) {
          // Reuse the existing thinking message
          turn.currentThinkingMessageId = turn.assistantMessageId;
        } else {
          // Existing message is a text message, create a new thinking message
          const initialThinkingContent = text || delta || '';
          const thinkingMessage = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: '',
            metadata: { isStreaming: true, isThinking: true },
            thinkingContent: initialThinkingContent,
            modelName: turn.modelName,
          });
          turn.currentThinkingMessageId = thinkingMessage.id;
          // Don't update assistantMessageId - keep it for the text message
          // Initialize turn state with the first text/delta content
          turn.currentThinkingContent = initialThinkingContent;
          this.emit('message', sessionId, thinkingMessage);
          // Return early to skip the update logic below - the initial content is already set
          return;
        }
      } else {
        // Use store.addMessage to create message - it generates its own ID
        // Set initial thinkingContent to the actual content from this event
        // OpenClaw's emitReasoningStream only sends events when text.trim() is non-empty,
        // so the first event should always have content
        const initialThinkingContent = text || delta || '';
        const thinkingMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: '',
          metadata: { isStreaming: true, isThinking: true },
          thinkingContent: initialThinkingContent,
          modelName: turn.modelName,
        });
        turn.currentThinkingMessageId = thinkingMessage.id;
        // IMPORTANT: Do NOT set assistantMessageId to thinking message id
        // This prevents text content from being written to the thinking message
        // Instead, keep assistantMessageId null so text creates a separate message
        // turn.assistantMessageId = thinkingMessage.id; // REMOVED
        // Initialize turn state with the first text/delta content
        turn.currentThinkingContent = initialThinkingContent;
        this.emit('message', sessionId, thinkingMessage);
        // Note: we don't emit thinkingUpdate for the initial content since
        // the message already includes it, and UI will render directly from the message event
        // Return early to skip the update logic below - the initial content is already set
        return;
      }
      // Reusing existing message: set currentThinkingContent to empty so update logic works
      turn.currentThinkingContent = '';
    }

    // Update thinking content - use text as the authoritative full content
    // and calculate the actual delta to emit
    let actualDelta = '';
    if (text) {
      // text is always the full accumulated content
      const previousContent = turn.currentThinkingContent;
      turn.currentThinkingContent = text;

      // Calculate actual delta: what's new in text compared to previous
      if (text.startsWith(previousContent) && text.length > previousContent.length) {
        actualDelta = text.slice(previousContent.length);
      } else if (previousContent === '') {
        // First event - send full text as delta
        actualDelta = text;
      } else {
        // Content reset or changed - send full text
        actualDelta = text;
      }
    } else if (delta) {
      // If only delta provided (no text), append it
      turn.currentThinkingContent += delta;
      actualDelta = delta;
    }

    // Emit thinking update event with the actual delta
    const messageId = turn.currentThinkingMessageId;
    if (messageId && actualDelta) {
      this.emit('thinkingUpdate', sessionId, messageId, actualDelta);
    }
  }

  private handleAgentToolEvent(sessionId: string, turn: ActiveTurn, data: unknown): void {
    if (!isRecord(data)) return;

    // Dedup: both stream=tool and stream=item can carry the same tool event
    // (e.g. sessions_spawn announced back to main session). Skip if already processed.
    const quickToolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
    const quickToolField = typeof data.tool === 'string' ? data.tool.trim() : '';
    const quickCall = typeof data.call === 'string' ? data.call.trim() : '';
    const quickPhase =
      typeof data.phase === 'string'
        ? data.phase.trim() === 'end'
          ? 'result'
          : data.phase.trim()
        : quickToolField.includes(':')
          ? quickToolField.split(':')[0] === 'end'
            ? 'result'
            : quickToolField.split(':')[0]
          : '';
    const quickDedupToolCallId = quickToolCallId || quickCall;
    if (quickPhase && quickDedupToolCallId) {
      const dedupKey = quickPhase + ':' + quickDedupToolCallId;
      if (this._processedToolEvents.has(dedupKey)) {
        return;
      }
      this._processedToolEvents.add(dedupKey);
    }

    // Gateway may return tool events in two formats:
    // 1. Standard format: { phase, name, toolCallId, args, result, ... }
    // 2. Gateway format: { tool: 'result:sessions_spawn', call: 'xxx', meta: 'label xxx', err: false }
    // Parse both formats

    // Try gateway format first: tool='result:sessions_spawn', call='toolCallId', meta='label xxx'
    const toolField = typeof data.tool === 'string' ? data.tool.trim() : '';
    let phase: string;
    let toolName: string;
    let toolCallId: string;

    if (toolField && toolField.includes(':')) {
      // Gateway format: 'result:sessions_spawn' or 'start:sessions_spawn'
      const parts = toolField.split(':');
      phase = parts[0] === 'end' ? 'result' : parts[0];
      toolName = parts.slice(1).join(':') || 'Tool';
      // In gateway format, 'call' is the toolCallId
      toolCallId = typeof data.call === 'string' ? data.call.trim() : '';
    } else {
      // Standard format
      const rawPhase = typeof data.phase === 'string' ? data.phase.trim() : '';
      phase = rawPhase === 'end' ? 'result' : rawPhase;
      toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId.trim() : '';
      const toolNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
      toolName = toolNameRaw || 'Tool';
    }

    if (!toolCallId) return;
    if (phase !== 'start' && phase !== 'update' && phase !== 'result') return;

    // Parse meta field from gateway format: 'label xxx, task yyy'
    // This provides label info when args is empty
    let metaLabel: string | null = null;
    const metaField = typeof data.meta === 'string' ? data.meta.trim() : '';
    if (metaField) {
      // meta format: 'label calc-1-plus-2, task 计算 1+2 的结果...'
      const labelMatch = metaField.match(/label\s+([^,]+)/);
      if (labelMatch && labelMatch[1]) {
        metaLabel = labelMatch[1].trim();
      }
    }

    // 调试：sessions_spawn 工具调用
    if (
      toolName === 'sessions_spawn' ||
      toolName === 'sessions_resume' ||
      toolName === 'sessions_read'
    ) {
      // Log full data structure to diagnose childSessionKey location
      const dataKeys = Object.keys(data);
      const hasResult = isRecord(data.result);
      const resultKeys = hasResult ? Object.keys(data.result as Record<string, unknown>) : [];
      const isErrorValue = Boolean(data.isError);
      console.log(
        '[OpenClawRuntime] subagent tool call: toolName=' +
          toolName +
          ' phase=' +
          phase +
          ' toolCallId=' +
          toolCallId +
          ' dataKeys=[' +
          dataKeys.join(',') +
          '] resultKeys=[' +
          resultKeys.join(',') +
          '] isError=' +
          isErrorValue +
          ' meta=' +
          (metaField || '(none)'),
      );
      // Log full result object if present
      if (hasResult) {
        try {
          const resultJson = JSON.stringify(data.result).slice(0, 500);
          console.log('[OpenClawRuntime] sessions_spawn result: ' + resultJson);
        } catch {
          console.log('[OpenClawRuntime] sessions_spawn result: (failed to stringify)');
        }
      }
    }

    // 当 sessions_spawn 开始时，使用 label 或 agentId 作为子任务标识符
    // 同时建立 toolCallId ↔ label 双向映射，以便后续子 Agent 事件能找到正确的 toolCallId
    if (toolName === 'sessions_spawn' && phase === 'start') {
      const args = isRecord(data.args) ? (data.args as Record<string, unknown>) : {};

      // Debug: log args structure
      const argsKeys = Object.keys(args);
      console.log(
        '[OpenClawRuntime] sessions_spawn start: args keys=[' +
          argsKeys.join(',') +
          '] meta=' +
          (metaField || '(none)'),
      );

      // Extract prompt from args.task, args.prompt, or meta field
      // Gateway sends task in args.task field
      // meta format: 'label xxx, task yyy' where yyy is the prompt
      let promptText = '';
      if (typeof args.task === 'string' && args.task) {
        // args.task is the actual prompt text sent to subagent
        promptText = args.task;
      } else if (typeof args.prompt === 'string' && args.prompt) {
        promptText = args.prompt;
      } else if (metaField) {
        // Try to extract task/prompt from meta: 'label xxx, task yyy' or 'label xxx, prompt yyy'
        const taskMatch = metaField.match(/(?:task|prompt)\s+(.+)$/i);
        if (taskMatch && taskMatch[1]) {
          promptText = taskMatch[1].trim();
        }
      }

      // 保存 args 和 metaLabel 供 result 阶段使用
      const savedInfo = {
        ...args,
        _metaLabel: metaLabel,
        _extractedPrompt: promptText,
      };
      this.toolCallArgs.set(toolCallId, savedInfo);

      // label is only for display, toolCallId is the unique identifier
      const displayLabel =
        typeof args.label === 'string' && args.label
          ? args.label
          : typeof args.agentId === 'string' && args.agentId
            ? args.agentId
            : metaLabel || (promptText ? promptText.slice(0, 60) : '');

      // sessions_spawn tool start: subagent is queued (pending), not yet running
      // Lifecycle phase=start will change status from pending to running
      this.subagentStatus.set(toolCallId, 'pending');
      this.pendingToolCallIds.add(toolCallId);
      this.pendingEntryTimestamps.set(toolCallId, Date.now());

      // Establish temporary mapping for hasRunningSubagents check in handleChatFinal.
      // This ensures the main session stays 'running' while subagent executes.
      // Will be updated with actual childSessionKey when tool result arrives.
      const currentSessionKey = turn.sessionKey;
      if (currentSessionKey) {
        this.toolCallIdToSessionKey.set(toolCallId, currentSessionKey);
        console.log(
          '[OpenClawRuntime] sessions_spawn start: established temporary mapping toolCallId=' +
            toolCallId +
            ' -> sessionKey=' +
            currentSessionKey +
            ' (will be updated when result arrives)',
        );
      }

      // Track parent session ID for hasRunningSubagents check.
      // This is the authoritative mapping - toolCallIdToSessionKey may be updated to childSessionKey.
      // DEBUG: Log when subagent is spawned - which session is spawning it?
      console.log(
        '[OpenClawRuntime] sessions_spawn start: TRACKING toolCallId=' +
          toolCallId +
          ' sessionId=' +
          sessionId +
          ' orchestrationParentSessionId=' +
          (this.orchestrationParentSessionId || '(none)') +
          ' sessionKey=' +
          (turn.sessionKey || '(none)'),
      );
      this.toolCallIdToParentSessionId.set(toolCallId, sessionId);

      // Store display label for later use (not used as key)
      if (displayLabel) {
        this.toolCallIdToLabel.set(toolCallId, displayLabel);
      }

      // 预先初始化 subagentMessages，以 toolCallId 为 key
      if (!this.subagentMessages.has(toolCallId)) {
        this.subagentMessages.set(toolCallId, []);
      }
      // 添加初始化指令作为第一条 user 消息 ([Subagent Context])
      // Use extracted promptText (from args.task, args.prompt or meta field)
      console.log(
        '[OpenClawRuntime] sessions_spawn start: toolCallId=' +
          toolCallId +
          ' displayLabel=' +
          (displayLabel || '(none)') +
          ' promptText (len=' +
          promptText.length +
          '): ' +
          (promptText.length > 100 ? promptText.slice(0, 100) + '...' : promptText || '(empty)'),
      );
      if (promptText) {
        const msgs = this.subagentMessages.get(toolCallId)!;
        const contextMsg = {
          role: 'user',
          content: `[Subagent Context]\n\n${promptText}`,
          metadata: {
            isSubagentContext: true,
            label: displayLabel,
          },
        };
        msgs.push(contextMsg);
        console.log(
          '[OpenClawRuntime] sessions_spawn start: added subagent context message to msgs (len=' +
            msgs.length +
            ')',
        );
        // Emit IPC event for this context message
        const contextParentSessionId = this.resolveSubagentParentSessionId(toolCallId);
        if (contextParentSessionId) {
          this.emit('subagentMessage', contextParentSessionId, toolCallId, {
            id: `subagent-context-${Date.now()}`,
            type: 'user',
            content: contextMsg.content,
            timestamp: Date.now(),
            metadata: contextMsg.metadata,
          });
        }
        console.log(
          '[OpenClawRuntime] sessions_spawn start: added subagent context message (len=' +
            promptText.length +
            ')',
        );
      }
      console.log(
        '[OpenClawRuntime] sessions_spawn start: toolCallId=' +
          toolCallId +
          ' displayLabel=' +
          (displayLabel || '(none)') +
          ' (established early mapping, pending sessionKey)',
      );
    }

    // 当 sessions_spawn 返回结果时，建立 label → childSessionKey 映射
    if (toolName === 'sessions_spawn' && phase === 'result' && !data.isError && !data.err) {
      // Track successful spawn immediately — needed so lifecycle error handler
      // doesn't remove it from the list when childSessionKey is unavailable.
      if (toolCallId) {
        this.successfulSpawnToolCallIds.add(toolCallId);
      }

      // Try to get childSessionKey from various sources
      let childSessionKey: string | null = null;

      // 1. From result object
      const result = data.result;
      if (isRecord(result)) {
        childSessionKey =
          typeof result.childSessionKey === 'string' ? result.childSessionKey : null;
      }

      // 2. From data.sessionKey or data.childSessionKey
      if (!childSessionKey) {
        childSessionKey =
          typeof data.sessionKey === 'string'
            ? data.sessionKey
            : typeof data.childSessionKey === 'string'
              ? data.childSessionKey
              : null;
      }

      // Get label from saved args or meta field
      const savedInfo = this.toolCallArgs.get(toolCallId);
      const savedArgs = savedInfo && isRecord(savedInfo) ? savedInfo : {};
      const label =
        typeof savedArgs.label === 'string' && savedArgs.label
          ? savedArgs.label
          : typeof savedArgs._metaLabel === 'string' && savedArgs._metaLabel
            ? savedArgs._metaLabel
            : metaLabel || null;
      const inputAgentId =
        typeof savedArgs.agentId === 'string' && savedArgs.agentId ? savedArgs.agentId : null;

      const mappingKey = label || inputAgentId;
      // Always establish toolCallId → sessionKey mapping (toolCallId is unique)
      if (childSessionKey && toolCallId) {
        console.log(
          '[OpenClawRuntime] sessions_spawn mapping: toolCallId=' +
            toolCallId +
            ' label=' +
            (mappingKey || '(none)') +
            ' childSessionKey=' +
            childSessionKey,
        );

        // Check if lifecycle fallback assigned wrong toolCallId to this childSessionKey
        const wrongToolCallId = this.sessionKeyToToolCallId.get(childSessionKey);
        if (wrongToolCallId && wrongToolCallId !== toolCallId) {
          console.log(
            '[OpenClawRuntime] sessions_spawn: correcting wrong lifecycle fallback mapping. childSessionKey=' +
              childSessionKey +
              ' wrongToolCallId=' +
              wrongToolCallId +
              ' correctToolCallId=' +
              toolCallId,
          );
          // Move status from wrong toolCallId to correct toolCallId
          const wrongStatus = this.subagentStatus.get(wrongToolCallId);
          if (wrongStatus) {
            this.subagentStatus.set(toolCallId, wrongStatus);
            this.subagentStatus.delete(wrongToolCallId);
          }
          // Clean up wrong mappings
          this.toolCallIdToSessionKey.delete(wrongToolCallId);
          this.sessionKeyToToolCallId.delete(childSessionKey);
          // Note: We keep the wrong toolCallId in toolCallIdToLabel etc.
          // since it might have been used by other events
        }

        // Also check if this toolCallId was wrongly mapped to a different sessionKey
        const existingSessionKey = this.toolCallIdToSessionKey.get(toolCallId);
        if (existingSessionKey && existingSessionKey !== childSessionKey) {
          console.log(
            '[OpenClawRuntime] sessions_spawn: correcting wrong toolCallId mapping. toolCallId=' +
              toolCallId +
              ' existingSessionKey=' +
              existingSessionKey +
              ' correctSessionKey=' +
              childSessionKey,
          );
          // Clean up wrong reverse mapping
          this.sessionKeyToToolCallId.delete(existingSessionKey);
        }

        this.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
        this.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
        if (mappingKey) {
          this.sessionKeyToLabel.set(childSessionKey, mappingKey);
          this.toolCallIdToLabel.set(toolCallId, mappingKey);
          // Also store UUID → label mapping for lifecycle event lookup
          // childSessionKey format: agent:main:subagent:xxx or similar
          const uuidMatch = childSessionKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
          if (uuidMatch && uuidMatch[1]) {
            this.subagentUuidToLabel.set(uuidMatch[1], mappingKey);
          }
        }

        // 从 pendingToolCallIds 中移除
        this.pendingToolCallIds.delete(toolCallId);
        this.pendingEntryTimestamps.delete(toolCallId);
        // 将以 toolCallId 为 key 的消息复制到 sessionKey 为 key 的存储
        const pendingMsgs = this.subagentMessages.get(toolCallId);
        if (pendingMsgs && pendingMsgs.length > 0) {
          // 如果 sessionKey 存储不存在，创建并复制
          if (!this.subagentMessages.has(childSessionKey)) {
            this.subagentMessages.set(childSessionKey, [...pendingMsgs]);
          } else {
            // 合并已有的消息（避免重复）
            const existingMsgs = this.subagentMessages.get(childSessionKey)!;
            for (const msg of pendingMsgs) {
              // 简单的重复检测：相同 role 和相同 content 开头
              const isDuplicate = existingMsgs.some(
                existing =>
                  existing.role === msg.role &&
                  (existing.content === msg.content ||
                    existing.content.startsWith(msg.content) ||
                    msg.content.startsWith(existing.content)),
              );
              if (!isDuplicate) {
                existingMsgs.push(msg);
              }
            }
          }
          console.log(
            '[OpenClawRuntime] sessions_spawn: copied ' +
              pendingMsgs.length +
              ' messages from toolCallId to sessionKey storage',
          );
        }
      } else {
        // childSessionKey not in gateway event — this is normal, the gateway
        // strips it. The spawn still succeeded (err=false above confirms it).
        // Keep the subagent in pending/running status; lifecycle events will
        // establish the sessionKey mapping when they arrive.
        console.log(
          '[OpenClawRuntime] sessions_spawn result: childSessionKey not in gateway event (expected), toolCallId=' +
            (toolCallId || '(none)') +
            ' label=' +
            (mappingKey || '(none)'),
        );
        // Save label mapping for display
        if (toolCallId && mappingKey) {
          this.toolCallIdToLabel.set(toolCallId, mappingKey);
        }
        // Try CoworkStore as a best-effort way to get childSessionKey for streaming
        if (toolCallId) {
          const foundSessionKey = this.findChildSessionKeyByToolCallId(toolCallId);
          if (foundSessionKey) {
            childSessionKey = foundSessionKey;
            if (mappingKey) {
              this.sessionKeyToLabel.set(childSessionKey, mappingKey);
              this.toolCallIdToLabel.set(toolCallId, mappingKey);
            }
            this.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
            this.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
            this.pendingToolCallIds.delete(toolCallId);
            this.pendingEntryTimestamps.delete(toolCallId);
            console.log(
              '[OpenClawRuntime] sessions_spawn: established mapping via CoworkStore toolCallId=' +
                toolCallId +
                ' childSessionKey=' +
                childSessionKey,
            );
          }
          // If not found in CoworkStore either, try querying the gateway's
          // sessions.list API as a final fallback. This is needed because the
          // gateway strips childSessionKey from tool events.
          if (toolCallId && mappingKey) {
            const parentSessionKey = this.toolCallIdToSessionKey.get(toolCallId);
            if (parentSessionKey) {
              // Fire-and-forget: query runs in background and will update
              // mappings when it resolves
              this.querySubagentSessionKey(mappingKey, parentSessionKey, toolCallId).catch(err => {
                console.warn(
                  '[OpenClawRuntime] sessions_spawn: querySubagentSessionKey background call failed:',
                  err,
                );
              });
            }
          }
          // If not found in CoworkStore either, keep as pending — lifecycle
          // events will resolve it. Do NOT mark as failed.
        }
      }
      // 清理保存的 args
      this.toolCallArgs.delete(toolCallId);
    }

    // Handle sessions_spawn result with isError - subagent failed to start
    // Keep in the list with 'failed' status so the frontend can display it
    // rather than silently disappearing
    if (toolName === 'sessions_spawn' && phase === 'result' && (data.isError || data.err)) {
      console.log(
        '[OpenClawRuntime] sessions_spawn failed: toolCallId=' +
          toolCallId +
          ' isError=' +
          Boolean(data.isError) +
          ' err=' +
          (data.err || '(none)') +
          ' - marking as failed in subagent tracking',
      );
      this.failedSubagentIds.add(toolCallId);
      this.subagentStatus.set(toolCallId, 'failed');
      this.pendingToolCallIds.delete(toolCallId);
      this.pendingEntryTimestamps.delete(toolCallId);
      // Clean up any temporary mappings
      this.toolCallIdToSessionKey.delete(toolCallId);
      this.toolCallIdToParentSessionId.delete(toolCallId);
      this.toolCallIdToLabel.delete(toolCallId);
      // Clean up any messages stored for this failed subagent
      this.subagentMessages.delete(toolCallId);
      // Clean up saved args
      this.toolCallArgs.delete(toolCallId);
    }

    if (toolName.toLowerCase() === 'browser') {
      const isError = Boolean(data.isError);
      // Log full data keys and values for diagnosis
      const dataKeys = Object.keys(data);
      const resultType =
        data.result === undefined
          ? 'undefined'
          : data.result === null
            ? 'null'
            : typeof data.result === 'string'
              ? `string(len=${data.result.length})`
              : Array.isArray(data.result)
                ? `array(len=${data.result.length})`
                : `object(keys=${Object.keys(data.result as Record<string, unknown>).join(',')})`;
      console.log(
        `[OpenClawRuntime] browser tool event: phase=${phase} toolCallId=${toolCallId}` +
          ` dataKeys=[${dataKeys.join(',')}] resultType=${resultType}` +
          (phase === 'start' ? ` args=${JSON.stringify(data.args ?? {}).slice(0, 500)}` : '') +
          (phase === 'result' ? ` isError=${isError}` : ''),
      );
      if (phase === 'result') {
        // Log full result for browser events (may contain error details)
        try {
          const fullResult = JSON.stringify(data.result, null, 2);
          console.log(
            `[OpenClawRuntime] browser tool result (${toolCallId}): ${fullResult?.slice(0, 2000) ?? '(null)'}`,
          );
        } catch {
          console.log(
            `[OpenClawRuntime] browser tool result (${toolCallId}): [unstringifiable] ${String(data.result).slice(0, 500)}`,
          );
        }
        if (isError) {
          // Log any additional error-related fields
          const errorFields: Record<string, unknown> = {};
          for (const key of dataKeys) {
            if (/error|reason|message|detail|status/i.test(key)) {
              errorFields[key] = data[key];
            }
          }
          if (Object.keys(errorFields).length > 0) {
            console.log(
              `[OpenClawRuntime] browser tool error fields (${toolCallId}): ${JSON.stringify(errorFields).slice(0, 1000)}`,
            );
          }
        }
      }
      // Probe browser control service reachability from Electron main process
      this.probeBrowserControlService(toolCallId, phase);
    }

    if (!turn.toolUseMessageIdByToolCallId.has(toolCallId)) {
      // Split assistant segment before creating tool_use message.
      // This finalizes the current assistant text message and resets assistantMessageId,
      // so the next assistant stream event creates a new message.
      this.splitAssistantSegmentBeforeTool(sessionId, turn);

      // For sessions_spawn, use saved args from toolCallArgs map if data.args is empty
      // Gateway format { tool: 'start:sessions_spawn', call: 'xxx', meta: 'label xxx' } may lack args
      let effectiveArgs = toToolInputRecord(data.args);
      if (
        (Object.keys(effectiveArgs).length === 0 || !isRecord(data.args)) &&
        this.toolCallArgs.has(toolCallId)
      ) {
        const savedArgs = this.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          // Remove internal fields before using as toolInput
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          effectiveArgs = actualArgs as Record<string, unknown>;
          console.log(
            '[OpenClawRuntime] tool_use message using saved args for toolCallId=' +
              toolCallId +
              ' toolName=' +
              toolName +
              ' argsKeys=[' +
              Object.keys(effectiveArgs).join(',') +
              ']',
          );
        }
      }
      const toolUseMessage = this.store.addMessage(sessionId, {
        type: 'tool_use',
        content: `Using tool: ${toolName}`,
        metadata: {
          toolName,
          toolInput: effectiveArgs,
          toolUseId: toolCallId,
        },
      });
      turn.toolUseMessageIdByToolCallId.set(toolCallId, toolUseMessage.id);
      this.emit('message', sessionId, toolUseMessage);
    }

    if (phase === 'update') {
      const incoming = extractToolText(data.partialResult);
      if (!incoming.trim()) return;

      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const merged = mergeStreamingText(previous, incoming, 'unknown').text;

      // Get toolInput from saved args for tool_result messages
      let toolInputForResult: Record<string, unknown> = {};
      if (this.toolCallArgs.has(toolCallId)) {
        const savedArgs = this.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          toolInputForResult = actualArgs as Record<string, unknown>;
        }
      }

      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);
      if (!existingResultMessageId) {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('message', sessionId, resultMessage);
        return;
      }

      if (merged !== previous) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: merged,
          metadata: {
            toolResult: merged,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            isError: false,
            isStreaming: true,
            isFinal: false,
          },
        });
        turn.toolResultTextByToolCallId.set(toolCallId, merged);
        this.emit('messageUpdate', sessionId, existingResultMessageId, merged);
      }
      return;
    }

    if (phase === 'result') {
      const incoming = extractToolText(data.result);
      const previous = turn.toolResultTextByToolCallId.get(toolCallId) ?? '';
      const isError = Boolean(data.isError);
      const finalContent = incoming.trim() ? incoming : previous;
      const finalError = isError ? finalContent || 'Tool execution failed' : undefined;
      const existingResultMessageId = turn.toolResultMessageIdByToolCallId.get(toolCallId);

      // Get toolInput from saved args for tool_result messages
      let toolInputForResult: Record<string, unknown> = {};
      if (this.toolCallArgs.has(toolCallId)) {
        const savedArgs = this.toolCallArgs.get(toolCallId);
        if (savedArgs) {
          const { _metaLabel, _extractedPrompt, ...actualArgs } = savedArgs;
          toolInputForResult = actualArgs as Record<string, unknown>;
        }
      }

      if (existingResultMessageId) {
        this.store.updateMessage(sessionId, existingResultMessageId, {
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        this.emit('messageUpdate', sessionId, existingResultMessageId, finalContent);
      } else {
        const resultMessage = this.store.addMessage(sessionId, {
          type: 'tool_result',
          content: finalContent,
          metadata: {
            toolResult: finalContent,
            toolUseId: toolCallId,
            toolName,
            toolInput: toolInputForResult,
            error: finalError,
            isError,
            isStreaming: false,
            isFinal: true,
          },
        });
        turn.toolResultMessageIdByToolCallId.set(toolCallId, resultMessage.id);
        this.emit('message', sessionId, resultMessage);
      }
      turn.toolResultTextByToolCallId.set(toolCallId, finalContent);
    }
  }

  private handleChatEvent(payload: unknown, seq?: number): void {
    if (!isRecord(payload)) return;
    const chatPayload = payload as ChatEventPayload;
    const state = chatPayload.state;
    if (!state) return;
    console.debug(
      '[OpenClawRuntime] handleChatEvent:',
      `state=${state}`,
      `runId=${typeof chatPayload.runId === 'string' ? chatPayload.runId : ''}`,
      `sessionKey=${typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey : ''}`,
      `message=${summarizeGatewayMessageShape(chatPayload.message)}`,
    );

    const chatRunId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    const chatSessionKey =
      typeof chatPayload.sessionKey === 'string' ? chatPayload.sessionKey.trim() : '';

    const sessionId = this.resolveSessionIdFromChatPayload(chatPayload);
    if (!sessionId) {
      console.log('[Debug:handleChatEvent] no sessionId resolved, dropping event');
      return;
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log('[Debug:handleChatEvent] no active turn for sessionId:', sessionId);
      return;
    }

    // Buffer chat events while user messages are being prefetched for channel sessions
    if (turn.pendingUserSync) {
      console.log(
        '[Debug:handleChatEvent] buffering chat event (pendingUserSync), sessionId:',
        sessionId,
        'buffered:',
        turn.bufferedChatPayloads.length + 1,
      );
      turn.bufferedChatPayloads.push({ payload, seq, bufferedAt: Date.now() });
      return;
    }

    const runId = typeof chatPayload.runId === 'string' ? chatPayload.runId.trim() : '';
    // Debug logging for runId diagnosis (after runId is declared)
    console.debug(
      '[Debug:handleChatEvent] turn found, sessionId:',
      sessionId,
      'turn.runId:',
      turn.runId,
      'event.runId:',
      runId,
      'state:',
      state,
    );
    if (typeof seq === 'number' && Number.isFinite(seq) && runId) {
      const lastSeq = this.lastChatSeqByRunId.get(runId);
      if (lastSeq !== undefined && seq <= lastSeq) {
        return;
      }
      this.lastChatSeqByRunId.set(runId, seq);
    }

    // Handle chat events from a different runId (e.g., sub-agent announce while main agent is running).
    // This mimics OpenClaw webchat behavior: skip deltas, add final messages without affecting current streaming state.
    // Reference: openclaw/ui/src/ui/controllers/chat.ts handleChatEvent
    if (runId && turn.runId && runId !== turn.runId) {
      console.debug(
        '[OpenClawRuntime] handleChatEvent: different runId detected, runId=' +
          runId +
          ' turn.runId=' +
          turn.runId +
          ' state=' +
          state,
      );
      if (state === 'delta') {
        // Skip delta events from different runId - they don't affect current streaming state
        return;
      }
      if (state === 'final') {
        // For final events from different runId, just add the message without modifying turn state
        // This prevents duplicate messages when main agent yields/resumes during subagent waits

        // Deduplication: skip if this runId's final was already processed
        if (this.processedAnnounceRunIds.has(runId)) {
          console.debug(
            '[OpenClawRuntime] handleChatEvent: skipping already-processed announce runId final, runId=' +
              runId.slice(0, 20),
          );
          return;
        }
        this.processedAnnounceRunIds.add(runId);

        const finalMessage = chatPayload.message;
        if (finalMessage && isRecord(finalMessage)) {
          const role = typeof finalMessage.role === 'string' ? finalMessage.role.toLowerCase() : '';
          if (role === 'assistant') {
            const text = extractMessageText(finalMessage).trim();
            // Combine thinking from the final message blocks with accumulated
            // thinking from subagent announce runs (streamed via separate events).
            let thinking = extractThinkingContent(finalMessage);
            const subagentThinking = this.subagentThinkingByRunId.get(runId);
            if (subagentThinking) {
              thinking = thinking ? thinking + '\n' + subagentThinking : subagentThinking;
            }
            // Skip silent replies (NO_REPLY) — also handle truncated versions
            // that OpenClaw gateway may produce during streaming (e.g. "NO", "NO_RE").
            // For truncated prefixes, query the subagent's chat.history to confirm
            // before skipping, to avoid suppressing legitimate short replies.
            const NO_REPLY_MARKER = 'NO_REPLY';
            const isFullNoReply = text.length > 0 && /^NO_REPLY$/i.test(text);
            const isTruncatedNoReply =
              text.length > 0 &&
              text.length <= NO_REPLY_MARKER.length &&
              NO_REPLY_MARKER.startsWith(text.toUpperCase()) &&
              !isFullNoReply;

            if (isFullNoReply) {
              // Confirmed NO_REPLY marker - skip entirely
              console.debug(
                '[OpenClawRuntime] handleChatEvent: skipping NO_REPLY final from different runId',
              );
            } else if (isTruncatedNoReply && this.gatewayClient) {
              // Possible truncated prefix — extract subagent sessionKey from runId
              // and query chat.history to confirm before deciding to skip.
              // runId format: announce:v1:agent:main:subagent:{uuid}:{runUuid}
              const subagentUuidMatch = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
              if (subagentUuidMatch) {
                const subagentSessionKey = 'agent:main:subagent:' + subagentUuidMatch[1];
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: possible truncated NO_REPLY="' +
                    text +
                    '", querying subagent history to confirm',
                );
                void this.syncFinalNoReplyWithHistory(
                  sessionId,
                  subagentSessionKey,
                  text,
                  turn.modelName,
                );
              } else {
                // Can't extract subagent UUID — show the text as-is since we can't confirm
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: showing truncated text (no subagent UUID in runId), text="' +
                    text.slice(0, 50) +
                    '"',
                );
                const assistantMessage = this.store.addMessage(sessionId, {
                  type: 'assistant',
                  content: text,
                  metadata: { isStreaming: false, isFinal: true },
                  modelName: turn.modelName,
                  ...(thinking ? { thinkingContent: thinking } : {}),
                });
                this.emit('message', sessionId, assistantMessage);
              }
            } else if (text) {
              // Normal text from different runId - only emit as regular assistant message
              // if subagent streaming did not already capture it. Otherwise we get duplicate.
              if (runId.includes(':subagent:')) {
                const subagentUuidMatch2 = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
                if (subagentUuidMatch2) {
                  const subagentSessionKey2 = 'agent:main:subagent:' + subagentUuidMatch2[1];
                  const msgs2 = this.subagentMessages.get(subagentSessionKey2);
                  const streamedAssistant2 = msgs2?.filter(m => m.role === 'assistant').pop();
                  if (
                    streamedAssistant2 &&
                    streamedAssistant2.content &&
                    streamedAssistant2.content.length > 0
                  ) {
                    console.log(
                      '[OpenClawRuntime] handleChatEvent: different runId normal text but subagent already has streamed content for sessionKey=' +
                        subagentSessionKey2 +
                        ', skipping (avoids duplicate)',
                    );
                  } else {
                    // Subagent has no streamed content — show as regular assistant message
                    console.debug(
                      '[OpenClawRuntime] handleChatEvent: adding final message from different runId (subagent, no streaming), text="' +
                        text.slice(0, 50) +
                        '"' +
                        (thinking ? ' (with thinking)' : ''),
                    );
                    const assistantMessage = this.store.addMessage(sessionId, {
                      type: 'assistant',
                      content: text,
                      metadata: { isStreaming: false, isFinal: true },
                      modelName: turn.modelName,
                      ...(thinking ? { thinkingContent: thinking } : {}),
                    });
                    this.emit('message', sessionId, assistantMessage);
                  }
                } else {
                  // Can't extract subagent UUID — show as-is
                  console.debug(
                    '[OpenClawRuntime] handleChatEvent: adding final message from different runId, text="' +
                      text.slice(0, 50) +
                      '"' +
                      (thinking ? ' (with thinking)' : ''),
                  );
                  const assistantMessage = this.store.addMessage(sessionId, {
                    type: 'assistant',
                    content: text,
                    metadata: { isStreaming: false, isFinal: true },
                    modelName: turn.modelName,
                    ...(thinking ? { thinkingContent: thinking } : {}),
                  });
                  this.emit('message', sessionId, assistantMessage);
                }
              } else {
                // Not a subagent runId — show as-is
                console.debug(
                  '[OpenClawRuntime] handleChatEvent: adding final message from different runId, text="' +
                    text.slice(0, 50) +
                    '"' +
                    (thinking ? ' (with thinking)' : ''),
                );
                const assistantMessage = this.store.addMessage(sessionId, {
                  type: 'assistant',
                  content: text,
                  metadata: { isStreaming: false, isFinal: true },
                  modelName: turn.modelName,
                  ...(thinking ? { thinkingContent: thinking } : {}),
                });
                this.emit('message', sessionId, assistantMessage);
              }
            }
          }
        }
        // Flush any buffered tool events from this announce runId so they
        // display after the announce text message.
        this.flushBufferedToolEventsForRunId(sessionId, turn, runId);

        // Mark the subagent as done when an announce run completes successfully.
        // Lifecycle events may only fire phase=start/error during quota retries,
        // with no phase=end. The announce completion via chat final is the
        // authoritative signal that the subagent finished.
        if (runId && runId.includes(':subagent:')) {
          const subagentUuidMatch = runId.match(/subagent[:\-]([a-f0-9-]{36})/i);
          if (subagentUuidMatch) {
            const subagentUuid = subagentUuidMatch[1];
            const subagentSessionKey = 'agent:main:subagent:' + subagentUuid;
            let toolCallId = this.sessionKeyToToolCallId.get(subagentSessionKey);
            // Fallback: try without the prefix
            if (!toolCallId) {
              const shortKey = 'subagent:' + subagentUuid;
              toolCallId = this.sessionKeyToToolCallId.get(shortKey);
            }
            // Fallback: search subagentStatus keys that contain the UUID
            if (!toolCallId) {
              for (const [key, status] of this.subagentStatus) {
                if (key.includes(subagentUuid) && status !== 'done' && status !== 'failed') {
                  toolCallId = key;
                  break;
                }
              }
            }
            if (toolCallId) {
              const currentStatus = this.subagentStatus.get(toolCallId);
              if (currentStatus !== 'done' && currentStatus !== 'failed') {
                console.log(
                  '[OpenClawRuntime] announce completion: marking subagent as done toolCallId=' +
                    toolCallId +
                    ' uuid=' +
                    subagentUuid +
                    ' was=' +
                    (currentStatus || '(none)'),
                );
                this.subagentStatus.set(toolCallId, 'done');
                this.persistSubagentStatus(toolCallId, 'done');
                this.pendingToolCallIds.delete(toolCallId);
                this.pendingEntryTimestamps.delete(toolCallId);
                this.checkAllSubagentsDone();
              }
            } else {
              console.log(
                '[OpenClawRuntime] announce completion: lookup FAILED for uuid=' +
                  subagentUuid +
                  '. sessionKeyToToolCallId keys=' +
                  Array.from(this.sessionKeyToToolCallId.keys()).join(',') +
                  ' subagentStatus keys=' +
                  Array.from(this.subagentStatus.keys()).slice(0, 20).join(','),
              );
            }
          }
        }

        // Safety net: if main agent lifecycle has ended and all subagents are done,
        // finalize the session. This handles the case where the last chat event
        // comes from a different runId (e.g., subagent announce) and handleChatFinal
        // is never called for the main agent's runId.
        if (this.mainAgentLifecycleEnded && sessionId === this.orchestrationParentSessionId) {
          console.log(
            '[OpenClawRuntime] handleChatEvent: different runId final + main agent lifecycle ended, finalizing: sessionId=' +
              sessionId,
          );
          this.activeTurns.delete(sessionId);
          this.checkAllSubagentsDone();
        }
        // Don't modify turn state, don't cleanup, just return
        return;
      }
      // Skip other states (aborted, error) from different runId
      return;
    }

    if (state === 'delta') {
      this.handleChatDelta(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'final') {
      this.handleChatFinal(sessionId, turn, chatPayload);
      return;
    }

    if (state === 'aborted') {
      this.handleChatAborted(sessionId, turn);
      return;
    }

    if (state === 'error') {
      this.handleChatError(sessionId, turn, chatPayload);
    }
  }

  private updateTurnTextState(
    turn: ActiveTurn,
    message: unknown,
    options: { protectBoundaryDrops?: boolean; forceReplace?: boolean } = {},
  ): void {
    const contentText = extractMessageText(message).trim();
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const shouldProtectBoundaryDrop = Boolean(
        options.protectBoundaryDrops &&
        (turn.sawNonTextContentBlocks || sawNonTextContentBlocks) &&
        isDroppedBoundaryTextBlockSubset(turn.currentContentBlocks, nextContentBlocks),
      );
      if (!shouldProtectBoundaryDrop) {
        if (options.forceReplace) {
          turn.currentContentText = contentText;
          turn.currentContentBlocks = nextContentBlocks;
          turn.textStreamMode = 'snapshot';
        } else {
          const merged = mergeStreamingText(
            turn.currentContentText,
            contentText,
            turn.textStreamMode,
          );
          turn.currentContentText = merged.text;
          turn.textStreamMode = merged.mode;
          if (merged.mode === 'snapshot') {
            turn.currentContentBlocks = nextContentBlocks;
          } else {
            const mergedText = merged.text.trim();
            if (mergedText) {
              turn.currentContentBlocks = [mergedText];
            }
          }
        }
      }
    }

    if (sawNonTextContentBlocks) {
      turn.sawNonTextContentBlocks = true;
    }
    turn.currentText = turn.currentContentText.trim();
  }

  private resolveFinalTurnText(turn: ActiveTurn, message: unknown): string {
    const streamedText = turn.currentText.trim();
    const streamedTextBlocks = [...turn.currentContentBlocks];
    const streamedSawNonTextContentBlocks = turn.sawNonTextContentBlocks;

    this.updateTurnTextState(turn, message, { forceReplace: true });
    const finalText = turn.currentText.trim();

    if (!finalText) {
      return streamedText;
    }

    const shouldFallbackToStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset(streamedTextBlocks, turn.currentContentBlocks);
    if (shouldFallbackToStreamedText && streamedText) {
      turn.currentContentText = streamedText;
      turn.currentContentBlocks = streamedTextBlocks;
      turn.currentText = streamedText;
      return streamedText;
    }

    return finalText;
  }

  private resolveAssistantSegmentText(turn: ActiveTurn, fullText: string): string {
    // Filter out OpenClaw special marker "NO_REPLY" (no text reply, only tool calls)
    if (fullText.trim() === 'NO_REPLY') {
      return '';
    }
    const normalizedFullText = fullText.trim();
    const committed = turn.committedAssistantText;
    if (!normalizedFullText) {
      return '';
    }
    if (!committed) {
      return normalizedFullText;
    }
    if (normalizedFullText.startsWith(committed)) {
      return normalizedFullText.slice(committed.length).trimStart();
    }
    return normalizedFullText;
  }

  /**
   * Process agent thinking-stream events directly from handleGatewayEvent.
   * This bypasses handleAgentEvent's session resolution (which may enqueue events),
   * ensuring thinking updates are processed immediately and displayed before assistant text.
   */
  private processAgentThinkingEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    const streamType = typeof p.stream === 'string' ? p.stream : '';
    if (streamType !== 'thinking') {
      // Only log non-thinking agent streams once per type to avoid spam
      if (streamType && !this._loggedThinkingStreamTypes.has(streamType)) {
        this._loggedThinkingStreamTypes.add(streamType);
        console.log(
          '[OpenClawRuntime] processThinking: received non-thinking stream=' +
            streamType +
            ' (keys: ' +
            Object.keys(p).join(',') +
            ')',
        );
      }
      return;
    }
    console.log(
      '[OpenClawRuntime] processThinking: received thinking event, runId=' +
        (typeof p.runId === 'string' ? p.runId.slice(0, 8) : '(none)') +
        ' sessionKey=' +
        (typeof p.sessionKey === 'string' ? p.sessionKey.slice(0, 30) : '(none)'),
    );

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text = typeof dataField.text === 'string' ? dataField.text : '';
    const delta = typeof dataField.delta === 'string' ? dataField.delta : '';

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    // Gateway agent events use 'session' field, not 'sessionKey'
    const sessionKey =
      (typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '') ||
      (typeof p.session === 'string' ? p.session.trim() : '');
    let sessionId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this.channelSessionSync) {
        sessionId =
          this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.heartbeatSessionKeys.has(sessionKey) &&
            this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.activeTurns.has(sessionId)) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(sessionId, sessionKey, '');
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
    }
    const turn = sessionId ? this.activeTurns.get(sessionId) : undefined;

    if (!turn || !sessionId) {
      console.log(
        '[OpenClawRuntime] processThinking: SKIPPED - no turn/session, runId:',
        runId.slice(0, 8),
        'sessionKey:',
        sessionKey,
        'sid:',
        !!sessionId,
        'turn:',
        !!turn,
      );
      return;
    }

    // Accumulate thinking events from subagent announce runs (different runId).
    // The accumulated thinking is retrieved when the subagent's chat final event is processed.
    if (runId && turn.runId && runId !== turn.runId) {
      const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : null;
      if (dataField) {
        const text = typeof dataField.text === 'string' ? dataField.text : '';
        const delta = typeof dataField.delta === 'string' ? dataField.delta : '';
        const current = this.subagentThinkingByRunId.get(runId) || '';
        // Use text as authoritative full content, fall back to delta appending
        if (text) {
          this.subagentThinkingByRunId.set(runId, text);
        } else if (delta) {
          this.subagentThinkingByRunId.set(runId, current + delta);
        }
      }
      return;
    }

    // Call the actual thinking event handler
    this.handleAgentThinkingEvent(sessionId, turn, p.data);
  }

  /**
   * Process agent assistant-stream text directly from handleGatewayEvent.
   * This bypasses handleAgentEvent's session resolution (which may enqueue events),
   * ensuring text updates and reset detection always work.
   */
  private processAgentAssistantText(payload: unknown): void {
    if (!isRecord(payload)) return;
    const p = payload as Record<string, unknown>;
    if (p.stream !== 'assistant') return;

    const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
    // Gateway agent events use 'session' field, not 'sessionKey'
    const sessionKey =
      (typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '') ||
      (typeof p.session === 'string' ? p.session.trim() : '');
    console.log(
      '[OpenClawRuntime] processAssistantText: received assistant event, runId=' +
        runId.slice(0, 8) +
        ' sessionKey=' +
        sessionKey.slice(0, 30),
    );

    const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
    const text =
      extractOpenClawAssistantStreamText(dataField) || extractOpenClawAssistantStreamText(p);

    let sessionId = runId ? this.sessionIdByRunId.get(runId) : undefined;
    if (!sessionId && sessionKey) {
      sessionId = this.resolveSessionIdBySessionKey(sessionKey) ?? undefined;
      if (!sessionId && this.channelSessionSync) {
        sessionId =
          this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
          (!this.heartbeatSessionKeys.has(sessionKey) &&
            this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
          this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
          undefined;
        if (sessionId) {
          this.rememberSessionKey(sessionId, sessionKey);
        }
      }
      if (sessionId && !this.activeTurns.has(sessionId)) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(sessionId, sessionKey, '');
      }
      // OpenClaw: runId is set only at send time, events never modify turn.runId
    }
    const turn = sessionId ? this.activeTurns.get(sessionId) : undefined;

    if (!turn || !sessionId) {
      if (text) {
        console.debug(
          '[Debug:processAgentAssistant] skipped: text.len:',
          text.length,
          'runId:',
          runId.slice(0, 8),
          'sessionKey:',
          sessionKey,
          'sid:',
          !!sessionId,
          'turn:',
          !!turn,
        );
      }
      return;
    }

    // Skip agent assistant events from a different runId (e.g., sub-agent announce while main agent is running).
    // This prevents duplicate messages when the main agent yields/resumes during subagent waits.
    // Agent events from announce runs should be skipped - they will be handled via chat events.
    if (runId && turn.runId && runId !== turn.runId) {
      console.log(
        '[OpenClawRuntime] processAgentAssistant: skipping event from different runId, runId=' +
          runId.slice(0, 20) +
          ' turn.runId=' +
          turn.runId.slice(0, 20),
      );
      return;
    }

    if (!text) {
      return;
    }

    // Text reset detection based on length comparison is unreliable because:
    // - Agent events and chat deltas may interleave
    // - Events may arrive out of order
    // - Length changes have many causes (gateway retry, content blocks, etc.)
    // OpenClaw: runId is set only at send time, different runId events are handled in handleChatEvent.
    // Only use high-water mark tracking to prevent false splits.
    turn.agentAssistantTextLength = Math.max(turn.agentAssistantTextLength, text.length);

    // Update turn text state and push to store.
    turn.currentText = text;
    turn.currentAssistantSegmentText = this.resolveAssistantSegmentText(turn, text);

    // Check if current assistantMessageId is a thinking message
    // If so, finalize it and create a new assistant message for text content
    if (turn.assistantMessageId && turn.currentThinkingMessageId === turn.assistantMessageId) {
      const session = this.store.getSession(sessionId);
      const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);
      const isThinkingMsg = existingMsg?.metadata?.isThinking === true;

      if (isThinkingMsg) {
        // Finalize thinking message and prepare for text content
        turn.thinkingStreamEnded = true;
        turn.assistantMessageId = null;
        this.finalizeThinkingMessage(
          sessionId,
          turn.currentThinkingMessageId!,
          turn.currentThinkingContent,
        );
      }
    }

    // Check if segment text is a possible truncated special marker prefix
    // "NO_REPLY" may be truncated by OpenClaw gateway during streaming
    // Skip message creation/update if text might be incomplete marker
    const NO_REPLY_MARKER = 'NO_REPLY';
    const segmentText = turn.currentAssistantSegmentText;
    const isPossibleNoReplyPrefix =
      segmentText &&
      segmentText.length <= NO_REPLY_MARKER.length &&
      NO_REPLY_MARKER.startsWith(segmentText.trim()) &&
      segmentText.trim().length > 0;

    if (isPossibleNoReplyPrefix) {
      // Don't create/update message for possible truncated marker
      // Will be handled correctly in handleChatFinal with chat.history sync
      console.debug(
        '[OpenClawRuntime] processAgentAssistant: skipping for possible truncated marker',
        `segment="${segmentText.trim()}"`,
      );
      return;
    }

    if (!turn.assistantMessageId && turn.currentAssistantSegmentText) {
      // Create a new message for the new text segment (after split or thinking end).
      const assistantMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: turn.currentAssistantSegmentText,
        metadata: { isStreaming: true, isFinal: false },
        modelName: turn.modelName,
      });
      turn.assistantMessageId = assistantMessage.id;
      this.emit('message', sessionId, assistantMessage);
    } else if (turn.assistantMessageId && turn.currentAssistantSegmentText) {
      this.throttledStoreUpdateMessage(
        sessionId,
        turn.assistantMessageId,
        turn.currentAssistantSegmentText,
        { isStreaming: true, isFinal: false },
      );
      this.throttledEmitMessageUpdate(
        sessionId,
        turn.assistantMessageId,
        turn.currentAssistantSegmentText,
      );
    }
  }

  private splitAssistantSegmentBeforeTool(sessionId: string, turn: ActiveTurn): void {
    if (!turn.assistantMessageId) return;
    const messageId = turn.assistantMessageId;

    // Flush pending throttled updates so store content is current before reading.
    this.flushPendingStoreUpdate(sessionId, messageId);
    this.clearPendingMessageUpdate(messageId);

    // Committed text: use agentAssistantTextLength as the reliable segment length,
    // since currentText/currentAssistantSegmentText may be overwritten by chat deltas.
    // Read the actual content from the store (which was updated by processAgentAssistantText).
    const session = this.store.getSession(sessionId);
    const currentMsg = session?.messages.find(m => m.id === messageId);
    const storeContent = currentMsg?.content?.trim() || '';

    if (storeContent) {
      turn.committedAssistantText = `${turn.committedAssistantText}${storeContent}`;
    }

    this.store.updateMessage(sessionId, messageId, {
      metadata: { isStreaming: false, isFinal: true },
    });
    if (storeContent) {
      this.emit('messageUpdate', sessionId, messageId, storeContent);
    }

    turn.assistantMessageId = null;
    turn.currentAssistantSegmentText = '';
  }

  private handleChatDelta(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    const extractedText = extractGatewayMessageText(payload.message);

    // End thinking stream when we receive text content
    // End thinking stream when we receive text content
    // Chat delta events carry accumulated full run text, which includes content
    // from all previous assistant segments. This causes content mixing when
    // combined with committedAssistantText-based segment resolution.
    // Instead, we rely entirely on processAgentAssistantText (agent stream events)
    // to handle assistant text content. handleChatDelta only handles thinking finalize.
    if (!turn.thinkingStreamEnded && turn.currentThinkingMessageId) {
      turn.thinkingStreamEnded = true;
      // Only clear assistantMessageId if it's pointing to the thinking message.
      if (turn.assistantMessageId === turn.currentThinkingMessageId) {
        turn.assistantMessageId = null;
      }
      // Finalize thinking message
      this.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
    }
    // Do NOT process text content from chat delta events.
    // Agent assistant stream events (processAgentAssistantText) handle all text.
  }

  private async handleChatFinal(
    sessionId: string,
    turn: ActiveTurn,
    payload: ChatEventPayload,
  ): Promise<void> {
    // Finalize any pending thinking message before processing final text
    if (turn.currentThinkingMessageId && !turn.thinkingStreamEnded) {
      this.finalizeThinkingMessage(
        sessionId,
        turn.currentThinkingMessageId,
        turn.currentThinkingContent,
      );
      turn.thinkingStreamEnded = true;
      // Clear assistantMessageId if it was pointing to the thinking message
      if (turn.assistantMessageId === turn.currentThinkingMessageId) {
        turn.assistantMessageId = null;
      }
    }

    // Chat final events carry accumulated full run text (all assistant segments),
    // which cannot be correctly split by resolveAssistantSegmentText.
    // Instead, we use currentAssistantSegmentText set by processAgentAssistantText
    // (agent stream events), which correctly tracks the current segment text.
    const previousSegmentText = turn.currentAssistantSegmentText;
    console.debug(
      '[OpenClawRuntime] handleChatFinal:',
      `sessionId=${sessionId}`,
      `runId=${payload.runId ?? turn.runId}`,
      `assistantMessageId=${turn.assistantMessageId ?? '(none)'}`,
      `currentSegmentText="${truncate(previousSegmentText, 200)}"`,
    );

    if (turn.assistantMessageId) {
      // Flush any pending throttled updates so store content is current.
      this.flushPendingStoreUpdate(sessionId, turn.assistantMessageId);
      this.clearPendingMessageUpdate(turn.assistantMessageId);
      const storeSession = this.store.getSession(sessionId);
      const storeMsg = storeSession?.messages.find(m => m.id === turn.assistantMessageId);
      if (storeMsg?.content) {
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, storeMsg.content);
      }

      // Use existing segment text from processAgentAssistantText, not from chat final
      const persistedSegmentText = previousSegmentText;
      if (persistedSegmentText) {
        const finalMetadata = { isStreaming: false, isFinal: true };
        this.store.updateMessage(sessionId, turn.assistantMessageId, {
          metadata: finalMetadata,
        });
        // Emit metadata update so UI reflects the finalized state
        this.emit('messageMetadataUpdate', sessionId, turn.assistantMessageId, finalMetadata);
      }
    } else if (previousSegmentText) {
      // Check if segment text is a possible truncated special marker prefix
      // "NO_REPLY" may be truncated by OpenClaw gateway, showing only "NO"
      // In this case, don't create message yet - let syncFinal handle it
      const NO_REPLY_MARKER = 'NO_REPLY';
      const isPossibleNoReplyPrefix =
        previousSegmentText.length <= NO_REPLY_MARKER.length &&
        NO_REPLY_MARKER.startsWith(previousSegmentText.trim()) &&
        previousSegmentText.trim().length > 0;

      if (isPossibleNoReplyPrefix) {
        console.debug(
          '[OpenClawRuntime] handleChatFinal: skipping message creation for possible truncated marker',
          `segment="${previousSegmentText.trim()}"`,
          'will sync with chat.history',
        );
        // Don't create message - let syncFinal get complete text from history
      } else {
        // No assistantMessageId but we have segment text - create message
        const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, previousSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
        } else {
          const assistantMessage = this.store.addMessage(sessionId, {
            type: 'assistant',
            content: previousSegmentText,
            metadata: {
              isStreaming: false,
              isFinal: true,
            },
            modelName: turn.modelName,
          });
          turn.assistantMessageId = assistantMessage.id;
          this.emit('message', sessionId, assistantMessage);
        }
      }
    }

    // Check if we need to sync with history (when no text was generated locally)
    const finalText = this.resolveFinalTurnText(turn, payload.message);
    turn.currentText = finalText;

    // Special marker detection: "NO_REPLY" may be truncated by OpenClaw gateway
    // If text is a prefix of "NO_REPLY", force sync to get complete text
    const NO_REPLY_MARKER = 'NO_REPLY';
    const isNoReplyPrefix =
      finalText.length <= NO_REPLY_MARKER.length &&
      NO_REPLY_MARKER.startsWith(finalText.trim()) &&
      finalText.trim().length > 0;

    if (!finalText.trim() || isNoReplyPrefix) {
      console.debug(
        '[OpenClawRuntime] handleChatFinal: falling back to chat.history sync',
        `sessionId=${sessionId}`,
        `runId=${payload.runId ?? turn.runId}`,
        isNoReplyPrefix
          ? `reason=possible_truncated_marker("${finalText.trim()}")`
          : 'reason=no_text',
      );
      await this.syncFinalAssistantWithHistory(sessionId, turn);
    }

    const messageRecord = isRecord(payload.message) ? payload.message : null;
    const stopReason =
      payload.stopReason ??
      (messageRecord && typeof messageRecord.stopReason === 'string'
        ? messageRecord.stopReason
        : undefined);
    const errorMessageFromMessage =
      messageRecord && typeof messageRecord.errorMessage === 'string'
        ? messageRecord.errorMessage
        : undefined;
    const stoppedByError = stopReason === 'error';
    if (stoppedByError) {
      const errorMessage =
        payload.errorMessage?.trim() || errorMessageFromMessage?.trim() || 'OpenClaw run failed';
      const erroredSessionKey = turn.sessionKey;
      this.store.updateSession(sessionId, { status: 'error' });
      this.emit('error', sessionId, errorMessage);
      this.cleanupSessionTurn(sessionId);
      this.rejectTurn(sessionId, new Error(errorMessage));
      // Reconcile even on error so the UI shows messages already delivered.
      void this.reconcileWithHistory(sessionId, erroredSessionKey);
      return;
    }

    // Early cleanup of activeTurns to allow new messages while reconcileWithHistory runs.
    // This prevents "Session is still running" error when user sends message after seeing
    // messageMetadataUpdate (isStreaming: false) but before cleanupSessionTurn completes.
    // reconcileWithHistory only needs sessionId/sessionKey, not turn data.
    this.activeTurns.delete(sessionId);

    // Reconcile local messages with authoritative gateway history.
    // This replaces the old syncFinalAssistantWithHistory + syncChannelAfterTurn flow.
    // Awaited so that IM handlers reading from the store see reconciled data.
    await this.reconcileWithHistory(sessionId, turn.sessionKey);

    // Detect thinking-only response: the last API call returned no visible text
    // (only a thinking block), causing the run to complete silently without output.
    // This happens with qwen3.5-plus under very large context (~380K tokens).
    // Signal: turn.currentText is empty AND there was at least one tool call in the run.
    // IMPORTANT: Skip this check if subagents are still running - the model is waiting for them.
    // Use toolCallIdToParentSessionId to check subagents belonging to THIS session.
    const hasRunningSubagents = Array.from(this.subagentStatus.entries()).some(
      ([toolCallId, status]) => {
        if (status !== 'running') return false;
        const parentSessionId = this.toolCallIdToParentSessionId.get(toolCallId);
        return parentSessionId === sessionId;
      },
    );
    const sessionAfterReconcile = this.store.getSession(sessionId);
    if (sessionAfterReconcile && !hasRunningSubagents) {
      const msgs = sessionAfterReconcile.messages;
      const hadToolCall = msgs.some(m => m.type === 'tool_result');
      const hadSessionsSpawn = msgs.some(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      );
      const lastApiResponseHadNoText = !turn.currentText.trim();
      console.debug(
        '[OpenClawRuntime] run end diagnostics, sessionId:',
        sessionId,
        'turn.currentText:',
        JSON.stringify(turn.currentText?.slice(0, 100)),
        'turn.committedAssistantText:',
        JSON.stringify(turn.committedAssistantText?.slice(0, 100)),
        'hadToolCall:',
        hadToolCall,
        'hadSessionsSpawn:',
        hadSessionsSpawn,
        'lastApiResponseHadNoText:',
        lastApiResponseHadNoText,
      );
      // Don't show hint when sessions_spawn is involved - the agent will continue running
      // and output text after processing subagent results
      if (hadToolCall && lastApiResponseHadNoText && !hadSessionsSpawn) {
        const hintMessage = this.store.addMessage(sessionId, {
          type: 'system',
          content: t('taskThinkingOnly'),
        });
        this.emit('message', sessionId, hintMessage);
        console.warn('[OpenClawRuntime] thinking-only response detected, sessionId:', sessionId);
      }
    }

    // Check if any subagents are still running - if so, keep session in 'running' status.
    // Also, if subagents were involved (even if all completed), keep 'running' status
    // because the main agent is still processing results and may have follow-up runs.
    // We use a delayed check to determine if the main agent truly finished:
    // after cleanup, if no new turn is created within 500ms, mark as 'completed'.
    const hadSubagentToolCalls =
      sessionAfterReconcile?.messages.some(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      ) ?? false;
    const shouldKeepRunning = hasRunningSubagents || hadSubagentToolCalls;
    const finalStatus = shouldKeepRunning ? 'running' : 'completed';
    console.log(
      '[OpenClawRuntime] handleChatFinal: sessionId=' +
        sessionId +
        ' hasRunningSubagents=' +
        hasRunningSubagents +
        ' hadSubagentToolCalls=' +
        hadSubagentToolCalls +
        ' finalStatus=' +
        finalStatus,
    );
    this.store.updateSession(sessionId, { status: finalStatus });
    this.emit('complete', sessionId, payload.runId ?? turn.runId, finalStatus);
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);

    // Delayed check: if subagents were involved and no new turn was created within 500ms,
    // the main agent has truly finished processing all results. Mark as 'completed'.
    // Use a retry loop (not single-shot) because subagents may take a long time to
    // complete and their lifecycle 'end' events arrive asynchronously.
    if (shouldKeepRunning) {
      const MAX_RETRY_MS = 300_000; // 5 minutes cap
      const RETRY_INTERVAL_MS = 2_000; // check every 2s
      const startTime = Date.now();

      const checkSubagentsAndFinalize = () => {
        // Check session's current status - only update if still 'running'
        // (avoid overwriting 'idle' from stopSession or 'error' from handleChatError)
        const session = this.store.getSession(sessionId);
        const currentStatus = session?.status;
        if (currentStatus !== 'running') {
          // Session was already finalized by another path (checkAllSubagentsDone, stopSession, etc).
          // Clean up any stale activeTurns entry that could block future messages.
          if (this.activeTurns.has(sessionId)) {
            console.log(
              '[OpenClawRuntime] handleChatFinal delayed check: cleaning up stale activeTurns: sessionId=' +
                sessionId,
            );
            this.cleanupSessionTurn(sessionId);
          }
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' currentStatus=' +
              currentStatus +
              ' -> skip (not running)',
          );
          return;
        }

        // If a new turn was created (follow-up run started), defer to checkAllSubagentsDone
        // which handles per-session completion tracking. Then reschedule to check again
        // after the new turn potentially completes.
        const hasNewTurn = this.activeTurns.has(sessionId);
        if (hasNewTurn) {
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' hasNewTurn=' +
              hasNewTurn +
              ' -> deferring to checkAllSubagentsDone, will retry',
          );
          this.checkAllSubagentsDone();
          // Reschedule the delayed check in case the new turn also spawns subagents
          setTimeout(checkSubagentsAndFinalize, RETRY_INTERVAL_MS);
          return;
        }

        // Check if any subagents of THIS session are still running.
        // Use toolCallIdToParentSessionId to filter subagents belonging to this session.
        const stillHasRunningSubagents = Array.from(this.subagentStatus.entries()).some(
          ([toolCallId, status]) => {
            if (status !== 'running') return false;
            const parentSessionId = this.toolCallIdToParentSessionId.get(toolCallId);
            return parentSessionId === sessionId;
          },
        );
        if (!stillHasRunningSubagents) {
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' hasNewTurn=' +
              hasNewTurn +
              ' stillHasRunningSubagents=' +
              stillHasRunningSubagents +
              ' -> completed',
          );
          this.store.updateSession(sessionId, { status: 'completed' });
          // Emit complete event to notify frontend of the status change
          // Use null for runId since this is a delayed update, not a new run completion
          this.emit('complete', sessionId, null, 'completed');
        } else if (Date.now() - startTime < MAX_RETRY_MS) {
          // Subagents still running and within retry window — check again
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' stillHasRunningSubagents=' +
              stillHasRunningSubagents +
              ' -> retry in ' +
              RETRY_INTERVAL_MS +
              'ms',
          );
          setTimeout(checkSubagentsAndFinalize, RETRY_INTERVAL_MS);
        } else {
          // Timed out — force complete to prevent stuck sessions
          console.log(
            '[OpenClawRuntime] handleChatFinal delayed check: sessionId=' +
              sessionId +
              ' timed out after ' +
              MAX_RETRY_MS +
              'ms, forcing completed',
          );
          this.store.updateSession(sessionId, { status: 'completed' });
          this.emit('complete', sessionId, null, 'completed');
        }
      };

      setTimeout(checkSubagentsAndFinalize, 500);
    }
  }

  private handleChatAborted(sessionId: string, turn: ActiveTurn): void {
    this.store.updateSession(sessionId, { status: 'idle' });
    if (!turn.stopRequested && !this.manuallyStoppedSessions.has(sessionId)) {
      // The run was aborted without user request — most likely a timeout.
      // Add a visible hint so the user knows the task was interrupted.
      const hintMessage = this.store.addMessage(sessionId, {
        type: 'assistant',
        content: t('taskTimedOut'),
        metadata: { isTimeout: true },
        modelName: turn.modelName,
      });
      this.emit('message', sessionId, hintMessage);
      this.emit('complete', sessionId, turn.runId, 'idle');
    }
    const abortedSessionKey = turn.sessionKey;
    this.cleanupSessionTurn(sessionId);
    this.resolveTurn(sessionId);
    void this.reconcileWithHistory(sessionId, abortedSessionKey);
  }

  private handleChatError(sessionId: string, turn: ActiveTurn, payload: ChatEventPayload): void {
    console.log(
      '[OpenClawRuntime] handleChatError payload:',
      JSON.stringify(payload).slice(0, 1000),
    );
    let errorMessage = payload.errorMessage?.trim() || 'OpenClaw run failed';

    // Detect model API errors that are likely caused by unsupported image content
    // in tool results (e.g., Read tool returning image blocks for non-vision models).
    // Only match 400 Bad Request — other 4xx codes (403 forbidden, 429 rate limit, etc.)
    // have unrelated causes and should show their original error message.
    if (/^400\b/.test(errorMessage)) {
      errorMessage +=
        '\n\n[Hint: If the model attempted to read an image file, this may be because the model does not support image input. Consider using a vision-capable model or avoid sending image files.]';
    }

    const erroredSessionKey = turn.sessionKey;
    this.store.updateSession(sessionId, { status: 'error' });
    // Persist error message to SQLite so it survives session switches
    const errorMsg = this.store.addMessage(sessionId, {
      type: 'system',
      content: errorMessage,
      metadata: { error: errorMessage },
    });
    this.emit('message', sessionId, errorMsg);
    this.emit('error', sessionId, errorMessage);
    this.cleanupSessionTurn(sessionId);
    this.rejectTurn(sessionId, new Error(errorMessage));
    void this.reconcileWithHistory(sessionId, erroredSessionKey);
  }

  private handleApprovalRequested(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalRequestedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    if (!typedPayload.request || !isRecord(typedPayload.request)) return;

    const request = typedPayload.request;
    const sessionKey = typeof request.sessionKey === 'string' ? request.sessionKey.trim() : '';
    let sessionId = sessionKey
      ? (this.resolveSessionIdBySessionKey(sessionKey) ?? undefined)
      : undefined;

    // Try to resolve channel-originated sessions for approval requests
    if (!sessionId && sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        this.rememberSessionKey(channelSessionId, sessionKey);
        sessionId = channelSessionId;
      }
    }

    if (!sessionId) {
      return;
    }

    const command = typeof request.command === 'string' ? request.command : '';
    const isChannelSession = this.channelSessionSync?.isChannelSessionKey(sessionKey) ?? false;

    // Auto-approve: channel sessions always, local sessions for non-delete commands.
    // Intentionally allows non-delete dangerous commands (git push, kill, chmod) without
    // prompting — this is a deliberate trade-off to avoid the approval-pending timing
    // issue on fresh installs.  Only file-deletion commands warrant a blocking modal.
    // The allow-always decision adds the command to the gateway allowlist so subsequent
    // calls skip the approval flow entirely.
    if (isChannelSession || !isDeleteCommand(command)) {
      this.pendingApprovals.set(requestId, { requestId, sessionId, allowAlways: true });
      this.respondToPermission(requestId, { behavior: 'allow', updatedInput: {} });
    }
    // Suppress approval popups for sessions in stop cooldown — the user
    // already stopped the session, so showing a new permission dialog
    // would be confusing.  The Gateway-side run will time out on its own.
    if (this.isSessionInStopCooldown(sessionId)) {
      return;
    }

    this.pendingApprovals.set(requestId, { requestId, sessionId });

    const { level: dangerLevel, reason: dangerReason } = getCommandDangerLevel(command);

    const permissionRequest: PermissionRequest = {
      requestId,
      toolName: 'Bash',
      toolInput: {
        command,
        dangerLevel,
        dangerReason,
        cwd: request.cwd ?? null,
        host: request.host ?? null,
        security: request.security ?? null,
        ask: request.ask ?? null,
        resolvedPath: request.resolvedPath ?? null,
        sessionKey: request.sessionKey ?? null,
        agentId: request.agentId ?? null,
      },
      toolUseId: requestId,
    };

    this.emit('permissionRequest', sessionId, permissionRequest);
  }

  private handleApprovalResolved(payload: unknown): void {
    if (!isRecord(payload)) return;
    const typedPayload = payload as ExecApprovalResolvedPayload;
    const requestId = typeof typedPayload.id === 'string' ? typedPayload.id.trim() : '';
    if (!requestId) return;
    this.pendingApprovals.delete(requestId);
  }

  private resolveSessionIdFromChatPayload(payload: ChatEventPayload): string | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    if (runId && this.sessionIdByRunId.has(runId)) {
      const sid = this.sessionIdByRunId.get(runId) ?? null;
      return sid;
    }

    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    if (sessionKey) {
      const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
      if (sessionId) {
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(sessionId, sessionKey, '');
        return sessionId;
      }
    }

    // Try to resolve channel-originated sessions
    if (sessionKey && this.channelSessionSync) {
      const channelSessionId =
        this.channelSessionSync.resolveOrCreateSession(sessionKey) ||
        (!this.heartbeatSessionKeys.has(sessionKey) &&
          this.channelSessionSync.resolveOrCreateMainAgentSession(sessionKey)) ||
        this.channelSessionSync.resolveOrCreateCronSession(sessionKey) ||
        null;
      if (channelSessionId) {
        // If this key was previously deleted, allow re-creation but skip history sync
        if (this.deletedChannelKeys.has(sessionKey)) {
          this.deletedChannelKeys.delete(sessionKey);
          this.fullySyncedSessions.add(channelSessionId);
          this.reCreatedChannelSessionIds.add(channelSessionId);
          console.debug(
            '[resolveSessionId] re-created after delete, skipping history sync for:',
            sessionKey,
          );
        }
        this.rememberSessionKey(channelSessionId, sessionKey);
        // OpenClaw: runId is set only at send time, events never modify turn.runId
        this.ensureActiveTurn(channelSessionId, sessionKey, '');
        return channelSessionId;
      }
    }

    console.warn('[resolveSessionId] failed — runId:', runId, 'sessionKey:', sessionKey);
    return null;
  }

  private syncSystemMessagesFromHistory(
    sessionId: string,
    historyMessages: unknown[],
    options: { previousCountKnown: boolean; previousCount: number },
  ): void {
    if (historyMessages.length === 0) {
      this.gatewayHistoryCountBySession.set(sessionId, 0);
      return;
    }

    const canUseCursor =
      options.previousCountKnown &&
      options.previousCount >= 0 &&
      options.previousCount <= historyMessages.length;
    const entries = extractGatewayHistoryEntries(
      canUseCursor ? historyMessages.slice(options.previousCount) : historyMessages,
    );
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);

    const systemEntries = entries.filter(entry => entry.role === 'system');
    if (systemEntries.length === 0) {
      return;
    }

    const session = this.store.getSession(sessionId);
    const existingSystemTexts = new Set(
      (session?.messages ?? [])
        .filter(message => message.type === 'system')
        .map(message => message.content.trim())
        .filter(Boolean),
    );

    for (const entry of systemEntries) {
      if (existingSystemTexts.has(entry.text)) {
        continue;
      }

      const systemMessage = this.store.addMessage(sessionId, {
        type: 'system',
        content: entry.text,
        metadata: {},
      });
      existingSystemTexts.add(entry.text);
      this.emit('message', sessionId, systemMessage);
    }
  }

  /**
   * Channel history prefetch/full-sync intentionally skips historical system entries.
   * Seed the raw gateway history cursor so those older reminders are not replayed
   * under the next assistant reply during final-history sync.
   */
  private markGatewayHistoryWindowConsumed(sessionId: string, historyMessages: unknown[]): void {
    if (historyMessages.length === 0) {
      return;
    }
    this.gatewayHistoryCountBySession.set(sessionId, historyMessages.length);
  }

  /**
   * Reconcile local session messages with the authoritative gateway chat.history.
   *
   * This is the single source-of-truth sync method: after a turn completes,
   * it fetches the full conversation from OpenClaw and overwrites local
   * user/assistant messages to match exactly.  Tool messages (tool_use,
   * tool_result, system) are kept as-is because the gateway does not
   * expose them in chat.history.
   *
   * The reconciliation is idempotent — calling it multiple times produces
   * the same result.
   */
  private async reconcileWithHistory(
    sessionId: string,
    sessionKey: string,
    options?: { isFullSync?: boolean },
  ): Promise<void> {
    const client = this.gatewayClient;
    if (!client) {
      console.log('[Reconcile] no gateway client, skipping — sessionId:', sessionId);
      return;
    }

    const isManaged = isManagedSessionKey(sessionKey);
    const limit = options?.isFullSync
      ? OpenClawRuntimeAdapter.FULL_HISTORY_SYNC_LIMIT
      : FINAL_HISTORY_SYNC_LIMIT;

    try {
      const history = await client.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit,
      });
      if (!Array.isArray(history?.messages) || history.messages.length === 0) {
        if (!isManaged) {
          console.log('[Reconcile] empty history — sessionId:', sessionId);
          this.channelSyncCursor.set(sessionId, 0);
        }
        return;
      }

      // Patch tool_result messages with content from history (gateway tool events
      // don't include the actual output — only the transcript does)
      this.patchToolResultsFromHistory(sessionId, history.messages);

      // Patch tool_use args from history (gateway tool events don't include args)
      this.patchToolUseArgsFromHistory(sessionId, history.messages);

      // For managed sessions, patch usage from history and return.
      // Managed sessions don't need the full message reconciliation (user/assistant
      // messages are already correct from the CoworkForwarder), but usage data
      // only exists in chat.history — so we must patch it here.
      if (isManaged) {
        this.patchUsageFromHistory(sessionId, history.messages);
        return;
      }

      // Update gateway history cursor for system message tracking
      this.gatewayHistoryCountBySession.set(sessionId, history.messages.length);

      // Sync system messages (reminders etc.)
      const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
      const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
      this.syncSystemMessagesFromHistory(sessionId, history.messages, {
        previousCountKnown: previousHistoryCountKnown,
        previousCount: previousHistoryCount,
      });

      // Determine if this is a channel session (for Discord text normalization)
      const isChannel =
        this.channelSessionSync &&
        !isManagedSessionKey(sessionKey) &&
        this.channelSessionSync.isChannelSessionKey(sessionKey);
      const isDiscord = sessionKey.includes(':discord:');

      // Extract authoritative user/assistant entries from gateway history
      const session = this.store.getSession(sessionId);
      const sessionAgentId = session?.agentId || 'main';
      const sessionAgent = this.store.getAgent(sessionAgentId);
      const sessionRawModel = sessionAgent?.model || '';
      const sessionModelName = sessionRawModel.includes('/')
        ? sessionRawModel.slice(sessionRawModel.indexOf('/') + 1)
        : sessionRawModel;
      const authoritativeEntries: Array<{
        role: 'user' | 'assistant';
        text: string;
        modelName?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }> = [];
      for (const message of history.messages) {
        if (!isRecord(message)) continue;
        const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
        if (role !== 'user' && role !== 'assistant') continue;
        let text = extractMessageText(message).trim();
        if (!text) continue;
        if (isDiscord) text = stripDiscordMentions(text);

        // Extract usage from gateway message (if assistant)
        const usage =
          role === 'assistant' && message.usage
            ? (message.usage as {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
              })
            : undefined;

        authoritativeEntries.push({
          role: role as 'user' | 'assistant',
          text,
          ...(role === 'assistant' ? { modelName: sessionModelName } : {}),
          ...(usage ? { usage } : {}),
        });
      }

      // For channel sessions, append file paths from "message" tool calls
      if (isChannel && authoritativeEntries.length > 0) {
        const sentFilePaths = extractSentFilePathsFromHistory(history.messages);
        if (sentFilePaths.length > 0) {
          const lastAssistantIdx = authoritativeEntries.findLastIndex(e => e.role === 'assistant');
          if (lastAssistantIdx >= 0) {
            const fileLinks = sentFilePaths.map(fp => `[${path.basename(fp)}](${fp})`).join('\n');
            authoritativeEntries[lastAssistantIdx] = {
              ...authoritativeEntries[lastAssistantIdx],
              text: `${authoritativeEntries[lastAssistantIdx].text}\n\n${fileLinks}`,
            };
          }
        }
      }

      if (authoritativeEntries.length === 0) {
        console.log('[Reconcile] no user/assistant entries in history — sessionId:', sessionId);
        this.channelSyncCursor.set(sessionId, 0);
        return;
      }

      // Collect local user/assistant messages for comparison
      const localSession = this.store.getSession(sessionId);
      const localEntries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
      if (localSession) {
        for (const msg of localSession.messages) {
          if (msg.type !== 'user' && msg.type !== 'assistant') continue;
          const text = msg.content.trim();
          if (!text) continue;
          localEntries.push({ role: msg.type, text });
        }
      }

      // Compare: if already in sync, skip the expensive replace — but still
      // patch usage into assistant messages that are missing it.
      const isInSync =
        localEntries.length === authoritativeEntries.length &&
        localEntries.every(
          (entry, idx) =>
            entry.role === authoritativeEntries[idx].role &&
            entry.text === authoritativeEntries[idx].text,
        );

      if (isInSync) {
        console.log(
          '[Reconcile] already in sync — sessionId:',
          sessionId,
          'entries:',
          localEntries.length,
        );

        // Patch usage into local assistant messages that are missing it.
        // Since isInSync guarantees same order, walk both arrays in parallel.
        const localSession = this.store.getSession(sessionId);
        if (localSession) {
          let patchedAny = false;
          let authAssistantIdx = 0;
          for (const msg of localSession.messages) {
            if (msg.type !== 'assistant') continue;
            // Find the next assistant entry in authoritative
            while (
              authAssistantIdx < authoritativeEntries.length &&
              authoritativeEntries[authAssistantIdx].role !== 'assistant'
            ) {
              authAssistantIdx++;
            }
            if (authAssistantIdx >= authoritativeEntries.length) break;
            const authEntry = authoritativeEntries[authAssistantIdx];
            authAssistantIdx++;

            if (authEntry.usage && !msg.usage) {
              this.store.updateMessage(sessionId, msg.id, {
                usage: authEntry.usage,
              });
              patchedAny = true;
            }
          }
          if (patchedAny) {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('cowork:sessions:changed');
              }
            }
          }
        }

        this.channelSyncCursor.set(sessionId, authoritativeEntries.length);
        return;
      }

      // Guard: don't replace if gateway returned fewer entries.
      // This typically means the gateway lost history (e.g., after restart)
      // and replacing would permanently destroy local messages.
      if (authoritativeEntries.length < localEntries.length) {
        console.log(
          '[Reconcile] skipping — gateway has fewer entries than local, preserving local history. sessionId:',
          sessionId,
          'local:',
          localEntries.length,
          'gateway:',
          authoritativeEntries.length,
        );
        this.channelSyncCursor.set(sessionId, localEntries.length);
        return;
      }

      // Replace local messages with authoritative ones
      console.log(
        '[Reconcile] replacing messages — sessionId:',
        sessionId,
        'local:',
        localEntries.length,
        '→ authoritative:',
        authoritativeEntries.length,
      );
      this.store.replaceConversationMessages(sessionId, authoritativeEntries);
      this.channelSyncCursor.set(sessionId, authoritativeEntries.length);

      // Notify renderer to refresh
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:sessions:changed');
        }
      }
    } catch (error) {
      console.warn('[Reconcile] failed — sessionId:', sessionId, 'error:', error);
    }
  }

  /**
   * Extract tool result content from chat.history messages and patch local
   * tool_result messages that have empty content.
   *
   * The gateway WebSocket `tool result` event does not include the actual tool
   * output — only a short `meta` summary.  The real output lives in the session
   * transcript, which chat.history reads from disk.
   */
  private patchToolResultsFromHistory(sessionId: string, historyMessages: unknown[]): void {
    const toolResultsByCallId = new Map<string, { text: string; isError: boolean }>();

    // Scan history for tool_result content: standalone messages and embedded blocks
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;

      // Standalone tool_result message (role-level)
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (
        role === 'tool_result' ||
        role === 'toolresult' ||
        role === 'tool' ||
        role === 'function'
      ) {
        const toolCallId =
          typeof message.toolCallId === 'string'
            ? message.toolCallId
            : typeof message.tool_call_id === 'string'
              ? message.tool_call_id
              : '';
        if (toolCallId) {
          const text = extractToolText(message.content) || extractToolText(message);
          if (text) {
            toolResultsByCallId.set(toolCallId, {
              text,
              isError: Boolean(message.isError),
            });
          }
        }
        continue;
      }

      // Content blocks with tool_result type (embedded in assistant messages)
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          if (blockType !== 'tool_result' && blockType !== 'toolresult') continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : '';
          if (!toolCallId) continue;
          const text = extractToolText(block);
          if (text) {
            toolResultsByCallId.set(toolCallId, {
              text,
              isError: Boolean(block.isError),
            });
          }
        }
      }
    }

    if (toolResultsByCallId.size === 0) return;

    // Patch local tool_result messages with content from history.
    // Gateway tool events often return only short meta info (e.g., "success")
    // instead of actual tool output. Always try to patch with the full output
    // from history, which contains the real stdout/stderr for Bash commands.
    const session = this.store.getSession(sessionId);
    if (!session) return;

    let patchedCount = 0;
    for (const msg of session.messages) {
      if (msg.type !== 'tool_result') continue;
      const toolUseId = msg.metadata?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const result = toolResultsByCallId.get(toolUseId);
      if (!result) continue;

      // Only patch if history has meaningful content different from current.
      // Skip if current content is identical to history (avoid redundant updates).
      const currentContent = msg.content?.trim() ?? '';
      const historyContent = result.text.trim();
      if (currentContent === historyContent) continue;

      this.store.updateMessage(sessionId, msg.id, {
        content: result.text,
        metadata: {
          ...msg.metadata,
          toolResult: result.text,
          isError: result.isError,
          error: result.isError ? result.text : undefined,
        },
      });
      this.emit('messageUpdate', sessionId, msg.id, result.text);
      patchedCount++;
    }
    if (patchedCount > 0) {
      console.log('[patchToolResults] patched', patchedCount, 'messages for sessionId:', sessionId);
    }
  }

  /**
   * Extract tool_use args from chat.history messages and patch local
   * tool_use messages that have empty or missing toolInput.
   *
   * The gateway WebSocket tool event (tool=start:edit) does not include args.
   * The args live in the assistant message's toolCall content blocks in chat.history.
   */
  private patchToolUseArgsFromHistory(sessionId: string, historyMessages: unknown[]): void {
    const toolArgsByCallId = new Map<string, { name: string; args: Record<string, unknown> }>();

    // Scan history for toolCall content blocks in assistant messages
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role !== 'assistant') continue;

      // Content blocks with toolCall type
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          if (blockType !== 'toolcall' && blockType !== 'tool_call' && blockType !== 'tooluse')
            continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : typeof block.id === 'string'
                  ? block.id
                  : '';
          const name = typeof block.name === 'string' ? block.name : '';
          const args = isRecord(block.arguments)
            ? (block.arguments as Record<string, unknown>)
            : isRecord(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          if (name && toolCallId) {
            toolArgsByCallId.set(toolCallId, { name, args });
          }
        }
      }
    }

    if (toolArgsByCallId.size === 0) return;

    // Patch local tool_use messages that have empty or missing toolInput
    const session = this.store.getSession(sessionId);
    if (!session) return;

    let patchedCount = 0;
    for (const msg of session.messages) {
      if (msg.type !== 'tool_use') continue;
      const toolUseId = msg.metadata?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const toolInfo = toolArgsByCallId.get(toolUseId);
      if (!toolInfo) continue;

      // Check if toolInput is empty or missing essential fields
      const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
      const needsPatch = !existingInput || Object.keys(existingInput).length === 0;

      if (needsPatch) {
        this.store.updateMessage(sessionId, msg.id, {
          metadata: {
            ...msg.metadata,
            toolName: toolInfo.name,
            toolInput: toolInfo.args,
          },
        });
        this.emit('messageMetadataUpdate', sessionId, msg.id, {
          toolName: toolInfo.name,
          toolInput: toolInfo.args,
        });
        patchedCount++;
      }
    }
    if (patchedCount > 0) {
      console.log(
        '[patchToolUseArgs] patched',
        patchedCount,
        'tool_use messages for sessionId:',
        sessionId,
      );
    }
  }

  /**
   * Patch usage data into local assistant messages from gateway chat.history.
   * For managed sessions, full message reconciliation is skipped, but usage
   * data (token counts) only exists in chat.history — this method extracts
   * and patches it by matching assistant messages on content text.
   */
  private patchUsageFromHistory(sessionId: string, historyMessages: unknown[]): void {
    // Build a map of assistant text -> usage from gateway history
    const usageByText = new Map<
      string,
      { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    >();
    for (const raw of historyMessages) {
      if (!isRecord(raw)) continue;
      const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
      if (role !== 'assistant') continue;
      const text = extractMessageText(raw).trim();
      if (!text) continue;
      const usage = isRecord(raw.usage)
        ? {
            input: typeof raw.usage.input === 'number' ? raw.usage.input : undefined,
            output: typeof raw.usage.output === 'number' ? raw.usage.output : undefined,
            cacheRead: typeof raw.usage.cacheRead === 'number' ? raw.usage.cacheRead : undefined,
            cacheWrite: typeof raw.usage.cacheWrite === 'number' ? raw.usage.cacheWrite : undefined,
          }
        : undefined;
      if (usage) {
        usageByText.set(text, usage);
      }
    }

    if (usageByText.size === 0) return;

    // Patch local assistant messages missing usage
    const session = this.store.getSession(sessionId);
    if (!session) return;

    let patchedAny = false;
    for (const msg of session.messages) {
      if (msg.type !== 'assistant') continue;
      if (msg.usage) continue; // already has usage
      const trimmedContent = msg.content.trim();
      if (!trimmedContent) continue;
      const usage = usageByText.get(trimmedContent);
      if (!usage) continue;

      this.store.updateMessage(sessionId, msg.id, { usage });
      // Emit via messageMetadataUpdate so renderer gets real-time notification
      // (extends the metadata event to also carry usage data)
      this.emit(
        'messageMetadataUpdate',
        sessionId,
        msg.id,
        { isStreaming: false, isFinal: true },
        { usage },
      );
      patchedAny = true;
    }

    if (patchedAny) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('cowork:sessions:changed');
        }
      }
    }
  }

  /**
   * Patch toolInput in CoworkMessage[] from raw Gateway history messages.
   * Used by getSubTaskHistory to fill missing toolInput for subagent tool_use messages.
   */
  private patchToolInputFromHistoryRaw(
    coworkMessages: CoworkMessage[],
    rawHistory: unknown[] | undefined,
  ): void {
    if (!Array.isArray(rawHistory) || coworkMessages.length === 0) return;

    const toolArgsByCallId = new Map<string, { name: string; args: Record<string, unknown> }>();

    // Scan raw history for toolCall blocks in assistant messages
    for (const raw of rawHistory) {
      if (!isRecord(raw)) continue;
      const message = raw as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role !== 'assistant') continue;

      // Content blocks with toolCall type
      if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (!isRecord(block)) continue;
          const blockType = typeof block.type === 'string' ? block.type.toLowerCase() : '';
          // Debug: log all non-text block types to understand Gateway format
          if (blockType && blockType !== 'text' && blockType !== 'thinking') {
            console.log(
              '[patchToolInputFromHistoryRaw] found block type:',
              blockType,
              'block keys:',
              Object.keys(block).slice(0, 6),
            );
          }
          if (blockType !== 'toolcall' && blockType !== 'tool_call' && blockType !== 'tooluse')
            continue;
          const toolCallId =
            typeof block.toolCallId === 'string'
              ? block.toolCallId
              : typeof block.tool_call_id === 'string'
                ? block.tool_call_id
                : typeof block.id === 'string'
                  ? block.id
                  : '';
          const name = typeof block.name === 'string' ? block.name : '';
          const args = isRecord(block.arguments)
            ? (block.arguments as Record<string, unknown>)
            : isRecord(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          if (name && toolCallId) {
            toolArgsByCallId.set(toolCallId, { name, args });
          }
        }
      }
    }

    if (toolArgsByCallId.size === 0) {
      console.log('[patchToolInputFromHistoryRaw] no toolCall blocks found in assistant messages');
      return;
    }

    // Debug: log all found toolCallIds
    console.log(
      '[patchToolInputFromHistoryRaw] found toolCallIds:',
      Array.from(toolArgsByCallId.keys()),
    );

    // Patch coworkMessages tool_use that have empty or missing toolInput
    // Also patch tool_result messages with toolInput from toolCall blocks
    let patchedToolUseCount = 0;
    let patchedToolResultCount = 0;
    for (const msg of coworkMessages) {
      // Handle tool_use messages
      if (msg.type === 'tool_use') {
        const toolUseId = msg.metadata?.toolUseId as string | undefined;
        console.log(
          '[patchToolInputFromHistoryRaw] tool_use msg toolUseId:',
          toolUseId,
          'toolName:',
          msg.metadata?.toolName,
        );
        if (!toolUseId) continue;
        const toolInfo = toolArgsByCallId.get(toolUseId);
        if (!toolInfo) {
          console.log('[patchToolInputFromHistoryRaw] no match for toolUseId:', toolUseId);
          continue;
        }

        const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
        const needsPatch = !existingInput || Object.keys(existingInput).length === 0;

        if (needsPatch) {
          msg.metadata = {
            ...msg.metadata,
            toolName: toolInfo.name,
            toolInput: toolInfo.args,
          };
          patchedToolUseCount++;
        }
      }

      // Handle tool_result messages - patch toolInput and toolName into metadata
      // Gateway history only has toolResult role, tool_use info is in assistant toolCall blocks
      if (msg.type === 'tool_result') {
        const toolUseId = msg.metadata?.toolUseId as string | undefined;
        console.log(
          '[patchToolInputFromHistoryRaw] tool_result msg toolUseId:',
          toolUseId,
          'toolName:',
          msg.metadata?.toolName,
        );
        if (!toolUseId) continue;
        const toolInfo = toolArgsByCallId.get(toolUseId);
        if (!toolInfo) {
          console.log(
            '[patchToolInputFromHistoryRaw] tool_result no match for toolUseId:',
            toolUseId,
          );
          continue;
        }

        // Patch toolName and toolInput into tool_result metadata
        const existingInput = msg.metadata?.toolInput as Record<string, unknown> | undefined;
        const existingName = msg.metadata?.toolName as string | undefined;
        const needsInputPatch = !existingInput || Object.keys(existingInput).length === 0;
        const needsNamePatch = !existingName || existingName === 'Unknown Tool';

        if (needsInputPatch || needsNamePatch) {
          msg.metadata = {
            ...msg.metadata,
            toolName: needsNamePatch ? toolInfo.name : existingName,
            toolInput: needsInputPatch ? toolInfo.args : existingInput,
          };
          patchedToolResultCount++;
        }
      }
    }

    if (patchedToolUseCount > 0 || patchedToolResultCount > 0) {
      console.log(
        '[patchToolInputFromHistoryRaw] patched',
        patchedToolUseCount,
        'tool_use messages and',
        patchedToolResultCount,
        'tool_result messages',
      );
    }
  }

  private async syncFinalAssistantWithHistory(sessionId: string, turn: ActiveTurn): Promise<void> {
    console.log('[Debug:syncFinal] start — sessionId:', sessionId, 'sessionKey:', turn.sessionKey);
    const client = this.gatewayClient;
    if (!client) {
      console.log('[Debug:syncFinal] no gateway client, skipping');
      return;
    }

    try {
      const retryDelaysMs = [0, 120, 250, 500];
      let historyMessages: unknown[] | null = null;
      let canonicalText = '';
      let isChannel = false;

      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: turn.sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.log(
          '[Debug:syncFinal] chat.history returned',
          msgCount,
          'messages',
          `afterDelay=${delayMs}`,
        );
        if (!Array.isArray(history?.messages) || history.messages.length === 0) {
          this.gatewayHistoryCountBySession.set(sessionId, 0);
          continue;
        }

        historyMessages = history.messages;
        const previousHistoryCountKnown = this.gatewayHistoryCountBySession.has(sessionId);
        const previousHistoryCount = this.gatewayHistoryCountBySession.get(sessionId) ?? 0;
        this.syncSystemMessagesFromHistory(sessionId, history.messages, {
          previousCountKnown: previousHistoryCountKnown,
          previousCount: previousHistoryCount,
        });

        // Debug: dump all history message roles and content types
        for (let i = 0; i < history.messages.length; i++) {
          const m = history.messages[i] as Record<string, unknown>;
          if (!isRecord(m)) continue;
          const r = typeof m.role === 'string' ? m.role : '?';
          let contentSummary: string;
          if (Array.isArray(m.content)) {
            const types = (m.content as Array<Record<string, unknown>>)
              .filter(isRecord)
              .map(b => b.type);
            contentSummary = `blocks:[${types.join(',')}]`;
          } else if (typeof m.content === 'string') {
            contentSummary = `text(${(m.content as string).length})`;
          } else {
            contentSummary = String(typeof m.content);
          }
          console.log(`[Debug:syncFinal:history] [${i}] role=${r} content=${contentSummary}`);
          if (r !== 'user' && Array.isArray(m.content)) {
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (
                isRecord(block) &&
                typeof block.type === 'string' &&
                block.type !== 'text' &&
                block.type !== 'thinking'
              ) {
                console.log(
                  `[Debug:syncFinal:history] [${i}] block:`,
                  JSON.stringify(block).slice(0, 800),
                );
              }
            }
          }
        }

        isChannel = Boolean(
          this.channelSessionSync &&
          !isManagedSessionKey(turn.sessionKey) &&
          this.channelSessionSync.isChannelSessionKey(turn.sessionKey),
        );
        if (isChannel) {
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          this.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            turn.sessionKey.includes(':discord:'),
          );
        }

        if (!this.isCurrentTurnToken(sessionId, turn.turnToken)) {
          console.log(
            '[Debug:syncFinal] stale turn token, skipping assistant text alignment for sessionId:',
            sessionId,
            'turnToken:',
            turn.turnToken,
          );
          return;
        }

        if (isChannel) {
          canonicalText = extractCurrentTurnAssistantText(history.messages);
        } else {
          for (let index = history.messages.length - 1; index >= 0; index -= 1) {
            const message = history.messages[index];
            if (!isRecord(message)) continue;
            const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
            if (role !== 'assistant') continue;
            canonicalText = extractMessageText(message).trim();
            if (canonicalText) {
              break;
            }
          }
        }

        if (canonicalText) {
          break;
        }
      }

      // Patch tool result messages with content from history (gateway tool events
      // do not include the actual output text).
      if (historyMessages) {
        this.patchToolResultsFromHistory(sessionId, historyMessages);
        // Patch tool_use args from history (gateway tool events don't include args)
        this.patchToolUseArgsFromHistory(sessionId, historyMessages);
      }

      if (!historyMessages || !canonicalText) {
        console.log('[Debug:syncFinal] no canonical assistant text found in history');
        return;
      }

      // For channel sessions, append file paths from "message" tool calls as clickable links
      if (isChannel) {
        const sentFilePaths = extractSentFilePathsFromHistory(historyMessages);
        if (sentFilePaths.length > 0) {
          console.log('[Debug:syncFinal] found sent file paths:', sentFilePaths);
          const fileLinks = sentFilePaths.map(fp => `[${path.basename(fp)}](${fp})`).join('\n');
          canonicalText = `${canonicalText}\n\n${fileLinks}`;
        }
      }

      console.log(
        '[Debug:syncFinal] canonicalText length:',
        canonicalText.length,
        'assistantMessageId:',
        turn.assistantMessageId,
      );

      const canonicalSegmentText = this.resolveAssistantSegmentText(turn, canonicalText);
      console.debug(
        '[Debug:syncFinal] canonicalSegmentText length:',
        canonicalSegmentText.length,
        'committed.length:',
        turn.committedAssistantText.length,
        'segment:',
        canonicalSegmentText.slice(0, 80),
      );
      turn.currentText = canonicalText;
      turn.currentAssistantSegmentText = canonicalSegmentText;

      // Handle "NO_REPLY" special marker: clear any previously created message
      // If canonicalSegmentText is empty (filtered out "NO_REPLY"), we should
      // delete any message created during streaming that may have partial marker content
      if (!canonicalSegmentText) {
        if (turn.assistantMessageId) {
          // Delete the message created during streaming (may have "NO" partial marker)
          this.store.deleteMessage(sessionId, turn.assistantMessageId);
          this.emit('messageDelete', sessionId, turn.assistantMessageId);
          turn.assistantMessageId = null;
        }
        return;
      }

      if (!turn.assistantMessageId) {
        const reusedMessageId = this.reuseFinalAssistantMessage(sessionId, canonicalSegmentText);
        if (reusedMessageId) {
          turn.assistantMessageId = reusedMessageId;
          return;
        }

        const assistantMessage = this.store.addMessage(sessionId, {
          type: 'assistant',
          content: canonicalSegmentText,
          metadata: {
            isStreaming: false,
            isFinal: true,
          },
          modelName: turn.modelName,
        });
        turn.assistantMessageId = assistantMessage.id;
        this.emit('message', sessionId, assistantMessage);
        return;
      }

      const session = this.store.getSession(sessionId);
      const currentMessage = session?.messages.find(
        message => message.id === turn.assistantMessageId,
      );
      const currentText = currentMessage?.content.trim() ?? '';
      if (canonicalSegmentText === currentText) {
        // Content matches but renderer may not have received the last throttled update.
        // Force-emit so the UI shows the final text.
        this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
        return;
      }

      console.debug(
        '[Debug:syncFinal] updating last segment:',
        currentText.length,
        '->',
        canonicalSegmentText.length,
      );
      this.store.updateMessage(sessionId, turn.assistantMessageId, {
        content: canonicalSegmentText,
        metadata: {
          isStreaming: false,
          isFinal: true,
        },
      });
      this.emit('messageUpdate', sessionId, turn.assistantMessageId, canonicalSegmentText);
    } catch (error) {
      console.warn('[OpenClawRuntime] chat.history sync after final failed:', error);
    }
  }

  private collectChannelHistoryEntries(
    historyMessages: unknown[],
    isDiscord: boolean,
  ): ChannelHistorySyncEntry[] {
    const historyEntries: ChannelHistorySyncEntry[] = [];
    for (const message of historyMessages) {
      if (!isRecord(message)) continue;
      const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
      if (role !== 'user' && role !== 'assistant') continue;
      let text = extractMessageText(message).trim();
      if (isDiscord) text = stripDiscordMentions(text);
      if (text) {
        historyEntries.push({ role: role as 'user' | 'assistant', text });
      }
    }
    return historyEntries;
  }

  private collectLocalChannelEntries(sessionId: string): ChannelHistorySyncEntry[] {
    const session = this.store.getSession(sessionId);
    if (!session) return [];

    const localEntries: ChannelHistorySyncEntry[] = [];
    for (const msg of session.messages) {
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;
      const text = msg.content.trim();
      if (!text) continue;
      localEntries.push({ role: msg.type, text });
    }
    return localEntries;
  }

  private computeChannelHistoryFirstNewIndex(
    localEntries: ChannelHistorySyncEntry[],
    historyEntries: ChannelHistorySyncEntry[],
    cursor: number,
  ): { firstNewIdx: number; strategy: string } {
    if (localEntries.length === 0) {
      return { firstNewIdx: 0, strategy: 'empty-local' };
    }

    // `chat.history` is byte-bounded in OpenClaw, so the returned window can slide
    // long before it reaches our requested count. Match the local tail against the
    // current history prefix to find the continuation point without trusting length.
    const maxOverlap = Math.min(localEntries.length, historyEntries.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let idx = 0; idx < overlap; idx += 1) {
        const localEntry = localEntries[localEntries.length - overlap + idx];
        const historyEntry = historyEntries[idx];
        if (!isSameChannelHistoryEntry(localEntry, historyEntry)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { firstNewIdx: overlap, strategy: 'tail-overlap' };
      }
    }

    let lastLocalUserIdx = -1;
    for (let idx = localEntries.length - 1; idx >= 0; idx -= 1) {
      if (localEntries[idx].role === 'user') {
        lastLocalUserIdx = idx;
        break;
      }
    }

    if (lastLocalUserIdx >= 0) {
      const lastLocalUser = localEntries[lastLocalUserIdx];
      let prevLocalUserText: string | undefined;
      for (let idx = lastLocalUserIdx - 1; idx >= 0; idx -= 1) {
        if (localEntries[idx].role === 'user') {
          prevLocalUserText = localEntries[idx].text;
          break;
        }
      }

      for (let idx = historyEntries.length - 1; idx >= 0; idx -= 1) {
        if (
          historyEntries[idx].role !== 'user' ||
          historyEntries[idx].text !== lastLocalUser.text
        ) {
          continue;
        }
        if (prevLocalUserText !== undefined && idx > 0) {
          let prevHistUserText: string | undefined;
          for (let histIdx = idx - 1; histIdx >= 0; histIdx -= 1) {
            if (historyEntries[histIdx].role === 'user') {
              prevHistUserText = historyEntries[histIdx].text;
              break;
            }
          }
          if (prevHistUserText !== prevLocalUserText) {
            continue;
          }
        }
        return { firstNewIdx: idx + 1, strategy: 'last-user-anchor' };
      }
    }

    // When cursor > 0, tail-overlap and last-user-anchor (above) are the correct
    // content-based strategies for detecting a sliding history window.  If both
    // failed the mismatch is caused by duplicates in the local store, not by
    // genuinely new gateway messages.  Trust the cursor — it was set to
    // historyEntries.length at the end of the previous sync — instead of falling
    // through to forward-match, which can produce wildly wrong firstNewIdx values
    // when local entries are polluted (causing either an infinite re-sync loop
    // when cursor == historyEntries.length, or a burst of old messages being
    // re-synced when cursor < historyEntries.length).
    //
    // forward-match is still used when cursor == 0 (initial sync / after restart)
    // because there is no cursor history to rely on.
    if (cursor > 0) {
      if (cursor >= historyEntries.length) {
        return { firstNewIdx: historyEntries.length, strategy: 'cursor-stable' };
      }
      return { firstNewIdx: cursor, strategy: 'cursor-fallback' };
    }

    let localIdx = 0;
    let forwardFirstNewIdx = 0;
    for (let idx = 0; idx < historyEntries.length; idx += 1) {
      if (
        localIdx < localEntries.length &&
        isSameChannelHistoryEntry(historyEntries[idx], localEntries[localIdx])
      ) {
        localIdx += 1;
        forwardFirstNewIdx = idx + 1;
      }
    }
    if (forwardFirstNewIdx > 0) {
      return { firstNewIdx: forwardFirstNewIdx, strategy: 'forward-match' };
    }

    if (historyEntries.length < cursor) {
      return { firstNewIdx: 0, strategy: 'history-rewrite' };
    }

    return {
      firstNewIdx: Math.min(cursor, historyEntries.length),
      strategy: 'cursor-fallback',
    };
  }

  /**
   * Sync user messages from gateway chat.history that haven't been added to the local store yet.
   * Used for channel-originated sessions (e.g. Telegram) where user messages arrive via the
   * gateway rather than the GucciAI UI.
   *
   * Called at the start of a new turn (via prefetchChannelUserMessages) so that user messages
   * appear before the assistant's streaming response. Both chat and agent events are buffered
   * during prefetch, so the replay order matches direct cowork sessions.
   *
   * Reconciles against the local tail instead of trusting history length/cursor alone,
   * because OpenClaw's `chat.history` window can slide due to byte limits well before
   * the requested message count is reached.
   */
  private syncChannelUserMessages(
    sessionId: string,
    historyMessages: unknown[],
    latestOnly = false,
    isDiscord = false,
  ): void {
    const historyEntries = this.collectChannelHistoryEntries(historyMessages, isDiscord);

    const cursor = this.channelSyncCursor.get(sessionId) ?? 0;

    // When latestOnly is true (e.g. session re-created after deletion),
    // only sync the last user message — the one that triggered this turn.
    // Advance cursor to end so subsequent syncs don't replay old history.
    if (latestOnly) {
      if (historyEntries.length > 0) {
        const lastUser = [...historyEntries].reverse().find(entry => entry.role === 'user');
        if (lastUser) {
          // Dedup: skip if this message already exists locally
          const session = this.store.getSession(sessionId);
          const alreadyExists =
            session?.messages.some(
              (m: CoworkMessage) => m.type === 'user' && m.content.trim() === lastUser.text,
            ) ?? false;
          if (!alreadyExists) {
            const userMessage = this.store.addMessage(sessionId, {
              type: 'user',
              content: lastUser.text,
              metadata: {},
            });
            this.emit('message', sessionId, userMessage);
          }
        }
      }
      this.channelSyncCursor.set(sessionId, historyEntries.length);
      return;
    }

    const localEntries = this.collectLocalChannelEntries(sessionId);
    const { firstNewIdx } = this.computeChannelHistoryFirstNewIndex(
      localEntries,
      historyEntries,
      cursor,
    );

    // Sync user messages from gateway history.
    // Only sync user messages here — assistant messages are already added by the
    // real-time streaming pipeline (handleChatDelta / handleAgentEvent) and by
    // syncFinalAssistantWithHistory's own addMessage/updateMessage logic.
    //
    // When syncing a user message, check whether the corresponding assistant response
    // was already created locally (e.g. due to prefetch timeout where the assistant
    // streamed before user messages were synced). If so, use insertMessageBeforeId
    // to place the user message before the assistant — preserving correct chronological
    // order. This handles the race condition where gateway chat.history lags behind
    // the real-time streaming events.
    let syncedCount = 0;

    // Collect all user message indices that need syncing:
    // 1. Normal: user messages from firstNewIdx onwards
    // 2. Repair: user messages before firstNewIdx that are missing locally
    //    (can happen when computeChannelHistoryFirstNewIndex's forward-match
    //    strategy matches the assistant but skips the preceding user message)
    const currentSession = this.store.getSession(sessionId);
    const localUserTexts = new Set<string>();
    if (currentSession) {
      for (const msg of currentSession.messages) {
        if (msg.type === 'user') {
          localUserTexts.add(msg.content.trim());
        }
      }
    }

    const userIndicesToSync: number[] = [];
    // Normal range: from firstNewIdx onwards, with dedup against local messages
    for (let i = firstNewIdx; i < historyEntries.length; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }
    // Repair range: before firstNewIdx, missing locally
    for (let i = 0; i < firstNewIdx; i++) {
      if (historyEntries[i].role === 'user' && !localUserTexts.has(historyEntries[i].text)) {
        userIndicesToSync.push(i);
      }
    }

    for (const idx of userIndicesToSync) {
      const entry = historyEntries[idx];

      // Find the next assistant entry in history after this user entry, then
      // look for a matching local assistant message. If found, insert the user
      // message before it to maintain correct chronological order.
      let insertBeforeId: string | null = null;
      if (currentSession) {
        for (let j = idx + 1; j < historyEntries.length; j++) {
          if (historyEntries[j].role !== 'assistant') continue;
          const assistantText = historyEntries[j].text;
          // Match by content prefix — local text may be segmented or truncated
          const matchPrefix = assistantText.slice(0, 100);
          const localMatch = currentSession.messages.find(
            (m: CoworkMessage) =>
              m.type === 'assistant' && m.content.trim().startsWith(matchPrefix),
          );
          if (localMatch) {
            insertBeforeId = localMatch.id;
          }
          break;
        }
      }

      let userMessage;
      if (insertBeforeId) {
        userMessage = this.store.insertMessageBeforeId(sessionId, insertBeforeId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
        console.debug(
          '[syncChannelUserMessages] inserted user message before assistant, sessionId:',
          sessionId,
        );
      } else {
        userMessage = this.store.addMessage(sessionId, {
          type: 'user',
          content: entry.text,
          metadata: {},
        });
      }
      this.emit('message', sessionId, userMessage);
      localUserTexts.add(entry.text);
      syncedCount++;
    }

    this.channelSyncCursor.set(sessionId, historyEntries.length);
  }

  private getUserMessageCount(sessionId: string): number {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    return session.messages.filter((m: CoworkMessage) => m.type === 'user').length;
  }

  /**
   * Sync full conversation history for a newly discovered channel session.
   * Adds both user and assistant messages to the local CoworkStore in order.
   * Skipped if the session has already been fully synced.
   *
   * Uses position-based matching to avoid false dedup of identical-content messages.
   */

  private async syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void> {
    if (this.fullySyncedSessions.has(sessionId)) return;
    this.fullySyncedSessions.add(sessionId);

    try {
      await this.reconcileWithHistory(sessionId, sessionKey, { isFullSync: true });
    } catch (error) {
      console.error('[ChannelSync] syncFullChannelHistory: error:', error);
      // Remove from synced set so retry is possible
      this.fullySyncedSessions.delete(sessionId);
    }
  }

  /**
   * Incremental sync for an already-known channel session.
   * Delegates to reconcileWithHistory which handles diff and update.
   */
  private async incrementalChannelSync(sessionId: string, sessionKey: string): Promise<void> {
    await this.reconcileWithHistory(sessionId, sessionKey);
  }

  /**
   * Trigger an immediate incremental sync after a channel session turn completes,
   * so that the renderer sees the latest messages without waiting for the next poll.
   */
  private syncChannelAfterTurn(sessionId: string, sessionKey: string): void {
    if (!this.channelSessionSync || !sessionKey) return;
    if (!this.channelSessionSync.isChannelSessionKey(sessionKey)) return;
    if (!this.fullySyncedSessions.has(sessionId)) return;

    void this.reconcileWithHistory(sessionId, sessionKey).catch(err => {
      console.warn('[ChannelSync] post-turn incremental sync failed for', sessionKey, err);
    });
  }

  private clearPendingApprovalsBySession(sessionId: string): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(requestId);
      }
    }
  }

  private cleanupSessionTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      // Clear client-side timeout watchdog
      if (turn.timeoutTimer) {
        clearTimeout(turn.timeoutTimer);
        turn.timeoutTimer = undefined;
      }
      // Cancel any pending throttled messageUpdate timer for this turn
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.lastMessageUpdateEmitTime.delete(turn.assistantMessageId);
        this.clearPendingStoreUpdate(turn.assistantMessageId);
        this.lastStoreUpdateTime.delete(turn.assistantMessageId);
      }
      turn.knownRunIds.forEach(knownRunId => {
        this.sessionIdByRunId.delete(knownRunId);
        this.pendingAgentEventsByRunId.delete(knownRunId);
        this.lastChatSeqByRunId.delete(knownRunId);
        this.lastAgentSeqByRunId.delete(knownRunId);
      });
    }
    this.activeTurns.delete(sessionId);
    setCoworkProxySessionId(null);
    this.reCreatedChannelSessionIds.delete(sessionId);
  }

  /**
   * Start a client-side timeout watchdog for a turn.
   * Fires after the server-side timeout + grace period, recovering the UI
   * if the gateway fails to deliver the abort/final event.
   */
  private startTurnTimeoutWatchdog(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    const timeoutMs =
      this.agentTimeoutSeconds * 1000 + OpenClawRuntimeAdapter.CLIENT_TIMEOUT_GRACE_MS;
    turn.timeoutTimer = setTimeout(() => {
      const currentTurn = this.activeTurns.get(sessionId);
      if (!currentTurn || currentTurn.turnToken !== turn.turnToken) return;
      console.warn(
        `[OpenClawRuntime] Client-side timeout watchdog fired for session ${sessionId}, ` +
          `runId=${currentTurn.runId} after ${timeoutMs}ms — gateway did not deliver abort event`,
      );
      this.handleChatAborted(sessionId, currentTurn);
    }, timeoutMs);
  }

  /**
   * Called when a session is deleted from the store.
   * Purges all in-memory references so that new channel messages
   * with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string, agentId?: string): void {
    // Remove sessionIdBySessionKey entries pointing to this session
    // IMPORTANT: Save removedKeys BEFORE deleting for OpenClaw sync
    const removedKeys: string[] = [];
    for (const [key, id] of this.sessionIdBySessionKey.entries()) {
      if (id === sessionId) {
        removedKeys.push(key);
        this.sessionIdBySessionKey.delete(key);
      }
    }

    // If removedKeys is empty, build sessionKey from agentId parameter or default to 'main'
    if (removedKeys.length === 0) {
      const effectiveAgentId = agentId || 'main';
      const sessionKey = this.toSessionKey(sessionId, effectiveAgentId);
      removedKeys.push(sessionKey);
    }

    console.log(
      `[OpenClaw] onSessionDeleted: sessionId=${sessionId}, agentId=${agentId}, removedKeys=${JSON.stringify(removedKeys)}, totalKeysInMap=${this.sessionIdBySessionKey.size}`,
    );

    // Sync deletion to OpenClaw Gateway FIRST (using saved removedKeys)
    // Wait for gatewayClient to be ready before attempting deletion
    this.deleteOpenClawSessionByKeysWithRetry(sessionId, removedKeys).catch(err => {
      console.warn(`[OpenClaw] deleteOpenClawSessionByKeysWithRetry error for ${sessionId}:`, err);
    });
    // Suppress polling re-creation for deleted channel keys.
    // Only real-time events (new IM messages) will re-create the session.
    for (const key of removedKeys) {
      this.deletedChannelKeys.add(key);
    }

    // Allow polling to rediscover channel sessions
    this.knownChannelSessionIds.delete(sessionId);

    // Allow full history re-sync when session is re-created
    this.fullySyncedSessions.delete(sessionId);
    this.channelSyncCursor.delete(sessionId);
    this.reCreatedChannelSessionIds.delete(sessionId);
    this.gatewayHistoryCountBySession.delete(sessionId);
    this.latestTurnTokenBySession.delete(sessionId);
    this.stoppedSessions.delete(sessionId);

    // Clean up active turn and related run-id mappings
    this.cleanupSessionTurn(sessionId);

    // Clean up pending approvals, confirmation mode
    this.clearPendingApprovalsBySession(sessionId);
    this.confirmationModeBySession.delete(sessionId);
    this.manuallyStoppedSessions.delete(sessionId);

    // Propagate to channel session sync
    if (this.channelSessionSync) {
      this.channelSessionSync.onSessionDeleted(sessionId);
    }
  }

  /**
   * Sync deletion to OpenClaw Gateway by calling sessions.delete API.
   * Deletes the remote session and all its related sessions (subagents, title sessions, etc).
   */
  private async deleteOpenClawSessionByKeys(sessionKeys: string[]): Promise<void> {
    const client = this.gatewayClient;
    if (!client || sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeys: skipped, client=${!!client}, keys=${sessionKeys.length}`,
      );
      return;
    }

    console.log(
      `[OpenClaw] deleteOpenClawSessionByKeys: starting with keys=${JSON.stringify(sessionKeys)}`,
    );

    // Extract agentId from the first sessionKey (format: agent:{agentId}:gucciai:{sessionId})
    const agentId = this.extractAgentIdFromSessionKey(sessionKeys[0]);

    // Delete all related sessions in parallel for efficiency
    const deletePromises: Promise<void>[] = [];

    for (const sessionKey of sessionKeys) {
      deletePromises.push(this.deleteSessionTree(client, sessionKey));
    }

    // Also delete orphan subagent and title sessions at agent level
    if (agentId) {
      deletePromises.push(this.deleteAgentLevelSessions(client, agentId));
    }

    await Promise.allSettled(deletePromises);
    console.log(`[OpenClaw] deleteOpenClawSessionByKeys: completed`);
  }

  /**
   * Delete orphan subagent and title sessions at agent level.
   * These sessions have keys like: agent:{agentId}:subagent:{uuid}, agent:{agentId}:title:{uuid}
   * They are not spawnedBy the GucciAI session, but should be cleaned up when the session is deleted.
   */
  private async deleteAgentLevelSessions(
    client: GatewayClientLike,
    agentId: string,
  ): Promise<void> {
    try {
      // Query all sessions for this agent
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { agentId, limit: 200 });

      console.log(
        `[OpenClaw] deleteAgentLevelSessions: agentId=${agentId}, found ${listResult.sessions?.length ?? 0} sessions`,
      );

      for (const session of listResult.sessions ?? []) {
        // Delete sessions that are:
        // 1. Not spawnedBy a GucciAI session (no spawnedBy or spawnedBy doesn't contain 'gucciai')
        // 2. Are subagent or title sessions (contain :subagent: or :title:)
        const isSubagentOrTitle =
          session.key.includes(':subagent:') || session.key.includes(':title:');
        const isNotSpawnedByGucciAI = !session.spawnedBy || !session.spawnedBy.includes('gucciai');

        if (isSubagentOrTitle && isNotSpawnedByGucciAI) {
          try {
            await client.request('sessions.delete', {
              key: session.key,
              deleteTranscript: true,
            });
            console.log(`[OpenClaw] deleteAgentLevelSessions: deleted ${session.key}`);
          } catch (err) {
            console.warn(
              `[OpenClaw] deleteAgentLevelSessions: failed to delete ${session.key}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[OpenClaw] deleteAgentLevelSessions: error querying agent ${agentId}:`, err);
    }
  }

  /**
   * Extract agentId from session key format: agent:{agentId}:gucciai:{sessionId}
   */
  private extractAgentIdFromSessionKey(sessionKey: string): string | null {
    const match = /^agent:([^:]+):/.exec(sessionKey);
    return match ? match[1] : null;
  }

  /**
   * Delete OpenClaw sessions with retry - waits for gatewayClient to be ready.
   */
  private async deleteOpenClawSessionByKeysWithRetry(
    sessionId: string,
    sessionKeys: string[],
  ): Promise<void> {
    if (sessionKeys.length === 0) {
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: no keys to delete for sessionId=${sessionId}`,
      );
      return;
    }

    // Wait for gatewayClient to be ready (with timeout)
    const maxWaitMs = 5000;
    const startTime = Date.now();
    while (!this.gatewayClient && Date.now() - startTime < maxWaitMs) {
      try {
        await this.ensureGatewayClientReady();
      } catch (err) {
        console.warn(
          `[OpenClaw] deleteOpenClawSessionByKeysWithRetry: waiting for gatewayClient...`,
          err,
        );
      }
      if (!this.gatewayClient) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    try {
      await this.deleteOpenClawSessionByKeys(sessionKeys);
      console.log(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry completed for sessionId=${sessionId}`,
      );
    } catch (err) {
      console.warn(
        `[OpenClaw] deleteOpenClawSessionByKeysWithRetry failed for sessionId=${sessionId}:`,
        err,
      );
    }
  }

  /**
   * Delete a session and all sessions spawned by it (recursively).
   */
  private async deleteSessionTree(client: GatewayClientLike, sessionKey: string): Promise<void> {
    try {
      // Query sessions spawned by this session (includes subagents and possibly title sessions)
      const listResult = await client.request<{
        sessions?: Array<{ key: string; spawnedBy?: string }>;
      }>('sessions.list', { spawnedBy: sessionKey, limit: 100 });

      // Recursively delete child sessions first (depth-first)
      for (const childSession of listResult.sessions ?? []) {
        await this.deleteSessionTree(client, childSession.key);
      }

      // Delete this session (if not a main session like agent:xxx:main)
      if (!this.isMainSessionKey(sessionKey)) {
        await client.request('sessions.delete', {
          key: sessionKey,
          deleteTranscript: true,
        });
      }
    } catch (err) {
      console.warn(`[OpenClaw] Error deleting session tree ${sessionKey}:`, err);
    }
  }

  /**
   * Check if a sessionKey is a main session (e.g., agent:{agentId}:main).
   * Main sessions cannot be deleted via sessions.delete API.
   */
  private isMainSessionKey(key: string): boolean {
    return key.endsWith(':main');
  }

  /**
   * Ensure an ActiveTurn exists for a session. Used for channel-originated sessions
   * where new turns arrive after the previous turn was cleaned up.
   */
  private isSessionInStopCooldown(sessionId: string): boolean {
    const stoppedAt = this.stoppedSessions.get(sessionId);
    if (stoppedAt === undefined) return false;
    if (Date.now() - stoppedAt < OpenClawRuntimeAdapter.STOP_COOLDOWN_MS) {
      return true;
    }
    // Cooldown expired, remove the entry
    this.stoppedSessions.delete(sessionId);
    return false;
  }

  private ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void {
    if (this.activeTurns.has(sessionId)) return;
    // Suppress automatic turn re-creation for sessions that are still within
    // the stop cooldown window.  This prevents late-arriving OpenClaw events
    // (e.g. from POPO/Telegram) from restarting a stopped session.
    if (this.isSessionInStopCooldown(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] suppressed — session in stop cooldown, sessionId:',
        sessionId,
      );
      return;
    }
    // Once the cooldown has expired, clear the manual-stop marker so that
    // genuinely new channel messages can create a fresh turn.  Without this,
    // `manuallyStoppedSessions` (a permanent Set) would block all future
    // channel events for this session until `runTurn` or `onSessionDeleted`
    // happens to clear it.
    if (this.manuallyStoppedSessions.has(sessionId)) {
      console.log(
        '[Debug:ensureActiveTurn] cooldown expired, clearing manuallyStoppedSessions for channel re-activation, sessionId:',
        sessionId,
      );
      this.manuallyStoppedSessions.delete(sessionId);
    }
    const turnRunId = runId || randomUUID();
    const turnToken = this.nextTurnToken(sessionId);
    const isChannel =
      this.channelSessionSync &&
      !isManagedSessionKey(sessionKey) &&
      this.channelSessionSync.isChannelSessionKey(sessionKey);
    const session = this.store.getSession(sessionId);
    const agentId = session?.agentId || 'main';
    const agent = this.store.getAgent(agentId);
    const rawModel = agent?.model || '';
    let modelName = rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    // Fallback to config default model if agent model is empty
    if (!modelName) {
      const apiResolution = resolveRawApiConfig();
      const configModel = apiResolution.config?.model;
      const providerMetadata = apiResolution.providerMetadata;
      if (configModel) {
        modelName = providerMetadata?.modelName || configModel;
      }
    }
    console.log(
      '[Debug:ensureActiveTurn] creating turn — sessionId:',
      sessionId,
      'sessionKey:',
      sessionKey,
      'runId:',
      turnRunId,
      'isChannel:',
      !!isChannel,
      'pendingUserSync:',
      !!isChannel,
    );
    this.activeTurns.set(sessionId, {
      sessionId,
      sessionKey,
      runId: turnRunId,
      turnToken,
      knownRunIds: new Set(runId ? [runId] : [turnRunId]),
      assistantMessageId: null,
      committedAssistantText: '',
      currentAssistantSegmentText: '',
      currentText: '',
      agentAssistantTextLength: 0,
      currentContentText: '',
      currentContentBlocks: [],
      sawNonTextContentBlocks: false,
      textStreamMode: 'unknown',
      toolUseMessageIdByToolCallId: new Map(),
      toolResultMessageIdByToolCallId: new Map(),
      toolResultTextByToolCallId: new Map(),
      stopRequested: false,
      pendingUserSync: !!isChannel,
      bufferedChatPayloads: [],
      bufferedAgentPayloads: [],
      currentThinkingMessageId: null,
      currentThinkingContent: '',
      thinkingStreamEnded: false,
      modelName,
    });
    if (runId) {
      this.sessionIdByRunId.set(runId, sessionId);
    }
    this.store.updateSession(sessionId, { status: 'running' });
    this.startTurnTimeoutWatchdog(sessionId);

    // For channel sessions, prefetch user messages before streaming starts
    if (isChannel) {
      void this.prefetchChannelUserMessages(sessionId, sessionKey);
    }
  }

  /**
   * Prefetch user messages from gateway history at the start of a channel session turn.
   * This ensures user messages appear before the assistant's streaming response.
   * Delta/final events are buffered until this completes.
   */
  private async prefetchChannelUserMessages(sessionId: string, sessionKey: string): Promise<void> {
    console.log('[Debug:prefetch] start — sessionId:', sessionId, 'sessionKey:', sessionKey);

    // Best-effort prefetch with 2 attempts. Final correctness is ensured by
    // reconcileWithHistory after the turn completes.
    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const client = this.gatewayClient;
        if (!client) {
          console.log('[Debug:prefetch] no gateway client available');
          break;
        }

        const history = await client.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: FINAL_HISTORY_SYNC_LIMIT,
        });
        const msgCount = Array.isArray(history?.messages) ? history.messages.length : 0;
        console.log(
          '[Debug:prefetch] chat.history returned',
          msgCount,
          'messages (attempt',
          attempt,
          ')',
        );

        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          this.markGatewayHistoryWindowConsumed(sessionId, history.messages);
          const latestOnly = this.reCreatedChannelSessionIds.has(sessionId);
          const beforeCount = this.getUserMessageCount(sessionId);
          this.syncChannelUserMessages(
            sessionId,
            history.messages,
            latestOnly,
            sessionKey.includes(':discord:'),
          );
          const afterCount = this.getUserMessageCount(sessionId);
          const newUserMessages = afterCount - beforeCount;
          console.log(
            '[Debug:prefetch] synced user messages:',
            newUserMessages,
            '(before:',
            beforeCount,
            'after:',
            afterCount,
            ')',
          );

          if (newUserMessages > 0) {
            break;
          }

          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] no new user messages but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        } else {
          // Retry once if buffered events suggest history hasn't caught up yet
          if (attempt < MAX_ATTEMPTS - 1) {
            const turn = this.activeTurns.get(sessionId);
            if (
              turn &&
              (turn.bufferedChatPayloads.length > 0 || turn.bufferedAgentPayloads.length > 0)
            ) {
              console.log(
                '[Debug:prefetch] empty history but have buffered events, retrying after 500ms...',
              );
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
          }
          break;
        }
      } catch (error) {
        console.warn(
          '[OpenClawRuntime] prefetchChannelUserMessages attempt',
          attempt,
          'failed:',
          error,
        );
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      console.log(
        '[Debug:prefetch] turn was removed during prefetch, cannot replay. sessionId:',
        sessionId,
      );
      return;
    }
    turn.pendingUserSync = false;

    const chatBuffered = turn.bufferedChatPayloads.length;
    const agentBuffered = turn.bufferedAgentPayloads.length;
    console.log(
      '[Debug:prefetch] replaying buffered events — chat:',
      chatBuffered,
      'agent:',
      agentBuffered,
    );

    // Merge and replay both chat and agent events in sequence order
    // so that tool use/result messages are interleaved with assistant text segments
    // just like in direct cowork sessions.
    const allBuffered: Array<{
      type: 'chat' | 'agent';
      payload: unknown;
      seq?: number;
      bufferedAt: number;
      idx: number;
    }> = [];
    let bufIdx = 0;
    for (const event of turn.bufferedChatPayloads) {
      allBuffered.push({
        type: 'chat',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    for (const event of turn.bufferedAgentPayloads) {
      allBuffered.push({
        type: 'agent',
        payload: event.payload,
        seq: event.seq,
        bufferedAt: event.bufferedAt,
        idx: bufIdx++,
      });
    }
    turn.bufferedChatPayloads = [];
    turn.bufferedAgentPayloads = [];

    allBuffered.sort((a, b) => {
      // Primary: sort by seq if both have it
      const hasSeqA = typeof a.seq === 'number';
      const hasSeqB = typeof b.seq === 'number';
      if (hasSeqA && hasSeqB) return a.seq! - b.seq!;
      // Events with seq come before events without
      if (hasSeqA !== hasSeqB) return hasSeqA ? -1 : 1;
      // Fallback: preserve arrival order via bufferedAt, then insertion index
      if (a.bufferedAt !== b.bufferedAt) return a.bufferedAt - b.bufferedAt;
      return a.idx - b.idx;
    });

    for (const event of allBuffered) {
      if (event.type === 'chat') {
        this.handleChatEvent(event.payload, event.seq);
      } else {
        this.handleAgentEvent(event.payload, event.seq);
      }
    }
    console.log('[Debug:prefetch] replay complete, sessionId:', sessionId);
  }

  private bindRunIdToTurn(sessionId: string, runId: string): void {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return;
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;

    // Check if this is a new runId (not already in knownRunIds)
    // If so, reset text-related state to avoid false "text reset" detection
    // that could cause incorrect message splitting
    const isNewRunId = !turn.knownRunIds.has(normalizedRunId);

    if (isNewRunId) {
      // Finalize any pending streaming message before resetting state
      // This ensures the old message is properly marked as final
      // NOTE: Do NOT call flushPendingStoreUpdate here because it would write
      // currentAssistantSegmentText (which may be truncated) to the store,
      // overwriting the complete content. Instead, just mark metadata as final.
      if (turn.assistantMessageId) {
        this.clearPendingMessageUpdate(turn.assistantMessageId);
        this.clearPendingStoreUpdate(turn.assistantMessageId);
        const session = this.store.getSession(sessionId);
        const existingMsg = session?.messages.find(m => m.id === turn.assistantMessageId);

        if (existingMsg && existingMsg.metadata?.isStreaming) {
          // Mark the old message as final without changing content
          // This preserves whatever content was already in the store
          this.store.updateMessage(sessionId, turn.assistantMessageId, {
            metadata: { isStreaming: false, isFinal: true },
          });
          if (existingMsg.content) {
            this.emit('messageUpdate', sessionId, turn.assistantMessageId, existingMsg.content);
          }
        }
      }

      // Finalize any pending thinking message
      if (turn.currentThinkingMessageId) {
        this.finalizeThinkingMessage(
          sessionId,
          turn.currentThinkingMessageId,
          turn.currentThinkingContent,
        );
      }

      // Reset text tracking state for new run
      turn.agentAssistantTextLength = 0;
      turn.committedAssistantText = '';
      turn.currentAssistantSegmentText = '';
      turn.currentText = '';
      turn.currentThinkingMessageId = null;
      turn.currentThinkingContent = '';
      turn.thinkingStreamEnded = false;
      turn.assistantMessageId = null;
    }

    turn.knownRunIds.add(normalizedRunId);
    this.sessionIdByRunId.set(normalizedRunId, sessionId);
    this.flushPendingAgentEvents(sessionId, normalizedRunId);
  }

  private resolveTurn(sessionId: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.resolve();
  }

  private rejectTurn(sessionId: string, error: Error): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) return;
    this.pendingTurns.delete(sessionId);
    pending.reject(error);
  }

  private toSessionKey(sessionId: string, agentId?: string): string {
    return buildManagedSessionKey(sessionId, agentId);
  }

  private requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }

  /**
   * Return the current gateway client instance, or null if not yet connected.
   * Used by CronJobService to call cron.* APIs on the same gateway.
   */
  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  getSessionKeysForSession(sessionId: string): string[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const keys: string[] = [];
    for (const [key, mappedSessionId] of this.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === normalizedSessionId) {
        keys.push(key);
      }
    }

    const session = this.store.getSession(normalizedSessionId);
    const managedKey = this.toSessionKey(normalizedSessionId, session?.agentId);
    if (!keys.includes(managedKey)) {
      keys.push(managedKey);
    }

    keys.sort((left, right) => {
      const leftManaged = isManagedSessionKey(left);
      const rightManaged = isManagedSessionKey(right);
      if (leftManaged !== rightManaged) {
        return leftManaged ? 1 : -1;
      }
      return left.localeCompare(right);
    });

    return keys;
  }

  /**
   * Ensure the gateway client is connected and ready.
   * Resolves when the WebSocket connection is established and authenticated.
   */
  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  /**
   * 持久化子 Agent 状态到 tool_use message 的 metadata
   * 用于重启后恢复状态
   */
  private persistSubagentStatus(toolCallId: string, status: 'running' | 'done'): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.toolCallIdToParentSessionId.get(toolCallId) || this.orchestrationParentSessionId;
    if (!parentSessionId) return;
    const session = this.store.getSession(parentSessionId);
    if (!session?.messages) return;

    // Find the tool_use message with matching toolUseId
    for (const msg of session.messages) {
      if (
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId
      ) {
        // Update metadata with subagentStatus
        const updatedMetadata = {
          ...msg.metadata,
          subagentStatus: status,
        };
        this.store.updateMessage(parentSessionId, msg.id, {
          metadata: updatedMetadata as CoworkMessageMetadata,
        });
        break;
      }
    }
  }

  /**
   * Check if all tracked subagents for each orchestration session are 'done'.
   * Only updates session status to 'completed' when BOTH:
   * 1. All subagents are done
   * 2. The main agent itself has no pending output (no active turn / not streaming)
   * This prevents premature completion when the main agent is still processing
   * subagent results or producing follow-up output.
   */
  private checkAllSubagentsDone(): void {
    // Check ALL tracked orchestration sessions (not just the most recent one)
    for (const sessionId of this.orchestrationSessionIds) {
      this.checkSessionSubagentsDone(sessionId);
    }
    // Also check the legacy single-value for backward compat
    if (
      this.orchestrationParentSessionId &&
      !this.orchestrationSessionIds.has(this.orchestrationParentSessionId)
    ) {
      this.checkSessionSubagentsDone(this.orchestrationParentSessionId);
    }
  }

  private checkSessionSubagentsDone(sessionId: string): void {
    // Check in-memory subagentStatus Map - this is the authoritative source
    const hasAnyNonDone = Array.from(this.subagentStatus.entries()).some(([toolCallId, status]) => {
      const parentSessionId = this.toolCallIdToParentSessionId.get(toolCallId);
      // Only count subagents belonging to this orchestration session
      if (parentSessionId !== sessionId) return false;
      return status !== 'done';
    });

    if (!hasAnyNonDone) {
      // Verify there's at least one subagent tracked
      const hasAnySubagent = Array.from(this.subagentStatus.keys()).some(
        toolCallId => this.toolCallIdToParentSessionId.get(toolCallId) === sessionId,
      );

      if (hasAnySubagent) {
        // Also check that the main agent itself has no pending output.
        // If the main agent lifecycle has ended (phase=end), we trust that
        // it's done even if activeTurns hasn't been cleaned up yet (e.g., when
        // the last chat event came from a different runId and returned early).
        const mainAgentActive = this.activeTurns.has(sessionId);
        if (mainAgentActive && !this.mainAgentLifecycleEnded) {
          console.log(
            '[OpenClawRuntime] checkAllSubagentsDone: all subagents done but main agent still active, deferring completion: sessionId=' +
              sessionId,
          );
          return;
        }

        // When lifecycle ended but activeTurns wasn't cleaned up (e.g., announce
        // follow-up runs that skip handleChatFinal), clean it up now to prevent
        // "Session is still running" errors on next user message.
        if (mainAgentActive && this.mainAgentLifecycleEnded) {
          console.log(
            '[OpenClawRuntime] checkAllSubagentsDone: cleaning up stale activeTurns for completed session: sessionId=' +
              sessionId,
          );
          this.cleanupSessionTurn(sessionId);
        }

        console.log(
          '[OpenClawRuntime] checkAllSubagentsDone: all subagents completed and main agent idle, updating session status to completed: sessionId=' +
            sessionId,
        );
        this.store.updateSession(sessionId, {
          status: 'completed',
        });
        this.emit('complete', sessionId, null, 'completed');
      }
    }
  }

  /**
   * Persist a nested subagent spawn event to the parent session.
   * When a subagent spawns another subagent (nested), the sessions_spawn
   * tool_use message lives in the subagent session, not the parent.
   * This method creates a synthetic entry in the parent session's messages
   * so that getSubagentStatuses can discover it after restart.
   */
  private persistNestedSubagentSpawn(toolCallId: string, label: string, sessionKey: string): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.toolCallIdToParentSessionId.get(toolCallId) ||
      this.findParentSessionIdForNested(toolCallId, sessionKey);
    if (!parentSessionId) return;
    const session = this.store.getSession(parentSessionId);
    if (!session?.messages) return;

    // Check if already persisted (prevent duplicates)
    const alreadyExists = session.messages.some(
      msg =>
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId,
    );
    if (alreadyExists) return;

    console.log(
      '[OpenClawRuntime] persistNestedSubagentSpawn: toolCallId=' +
        toolCallId +
        ' label=' +
        label +
        ' parentSessionId=' +
        parentSessionId +
        ' sessionKey=' +
        sessionKey,
    );

    // Create a synthetic tool_use message in the parent session
    // Note: addMessage generates its own id and timestamp, so we omit those
    this.store.addMessage(parentSessionId, {
      type: 'tool_use',
      content: '',
      metadata: {
        toolName: 'sessions_spawn',
        toolUseId: toolCallId,
        label,
        sessionKey,
        subagentStatus: 'running',
        isNestedSpawn: true,
        toolInput: { label, toolCallId },
      },
    });
  }

  /**
   * Update the label in a synthetic nested spawn message.
   * Called when queryNestedSubagentLabel resolves a label after the initial
   * synthetic message was created with a UUID placeholder.
   */
  private updateNestedSpawnLabel(toolCallId: string, label: string): void {
    // Use per-session mapping instead of global to avoid cross-session contamination
    const parentSessionId =
      this.toolCallIdToParentSessionId.get(toolCallId) || this.orchestrationParentSessionId;
    if (!parentSessionId) return;
    const session = this.store.getSession(parentSessionId);
    if (!session?.messages) return;

    const targetMsg = session.messages.find(
      msg =>
        msg.type === 'tool_use' &&
        msg.metadata?.toolName === 'sessions_spawn' &&
        msg.metadata?.toolUseId === toolCallId,
    );
    if (!targetMsg) return;

    console.log(
      '[OpenClawRuntime] updateNestedSpawnLabel: toolCallId=' + toolCallId + ' newLabel=' + label,
    );

    const updated = {
      ...targetMsg.metadata,
      label,
      toolInput: { ...targetMsg.metadata?.toolInput, label },
    };
    this.store.updateMessage(parentSessionId, targetMsg.id, {
      metadata: updated,
    });
  }

  /**
   * 获取子 Agent 状态
   * @param sessionId 可选，指定父会话 ID 进行过滤
   * 状态来源：
   * 1. tool_use message metadata 中的 subagentStatus（持久化状态，重启后恢复）
   * 2. 内存中的 subagentStatus（实时状态，覆盖持久化状态）
   * 3. CoworkStore 消息中的 sessions_spawn/sessions_resume/sessions_read（默认 running）
   */
  getSubagentStatuses(sessionId?: string): {
    statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
    displayLabels: Record<string, string>;
  } {
    console.log(
      '[OpenClawRuntime] getSubagentStatuses called: sessionId=' +
        (sessionId || '(none)') +
        ' orchestrationParentSessionId=' +
        (this.orchestrationParentSessionId || '(none)') +
        ' subagentStatus.size=' +
        this.subagentStatus.size +
        ' pendingToolCallIds.size=' +
        this.pendingToolCallIds.size,
    );

    const statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'> = {};
    const displayLabels: Record<string, string> = {};
    const toolUseIdToLabel = new Map<string, string>();

    // 从 CoworkStore 消息中提取子任务（使用 toolUseId 作为唯一 key）
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (session?.messages) {
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: session.messages.length=' +
            session.messages.length,
        );

        // First pass: find all sessions_spawn tool_use messages
        for (const msg of session.messages) {
          const meta = msg.metadata;
          if (!meta) continue;

          if (msg.type === 'tool_use' && meta.toolName === 'sessions_spawn') {
            const input = meta.toolInput as Record<string, unknown> | undefined;
            const toolUseId = meta.toolUseId || '';
            const label = typeof input?.label === 'string' && input.label ? input.label : '';
            const agentId =
              typeof input?.agentId === 'string' && input.agentId ? input.agentId : '';
            const task = typeof input?.task === 'string' ? input.task : '';
            // Use toolUseId as unique key (label may duplicate)
            const key = toolUseId;
            // Display label: prefer label, then agentId, then task slice
            const display = label || agentId || (task ? task.slice(0, 30) : toolUseId);
            console.debug(
              '[OpenClawRuntime] getSubagentStatuses: sessions_spawn toolUseId=' +
                toolUseId +
                ' label=' +
                label +
                ' display=' +
                display,
            );
            if (key) {
              // Check for persisted status in metadata (from previous session)
              // This allows status recovery after restart
              const persistedStatus = meta.subagentStatus as 'running' | 'done' | undefined;
              if (persistedStatus === 'running' || persistedStatus === 'done') {
                statuses[key] = persistedStatus;
              } else {
                // Default to running if no persisted status
                statuses[key] = 'running';
              }
              displayLabels[key] = display;
              if (label) {
                toolUseIdToLabel.set(key, label);
              }
            }
          }
        }

        // NOTE: We do NOT use tool_result to determine subagent completion status.
        // tool_result for sessions_spawn only indicates that the spawn call succeeded
        // (the subagent was successfully started), NOT that the subagent has finished running.
        // The actual subagent completion is tracked via lifecycle events (agent.stopped/agent.completed)
        // which update the subagentStatus Map.

        // Override statuses from in-memory subagentStatus Map (real-time lifecycle events)
        // subagentStatus uses toolCallId as key and is the authoritative source for subagent status.
        // Lifecycle events (agent.started -> 'running', agent.stopped/agent.completed -> 'done')
        // are the only reliable indicators of actual subagent state.

        // Helper: find lifecycle status for a message key, handling key format mismatches.
        // The sessions_spawn message uses toolUseId (e.g. 'call_xxx') as key, while
        // lifecycle events may use a different key (e.g. raw UUID). We need to bridge
        // between these formats.
        const findLifecycleStatus = (
          msgKey: string,
        ): 'pending' | 'running' | 'done' | 'failed' | null => {
          // Direct match first
          const direct = this.subagentStatus.get(msgKey);
          if (direct) return direct;

          // Extract UUID-like portion from msgKey for cross-format matching
          const uuidMatch = msgKey.match(
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
          );
          if (!uuidMatch) return null;
          const uuid = uuidMatch[1];

          // Check if any subagentStatus key matches this UUID
          for (const [sk, sv] of this.subagentStatus) {
            if (sk === uuid || sk.includes(uuid)) return sv;
          }

          // Check sessionKey mapping: does any subagentStatus key map to the same sessionKey?
          const msgSessionKey = this.toolCallIdToSessionKey.get(msgKey);
          if (msgSessionKey) {
            const viaSessionKey = this.sessionKeyToToolCallId.get(msgSessionKey);
            if (viaSessionKey && viaSessionKey !== msgKey) {
              const viaStatus = this.subagentStatus.get(viaSessionKey);
              if (viaStatus) return viaStatus;
            }
          }

          // DEBUG: log why lookup failed
          console.debug(
            '[OpenClawRuntime] findLifecycleStatus: NO MATCH for msgKey=' +
              msgKey +
              ' uuid=' +
              (uuid || '(none)') +
              ' msgSessionKey=' +
              (msgSessionKey || '(none)') +
              ' mapKeys=' +
              Array.from(this.subagentStatus.keys()).join(','),
          );

          return null;
        };

        for (const toolCallId of Object.keys(statuses)) {
          const memoryStatus = findLifecycleStatus(toolCallId);
          if (memoryStatus) {
            // Memory status from lifecycle events is authoritative
            statuses[toolCallId] = memoryStatus;
          }
        }

        // Also check pendingToolCallIds and direct toolCallId keys in subagentStatus
        // But only include those that belong to THIS session (prevent cross-session leakage)
        // DEBUG: Log all toolCallId mappings for debugging
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: checking subagentStatus Map, size=' +
            this.subagentStatus.size +
            ' sessionId=' +
            sessionId,
        );
        const currentSessionKey = sessionId ? `agent:main:gucciai:${sessionId}` : null;
        for (const [key, status] of this.subagentStatus) {
          if (!statuses[key] && (key.startsWith('call_') || key.includes('-'))) {
            // Check if this toolCallId belongs to the current session
            const toolCallSessionKey = this.toolCallIdToSessionKey.get(key);
            const parentSessionId = this.toolCallIdToParentSessionId.get(key);
            console.debug(
              '[OpenClawRuntime] getSubagentStatuses: toolCallId=' +
                key +
                ' status=' +
                status +
                ' toolCallSessionKey=' +
                (toolCallSessionKey || '(none)') +
                ' parentSessionId=' +
                (parentSessionId || '(none)') +
                ' currentSessionKey=' +
                (currentSessionKey || '(none)'),
            );
            // Verify session ownership using either toolCallSessionKey or parentSessionId
            // toolCallSessionKey may point to parent session temporarily, so also use parentSessionId
            const belongsToCurrentSession =
              (toolCallSessionKey &&
                (toolCallSessionKey.startsWith(currentSessionKey) ||
                  toolCallSessionKey.includes(sessionId))) ||
              (parentSessionId && parentSessionId === sessionId);
            if (currentSessionKey && !belongsToCurrentSession) {
              console.debug(
                '[OpenClawRuntime] getSubagentStatuses: SKIP toolCallId=' +
                  key +
                  ' (session mismatch: toolCallSessionKey=' +
                  (toolCallSessionKey || '(none)') +
                  ' parentSessionId=' +
                  (parentSessionId || '(none)') +
                  ' != sessionId=' +
                  sessionId,
              );
              continue;
            }
            console.debug(
              '[OpenClawRuntime] getSubagentStatuses: INCLUDE toolCallId=' +
                key +
                ' status=' +
                status,
            );
            statuses[key] = status;
            const spawnInfo = this.toolCallArgs.get(key);
            const display =
              this.toolCallIdToLabel.get(key) ||
              this.subagentUuidToLabel.get(key) ||
              (spawnInfo && typeof spawnInfo.task === 'string'
                ? spawnInfo.task.slice(0, 30)
                : '') ||
              key;
            displayLabels[key] = display;
          }
        }

        // NOTE: We no longer use session.completed as a fallback to mark subagents as 'done'.
        // The subagentStatus Map (real-time lifecycle events) and tool_result messages
        // are the authoritative sources for subagent completion status.
        // Removing this fallback prevents marking newly started subagents as 'done'
        // when the session status might be stale or from a previous run.
      }
    }

    // Keep failed subagents in the list with 'failed' status instead of removing them
    for (const failedId of this.failedSubagentIds) {
      if (statuses[failedId]) {
        statuses[failedId] = 'failed';
      }
    }

    // Check for stuck pending subagents: if a subagent has been in pending state
    // for too long without any lifecycle events, mark it as silently failed
    // (spawn returned ok but no session was actually created)
    // IMPORTANT: We check the actual subagentStatus first. If a lifecycle event
    // has already updated the status to 'running', skip even if still in
    // pendingToolCallIds (the lifecycle handler may not have cleaned up the
    // pending set yet, or events arrived out of order).
    const now = Date.now();
    for (const pendingId of this.pendingToolCallIds) {
      const currentStatus = this.subagentStatus.get(pendingId);
      // Skip if lifecycle already promoted to running/done
      if (currentStatus === 'running' || currentStatus === 'done') continue;

      const entryTime = this.pendingEntryTimestamps.get(pendingId);
      if (entryTime && now - entryTime > OpenClawRuntimeAdapter.PENDING_TIMEOUT_MS) {
        // Only mark as failed if it belongs to current session
        if (sessionId) {
          const parentSessionId = this.toolCallIdToParentSessionId.get(pendingId);
          if (parentSessionId && parentSessionId !== sessionId) continue;
        }
        console.log(
          '[OpenClawRuntime] getSubagentStatuses: pending subagent timed out after ' +
            Math.round((now - entryTime) / 1000) +
            's, marking as failed: toolCallId=' +
            pendingId,
        );
        this.failedSubagentIds.add(pendingId);
        this.subagentStatus.set(pendingId, 'failed');
        this.pendingEntryTimestamps.delete(pendingId);
      }
    }
    // Clean up expired entries from failedSubagentIds
    for (const failedId of this.failedSubagentIds) {
      this.pendingToolCallIds.delete(failedId);
      this.pendingEntryTimestamps.delete(failedId);
      this.subagentLastActivity.delete(failedId);
    }

    // NOTE: We no longer use an idle timeout to mark subagents as failed.
    // Subagent completion is determined exclusively by lifecycle events
    // (phase=end/completed/stopped/error). Tasks can legitimately run for
    // 1+ hours, and idle-based heuristics cause false positives when gateway
    // event delivery is intermittent. The subagentLastActivity map is still
    // maintained in the lifecycle handler in case this needs to be revisited.

    // Orphan detection: ensure all toolCallIds belonging to this session are represented
    // This bridges the gap between path A (CoworkStore messages) and path B (subagentStatus Map)
    if (sessionId) {
      for (const [toolCallId, parentSessionId] of this.toolCallIdToParentSessionId) {
        if (parentSessionId !== sessionId) continue;
        if (statuses[toolCallId]) continue;
        if (this.failedSubagentIds.has(toolCallId)) {
          statuses[toolCallId] = 'failed';
          const spawnInfo = this.toolCallArgs.get(toolCallId);
          displayLabels[toolCallId] =
            this.toolCallIdToLabel.get(toolCallId) ||
            (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '') ||
            toolCallId;
          continue;
        }
        const memoryStatus = this.subagentStatus.get(toolCallId);
        if (memoryStatus) {
          statuses[toolCallId] = memoryStatus;
        } else {
          statuses[toolCallId] = 'pending';
        }
        const spawnInfo = this.toolCallArgs.get(toolCallId);
        displayLabels[toolCallId] =
          this.toolCallIdToLabel.get(toolCallId) ||
          (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '') ||
          toolCallId;
        console.debug(
          '[OpenClawRuntime] getSubagentStatuses: orphan recovery toolCallId=' +
            toolCallId +
            ' status=' +
            statuses[toolCallId] +
            ' label=' +
            displayLabels[toolCallId],
        );
      }

      // Detect item-level spawns that are stuck as 'running' with no tool_result message.
      // These are spawns from announce runs that the gateway prunes as orphans.
      // Without a lifecycle end event, they stay 'running' indefinitely.
      const orphanIdleThreshold = Date.now() - 60 * 1000; // 60 seconds without activity

      // Build a Set of toolUseIds that have tool_result messages in this session
      const toolResultToolUseIds = new Set<string>();
      const sess = this.store.getSession(sessionId);
      if (sess?.messages) {
        for (const msg of sess.messages) {
          if (msg.type === 'tool_result' && msg.metadata?.toolUseId) {
            toolResultToolUseIds.add(msg.metadata.toolUseId as string);
          }
        }
      }

      for (const itemToolCallId of this.itemLevelSpawnedToolCallIds) {
        if (!statuses[itemToolCallId]) continue; // not yet in this session's statuses
        if (statuses[itemToolCallId] === 'done' || statuses[itemToolCallId] === 'failed') continue;

        // Check if a tool_result message was ever created
        const hasToolResult = toolResultToolUseIds.has(itemToolCallId);
        const hasLifecycleEnd = (() => {
          const status = this.subagentStatus.get(itemToolCallId);
          return status === 'done' || status === 'failed';
        })();

        const lastActivity = this.subagentLastActivity.get(itemToolCallId) || 0;
        const isStuck = !hasToolResult && !hasLifecycleEnd && lastActivity < orphanIdleThreshold;

        if (isStuck) {
          console.log(
            '[OpenClawRuntime] getSubagentStatuses: marking item-level orphan as failed toolCallId=' +
              itemToolCallId +
              ' label=' +
              (this.toolCallIdToLabel.get(itemToolCallId) || '(unknown)') +
              ' reason=no tool_result, no lifecycle end, last activity=' +
              (lastActivity > 0
                ? Math.round((Date.now() - lastActivity) / 1000) + 's ago'
                : 'never'),
          );
          statuses[itemToolCallId] = 'failed';
          this.subagentStatus.set(itemToolCallId, 'failed');
          this.failedSubagentIds.add(itemToolCallId);
        }
      }
    }

    // Add pending subagents (in pendingToolCallIds but not yet mapped to sessionKey)
    // These are subagents that have been spawned but are waiting for execution
    for (const pendingId of this.pendingToolCallIds) {
      // Skip if already in statuses (has been mapped or has lifecycle events)
      if (statuses[pendingId]) continue;
      // Skip if failed
      if (this.failedSubagentIds.has(pendingId)) continue;
      // Check if belongs to current session
      if (sessionId) {
        const parentSessionId = this.toolCallIdToParentSessionId.get(pendingId);
        if (parentSessionId && parentSessionId !== sessionId) continue;
      }
      // Mark as pending (queued, waiting for execution)
      statuses[pendingId] = 'pending';
      // Get display label
      const spawnInfo = this.toolCallArgs.get(pendingId);
      const label =
        this.toolCallIdToLabel.get(pendingId) ||
        this.subagentUuidToLabel.get(pendingId) ||
        (spawnInfo && typeof spawnInfo.task === 'string' ? spawnInfo.task.slice(0, 30) : '');
      displayLabels[pendingId] = label || pendingId;
      console.debug(
        '[OpenClawRuntime] getSubagentStatuses: pending subagent toolCallId=' +
          pendingId +
          ' label=' +
          (label || '(none)'),
      );
    }

    // Build status detail for debug logging (show what each key resolves to)
    const statusDetail = Object.entries(statuses)
      .map(([k, v]) => k + '=' + v)
      .join(', ');
    const mapDetail = Array.from(this.subagentStatus.entries())
      .map(([k, v]) => k + '=' + v)
      .join(', ');
    console.log(
      '[OpenClawRuntime] getSubagentStatuses: returning count=' +
        Object.keys(statuses).length +
        ' failedSubagentIds=' +
        Array.from(this.failedSubagentIds).join(',') +
        ' pendingToolCallIds=' +
        Array.from(this.pendingToolCallIds).join(',') +
        ' keys=' +
        Object.keys(statuses).join(',') +
        ' statusValues={' +
        statusDetail +
        '} subagentStatusMap={' +
        mapDetail +
        '}',
    );
    return { statuses, displayLabels };
  }

  /**
   * Find the correct parent GUI session ID for a nested subagent.
   * Searches per-session mappings instead of using the global orchestrationParentSessionId,
   * which can be contaminated by concurrent sessions.
   */
  private findParentSessionIdForNested(emitAgentId: string, sessionKey?: string): string | null {
    // Try 1: Check if any top-level subagent's sessionKey contains this nested subagent
    // Nested subagents are children of top-level subagents, so their parent GUI session
    // is the same as the spawning subagent's parent.
    for (const [tcId, parentSessId] of this.toolCallIdToParentSessionId) {
      const childKey = this.toolCallIdToSessionKey.get(tcId);
      if (childKey && childKey.includes(':subagent:')) {
        // This is a top-level subagent — check if the nested subagent's sessionKey
        // shares the same parent context
        if (sessionKey && childKey && sessionKey.includes(childKey.split(':subagent:')[0])) {
          return parentSessId;
        }
      }
    }

    // Try 2: Check if the sessionKey itself encodes a gucciai parent
    if (sessionKey) {
      const gucciaiMatch = sessionKey.match(/^agent:main:gucciai:([^:]+)/);
      if (gucciaiMatch) {
        return gucciaiMatch[1];
      }
    }

    // Try 3: Check if any running subagent's sessionKey matches our nested subagent's context
    for (const [sk, tcId] of this.sessionKeyToToolCallId) {
      if (sk.includes(':subagent:') && sk.includes(emitAgentId)) {
        const parentId = this.toolCallIdToParentSessionId.get(tcId);
        if (parentId) return parentId;
      }
    }

    // Fallback: use global (only if no per-session info found)
    return this.orchestrationParentSessionId;
  }

  /**
   * Query sessions.list to find subagent sessionKey and establish mapping.
   * Called when gateway tool event doesn't contain childSessionKey directly.
   * NOTE: Only use label for matching, no fallback to avoid mapping confusion.
   */
  private async querySubagentSessionKey(
    label: string,
    parentSessionKey: string,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const sessionsResult = await this.gatewayClient.request<{
        sessions?: Array<{ key: string; label?: string; spawnedBy?: string; spawnedAt?: number }>;
      }>('sessions.list', {
        spawnedBy: parentSessionKey,
        limit: 20,
      });

      const childSessions = sessionsResult?.sessions;
      if (Array.isArray(childSessions) && childSessions.length > 0) {
        console.log(
          '[OpenClawRuntime] querySubagentSessionKey: found ' +
            childSessions.length +
            ' child sessions for parentSessionKey=' +
            parentSessionKey,
          'childSessionKeys:',
          childSessions.map(cs => cs.key),
          'childLabels:',
          childSessions.map(cs => cs.label || '(no label)'),
        );

        // Find the matching child session by label ONLY - no fallback to avoid confusion
        const matchingChild = childSessions.find(
          cs => cs.label === label || cs.key.includes(label),
        );

        if (matchingChild && matchingChild.key) {
          const childSessionKey = matchingChild.key;
          console.log(
            '[OpenClawRuntime] querySubagentSessionKey: found mapping label=' +
              label +
              ' childSessionKey=' +
              childSessionKey +
              ' toolCallId=' +
              (toolCallId || '(none)'),
          );
          this.sessionKeyToLabel.set(childSessionKey, label);
          // Also extract UUID and store for lifecycle event lookup
          const uuidMatch = childSessionKey.match(/subagent[:\-]([a-f0-9-]{36})$/i);
          if (uuidMatch && uuidMatch[1]) {
            this.subagentUuidToLabel.set(uuidMatch[1], label);
          }
          // Also establish toolCallId mappings if toolCallId is provided
          if (toolCallId) {
            this.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
            this.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
            this.toolCallIdToLabel.set(toolCallId, label);
          }
          // Set status to running since we found it
          // IMPORTANT: Only use toolCallId as key, NOT label!
          // label is for display only, toolCallId is the unique identifier
          if (toolCallId) {
            // Never overwrite 'done' — a completed subagent stays completed
            const existingStatus = this.subagentStatus.get(toolCallId);
            if (existingStatus !== 'done') {
              this.subagentStatus.set(toolCallId, 'running');
            }
          }
        } else {
          console.log(
            '[OpenClawRuntime] querySubagentSessionKey: no matching child session found',
            'label=' + label,
            'toolCallId=' + (toolCallId || '(none)'),
          );
          // No matching child session found at this moment
          // This could be a timing issue - the child session may not have been created yet
          // DO NOT mark as failed immediately - keep in pendingToolCallIds
          // Lifecycle events will eventually establish the mapping or confirm failure
          // If lifecycle events never arrive, the subagent will remain 'pending' in status
          if (toolCallId) {
            console.log(
              '[OpenClawRuntime] querySubagentSessionKey: keeping toolCallId=' +
                toolCallId +
                ' in pendingToolCallIds, waiting for lifecycle events',
            );
            // Keep toolCallId in pendingToolCallIds - will be resolved by lifecycle events
            // or shown as 'pending' in UI if lifecycle events never arrive
          }
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] querySubagentSessionKey failed:', err);
    }
  }

  /**
   * Sync with gateway history to resolve a possible truncated NO_REPLY marker
   * in a subagent's assistant stream. Queries chat.history, checks if the final
   * text is "NO_REPLY", and only creates a message if there's real content.
   */
  private async syncSubagentNoReply(
    storageKey: string,
    emitAgentId: string,
    sessionKey: string,
    msgs: Array<{ role: string; content: string }>,
    partialText: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
        sessionKey,
        limit: 10,
      });

      const historyMessages = history?.messages;
      if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
        return;
      }

      // Find the last assistant message from history
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        if (!isRecord(msg)) continue;
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
        if (role !== 'assistant') continue;

        const text = extractMessageText(msg).trim();
        if (!text) continue;

        // Check if this is a NO_REPLY marker
        if (/^NO_REPLY$/i.test(text)) {
          console.log(
            '[OpenClawRuntime] syncSubagentNoReply: confirmed NO_REPLY for agentId=' +
              emitAgentId +
              ', skipping',
          );
          return;
        }

        // Real content found - create the message
        console.log(
          '[OpenClawRuntime] syncSubagentNoReply: found real content for agentId=' +
            emitAgentId +
            ', text="' +
            text.slice(0, 100) +
            '"',
        );
        const newMsg = { role: 'assistant', content: text };
        msgs.push(newMsg);
        const syncParentSessionId = this.resolveSubagentParentSessionId(emitAgentId);
        if (syncParentSessionId) {
          this.emit('subagentMessage', syncParentSessionId, emitAgentId, {
            id: `subagent-assistant-synced-${Date.now()}`,
            type: 'assistant',
            content: text,
            timestamp: Date.now(),
          });
        }
        return;
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] syncSubagentNoReply failed:', err);
    }
  }

  /**
   * Sleep helper for retry delays.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Record subagent activity to reset the idle timeout.
   * Should be called whenever we see any event from a running subagent.
   */
  private touchSubagentActivity(toolCallId: string): void {
    this.subagentLastActivity.set(toolCallId, Date.now());
  }

  /**
   * Retry wrapper for querying subagent chat.history.
   * Retries up to `retries` times with `delayMs` between attempts.
   * Returns the last result even if all attempts yield empty messages.
   */
  private async querySubagentHistoryWithRetry(
    sessionKey: string,
    retries: number,
    delayMs: number,
  ): Promise<{ messages?: unknown[] }> {
    if (!this.gatewayClient) return {};

    let result: { messages?: unknown[] } = {};
    for (let i = 0; i <= retries; i++) {
      try {
        result = await this.gatewayClient.request('chat.history', {
          sessionKey,
          limit: 10,
        });
        const msgs = result?.messages;
        if (Array.isArray(msgs) && msgs.length > 0) {
          return result;
        }
      } catch {
        // Transient error — retry again
      }
      if (i < retries) {
        await this.sleep(delayMs);
      }
    }
    return result;
  }

  /**
   * Query subagent chat.history to resolve a possible truncated NO_REPLY marker
   * in a different-runId final event. Retries once to handle slow history flush.
   * Only adds a message to the parent session if history confirms real content
   * (not NO_REPLY). Falls back to showing partialText as-is if history remains
   * empty after retry — better to show "NO" than to lose real content.
   */
  private async syncFinalNoReplyWithHistory(
    parentSessionId: string,
    subagentSessionKey: string,
    partialText: string,
    modelName?: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const history = await this.querySubagentHistoryWithRetry(
        subagentSessionKey,
        1, // one retry
        1000, // 1s between attempts
      );

      const historyMessages = history?.messages;
      if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
        // History still empty after retry — fall back to showing text as-is.
        // This avoids losing legitimate short replies like "NO" when the
        // model response hasn't flushed yet.
        // But if subagent streaming already captured content, skip to avoid duplicate.
        const storageKey = subagentSessionKey;
        const msgs = this.subagentMessages.get(storageKey);
        const streamedAssistant = msgs?.filter(m => m.role === 'assistant').pop();
        if (
          streamedAssistant &&
          streamedAssistant.content &&
          streamedAssistant.content.length > 0
        ) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: history empty but subagent already has streamed content for sessionKey=' +
              subagentSessionKey +
              ', skipping (avoids duplicate)',
          );
          return;
        }
        console.log(
          '[OpenClawRuntime] syncFinalNoReplyWithHistory: history empty after retry for sessionKey=' +
            subagentSessionKey +
            ', showing text as-is',
        );
        const assistantMessage = this.store.addMessage(parentSessionId, {
          type: 'assistant',
          content: partialText,
          metadata: { isStreaming: false, isFinal: true },
          modelName,
        });
        this.emit('message', parentSessionId, assistantMessage);
        return;
      }

      // Find the last assistant message from history
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        if (!isRecord(msg)) continue;
        const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';
        if (role !== 'assistant') continue;

        const text = extractMessageText(msg).trim();
        if (!text) continue;

        // Check if this is a NO_REPLY marker
        if (/^NO_REPLY$/i.test(text)) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: confirmed NO_REPLY for sessionKey=' +
              subagentSessionKey +
              ', skipping',
          );
          return;
        }

        // Real content found - add to parent session ONLY if subagent streaming
        // did not already capture it. Otherwise we get duplicate display:
        // the subagent_completion message AND this regular assistant message.
        const storageKey = subagentSessionKey;
        const msgs = this.subagentMessages.get(storageKey);
        const streamedAssistant = msgs?.filter(m => m.role === 'assistant').pop();
        if (
          streamedAssistant &&
          streamedAssistant.content &&
          streamedAssistant.content.length > 0
        ) {
          console.log(
            '[OpenClawRuntime] syncFinalNoReplyWithHistory: subagent already has streamed content for sessionKey=' +
              subagentSessionKey +
              ', skipping (avoids duplicate)',
          );
          return;
        }

        console.log(
          '[OpenClawRuntime] syncFinalNoReplyWithHistory: found real content for sessionKey=' +
            subagentSessionKey +
            ', text="' +
            text.slice(0, 100) +
            '"',
        );
        const assistantMessage = this.store.addMessage(parentSessionId, {
          type: 'assistant',
          content: text,
          metadata: { isStreaming: false, isFinal: true },
          modelName,
        });
        this.emit('message', parentSessionId, assistantMessage);
        return;
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] syncFinalNoReplyWithHistory failed:', err);
    }
  }

  /**
   * Query sessions.list to find the label for a nested subagent identified by UUID.
   * Used when lifecycle START event fires before the tool event provides label info.
   */
  private async queryNestedSubagentLabel(
    subagentUuid: string,
    parentSessionKey: string,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.gatewayClient) return;

    try {
      const sessionsResult = await this.gatewayClient.request<{
        sessions?: Array<{ key: string; label?: string; spawnedBy?: string; spawnedAt?: number }>;
      }>('sessions.list', {
        spawnedBy: parentSessionKey,
        limit: 50,
      });

      const childSessions = sessionsResult?.sessions;
      if (Array.isArray(childSessions) && childSessions.length > 0) {
        // Find the child session whose key contains our UUID
        const matchingChild = childSessions.find(
          cs => cs.key.includes(subagentUuid) || cs.key.endsWith(subagentUuid),
        );

        if (matchingChild && matchingChild.label) {
          const label = matchingChild.label;
          console.log(
            '[OpenClawRuntime] queryNestedSubagentLabel: resolved UUID=' +
              subagentUuid +
              ' -> label=' +
              label,
          );
          this.subagentUuidToLabel.set(subagentUuid, label);
          // Also add UUID to successfulSpawnToolCallIds so the lifecycle
          // error handler can find it (lifecycle events use UUID as toolCallId).
          this.successfulSpawnToolCallIds.add(subagentUuid);
          if (toolCallId) {
            this.toolCallIdToLabel.set(toolCallId, label);
            // Also update the synthetic tool_use message label in the parent session
            this.updateNestedSpawnLabel(toolCallId, label);
          }
        }
      }
    } catch (err) {
      console.warn('[OpenClawRuntime] queryNestedSubagentLabel failed:', err);
    }
  }

  /**
   * Find toolCallId by childSessionKey from parent session's sessions_spawn results.
   * Used when mapping isn't established yet (race condition between subagent events and spawn result).
   */
  private findToolCallIdByChildSessionKey(childSessionKey: string): string | null {
    // Search across all orchestration sessions instead of using the global
    // to avoid cross-session contamination when multiple GUI sessions are concurrent
    for (const parentSessionId of this.orchestrationSessionIds) {
      const parentSession = this.store.getSession(parentSessionId);
      if (!parentSession?.messages) continue;

      // Find sessions_spawn tool_result messages that contain this childSessionKey
      for (const msg of parentSession.messages) {
        if (msg.type === 'tool_result' && msg.metadata?.toolName === 'sessions_spawn') {
          const toolUseId = msg.metadata?.toolUseId;
          const result = msg.metadata?.toolResult;
          if (
            toolUseId &&
            isRecord(result) &&
            (result.childSessionKey === childSessionKey ||
              result.sessionKey === childSessionKey ||
              result.key === childSessionKey)
          ) {
            // Found matching result - establish mapping and return
            this.toolCallIdToSessionKey.set(toolUseId, childSessionKey);
            this.sessionKeyToToolCallId.set(childSessionKey, toolUseId);
            return toolUseId;
          }
        }
      }
    }

    return null;
  }

  /**
   * Find childSessionKey by toolCallId from parent session's sessions_spawn results.
   * This is the preferred method when gateway tool event doesn't include childSessionKey.
   * Uses toolCallId as unique identifier instead of unreliable label matching.
   */
  private findChildSessionKeyByToolCallId(toolCallId: string): string | null {
    // Search across all orchestration sessions instead of using the global
    // to avoid cross-session contamination when multiple GUI sessions are concurrent
    for (const parentSessionId of this.orchestrationSessionIds) {
      const parentSession = this.store.getSession(parentSessionId);
      if (!parentSession?.messages) continue;

      // Find sessions_spawn tool_result messages that match this toolCallId
      for (const msg of parentSession.messages) {
        if (
          msg.type === 'tool_result' &&
          msg.metadata?.toolName === 'sessions_spawn' &&
          msg.metadata?.toolUseId === toolCallId
        ) {
          // Parse result to find childSessionKey
          const result = msg.metadata?.toolResult;
          if (isRecord(result)) {
            const childSessionKey =
              typeof result.childSessionKey === 'string'
                ? result.childSessionKey
                : typeof result.sessionKey === 'string'
                  ? result.sessionKey
                  : typeof result.key === 'string'
                    ? result.key
                    : null;
            if (childSessionKey) {
              // Found matching result - establish mapping and return
              this.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
              this.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
              console.log(
                '[OpenClawRuntime] findChildSessionKeyByToolCallId: found mapping toolCallId=' +
                  toolCallId +
                  ' childSessionKey=' +
                  childSessionKey,
              );
              return childSessionKey;
            }
          }
          // Also try parsing content as JSON (legacy format)
          if (typeof msg.content === 'string') {
            try {
              const parsed = JSON.parse(msg.content);
              const childSessionKey =
                typeof parsed.childSessionKey === 'string'
                  ? parsed.childSessionKey
                  : typeof parsed.sessionKey === 'string'
                    ? parsed.sessionKey
                    : null;
              if (childSessionKey) {
                this.toolCallIdToSessionKey.set(toolCallId, childSessionKey);
                this.sessionKeyToToolCallId.set(childSessionKey, toolCallId);
                console.log(
                  '[OpenClawRuntime] findChildSessionKeyByToolCallId: found mapping from content toolCallId=' +
                    toolCallId +
                    ' childSessionKey=' +
                    childSessionKey,
                );
                return childSessionKey;
              }
            } catch {
              // Content not JSON, ignore
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * 获取子 Agent 消息历史
   */
  async getSubTaskHistory(
    parentSessionId: string,
    agentId: string,
    sessionKey?: string,
  ): Promise<CoworkMessage[]> {
    // 确保 gateway client 已准备好（重启后可能未初始化）
    try {
      await this.ensureGatewayClientReady();
    } catch (error) {
      console.warn('[OpenClawRuntime] getSubTaskHistory: gateway client not ready:', error);
      return [];
    }

    // 先获取 in-memory 的 Subagent Context 消息（用于显示启动指令）
    // 查找所有可能的 in-memory 消息来源
    // 注意：toolCallIdToSessionKey 可能包含临时映射（指向主agent sessionKey），
    // 需要验证是否是真正的 subagent sessionKey（包含 ':subagent:'）
    const rawSessionKeyFromToolCallId = this.toolCallIdToSessionKey.get(agentId);
    const sessionKeyFromToolCallId = rawSessionKeyFromToolCallId?.includes(':subagent:')
      ? rawSessionKeyFromToolCallId
      : null;

    const directMessages = this.subagentMessages.get(agentId);
    const mappedMessages = sessionKeyFromToolCallId
      ? this.subagentMessages.get(sessionKeyFromToolCallId)
      : null;

    // 获取 Subagent Context 消息（第一条 user 消息，带有 isSubagentContext 标记）
    const subagentContextMsg = (() => {
      const candidates = [directMessages, mappedMessages];
      for (const msgs of candidates) {
        if (msgs && msgs.length > 0) {
          const contextMsg = msgs.find(m => m.role === 'user' && m.metadata?.isSubagentContext);
          if (contextMsg) return contextMsg;
        }
      }
      // Fallback: try uuidToToolCallId cross-reference for nested subagents.
      // Context messages are stored under call_... keys, but agentId may be UUID.
      const linkedToolCallId = this.uuidToToolCallId.get(agentId);
      if (linkedToolCallId) {
        const linkedMsgs = this.subagentMessages.get(linkedToolCallId);
        if (linkedMsgs && linkedMsgs.length > 0) {
          const contextMsg = linkedMsgs.find(
            m => m.role === 'user' && m.metadata?.isSubagentContext,
          );
          if (contextMsg) {
            console.log(
              '[OpenClawRuntime] getSubTaskHistory: found context via uuidToToolCallId agentId=' +
                agentId +
                ' -> toolCallId=' +
                linkedToolCallId,
            );
            return contextMsg;
          }
        }
      }
      return null;
    })();

    // Debug: log lookup state for subagent context
    const allMsgKeys = [...this.subagentMessages.keys()];
    console.log(
      '[OpenClawRuntime] getSubTaskHistory context lookup: agentId=' +
        agentId +
        ' directMessages=' +
        (directMessages ? directMessages.length : 'null') +
        ' mappedMessages=' +
        (mappedMessages ? mappedMessages.length : 'null') +
        ' sessionKeyFromToolCallId=' +
        (sessionKeyFromToolCallId || 'null') +
        ' allSubagentMessagesKeys=[' +
        allMsgKeys.join(', ') +
        ']',
    );
    if (subagentContextMsg) {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory subagentContextMsg found: content starts with "' +
          subagentContextMsg.content.slice(0, 50) +
          '"',
      );
    } else {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory NO subagentContextMsg found, will use markSubagentContextMessage fallback',
      );
    }

    // Strategy 1: If sessionKey is provided, use it directly
    if (sessionKey && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages)) {
          console.log(
            '[OpenClawRuntime] getSubTaskHistory raw messages sample:',
            history.messages
              .slice(0, 3)
              .map(m =>
                typeof m === 'object' && m
                  ? { role: (m as any).role, content_type: typeof (m as any).content }
                  : m,
              ),
          );
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory extracted entries:',
            entries.map(e => ({ role: e.role, textLen: e.text?.length, hasMeta: !!e.metadata })),
          );
          if (entries.length > 0) {
            let historyMessages = convertEntriesToCoworkMessages(entries);
            // Patch tool_use toolInput from assistant messages' toolCall blocks
            // Gateway tool events don't include args, but they exist in assistant content blocks
            this.patchToolInputFromHistoryRaw(historyMessages, history?.messages);
            // 如果有 Subagent Context 消息，将其添加到历史消息的最前面
            if (subagentContextMsg) {
              const contextContent = subagentContextMsg.content;
              console.log(
                '[OpenClawRuntime] getSubTaskHistory Strategy 1: prepending context msg, startsWith "' +
                  contextContent.slice(0, 50) +
                  '"',
              );
              // Skip the first user message from Gateway history (it's the duplicate Subagent Context without metadata)
              const firstUserIndex = historyMessages.findIndex(m => m.type === 'user');
              if (
                firstUserIndex !== -1 &&
                !historyMessages[firstUserIndex].metadata?.isSubagentContext
              ) {
                historyMessages.splice(firstUserIndex, 1);
              }
              // Add the in-memory Subagent Context message with correct metadata (blue background + 📋 label)
              const contextCoworkMsg: CoworkMessage = {
                id: `subagent-context-${Date.now()}`,
                type: 'user',
                content: contextContent,
                timestamp: Date.now() - 100,
                metadata: subagentContextMsg.metadata,
              };
              historyMessages.unshift(contextCoworkMsg);
            } else {
              // No in-memory context message (after restart): mark based on content prefix
              historyMessages = markSubagentContextMessage(historyMessages);
            }
            return historyMessages;
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: gateway query failed:', err);
      }
    }

    // Strategy 0: Check in-memory subagentMessages for Subagent Context
    // If we have Subagent Context, use Gateway history for complete messages
    const inMemoryMessages =
      (directMessages && directMessages.length > 0 ? directMessages : null) ||
      (mappedMessages && mappedMessages.length > 0 ? mappedMessages : null);

    // Find sessionKey to query Gateway history
    // Only use sessionKey that is a valid subagent sessionKey (contains ':subagent:')
    const rawToolCallIdSessionKey = this.toolCallIdToSessionKey.get(agentId);
    const validToolCallIdSessionKey = rawToolCallIdSessionKey?.includes(':subagent:')
      ? rawToolCallIdSessionKey
      : null;
    const effectiveSessionKey = sessionKey || sessionKeyFromToolCallId || validToolCallIdSessionKey;

    if (effectiveSessionKey && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: effectiveSessionKey,
          limit: 100,
        });
        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0: using Gateway history (' +
              history.messages.length +
              ' msgs) with Subagent Context',
          );
          // Debug: log raw messages structure to understand role format
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0 raw messages:',
            history.messages.slice(0, 5).map(m =>
              isRecord(m)
                ? {
                    role: (m as Record<string, unknown>).role,
                    hasContent: !!(m as Record<string, unknown>).content,
                    keys: Object.keys(m).slice(0, 5),
                  }
                : m,
            ),
          );
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory Strategy 0 entries:',
            entries.slice(0, 3).map(e => ({ role: e.role, textLen: e.text?.length })),
          );
          if (entries.length > 0) {
            let historyMessages = convertEntriesToCoworkMessages(entries);
            // Patch toolInput from assistant toolCall blocks
            this.patchToolInputFromHistoryRaw(historyMessages, history.messages);

            // Add Subagent Context message to the front if available
            if (subagentContextMsg) {
              const contextContent = subagentContextMsg.content;
              console.log(
                '[OpenClawRuntime] getSubTaskHistory Strategy 0: prepending context msg, startsWith "' +
                  contextContent.slice(0, 50) +
                  '"',
              );
              // Skip the first user message from Gateway history (it's the duplicate Subagent Context without metadata)
              const firstUserIndex = historyMessages.findIndex(m => m.type === 'user');
              if (
                firstUserIndex !== -1 &&
                !historyMessages[firstUserIndex].metadata?.isSubagentContext
              ) {
                historyMessages.splice(firstUserIndex, 1);
              }
              // Add the in-memory Subagent Context message with correct metadata (blue background + 📋 label)
              const contextCoworkMsg: CoworkMessage = {
                id: `subagent-context-${Date.now()}`,
                type: 'user',
                content: contextContent,
                timestamp: Date.now() - 100,
                metadata: subagentContextMsg.metadata,
              };
              historyMessages.unshift(contextCoworkMsg);
            } else {
              // No in-memory context message (after restart): mark based on content prefix
              historyMessages = markSubagentContextMessage(historyMessages);
            }
            return historyMessages;
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: Gateway history query failed:', err);
      }
    }

    // Fallback: return in-memory messages if Gateway history unavailable
    if (inMemoryMessages && inMemoryMessages.length > 0) {
      console.log(
        '[OpenClawRuntime] getSubTaskHistory: fallback to in-memory messages (' +
          inMemoryMessages.length +
          ' msgs)',
      );
      const coworkMsgs = convertToCoworkMessages(inMemoryMessages);
      return coworkMsgs;
    }

    // Strategy 1.5: Use toolCallId to find sessionKey (agentId is now toolCallId)
    // Only use valid subagent sessionKey (contains ':subagent:')
    const rawToolCallIdSessionKey15 = this.toolCallIdToSessionKey.get(agentId);
    const toolCallIdSessionKey = rawToolCallIdSessionKey15?.includes(':subagent:')
      ? rawToolCallIdSessionKey15
      : null;
    if (toolCallIdSessionKey && this.gatewayClient) {
      try {
        const history = await this.gatewayClient.request<{ messages?: unknown[] }>('chat.history', {
          sessionKey: toolCallIdSessionKey,
          limit: 100,
        });
        console.log(
          '[OpenClawRuntime] getSubTaskHistory strategy 1.5: sessionKey=' +
            toolCallIdSessionKey +
            ' messagesLen=' +
            (history?.messages?.length ?? 0),
        );
        if (Array.isArray(history?.messages) && history.messages.length > 0) {
          const entries = extractGatewayHistoryEntries(history.messages);
          console.log(
            '[OpenClawRuntime] getSubTaskHistory strategy 1.5 entries:',
            entries.map(e => ({ role: e.role, textLen: e.text?.length })),
          );
          if (entries.length > 0) {
            const msgs = convertEntriesToCoworkMessages(entries);
            this.patchToolInputFromHistoryRaw(msgs, history.messages);
            return markSubagentContextMessage(msgs);
          }
        }
      } catch (err) {
        console.warn(
          '[OpenClawRuntime] getSubTaskHistory: toolCallId sessionKey query failed:',
          err,
        );
      }
    }

    // Strategy 2: Find childSessionKey from CoworkStore tool_result for sessions_spawn
    const parentSession = this.store.getSession(parentSessionId);
    if (parentSession && this.gatewayClient) {
      // Find all tool_use messages for sessions_spawn
      const spawnToolUses = parentSession.messages.filter(
        m => m.type === 'tool_use' && m.metadata?.toolName === 'sessions_spawn',
      );

      for (const toolUse of spawnToolUses) {
        const toolInput = toolUse.metadata?.toolInput as Record<string, unknown> | undefined;
        const label = typeof toolInput?.label === 'string' ? toolInput.label : '';
        const inputAgentId = typeof toolInput?.agentId === 'string' ? toolInput.agentId : '';
        const toolUseId = toolUse.metadata?.toolUseId;

        // Check if this spawn matches our target agentId (now toolUseId)
        // agentId could be toolUseId, label, or inputAgentId
        if (toolUseId === agentId || label === agentId || inputAgentId === agentId) {
          // First try in-memory toolCallId mapping
          if (toolUseId && this.toolCallIdToSessionKey.has(toolUseId)) {
            const memSessionKey = this.toolCallIdToSessionKey.get(toolUseId);
            if (memSessionKey) {
              try {
                const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
                  'chat.history',
                  { sessionKey: memSessionKey, limit: 100 },
                );
                if (Array.isArray(history?.messages)) {
                  const extracted: Array<{
                    role: string;
                    content: string;
                    metadata?: Record<string, unknown>;
                  }> = [];
                  for (const entry of extractGatewayHistoryEntries(history.messages)) {
                    extracted.push({
                      role: entry.role,
                      content: entry.text,
                      metadata: entry.metadata,
                    });
                  }
                  if (extracted.length > 0) {
                    const msgs = convertToCoworkMessages(extracted);
                    this.patchToolInputFromHistoryRaw(msgs, history.messages);
                    return markSubagentContextMessage(msgs);
                  }
                }
              } catch {
                // Continue to next strategy
              }
            }
          }

          // Find the corresponding tool_result
          const effectiveToolUseId = toolUseId || agentId;
          const toolResult = parentSession.messages.find(
            m => m.type === 'tool_result' && m.metadata?.toolUseId === effectiveToolUseId,
          );

          if (toolResult?.content) {
            try {
              const parsed = JSON.parse(toolResult.content);
              const childSessionKey =
                typeof parsed.childSessionKey === 'string' ? parsed.childSessionKey : null;

              if (childSessionKey) {
                // Query gateway with the childSessionKey
                const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
                  'chat.history',
                  {
                    sessionKey: childSessionKey,
                    limit: 100,
                  },
                );

                if (Array.isArray(history?.messages)) {
                  const extracted: Array<{
                    role: string;
                    content: string;
                    metadata?: Record<string, unknown>;
                  }> = [];
                  for (const entry of extractGatewayHistoryEntries(history.messages)) {
                    extracted.push({
                      role: entry.role,
                      content: entry.text,
                      metadata: entry.metadata,
                    });
                  }
                  if (extracted.length > 0) {
                    const msgs = convertToCoworkMessages(extracted);
                    this.patchToolInputFromHistoryRaw(msgs, history.messages);
                    return markSubagentContextMessage(msgs);
                  }
                }
              }
            } catch {
              // tool_result parse failed, continue to next strategy
            }
          }
        }
      }
    }

    // Strategy 2.5: Use sessions.list API to get child sessions spawned by the parent
    if (parentSession && this.gatewayClient) {
      try {
        const parentSessionKey = this.toSessionKey(
          parentSessionId,
          parentSession.agentId || 'main',
        );

        const sessionsResult = await this.gatewayClient.request<{
          sessions?: Array<{ key: string; label?: string; spawnedBy?: string }>;
        }>('sessions.list', {
          spawnedBy: parentSessionKey,
          limit: 20,
        });

        const childSessions = sessionsResult?.sessions;
        if (Array.isArray(childSessions) && childSessions.length > 0) {
          // 建立所有子会话的 sessionKey → label 映射（用于显示）
          for (const cs of childSessions) {
            if (cs.key && cs.label) {
              this.sessionKeyToLabel.set(cs.key, cs.label);
            }
          }

          // Find the matching child session by label
          const matchingChild = childSessions.find(
            cs => cs.label === agentId || cs.key.includes(agentId),
          );

          if (matchingChild?.key) {
            const history = await this.gatewayClient.request<{ messages?: unknown[] }>(
              'chat.history',
              {
                sessionKey: matchingChild.key,
                limit: 100,
              },
            );

            if (Array.isArray(history?.messages)) {
              const extracted: Array<{
                role: string;
                content: string;
                metadata?: Record<string, unknown>;
              }> = [];
              for (const entry of extractGatewayHistoryEntries(history.messages)) {
                extracted.push({
                  role: entry.role,
                  content: entry.text,
                  metadata: entry.metadata,
                });
              }
              if (extracted.length > 0) {
                const msgs = convertToCoworkMessages(extracted);
                this.patchToolInputFromHistoryRaw(msgs, history.messages);
                return markSubagentContextMessage(msgs);
              }
            }
          }
        }
      } catch (err) {
        console.warn('[OpenClawRuntime] getSubTaskHistory: sessions.list failed:', err);
      }
    }

    console.log('[OpenClawRuntime] getSubTaskHistory: no messages found for agentId=' + agentId);
    return [];
  }

  /**
   * Generate a session title using the configured model via GatewayClient.
   * This reuses the Gateway's authentication mechanism, avoiding separate HTTP auth handling.
   *
   * @param userIntent The user's initial prompt/message to generate title from
   * @param timeoutMs Timeout in milliseconds (default 8000ms)
   * @returns Generated title, or fallback if generation fails
   */
  async generateTitle(userIntent: string | null, timeoutMs = 8000): Promise<string> {
    const SESSION_TITLE_MAX_CHARS = 50;
    const SESSION_TITLE_FALLBACK = 'New Session';

    const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
    const fallbackTitle = this.buildFallbackTitle(
      normalizedInput,
      SESSION_TITLE_FALLBACK,
      SESSION_TITLE_MAX_CHARS,
    );

    // CRITICAL: Skip gateway-based title generation entirely.
    // The gateway's bootstrapContextMode: 'lightweight' does NOT prevent skill context injection,
    // causing the title session to spawn subagents for skill processing instead of just generating a title.
    // This creates race conditions and orphan subagent sessions that pollute the subagent display.
    // Use fallback title derived from user input directly to avoid these issues.
    // See: https://github.com/anthropics/claude-code/issues/xxx (subagent display showing title session subagents)
    console.log(
      '[OpenClawRuntime] generateTitle: using fallback title to avoid skill injection (input="' +
        normalizedInput.slice(0, 50) +
        '...") -> "' +
        fallbackTitle +
        '"',
    );
    return fallbackTitle;
  }

  private buildFallbackTitle(input: string, fallback: string, maxChars: number): string {
    if (!input) return fallback;
    const firstLine =
      input
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return this.normalizeTitle(firstLine, fallback, maxChars);
  }

  private normalizeTitle(value: string, fallback: string, maxChars: number): string {
    let title = value.trim();

    // Strip markdown code fences
    const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
    if (fenced?.[1]) {
      title = fenced[1].trim();
    }

    // Strip markdown formatting
    title = title
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();

    // Extract from "title: xxx" format
    const labeled = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
    if (labeled?.[1]) {
      title = labeled[1].trim();
    }

    // Strip quotes
    title = title
      .replace(/^["'`"''']+/, '')
      .replace(/["'`"''']+$/, '')
      .trim();

    // Only use first line (model may return multi-line content)
    title = title.split(/\r?\n/)[0].trim();

    // Strip suffix after dash/hyphen (e.g., "Sorting Algorithms - Part 1/2")
    const dashMatch = title.match(/^(.+?)[-—–.]/);
    if (dashMatch?.[1]) {
      title = dashMatch[1].trim();
    }

    if (!title) return fallback;
    if (title.length > maxChars) {
      title = title.slice(0, maxChars).trim();
    }

    return title || fallback;
  }

  private extractTitleFromAgentResult(result: unknown): string | null {
    if (!result) return null;

    // Gateway agent response format: { runId, status: 'ok', summary: 'completed', result: { payloads, meta } }
    // The 'result.payloads[].text' contains the actual agent output
    const obj = result as Record<string, unknown>;

    // Check for Gateway agent final response structure
    if (obj.status === 'ok' && obj.result !== undefined) {
      const innerResult = obj.result as Record<string, unknown>;
      // result.payloads is an array of ReplyPayload objects
      const payloads = innerResult.payloads as unknown[];
      if (Array.isArray(payloads) && payloads.length > 0) {
        // Extract text from the first payload
        const firstPayload = payloads[0] as Record<string, unknown>;
        if (typeof firstPayload?.text === 'string') {
          return firstPayload.text;
        }
      }
      // Fallback: try other fields in result
      return this.extractTitleFromAgentResult(obj.result);
    }

    // Result might be a string directly
    if (typeof result === 'string') {
      return result;
    }

    // Result might be an object with text/content
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.result === 'string') return obj.result;
    if (typeof obj.summary === 'string') return obj.summary;

    // Result might have a payloads array (direct structure)
    const payloads = obj.payloads as unknown[];
    if (Array.isArray(payloads) && payloads.length > 0) {
      const firstPayload = payloads[0] as Record<string, unknown>;
      if (typeof firstPayload?.text === 'string') {
        return firstPayload.text;
      }
    }

    // Result might have a message array
    const messages = obj.messages as unknown[];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const msgObj = msg as Record<string, unknown>;
        if (msgObj?.role === 'assistant') {
          const content = msgObj.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const blockObj = block as Record<string, unknown>;
              if (blockObj?.type === 'text' && typeof blockObj.text === 'string') {
                return blockObj.text;
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Patch the model for an active session via sessions.patch API.
   * This enables real-time model switching without restarting the session.
   */
  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.gatewayClient;
    if (!client) {
      return { ok: false, error: 'OpenClaw gateway client not connected' };
    }

    // Get agentId from session store if not provided
    const session = this.store.getSession(sessionId);
    const effectiveAgentId = agentId || session?.agentId || 'main';

    // Build session key in the format: agent:{agentId}:gucciai:{sessionId}
    const sessionKey = `agent:${effectiveAgentId}:gucciai:${sessionId}`;

    // Normalize model reference - should be in format "provider/model-id"
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return { ok: false, error: 'Model reference is required' };
    }

    console.log(
      '[OpenClawRuntime] patchSessionModel: sessionId=%s, agentId=%s, key=%s, model=%s',
      sessionId,
      effectiveAgentId,
      sessionKey,
      normalizedModel,
    );

    try {
      const result = await client.request<{ ok?: boolean; key?: string; entry?: unknown }>(
        'sessions.patch',
        {
          key: sessionKey,
          model: normalizedModel,
        },
      );
      console.log('[OpenClawRuntime] patchSessionModel: success, result=', result);
      return { ok: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawRuntime] patchSessionModel: failed:', errorMsg);
      return { ok: false, error: errorMsg };
    }
  }

  // ============================================================
  // Skill Management RPC Methods
  // ============================================================

  /**
   * Get skill status from Gateway via skills.status RPC.
   * Returns all skills visible to the gateway with eligibility info.
   */
  async getSkillsStatus(agentId?: string): Promise<import('./types').GatewaySkillStatus> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<import('./types').GatewaySkillStatus>('skills.status', {
      agentId,
    });
    // Debug: Log full Gateway response including managedSkillsDir
    console.log('[OpenClawRuntime] getSkillsStatus response:', {
      workspaceDir: result.workspaceDir,
      managedSkillsDir: result.managedSkillsDir,
      skillCount: result.skills?.length || 0,
      firstSkillPath: result.skills?.[0]?.filePath,
      firstSkillBaseDir: result.skills?.[0]?.baseDir,
    });
    return result;
  }

  /**
   * Install a skill via skills.install RPC.
   * Supports ClawHub installs (source: 'clawhub') and Gateway installer mode.
   */
  async installSkill(
    params: import('./types').SkillInstallParams,
  ): Promise<import('./types').SkillRpcResult> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    console.log('[OpenClawRuntime] installSkill: params=', params);
    const result = await client.request<import('./types').SkillRpcResult>('skills.install', params);
    console.log('[OpenClawRuntime] installSkill: result=', result);
    return result;
  }

  /**
   * Update skill config via skills.update RPC.
   * Used to enable/disable skills or set apiKey/env config.
   */
  async updateSkillConfig(
    params: import('./types').SkillUpdateParams,
  ): Promise<import('./types').SkillRpcResult> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    console.log(
      '[OpenClawRuntime] updateSkillConfig: skillKey=',
      params.skillKey,
      'enabled=',
      params.enabled,
    );
    const result = await client.request<import('./types').SkillRpcResult>('skills.update', params);
    console.log('[OpenClawRuntime] updateSkillConfig: result=', result);
    return result;
  }

  /**
   * Search ClawHub marketplace via skills.search RPC.
   */
  async searchClawHubSkills(
    query?: string,
    limit?: number,
  ): Promise<import('./types').ClawHubSearchResult[]> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<{ results?: import('./types').ClawHubSearchResult[] }>(
      'skills.search',
      { query, limit: limit || 20 },
    );
    console.log(
      '[OpenClawRuntime] searchClawHubSkills: received',
      result.results?.length || 0,
      'results',
    );
    return result.results || [];
  }

  /**
   * Get ClawHub skill detail via skills.detail RPC.
   */
  async getClawHubSkillDetail(slug: string): Promise<import('./types').ClawHubDetail | null> {
    await this.ensureGatewayClientReady();
    const client = this.requireGatewayClient();
    const result = await client.request<import('./types').ClawHubDetail>('skills.detail', { slug });
    console.log('[OpenClawRuntime] getClawHubSkillDetail: slug=', slug, 'result=', result);
    return result;
  }
}
