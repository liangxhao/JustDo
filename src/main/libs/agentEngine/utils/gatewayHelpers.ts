/**
 * Shared utility functions for gateway event processing.
 *
 * Extracted from openclawRuntimeAdapter.ts to reduce file size and enable reuse
 * across event handlers, subagent tracker, and history reconciler.
 */

import type { CoworkMessage } from '../../../coworkStore';
import { extractGatewayMessageText } from '../../openclawHistory';

// ─── Constants ───────────────────────────────────────────────────────────────

export const OPENCLAW_GATEWAY_TOOL_EVENTS_CAP = 'tool-events';
export const GATEWAY_READY_TIMEOUT_MS = 15_000;
export const FINAL_HISTORY_SYNC_LIMIT = 50;
export const CHANNEL_SESSION_DISCOVERY_LIMIT = 200;

// Internal runtime context markers from OpenClaw
export const INTERNAL_RUNTIME_CONTEXT_BEGIN = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';
export const INTERNAL_RUNTIME_CONTEXT_END = '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>';
export const INTERNAL_TASK_COMPLETION_MARKER = '[Internal task completion event]';

// ─── Type Guards ─────────────────────────────────────────────────────────────

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

// ─── String Utilities ────────────────────────────────────────────────────────

export const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

/** Strip Discord mention markup: <@userId>, <@!userId>, <#channelId>, <@&roleId> */
export const stripDiscordMentions = (text: string): string =>
  text
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .trim();

// ─── Async Utilities ─────────────────────────────────────────────────────────

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

export const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
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

// ─── Gateway Message Parsing ─────────────────────────────────────────────────

export const extractMessageText = extractGatewayMessageText;

export const summarizeGatewayMessageShape = (message: unknown): string => {
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

export const extractTextBlocksAndSignals = (
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
export const extractThinkingContent = (message: unknown): string => {
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
 */
export const extractSentFilePathsFromHistory = (messages: unknown[]): string[] => {
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
export const extractCurrentTurnAssistantText = (messages: unknown[]): string => {
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

export const isDroppedBoundaryTextBlockSubset = (
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

// ─── Tool Text Extraction ────────────────────────────────────────────────────

export const extractToolText = (payload: unknown): string => {
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

  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
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

export const toToolInputRecord = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return {};
  }
  return { value };
};

// ─── Streaming Text Merge ────────────────────────────────────────────────────

export const computeSuffixPrefixOverlap = (left: string, right: string): number => {
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

type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

export const mergeStreamingText = (
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

// ─── Subagent Completion Parsing ─────────────────────────────────────────────

/**
 * Parse subagent completion event from internal context block
 */
export function parseSubagentCompletionEvent(block: string): {
  sessionKey: string;
  taskLabel: string;
  status: string;
  result: string;
} | null {
  if (!block.startsWith(INTERNAL_TASK_COMPLETION_MARKER)) {
    return null;
  }

  const lines = block.split('\n');
  let sessionKey = '';
  let taskLabel = '';
  let status = '';
  let result = '';

  const resultBeginMarker = '<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>';
  const resultEndMarker = '<<<END_UNTRUSTED_CHILD_RESULT>>>';
  const resultBeginIdx = block.indexOf(resultBeginMarker);
  const resultEndIdx = block.indexOf(resultEndMarker);

  if (resultBeginIdx !== -1 && resultEndIdx !== -1) {
    result = block.slice(resultBeginIdx + resultBeginMarker.length, resultEndIdx).trim();
  }

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

    if (line.trim() === '') break;
  }

  if (!sessionKey || !taskLabel) {
    return null;
  }

  return { sessionKey, taskLabel, status, result };
}

/**
 * Extract subagent completion messages from assistant message content.
 */
export function extractSubagentCompletionMessages(
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

  let searchStart = 0;
  let completionIndex = 0;

  while (searchStart < content.length) {
    const beginIdx = content.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN, searchStart);
    if (beginIdx === -1) break;

    const endIdx = content.indexOf(INTERNAL_RUNTIME_CONTEXT_END, beginIdx);
    if (endIdx === -1) break;

    const blockContent = content
      .slice(beginIdx + INTERNAL_RUNTIME_CONTEXT_BEGIN.length, endIdx)
      .trim();

    const events = blockContent.split('\n\n---\n\n').filter(s => s.trim());

    for (const eventBlock of events) {
      const parsed = parseSubagentCompletionEvent(eventBlock.trim());
      if (parsed) {
        results.push({
          type: 'subagent_completion',
          content: parsed.result,
          timestamp: baseTimestamp + completionIndex,
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
    results.unshift({ type: 'assistant', content: finalContent, timestamp: baseTimestamp });
  }

  return results;
}

// ─── Message Conversion ──────────────────────────────────────────────────────

/**
 * Generate stable message id from entry data.
 */
export function generateStableMessageId(
  entry: { role: string; text: string; metadata?: Record<string, unknown> },
  index: number,
): string {
  if (entry.role === 'tool_use' || entry.role === 'tool_result') {
    const toolUseId = entry.metadata?.toolUseId;
    if (typeof toolUseId === 'string' && toolUseId) {
      return `subagent-${entry.role}-${toolUseId}`;
    }
  }
  const contentPrefix = entry.text.slice(0, 50).replace(/\s+/g, '-');
  return `subagent-msg-${entry.role}-${index}-${contentPrefix}`;
}

/**
 * Convert GatewayHistoryEntry array to CoworkMessage array.
 */
export function convertEntriesToCoworkMessages(
  entries: Array<{ role: string; text: string; metadata?: Record<string, unknown> }>,
): CoworkMessage[] {
  const now = Date.now();
  const results: CoworkMessage[] = [];
  let subIdx = 0;

  for (const entry of entries) {
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
 * Mark the first user message as Subagent Context.
 * For subagent history, the first user message is always the context/instruction.
 * No longer requires '[Subagent Context]' prefix since Gateway may not preserve it.
 */
export function markSubagentContextMessage(messages: CoworkMessage[]): CoworkMessage[] {
  if (messages.length === 0) return messages;
  const firstUserIndex = messages.findIndex(m => m.type === 'user');
  if (firstUserIndex === -1) return messages;

  const firstUserMsg = messages[firstUserIndex];

  // Already marked, skip
  if (firstUserMsg.metadata?.isSubagentContext) return messages;

  // Mark first user message as Subagent Context (it's the instruction sent to subagent)
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
 * Convert simple role/content format to CoworkMessage format.
 */
export function convertToCoworkMessage(
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
 * Convert array of simple role/content messages to CoworkMessage[].
 */
export function convertToCoworkMessages(
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>,
): CoworkMessage[] {
  return messages.map((msg, idx) => convertToCoworkMessage(msg, idx));
}

export const isSameChannelHistoryEntry = (
  left: { role: string; text: string },
  right: { role: string; text: string },
): boolean => {
  return left.role === right.role && left.text === right.text;
};
