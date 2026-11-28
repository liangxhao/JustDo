import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { normalizeToolTerminalStatus } from '@shared/openclaw/messageDomain';
import { isHiddenNativeMessage } from '@shared/openclaw/messageVisibility';
import type { McpAppDescriptor } from '@shared/plugins/mcpApps';
import { isGatewayInjectedModelRef } from '@shared/providers/modelRef';

import { getTranscriptMedia } from '@/libs/openclaw-chat/attachments';
import { isPresentPlanToolName } from '@/libs/openclaw-chat/model/turn/plan-preview';
import { stripEmbedShortcodesFromTextParts } from '@/libs/openclaw-chat/pipeline/embed-shortcodes';
import { collapseRepeatedFailures } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import {
  decodeNativeCanvasResult,
  isNativeWidgetFallbackAttributes,
  isNativeWidgetFallbackPreview,
} from '@/libs/openclaw-chat/pipeline/native-canvas';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import { decodeNativeAppReference } from '../../pipeline/native-app-reference';
import { decodeNativeBoardResult } from '../../pipeline/native-board';
import {
  decodeNativeMcpAppHistoryResult,
  decodeNativeMcpAppResult,
  decodeNativeNestedMcpAppHistoryResult,
  isNativeMcpAppFallbackAttributes,
  isNativeMcpAppFallbackPreview,
  readFailedNativeMcpAppHistoryDescriptor,
  readFailedNativeNestedMcpAppHistoryDescriptor,
} from '../../pipeline/native-mcp-app';
import { type ThinkingItem, type ToolItem } from '../chat-transcript-state';
import { deterministicHistoryKey } from '../history/history-reconciler';
import { readCommittedUserInputKey } from '../history/session-message-apply';
import {
  hasToolResultPayload,
  inferSessionsYieldInput,
  isSessionsYieldTool,
} from '../tools/tool-lifecycle';
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
} from '../tools/tool-message-adapter';
import { readToolPresentation } from '../tools/tool-presentation';
import {
  FAILED_RUN_MESSAGE_FLAG,
  isFailedRunMessage,
  projectRecoveredOutputCutoffMessages,
  readAssistantFailureDetail,
  readUncoveredFailureDetail,
} from '../turn/failed-run-message';
import { projectProcessVisibility } from './process-visibility';
import type {
  AppReferenceTimelineItem,
  LiveProcessTimelineItem,
  NativeMcpAppTimelineItem,
  NativeWidgetTimelineItem,
  PlanPresentationTimelineItem,
  ProcessSummaryTimelineItem,
  ProgressReceiptTimelineItem,
  QuestionPresentationTimelineItem,
} from './project-turn-items';
import { isQuestionPresentationTool } from './project-turn-items';

export type PersistedTimelineItem =
  | AppReferenceTimelineItem
  | {
      kind: 'history-message';
      key: string;
      message: GatewayMessage;
      durationMs?: number;
      completedAt?: number;
      modelRef?: string;
      runState?: SessionRunTiming['state'];
      runReceiptId?: string;
    }
  | {
      kind: 'phase-boundary';
      key: string;
      label: string;
    }
  | ProcessSummaryTimelineItem
  | LiveProcessTimelineItem
  | PlanPresentationTimelineItem
  | QuestionPresentationTimelineItem
  | ProgressReceiptTimelineItem
  | NativeWidgetTimelineItem
  | NativeMcpAppTimelineItem;

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
  ].some(isGatewayInjectedModelRef);
}

