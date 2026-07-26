import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import {
  MAX_LIVE_TOOL_OUTPUT_CHARS,
  type ThinkingItem,
  type ToolItem,
} from './chat-transcript-state';
import { deterministicHistoryKey } from './history-reconciler';
import type { ProcessSummaryTimelineItem } from './project-turn-items';
import {
  asToolRecord,
  attachedToolMessages,
  isToolCallRecord,
  isToolResultType,
  readToolCallId,
  readToolError,
  readToolInput,
  readToolName,
  readToolOutput,
  unwrapToolMessage,
} from './tool-message-adapter';

export type PersistedTimelineItem =
  { kind: 'history-message'; key: string; message: GatewayMessage } | ProcessSummaryTimelineItem;

const THINKING_TYPES = new Set(['thinking', 'reasoning']);
const TOOL_RESULT_ROLES = new Set(['tool', 'toolresult', 'tool_result', 'function']);
const TOOL_CALL_ROLES = new Set(['tooluse', 'tool_use']);

function roleOf(message: Record<string, unknown>): string {
  return typeof message.role === 'string' ? message.role.toLowerCase() : '';
}

function blockText(block: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = block[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function boundedOutput(value: string): string {
  return value.length <= MAX_LIVE_TOOL_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_LIVE_TOOL_OUTPUT_CHARS)}\n[truncated]`;
}

function timestampOf(outer: Record<string, unknown>, message: Record<string, unknown>): number {
  for (const value of [message.timestamp, message.ts, outer.timestamp, outer.ts]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function runIdOf(
  outer: Record<string, unknown>,
  message: Record<string, unknown>,
  fallback: string,
): string {
  const outerMetadata =
    outer.metadata && typeof outer.metadata === 'object' && !Array.isArray(outer.metadata)
      ? (outer.metadata as Record<string, unknown>)
      : null;
  const messageMetadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  for (const value of [
    message.runId,
    message.run_id,
    messageMetadata?.runId,
    messageMetadata?.run_id,
    outer.runId,
    outer.run_id,
    outerMetadata?.runId,
    outerMetadata?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function visibleMessageWithContent(
  outer: GatewayMessage,
  message: Record<string, unknown>,
  content: unknown[],
): GatewayMessage {
  const outerRecord = outer as Record<string, unknown>;
  return message === outerRecord
    ? ({ ...outer, content } as GatewayMessage)
    : ({
        ...outerRecord,
        message: { ...message, content },
      } as unknown as GatewayMessage);
}

function withToolMessageContext(
  message: Record<string, unknown>,
  block: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...message,
    ...block,
    content: block.content,
    metadata: block.metadata ?? message.metadata,
  };
}

export function projectPersistedTimeline(messages: GatewayMessage[]): PersistedTimelineItem[] {
  const projected: PersistedTimelineItem[] = [];
  let archived: Array<ThinkingItem | ToolItem> = [];
  let segment = 0;
  const toolById = new Map<string, ToolItem>();

  const flushSummary = () => {
    if (archived.length === 0) return;
    const first = archived[0];
    projected.push({
      kind: 'process-summary',
      key: `history-process:${segment}:${first.id}`,
      runId: first.runId,
      items: archived,
      thinkingCount: archived.filter(item => item.type === 'thinking').length,
      toolCount: archived.filter(item => item.type === 'tool').length,
      errorCount: archived.filter(item => item.status === 'failed').length,
      interruptedCount: 0,
    });
    archived = [];
    segment += 1;
  };

  const emitMessage = (message: GatewayMessage, key: string) => {
    flushSummary();
    projected.push({ kind: 'history-message', key, message });
    segment += 1;
  };

  const applyToolCall = (
    source: Record<string, unknown>,
    fallbackId: string,
    runId: string,
    sequence: number,
    timestamp: number,
  ): ToolItem => {
    const toolCallId = readToolCallId(source, fallbackId) ?? fallbackId;
    const existing = toolById.get(toolCallId);
    const input = readToolInput(source);
    if (existing) {
      existing.name = readToolName(source, existing.name);
      if (input !== undefined && input !== null) existing.input = input;
      existing.updatedAt = Math.max(existing.updatedAt, timestamp);
      existing.lastSeq = Math.max(existing.lastSeq, sequence);
      return existing;
    }
    const tool: ToolItem = {
      id: fallbackId,
      runId,
      firstSeq: sequence,
      lastSeq: sequence,
      startedAt: timestamp,
      updatedAt: timestamp,
      type: 'tool',
      status: 'completed',
      toolCallId,
      name: readToolName(source),
      ...(input !== undefined && input !== null ? { input } : {}),
    };
    archived.push(tool);
    toolById.set(toolCallId, tool);
    return tool;
  };

  const applyToolResult = (
    source: Record<string, unknown>,
    fallbackId: string,
    runId: string,
    sequence: number,
    timestamp: number,
  ): ToolItem => {
    const explicitToolCallId = readToolCallId(source);
    const sourceName = readToolName(source);
    let tool = explicitToolCallId
      ? toolById.get(explicitToolCallId)
      : [...toolById.values()].find(
          candidate => candidate.name === sourceName && candidate.output === undefined,
        );
    const toolCallId = explicitToolCallId ?? tool?.toolCallId ?? fallbackId;
    const input = readToolInput(source);
    const output = readToolOutput(source);
    const error = readToolError(source, output);
    if (!tool) {
      tool = {
        id: fallbackId,
        runId,
        firstSeq: sequence,
        lastSeq: sequence,
        startedAt: timestamp,
        updatedAt: timestamp,
        type: 'tool',
        status: error.failed ? 'failed' : 'completed',
        toolCallId,
        name: sourceName,
        ...(input !== undefined && input !== null ? { input } : {}),
      };
      archived.push(tool);
      toolById.set(toolCallId, tool);
    } else {
      tool.name = readToolName(source, tool.name);
      if (input !== undefined && input !== null) tool.input = input;
      tool.updatedAt = Math.max(tool.updatedAt, timestamp);
      tool.lastSeq = Math.max(tool.lastSeq, sequence);
    }
    tool.status = error.failed ? 'failed' : 'completed';
    if (output !== null) tool.output = boundedOutput(output);
    if (error.message !== null) tool.error = boundedOutput(error.message);
    return tool;
  };

  const applyToolOnlyMessage = (
    rawValue: unknown,
    fallbackId: string,
    runId: string,
    sequence: number,
    timestamp: number,
  ): boolean => {
    const source = unwrapToolMessage(rawValue);
    if (!source) return false;
    const role = roleOf(source);
    if (TOOL_RESULT_ROLES.has(role)) {
      applyToolResult(source, fallbackId, runId, sequence, timestamp);
      return true;
    }
    if (TOOL_CALL_ROLES.has(role)) {
      applyToolCall(source, fallbackId, runId, sequence, timestamp);
      return true;
    }
    const content = Array.isArray(source.content) ? source.content : [];
    let applied = false;
    content.forEach((rawBlock, index) => {
      const block = asToolRecord(rawBlock);
      if (!block) return;
      const blockSource = withToolMessageContext(source, block);
      const blockId = `${fallbackId}:block:${index}`;
      if (isToolCallRecord(blockSource)) {
        applyToolCall(blockSource, blockId, runId, sequence + index, timestamp);
        applied = true;
      } else if (isToolResultType(blockSource.type)) {
        applyToolResult(blockSource, blockId, runId, sequence + index, timestamp);
        applied = true;
      }
    });
    return applied;
  };

  messages.forEach((outerMessage, messageIndex) => {
    const outer = outerMessage as Record<string, unknown>;
    const message = unwrapToolMessage(outerMessage);
    if (!message) return;
    const messageKey = deterministicHistoryKey(outerMessage, messageIndex);
    const runId = runIdOf(outer, message, messageKey);
    const timestamp = timestampOf(outer, message);
    const role = roleOf(message);
    const attachments = [
      ...attachedToolMessages(message),
      ...(message === outer ? [] : attachedToolMessages(outer)),
    ];

    if (TOOL_RESULT_ROLES.has(role) || TOOL_CALL_ROLES.has(role)) {
      applyToolOnlyMessage(message, `${messageKey}:tool`, runId, messageIndex, timestamp);
      return;
    }

    const content = Array.isArray(message.content) ? message.content : null;
    if (!content) {
      if (
        attachments.length === 0 ||
        (typeof message.content === 'string' && message.content.trim().length > 0)
      ) {
        emitMessage(outerMessage, messageKey);
      }
      for (const [index, attached] of attachments.entries()) {
        applyToolOnlyMessage(
          attached,
          `${messageKey}:attached:${index}`,
          runId,
          messageIndex + index,
          timestamp,
        );
      }
      return;
    }

    let visibleBlocks: unknown[] = [];
    const flushVisibleBlocks = () => {
      if (visibleBlocks.length === 0) return;
      emitMessage(
        visibleMessageWithContent(outerMessage, message, visibleBlocks),
        `${messageKey}:content:${segment}`,
      );
      visibleBlocks = [];
    };

    content.forEach((rawBlock, blockIndex) => {
      const block = asToolRecord(rawBlock);
      if (!block) {
        visibleBlocks.push(rawBlock);
        return;
      }
      const itemId = `${messageKey}:block:${blockIndex}`;
      const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
      const toolSource = withToolMessageContext(message, block);
      if (THINKING_TYPES.has(type)) {
        flushVisibleBlocks();
        archived.push({
          id: itemId,
          runId,
          firstSeq: blockIndex,
          lastSeq: blockIndex,
          startedAt: timestamp,
          updatedAt: timestamp,
          type: 'thinking',
          status: 'completed',
          text: blockText(block, 'thinking', 'text', 'reasoning'),
        });
        return;
      }
      if (isToolCallRecord(toolSource)) {
        flushVisibleBlocks();
        applyToolCall(toolSource, itemId, runId, blockIndex, timestamp);
        return;
      }
      if (isToolResultType(type)) {
        flushVisibleBlocks();
        applyToolResult(toolSource, itemId, runId, blockIndex, timestamp);
        return;
      }

      // Text and rich visible blocks are hard Content boundaries.
      flushSummary();
      visibleBlocks.push(rawBlock);
    });
    flushVisibleBlocks();

    for (const [index, attached] of attachments.entries()) {
      applyToolOnlyMessage(
        attached,
        `${messageKey}:attached:${index}`,
        runId,
        content.length + index,
        timestamp,
      );
    }
  });
  flushSummary();

  // Tool results may update items after their summary was flushed.
  for (const item of projected) {
    if (item.kind !== 'process-summary') continue;
    item.thinkingCount = item.items.filter(process => process.type === 'thinking').length;
    item.toolCount = item.items.filter(process => process.type === 'tool').length;
    item.errorCount = item.items.filter(process => process.status === 'failed').length;
    item.interruptedCount = item.items.filter(
      process => process.status === 'cancelled' || process.status === 'interrupted',
    ).length;
  }
  return projected;
}
