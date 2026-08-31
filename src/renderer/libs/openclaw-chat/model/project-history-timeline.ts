import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { parseExecutionPlanUpdate } from '@shared/openclaw/executionPlan';
import { normalizeToolTerminalStatus } from '@shared/openclaw/messageDomain';

import { getTranscriptMedia } from '@/libs/openclaw-chat/attachments';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import {
  MAX_LIVE_TOOL_OUTPUT_CHARS,
  type ThinkingItem,
  type ToolItem,
} from './chat-transcript-state';
import { deterministicHistoryKey } from './history-reconciler';
import type {
  LiveProcessTimelineItem,
  PlanUpdateTimelineItem,
  ProcessSummaryTimelineItem,
} from './project-turn-items';
import {
  hasToolResultPayload,
  inferSessionsYieldInput,
  isSessionsYieldTool,
} from './tool-lifecycle';
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
  | {
      kind: 'history-message';
      key: string;
      message: GatewayMessage;
      durationMs?: number;
      completedAt?: number;
    }
  | ProcessSummaryTimelineItem
  | LiveProcessTimelineItem
  | PlanUpdateTimelineItem;

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
  const messageMarker =
    message.__openclaw &&
    typeof message.__openclaw === 'object' &&
    !Array.isArray(message.__openclaw)
      ? (message.__openclaw as Record<string, unknown>)
      : null;
  const outerMarker =
    outer.__openclaw && typeof outer.__openclaw === 'object' && !Array.isArray(outer.__openclaw)
      ? (outer.__openclaw as Record<string, unknown>)
      : null;
  for (const value of [
    message.timestamp,
    message.ts,
    messageMarker?.recordTimestampMs,
    outer.timestamp,
    outer.ts,
    outerMarker?.recordTimestampMs,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      const numeric = Number(trimmed);
      if (trimmed && Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function isGatewayInjectedAssistant(
  outer: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  const outerMetadata =
    outer.metadata && typeof outer.metadata === 'object' && !Array.isArray(outer.metadata)
      ? (outer.metadata as Record<string, unknown>)
      : null;
  const messageMetadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  return [
    message.modelName,
    message.model,
    messageMetadata?.modelName,
    messageMetadata?.model,
    outer.modelName,
    outer.model,
    outerMetadata?.modelName,
    outerMetadata?.model,
  ].some(value => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === 'gateway-injected' || normalized.endsWith('/gateway-injected');
  });
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

function clientTurnTimestampOf(timing: SessionRunTiming): number | null {
  const match = /^justdo-(\d{10,16})-/.exec(timing.clientTurnId);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
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

export function projectPersistedTimeline(
  messages: GatewayMessage[],
  runTimings: readonly SessionRunTiming[] = [],
): PersistedTimelineItem[] {
  const projected: PersistedTimelineItem[] = [];
  let archived: Array<ThinkingItem | ToolItem> = [];
  let segment = 0;
  const toolsByCallId = new Map<string, ToolItem[]>();
  const allTools: ToolItem[] = [];
  const syntheticRunIds = new Set<string>();
  const toolEpochByItem = new WeakMap<ToolItem, number>();
  let toolEpoch = 0;
  const claimableTimings = runTimings
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const timingByRootRunId = new Map(
    claimableTimings
      .filter(timing => timing.rootRunId)
      .map(timing => [timing.rootRunId!, timing] as const),
  );
  const claimedTimingIds = new Set<string>();
  let activeTiming: SessionRunTiming | null = null;
  let lastTimedMessage: Extract<PersistedTimelineItem, { kind: 'history-message' }> | null = null;
  const terminalTimingByProcessId = new Map<string, SessionRunTiming>();

  const rememberTerminalTiming = (process: ThinkingItem | ToolItem): void => {
    if (!activeTiming) return;
    if (activeTiming.endedAt !== undefined) {
      terminalTimingByProcessId.set(process.id, activeTiming);
    } else {
      terminalTimingByProcessId.delete(process.id);
    }
  };

  const registerTool = (tool: ToolItem): void => {
    const candidates = toolsByCallId.get(tool.toolCallId) ?? [];
    candidates.push(tool);
    toolsByCallId.set(tool.toolCallId, candidates);
    allTools.push(tool);
    toolEpochByItem.set(tool, toolEpoch);
  };

  const isCurrentToolEpoch = (tool: ToolItem): boolean => toolEpochByItem.get(tool) === toolEpoch;

  const findToolByCallId = (toolCallId: string, runId: string): ToolItem | undefined => {
    const candidates = toolsByCallId.get(toolCallId) ?? [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate.runId === runId && candidate.status === 'running') return candidate;
    }
    const incomingIsFallback = syntheticRunIds.has(runId);
    if (!incomingIsFallback) {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (
          syntheticRunIds.has(candidate.runId) &&
          candidate.status === 'running' &&
          isCurrentToolEpoch(candidate)
        ) {
          candidate.runId = runId;
          return candidate;
        }
      }
      return undefined;
    }
    // Persisted Tool result messages often omit their run id. Match only an
    // unresolved call: falling back to a completed Tool would overwrite an
    // earlier invocation when a call id is reused.
    for (const candidate of candidates) {
      if (candidate.status === 'running' && isCurrentToolEpoch(candidate)) return candidate;
    }
    return undefined;
  };

  const findToolForCall = (toolCallId: string, runId: string): ToolItem | undefined => {
    const candidates = toolsByCallId.get(toolCallId) ?? [];
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate.runId === runId && candidate.status === 'running') return candidate;
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      const candidateIsFallback = syntheticRunIds.has(candidate.runId);
      const incomingIsFallback = syntheticRunIds.has(runId);
      if (
        candidateIsFallback &&
        !incomingIsFallback &&
        candidate.status === 'running' &&
        isCurrentToolEpoch(candidate)
      ) {
        candidate.runId = runId;
        return candidate;
      }
      if (incomingIsFallback && candidate.status === 'running' && isCurrentToolEpoch(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };

  const findUnresolvedToolByName = (name: string, runId: string): ToolItem | undefined => {
    for (const candidate of allTools) {
      if (candidate.runId === runId && candidate.name === name && candidate.status === 'running') {
        return candidate;
      }
    }
    const incomingIsFallback = syntheticRunIds.has(runId);
    for (const candidate of allTools) {
      if (
        candidate.name !== name ||
        candidate.status !== 'running' ||
        !isCurrentToolEpoch(candidate)
      ) {
        continue;
      }
      if (!incomingIsFallback && !syntheticRunIds.has(candidate.runId)) continue;
      if (!incomingIsFallback) candidate.runId = runId;
      return candidate;
    }
    return undefined;
  };

  const isPlanUpdate = (item: ThinkingItem | ToolItem): item is ToolItem =>
    item.type === 'tool' &&
    item.name.toLowerCase() === 'update_plan' &&
    parseExecutionPlanUpdate(item.input) !== null;

  const flushSummary = () => {
    if (archived.length === 0) return;
    let summaryItems: Array<ThinkingItem | ToolItem> = [];
    const flushSummaryItems = () => {
      if (summaryItems.length === 0) return;
      const first = summaryItems[0];
      projected.push({
        kind: 'process-summary',
        key: `history-process:${segment}:${first.id}`,
        runId: first.runId,
        items: summaryItems,
        thinkingCount: summaryItems.filter(item => item.type === 'thinking').length,
        toolCount: summaryItems.filter(item => item.type === 'tool').length,
        errorCount: summaryItems.filter(item => item.status === 'failed').length,
        interruptedCount: summaryItems.filter(
          item => item.status === 'cancelled' || item.status === 'interrupted',
        ).length,
      });
      summaryItems = [];
      segment += 1;
    };
    for (const item of archived) {
      if (isPlanUpdate(item)) {
        flushSummaryItems();
        projected.push({
          kind: 'plan-update',
          key: `history-plan:${segment}:${item.id}`,
          item,
        });
        segment += 1;
      } else {
        summaryItems.push(item);
      }
    }
    flushSummaryItems();
    archived = [];
  };

  const emitMessage = (
    message: GatewayMessage,
    key: string,
    durationMs?: number,
    completedAt?: number,
  ) => {
    flushSummary();
    if (durationMs !== undefined && lastTimedMessage) {
      delete lastTimedMessage.durationMs;
      delete lastTimedMessage.completedAt;
    }
    const item: Extract<PersistedTimelineItem, { kind: 'history-message' }> = {
      kind: 'history-message',
      key,
      message,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
    projected.push(item);
    if (durationMs !== undefined) lastTimedMessage = item;
    segment += 1;
  };

  const claimTiming = (runId: string, timestamp: number): SessionRunTiming | null => {
    const exact = timingByRootRunId.get(runId);
    if (exact) {
      claimedTimingIds.add(exact.id);
      return exact;
    }
    if (timestamp <= 0) return null;
    const candidate = claimableTimings
      .filter(timing => !claimedTimingIds.has(timing.id))
      .map(timing => {
        const clientTurnTimestamp = clientTurnTimestampOf(timing);
        return {
          timing,
          distance: Math.abs((clientTurnTimestamp ?? timing.startedAt) - timestamp),
        };
      })
      .filter(entry => entry.distance <= 60_000)
      .sort((left, right) => left.distance - right.distance)[0]?.timing;
    if (!candidate) return null;
    claimedTimingIds.add(candidate.id);
    return candidate;
  };

  const applyToolCall = (
    source: Record<string, unknown>,
    fallbackId: string,
    runId: string,
    sequence: number,
    timestamp: number,
  ): ToolItem => {
    const toolCallId = readToolCallId(source, fallbackId) ?? fallbackId;
    const existing = findToolForCall(toolCallId, runId);
    const input = readToolInput(source);
    if (existing) {
      existing.name = readToolName(source, existing.name);
      if (input !== undefined && input !== null) existing.input = input;
      existing.updatedAt = Math.max(existing.updatedAt, timestamp);
      existing.lastSeq = Math.max(existing.lastSeq, sequence);
      rememberTerminalTiming(existing);
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
      status: 'running',
      toolCallId,
      name: readToolName(source),
      ...(input !== undefined && input !== null ? { input } : {}),
    };
    archived.push(tool);
    registerTool(tool);
    rememberTerminalTiming(tool);
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
      ? findToolByCallId(explicitToolCallId, runId)
      : findUnresolvedToolByName(sourceName, runId);
    const toolCallId = explicitToolCallId ?? tool?.toolCallId ?? fallbackId;
    const sourceInput = readToolInput(source);
    const output = readToolOutput(source);
    const error = readToolError(source, output);
    const effectiveName = sourceName === 'tool' ? (tool?.name ?? sourceName) : sourceName;
    const input = sourceInput ?? tool?.input ?? inferSessionsYieldInput(effectiveName, output);
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
      registerTool(tool);
    } else {
      tool.name = readToolName(source, tool.name);
      if (input !== undefined && input !== null) tool.input = input;
      tool.updatedAt = Math.max(tool.updatedAt, timestamp);
      tool.lastSeq = Math.max(tool.lastSeq, sequence);
    }
    const outputlessSessionsYieldResult =
      isSessionsYieldTool(tool.name) &&
      !hasToolResultPayload({
        output: output ?? undefined,
        error: error.message ?? undefined,
      });
    if (output !== null && !outputlessSessionsYieldResult) tool.output = boundedOutput(output);
    if (error.message !== null && !outputlessSessionsYieldResult) {
      tool.error = boundedOutput(error.message);
    }
    const terminalStatus = normalizeToolTerminalStatus(source.phase ?? source.status, error.failed);
    tool.status = error.failed
      ? 'failed'
      : terminalStatus === 'cancelled'
        ? 'cancelled'
        : isSessionsYieldTool(tool.name) && !hasToolResultPayload(tool)
          ? 'running'
          : 'completed';
    rememberTerminalTiming(tool);
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
    if (runId === messageKey) syntheticRunIds.add(runId);
    const timestamp = timestampOf(outer, message);
    const role = roleOf(message);
    const matchingTiming = timingByRootRunId.get(runId);
    if (role === 'user') {
      toolEpoch += 1;
      activeTiming = claimTiming(runId, timestamp);
      lastTimedMessage = null;
    } else if (matchingTiming) {
      activeTiming = matchingTiming;
      claimedTimingIds.add(matchingTiming.id);
      lastTimedMessage = null;
    }
    const durationMs =
      role === 'assistant' &&
      (!isGatewayInjectedAssistant(outer, message) || runId.startsWith('announce:v1:')) &&
      activeTiming?.endedAt !== undefined
        ? Math.max(0, activeTiming.endedAt - activeTiming.startedAt)
        : undefined;
    const completedAt = durationMs === undefined ? undefined : activeTiming?.endedAt;
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
      const marker =
        message.__openclaw &&
        typeof message.__openclaw === 'object' &&
        !Array.isArray(message.__openclaw)
          ? (message.__openclaw as Record<string, unknown>)
          : outer.__openclaw &&
              typeof outer.__openclaw === 'object' &&
              !Array.isArray(outer.__openclaw)
            ? (outer.__openclaw as Record<string, unknown>)
            : null;
      const senderLabel = message.senderLabel ?? outer.senderLabel;
      const fallbackText = message.text ?? (message === outer ? undefined : outer.text);
      const hasTranscriptMedia =
        getTranscriptMedia(message).length > 0 ||
        (message !== outer && getTranscriptMedia(outer).length > 0);
      const hasBlankAssistantControlContent =
        role === 'assistant' &&
        (message.content === null ||
          message.content === undefined ||
          (typeof message.content === 'string' && !message.content.trim())) &&
        !(typeof fallbackText === 'string' && fallbackText.trim()) &&
        !(typeof senderLabel === 'string' && senderLabel.trim()) &&
        !(typeof marker?.kind === 'string' && marker.kind.trim()) &&
        !hasTranscriptMedia;
      if (
        (attachments.length === 0 && !hasBlankAssistantControlContent) ||
        (typeof message.content === 'string' && message.content.trim().length > 0)
      ) {
        emitMessage(outerMessage, messageKey, durationMs, completedAt);
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
        durationMs,
        completedAt,
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
        const text = blockText(block, 'thinking', 'text', 'reasoning');
        if (!text.trim()) return;
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
          text,
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
      if (type === 'text' && !blockText(block, 'text').trim()) return;
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

  // A history refresh can expose an in-flight Tool before its result, notably
  // when a subagent announce is persisted behind a long sessions_yield call.
  // Keep the same invariant as the live projection: only settled Thinking and
  // Tool items belong in a collapsible summary.
  return projected.flatMap(item => {
    if (item.kind !== 'process-summary') return [item];

    const normalized: PersistedTimelineItem[] = [];
    let settled: Array<ThinkingItem | ToolItem> = [];
    let settledSegment = 0;
    const flushSettled = () => {
      if (settled.length === 0) return;
      const first = settled[0];
      normalized.push({
        kind: 'process-summary',
        key: settledSegment === 0 ? item.key : `${item.key}:settled:${settledSegment}:${first.id}`,
        runId: first.runId,
        items: settled,
        thinkingCount: settled.filter(process => process.type === 'thinking').length,
        toolCount: settled.filter(process => process.type === 'tool').length,
        errorCount: settled.filter(process => process.status === 'failed').length,
        interruptedCount: settled.filter(
          process => process.status === 'cancelled' || process.status === 'interrupted',
        ).length,
      });
      settled = [];
      settledSegment += 1;
    };

    for (const process of item.items) {
      if (process.status === 'running') {
        const latestRootTiming = timingByRootRunId.get(process.runId);
        const terminalTiming =
          latestRootTiming === undefined
            ? terminalTimingByProcessId.get(process.id)
            : latestRootTiming.endedAt !== undefined
              ? latestRootTiming
              : undefined;
        if (terminalTiming) {
          process.status = 'interrupted';
          process.updatedAt = Math.max(process.updatedAt, terminalTiming.endedAt ?? 0);
          settled.push(process);
          continue;
        }
        flushSettled();
        normalized.push({
          kind: 'live-process',
          key: `history-live:${process.id}`,
          item: process,
        });
      } else {
        settled.push(process);
      }
    }
    flushSettled();
    return normalized;
  });
}