function runIdsOf(
  outer: Record<string, unknown>,
  message: Record<string, unknown>,
): string[] {
  const outerMetadata =
    outer.metadata && typeof outer.metadata === 'object' && !Array.isArray(outer.metadata)
      ? (outer.metadata as Record<string, unknown>)
      : null;
  const messageMetadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const outerOpenClaw =
    outer.__openclaw && typeof outer.__openclaw === 'object' && !Array.isArray(outer.__openclaw)
      ? (outer.__openclaw as Record<string, unknown>)
      : null;
  const messageOpenClaw =
    message.__openclaw &&
    typeof message.__openclaw === 'object' &&
    !Array.isArray(message.__openclaw)
      ? (message.__openclaw as Record<string, unknown>)
      : null;
  const ids = new Set<string>();
  for (const value of [
    message.runId,
    message.run_id,
    messageOpenClaw?.runId,
    messageOpenClaw?.run_id,
    messageMetadata?.runId,
    messageMetadata?.run_id,
    outer.runId,
    outer.run_id,
    outerOpenClaw?.runId,
    outerOpenClaw?.run_id,
    outerMetadata?.runId,
    outerMetadata?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  }
  return [...ids];
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
  if (
    Array.isArray(message.content) &&
    message.content.length === content.length &&
    message.content.every((block, index) => block === content[index])
  )
    return outer;
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
  options: { groupLiveToolFamilies?: boolean } = {},
): PersistedTimelineItem[] {
  const projected: PersistedTimelineItem[] = [];
  let archived: Array<ThinkingItem | ToolItem> = [];
  const messageOccurrences = new Map<string, number>();
  const toolsByCallId = new Map<string, ToolItem[]>();
  const allTools: ToolItem[] = [];
  const presentedWidgets = new WeakSet<ToolItem>();
  const presentedWidgetDocIds = new Set<string>();
  const nativeDocIds = new Set<string>();
  const presentedAppViewIds = new Set<string>();
  const failedApps = new Map<string, McpAppDescriptor>();
  const syntheticRunIds = new Set<string>();
  const toolEpochByItem = new WeakMap<ToolItem, number>();
  let toolEpoch = 0;
  const claimableTimings = runTimings
    .slice()
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const timingByRunId = new Map<string, SessionRunTiming | null>();
  const toolTimingByRootRunId = new Map<string, SessionRunTiming>();
  const timingByInputKey = new Map<string, SessionRunTiming>();
  for (const timing of claimableTimings) {
    const runId = timing.rootRunId ?? timing.clientTurnId;
    timingByRunId.set(runId, timingByRunId.has(runId) ? null : timing);
    if (timing.rootRunId) toolTimingByRootRunId.set(timing.rootRunId, timing);
    timingByInputKey.set(`${timing.clientTurnId}:user`, timing);
  }
  const claimedTimingIds = new Set<string>();
  let activeTiming: SessionRunTiming | null = null;
  let turnTiming: SessionRunTiming | null = null;
  const receiptByMessageKey = new Map<string, SessionRunTiming>();
  const terminalTimingByProcessId = new Map<string, SessionRunTiming>();
  const supersededTools = new Set<string>();
  let planPresentedSinceLastReset = false;

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

  const flushSummary = () => {
    if (archived.length === 0) return;
    let summaryItems: Array<ThinkingItem | ToolItem> = [];
    const flushSummaryItems = () => {
      if (summaryItems.length === 0) return;
      const first = summaryItems[0];
      projected.push({
        kind: 'process-summary',
        key: `history-process:${first.id}`,
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
    };
    for (const item of archived) {
      if (item.type === 'tool' && isPresentPlanToolName(item.name)) {
        flushSummaryItems();
        projected.push({
          kind: 'plan-presentation',
          key: `history-plan:${item.id}`,
          item,
        });
      } else if (item.type === 'tool' && item.name.trim().toLowerCase() === 'progress_card') {
        flushSummaryItems();
        projected.push({
          kind: 'progress-receipt',
          key: `history-progress:${item.id}`,
          item,
        });
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
    timing?: SessionRunTiming | null,
  ) => {
    flushSummary();
    const item: Extract<PersistedTimelineItem, { kind: 'history-message' }> = {
      kind: 'history-message',
      key,
      message,
    };
    if (timing && timing.state !== 'running') receiptByMessageKey.set(key, timing);
    projected.push(item);
  };

  // Legacy tools without a native owner still need the existing interruption
  // presentation. This approximation cannot supply a reply footer.
  const claimLegacyToolTiming = (timestamp: number): SessionRunTiming | null => {
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
      existing.presentation = { ...existing.presentation, ...readToolPresentation(source) };
      existing.name = readToolName(source, existing.name);
      if (isPresentPlanToolName(existing.name)) planPresentedSinceLastReset = true;
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
      presentation: readToolPresentation(source),
      ...(input !== undefined && input !== null ? { input } : {}),
    };
    archived.push(tool);
    if (isPresentPlanToolName(tool.name)) planPresentedSinceLastReset = true;
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
    tool.presentation = { ...tool.presentation, ...readToolPresentation(source) };
    const outputlessSessionsYieldResult =
      isSessionsYieldTool(tool.name) &&
      !hasToolResultPayload({
        output: output ?? undefined,
        error: error.message ?? undefined,
      });
    if (output !== null && !outputlessSessionsYieldResult) tool.output = output;
    if (error.message !== null && !outputlessSessionsYieldResult) {
      tool.error = error.message;
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
      const tool = applyToolResult(source, fallbackId, runId, sequence, timestamp);
      const failedApp = readFailedNativeMcpAppHistoryDescriptor(
        source,
        readToolName(source),
        readToolCallId(source) ?? undefined,
      );
      if (failedApp) failedApps.set(failedApp.viewId, failedApp);
      const reference =
        tool.status === 'completed'
          ? decodeNativeAppReference(
              source,
              readToolName(source),
              readToolCallId(source) ?? undefined,
              syntheticRunIds.has(runId) ? undefined : runId,
            )
          : undefined;
      if (reference) {
        flushSummary();
        projected.push({
          kind: 'app-reference',
          key: `history-app-reference:${tool.id}`,
          reference,
        });
      }
      const app =
        tool.status === 'completed'
          ? (decodeNativeMcpAppHistoryResult(
              source,
              readToolName(source),
              readToolCallId(source) ?? undefined,
            ) ??
            decodeNativeMcpAppResult(tool.output, tool.name, readToolCallId(source) ?? undefined))
          : undefined;
      if (app && !presentedAppViewIds.has(app.viewId)) {
        presentedAppViewIds.add(app.viewId);
        flushSummary();
        projected.push({ kind: 'mcp-app', key: `history-mcp-app:${tool.id}`, preview: app });
      }
      // Only native tool-role records grant document-view authority. An
      // assistant-authored nested result is still just ordinary transcript data.
      const board =
        tool.status === 'completed'
          ? decodeNativeBoardResult(tool.output, tool.name, readToolCallId(source) ?? undefined)
          : undefined;
      const widget =
        tool.status === 'completed'
          ? decodeNativeCanvasResult(tool.output, tool.name, readToolCallId(source) ?? undefined)
          : undefined;
      // Every admitted receipt owns its inline fallback, even when a repeated
      // board name shares one presentation row across several document versions.
      if (board?.suppressedInlineDocId) nativeDocIds.add(board.suppressedInlineDocId);
      if (widget) nativeDocIds.add(widget.docId);
      if (board && !presentedWidgetDocIds.has(`board:${board.name}`)) {
        presentedWidgetDocIds.add(`board:${board.name}`);
        flushSummary();
        projected.push({
          kind: 'native-widget',
          key: `history-board-widget:${tool.id}`,
          preview: board,
        });
      } else if (
        widget &&
        !presentedWidgets.has(tool) &&
        !presentedWidgetDocIds.has(widget.docId)
      ) {
        presentedWidgets.add(tool);
        presentedWidgetDocIds.add(widget.docId);
        flushSummary();
        projected.push({
          kind: 'native-widget',
          key: `history-widget:${tool.id}`,
          preview: widget,
        });
      }
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

  const visibleMessages = collapseRepeatedFailures(
    projectRecoveredOutputCutoffMessages(messages.filter(message => !isHiddenNativeMessage(message))),
  );
  const failureDetailOwners = new Map<string, GatewayMessage>();
  for (const value of visibleMessages) {
    if (!readAssistantFailureDetail(value)) continue;
    const source = unwrapToolMessage(value);
    const marker = asToolRecord(source?.__openclaw) ?? asToolRecord(value.__openclaw);
    if (typeof marker?.id === 'string' && marker.id.trim()) {
      failureDetailOwners.set(marker.id, value);
    }
  }
  let visibleMessageIndex = 0;
  messages.forEach((outerMessage, messageIndex) => {
    if (visibleMessages[visibleMessageIndex] !== outerMessage) return;
    visibleMessageIndex += 1;
    const outer = outerMessage as Record<string, unknown>;
    const message = unwrapToolMessage(outerMessage);
    if (!message) return;
    const nativeKey = deterministicHistoryKey(outerMessage, messageIndex);
    // Commentary sidecars retain the owner's entry id but expose a native item id.
    // Use it even when the window cuts off the owner's other projections.
    const fallback = asToolRecord(message.openclawStreamFallback ?? outer.openclawStreamFallback);
    const itemId =
      typeof fallback?.itemId === 'string' && fallback.itemId.trim() ? fallback.itemId : '';
    const projectionKey =
      fallback?.source === 'segment' && itemId
        ? `${nativeKey}:segment:${JSON.stringify(itemId)}`
        : nativeKey;
    // Unknown duplicate shapes have no stronger discriminator; keep them distinct
    // without treating their ordinal as native execution identity.
    const occurrence = messageOccurrences.get(projectionKey) ?? 0;
    messageOccurrences.set(projectionKey, occurrence + 1);
    const messageKey =
      occurrence === 0 ? projectionKey : `${projectionKey}:projection:${occurrence}`;
    const runIds = runIdsOf(outer, message);
    const runId = runIds[0] ?? nativeKey;
    if (runIds.length === 0) syntheticRunIds.add(runId);
    const timestamp = timestampOf(outer, message);
    const role = roleOf(message);
    const marker = asToolRecord(message.__openclaw) ?? asToolRecord(outer.__openclaw);
    if (marker?.kind === 'reset') {
      flushSummary();
      if (planPresentedSinceLastReset || marker.planImplementation === true) {
        projected.push({
          kind: 'phase-boundary',
          key: `history-phase:${messageKey}`,
          label: '',
        });
      } else {
        // Patch 022 exposes pre-reset rows so Plan history can remain visible.
        // Preserve native clear semantics for every reset that did not follow
        // a persisted present_plan tool call.
        projected.length = 0;
        presentedWidgetDocIds.clear();
        archived = [];
        toolsByCallId.clear();
        allTools.length = 0;
        syntheticRunIds.clear();
        claimedTimingIds.clear();
        terminalTimingByProcessId.clear();
        receiptByMessageKey.clear();
        supersededTools.clear();
      }
      planPresentedSinceLastReset = false;
      toolEpoch += 1;
      activeTiming = null;
      turnTiming = null;
      return;
    }
    if (marker?.turnBoundary === true) {
      activeTiming = null;
      turnTiming = null;
    }
    // A subsequent explicit assistant run cannot still be executing tools
    // from the previous run. Missing results remain interrupted, not successful.
    if (
      role === 'assistant' &&
      !syntheticRunIds.has(runId) &&
      !isGatewayInjectedAssistant(outer, message)
    ) {
      for (const tool of allTools) {
        if (tool.runId !== runId && !syntheticRunIds.has(tool.runId) && !isCurrentToolEpoch(tool)) {
          supersededTools.add(tool.id);
        }
      }
    }
    const matchingTiming = runIds.length === 1 ? timingByRunId.get(runId) : null;
    const matchingToolTiming = toolTimingByRootRunId.get(runId);
    if (role === 'user') {
      toolEpoch += 1;
      const inputKey = readCommittedUserInputKey(message);
      const inputTiming = inputKey ? timingByInputKey.get(inputKey) : undefined;
      // Steering has its own input key and preserves the target run's identity.
      const steerTarget = inputKey && typeof marker?.steerTargetRunId === 'string'
        ? marker.steerTargetRunId : undefined;
      if (steerTarget) {
        turnTiming = runIds.length === 0 || (runIds.length === 1 && runId === steerTarget)
          ? timingByRunId.get(steerTarget) ?? null : null;
      } else {
        turnTiming = runIds.length > 0
          ? matchingTiming && (!inputTiming || inputTiming === matchingTiming) ? matchingTiming : null
          : inputTiming ?? null;
      }
      activeTiming = turnTiming ?? matchingToolTiming ?? claimLegacyToolTiming(timestamp);
    } else {
      if (matchingToolTiming) activeTiming = matchingToolTiming;
      if (runIds.length > 0 && matchingTiming !== turnTiming) turnTiming = null;
    }
    if (activeTiming) claimedTimingIds.add(activeTiming.id);
    const failedRunMessage = isFailedRunMessage(outerMessage);
    const replyPhase = message.phase ?? outer.phase;
    const stopReason = message.stopReason ?? message.stop_reason;
    const content = Array.isArray(message.content) ? message.content : null;
    const replyTiming = runIds.length > 0 ? matchingTiming : turnTiming;
    const displayTiming = failedRunMessage ? matchingTiming
      : replyTiming && role === 'assistant' && !isGatewayInjectedAssistant(outer, message) &&
        replyPhase !== 'commentary' && fallback?.source !== 'segment' &&
        message.endTurn !== false && stopReason !== 'toolUse' &&
        !content?.some(value => {
          const block = asToolRecord(value);
          return block !== null && isToolCallRecord(withToolMessageContext(message, block));
        })
      ? replyTiming
      : null;
    const attachments = [
      ...attachedToolMessages(message),
      ...(message === outer ? [] : attachedToolMessages(outer)),
    ];
    const emitFailureDetail = () => {
      // Native history may admit multiple commentary/content projections for
      // one source message. Its final visible sibling owns the diagnostic.
      if (typeof marker?.id === 'string' && failureDetailOwners.get(marker.id) !== outerMessage) {
        return;
      }
      const detail = readUncoveredFailureDetail(outerMessage, visibleMessages);
      if (!detail) return;
      // Emit once per native source, after all of its Content/Thinking/Tool
      // segments, including sources that have no visible Content blocks.
      const failureMessage = {
        ...message,
        role: 'system',
        content: detail,
        isError: true,
        [FAILED_RUN_MESSAGE_FLAG]: true,
      };
      emitMessage(
        (message === outer
          ? failureMessage
          : { ...outer, message: failureMessage }) as GatewayMessage,
        `${messageKey}:failure`,
        matchingTiming,
      );
    };

    if (TOOL_RESULT_ROLES.has(role) || TOOL_CALL_ROLES.has(role)) {
      applyToolOnlyMessage(message, `${messageKey}:tool`, runId, messageIndex, timestamp);
      return;
    }

    if (!content) {
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
        emitMessage(outerMessage, messageKey, displayTiming);
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
      emitFailureDetail();
      return;
    }

    let visibleBlocks: unknown[] = [];
    let visibleBlockStart = 0;
    const flushVisibleBlocks = () => {
      if (visibleBlocks.length === 0) return;
      emitMessage(
        visibleMessageWithContent(outerMessage, message, visibleBlocks),
        `${messageKey}:content:${visibleBlockStart}`,
        displayTiming,
      );
      visibleBlocks = [];
    };

    content.forEach((rawBlock, blockIndex) => {
      if (visibleBlocks.length === 0) visibleBlockStart = blockIndex;
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
        const tool = applyToolResult(toolSource, itemId, runId, blockIndex, timestamp);
        const failedApp = readFailedNativeNestedMcpAppHistoryDescriptor(message, block);
        if (failedApp) failedApps.set(failedApp.viewId, failedApp);
        const app =
          tool.status === 'completed'
            ? decodeNativeNestedMcpAppHistoryResult(message, block)
            : undefined;
        if (app && !presentedAppViewIds.has(app.viewId)) {
          presentedAppViewIds.add(app.viewId);
          flushSummary();
          projected.push({ kind: 'mcp-app', key: `history-mcp-app:${tool.id}`, preview: app });
        }
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
    emitFailureDetail();
  });
  flushSummary();

  const nativeApps = new Map(
    projected.flatMap(item =>
      item.kind === 'mcp-app' ? [[item.preview.viewId, item.preview] as const] : [],
    ),
  );
  const appIds = new Set([...nativeApps.keys(), ...failedApps.keys()]);
  // A history refresh can expose an in-flight Tool before its result, notably
  // when a subagent announce is persisted behind a long sessions_yield call.
  // Keep the same invariant as the live projection: only settled Thinking and
  // Tool items belong in a collapsible summary.
  const visibleTimeline = projected.flatMap<PersistedTimelineItem>(item => {
    if (item.kind === 'history-message' && (nativeDocIds.size || appIds.size)) {
      const source = unwrapToolMessage(item.message);
      if (!source || roleOf(source) !== 'assistant') return [item];
      const content = Array.isArray(source.content)
        ? source.content
        : typeof source.content === 'string'
          ? [{ type: 'text', text: source.content }]
          : typeof source.text === 'string'
            ? [{ type: 'text', text: source.text }]
            : [];
      let changed = false;
      const textByIndex = new Map<number, string>();
      for (let start = 0; start < content.length;) {
        const first = asToolRecord(content[start]);
        if (first?.type !== 'text' || typeof first.text !== 'string') {
          start++;
          continue;
        }
        const texts: string[] = [];
        let end = start;
        while (end < content.length) {
          const block = asToolRecord(content[end]);
          if (block?.type !== 'text' || typeof block.text !== 'string') break;
          texts.push(block.text);
          end++;
        }
        stripEmbedShortcodesFromTextParts(
          texts,
          attributes =>
            isNativeWidgetFallbackAttributes(attributes, nativeDocIds, appIds) ||
            isNativeMcpAppFallbackAttributes(attributes, appIds, nativeDocIds),
        ).forEach((text, index) => textByIndex.set(start + index, text));
        start = end;
      }
      const cleaned = content.flatMap((block, index) => {
        const record = asToolRecord(block);
        // Native history can also expand a fallback into a Canvas block.
        // Remove only the same admitted document/App or confirmed failed App;
        // preserve unrelated and external embeds, and keep the failed Tool.
        if (
          record?.type === 'canvas' &&
          (isNativeWidgetFallbackPreview(record.preview, nativeDocIds) ||
            isNativeMcpAppFallbackPreview(record.preview, nativeApps, failedApps))
        ) {
          changed = true;
          return [];
        }
        if (record?.type !== 'text' || typeof record.text !== 'string') return [block];
        const text = textByIndex.get(index) ?? record.text;
        if (text === record.text) return [block];
        changed = true;
        return text.trim() ? [{ ...record, text }] : [];
      });
      if (!changed) return [item];
      if (!cleaned.length && !getTranscriptMedia(source).length) return [];
      return [{ ...item, message: visibleMessageWithContent(item.message, source, cleaned) }];
    }
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

    const pending: Array<ThinkingItem | ToolItem> = [];
    const flushProcesses = () => {
      // History recovery consumes this projection in native order. Only the
      // desktop display may move a running child and its ancestors together.
      const processes = options.groupLiveToolFamilies
        ? projectProcessVisibility(pending, process => process.status === 'running')
        : pending.map(process => ({ item: process, visible: process.status === 'running', toolDepth: undefined }));
      for (const { item: process, visible, toolDepth } of processes) {
        if (visible) {
          flushSettled();
          normalized.push({
            kind: 'live-process',
            key: `history-live:${process.id}`,
            item: process,
            origin: 'persisted',
            ...(toolDepth === undefined ? {} : { toolDepth }),
          });
        } else {
          settled.push(process);
        }
      }
      pending.length = 0;
    };

    for (const process of item.items) {
      if (process.status === 'running') {
        const latestRootTiming = toolTimingByRootRunId.get(process.runId);
        const terminalTiming =
          latestRootTiming === undefined
            ? terminalTimingByProcessId.get(process.id)
            : latestRootTiming.endedAt !== undefined
              ? latestRootTiming
              : undefined;
        if (terminalTiming || supersededTools.has(process.id)) {
          process.status = 'interrupted';
          process.updatedAt = Math.max(process.updatedAt, terminalTiming?.endedAt ?? 0);
        }
      }
      if (process.type === 'tool' && isQuestionPresentationTool(process)) {
        flushProcesses();
        flushSettled();
        normalized.push({
          kind: 'question-presentation',
          key: `history-question:${process.id}`,
          item: process,
        });
      } else {
        pending.push(process);
      }
    }
    flushProcesses();
    flushSettled();
    return normalized;
  });
  if (!receiptByMessageKey.size) return visibleTimeline;

  const shownReceipts = new Set<string>();
  for (let index = visibleTimeline.length - 1; index >= 0; index -= 1) {
    const item = visibleTimeline[index];
    if (item.kind !== 'history-message') continue;
    const timing = receiptByMessageKey.get(item.key);
    if (!timing || shownReceipts.has(timing.id)) continue;
    shownReceipts.add(timing.id);
    const execution = timing.executionTiming;
    if (execution) {
      item.durationMs = execution.endedAt - execution.startedAt;
      item.completedAt = execution.endedAt;
    }
    item.runReceiptId = timing.id;
    item.runState = timing.state;
    if (timing.modelRef) item.modelRef = timing.modelRef;
  }
  return visibleTimeline;
}
