import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { appendErrorDisplayDetail } from '@shared/openclaw/errorDisplay';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';
import { isHiddenNativeMessage } from '@shared/openclaw/messageVisibility';
import {
  FAILED_RUN_MESSAGE_FLAG,
  isFailedRunMessage,
  readFailedRunMessageText,
} from '@shared/openclaw/runFailureDisplay';
import { isGatewayInjectedModelRef, readModelRef } from '@shared/providers/modelRef';

import { getTranscriptMedia } from '../../attachments';
import { normalizeMessage } from '../../pipeline/message-normalizer';
import { cleanFailureDisplayText } from '../../pipeline/system-message-display';
import { type AssistantTurn, type ContentItem, normalizeTranscriptSessionKey } from '../chat-transcript-state';
import { attachedToolMessages, isToolCallRecord, isToolResultType } from '../tools/tool-message-adapter';

export {
  FAILED_RUN_MESSAGE_FLAG,
  FAILED_RUN_MESSAGE_ID,
  isFailedRunMessage,
  readFailedRunMessageText,
} from '@shared/openclaw/runFailureDisplay';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapFailedRunMessage(value: unknown): {
  outer: Record<string, unknown> | null;
  message: Record<string, unknown> | null;
} {
  const outer = asRecord(value);
  return { outer, message: asRecord(outer?.message) ?? outer };
}

const nativeFailureSummary = Symbol('native-failure-summary');
const NATIVE_OUTPUT_CUTOFF = 'The model was cut off at its output token limit. Some work may be unfinished.';
const OUTPUT_CUTOFF_NOTICE_GRACE_MS = 5_000;
const NATIVE_TERMINAL_REPLY_LIMIT = 4_096;

export function isNativeOutputCutoffNotice(message: string): boolean {
  return message.trim().replace(/^⚠[\uFE0E\uFE0F]?\s*/u, '') === NATIVE_OUTPUT_CUTOFF;
}

export function rememberOutputCutoffReply(turn: AssistantTurn | null, event: NormalizedAgentEvent): boolean {
  const { data } = event;
  if (!turn || turn.outputCutoffReply !== undefined || (turn.status !== 'running' && turn.status !== 'error') ||
      event.deliveryEvent !== 'agent' || event.stream !== 'lifecycle' || data.phase !== 'error' ||
      data.executionSettled !== true || data.stopReason !== 'length' || data.aborted === true ||
      typeof data.error !== 'string' || !isNativeOutputCutoffNotice(data.error) ||
      event.runId !== turn.runId || !event.sessionId || event.sessionId !== turn.sessionId ||
      !event.sessionKey || normalizeTranscriptSessionKey(event.sessionKey) !== normalizeTranscriptSessionKey(turn.sessionKey) ||
      (event.lifecycleGeneration && turn.lifecycleGeneration && event.lifecycleGeneration !== turn.lifecycleGeneration) ||
      event.agentSeq <= turn.lastAgentSeq) return false;
  const receipt = asRecord(data.terminalReceipt);
  if (data.terminalReceipt !== undefined &&
      (receipt?.runId !== event.runId || receipt.sessionId !== event.sessionId)) return false;
  const reply = asRecord(data.terminalReply);
  if (reply?.disposition === 'empty' || reply?.disposition === 'silent') {
    turn.outputCutoffReply = null;
    return true;
  }
  if (reply?.disposition !== 'visible' || typeof reply.text !== 'string') return false;
  const text = reply.text.trim();
  // The pinned wire snapshot replaces its tail with an ellipsis when capped.
  if (!text || text.length >= NATIVE_TERMINAL_REPLY_LIMIT || text.endsWith('…') ||
      /^(?:NO_REPLY|HEARTBEAT_OK|<tool_call>)$/iu.test(text) || isNativeOutputCutoffNotice(text)) return false;
  turn.outputCutoffReply = text;
  return true;
}

function cutoffTerminal(turn: AssistantTurn) {
  return turn.items.find(item => item.type === 'terminal' && item.status === 'error' &&
    item.runId === turn.runId && isNativeOutputCutoffNotice(item.message));
}

export function pendingOutputCutoffDeadline(turn: AssistantTurn | null, now: number): number | undefined {
  if (turn?.status !== 'error' || turn.outputCutoffReply !== undefined || turn.endedAt === undefined ||
      !Number.isFinite(turn.endedAt) ||
      !cutoffTerminal(turn)) return;
  const deadline = turn.endedAt + OUTPUT_CUTOFF_NOTICE_GRACE_MS;
  if (deadline > now) return deadline;
}

/** Preserve only Gateway display copy on this in-memory, source-owned projection. */
export function withNativeFailureSummary<T extends object>(message: T, summary: string): T {
  return summary.trim() ? { ...message, [nativeFailureSummary]: summary.trim() } : message;
}

export function readNativeFailureSummary(value: unknown): string {
  const { message } = unwrapFailedRunMessage(value);
  const summary = (message as { [nativeFailureSummary]?: unknown } | null)?.[nativeFailureSummary];
  return typeof summary === 'string' ? summary : '';
}

function nativeFailureRunId(value: unknown): string | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
  const runId = marker?.runId ?? message?.runId ?? outer?.runId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : null;
}

function cutoffRunId(value: unknown): string | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  const owners = [message, outer, asRecord(message?.__openclaw), asRecord(outer?.__openclaw),
    asRecord(message?.metadata), asRecord(outer?.metadata)];
  const ids = owners.flatMap(owner => [owner?.runId, owner?.run_id])
    .flatMap(value => typeof value === 'string' && value.trim() ? [value.trim()] : []);
  return ids[0] && ids.every(id => id === ids[0]) ? ids[0] : null;
}

export function isPureOutputCutoffFailure(value: unknown): boolean {
  if (!isFailedRunMessage(value) || !isNativeOutputCutoffNotice(readFailedRunMessageText(value)) || !cutoffRunId(value))
    return false;
  const { outer, message } = unwrapFailedRunMessage(value);
  if (!outer || !message) return false;
  return [outer, message].every(row =>
    !attachedToolMessages(row).length && !getTranscriptMedia(row).length &&
    !(Array.isArray(row.activity) && row.activity.length > 0) &&
    !asRecord(row.openclawDelivery) &&
    (typeof row.content === 'string' || row.content === undefined ||
      (Array.isArray(row.content) && row.content.every(block => asRecord(block)?.type === 'text'))),
  );
}

/** A successful, visible native assistant row after the last tool is evidence of reply delivery only. */
function recoveredCutoffSummary(messages: readonly unknown[], runId: string): string | undefined {
  let summary: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index];
    const { outer, message } = unwrapFailedRunMessage(value);
    const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
    if ((marker?.runId ?? marker?.run_id) !== runId || typeof marker?.id !== 'string' || !marker.id.trim()) continue;
    if (cutoffRunId(value) !== runId) return;
    if (message?.role === 'toolResult') return summary;
    if (message?.role !== 'assistant' || isFailedRunMessage(value)) continue;
    if (summary) continue;
    if (
      (message.stopReason ?? message.stop_reason) !== 'stop' || marker.truncated === true ||
      message.endTurn === false || outer?.endTurn === false ||
      message.phase === 'commentary' || message.channel === 'commentary' ||
      outer?.phase === 'commentary' || outer?.channel === 'commentary' ||
      asRecord(message.openclawStreamFallback)?.source === 'segment' ||
      asRecord(outer?.openclawStreamFallback)?.source === 'segment' ||
      isHiddenNativeMessage(value) || isGatewayInjectedModelRef(readModelRef(message)) ||
      isToolCallRecord(message) || (Array.isArray(message.content) && message.content.some(block => {
        const raw = asRecord(block);
        return raw && (isToolCallRecord(raw) || isToolResultType(raw.type) || raw.openclawStatusNotice === true);
      }))
    ) return;
    const normalized = normalizeMessage(message);
    if (normalized.role !== 'assistant') return;
    const text = normalized.content.flatMap(block => block.type === 'text' && block.text ? [block.text] : [])
      .join('\n').trim();
    if (!text || /^(?:NO_REPLY|HEARTBEAT_OK)$/u.test(text) || isNativeOutputCutoffNotice(text)) return;
    summary = text;
  }
}

export function shouldRetainCutoffDisplay(turn: AssistantTurn, messages: readonly unknown[], now: number): boolean {
  return Boolean(cutoffTerminal(turn) &&
    (typeof turn.outputCutoffReply === 'string' || pendingOutputCutoffDeadline(turn, now) !== undefined) &&
    !recoveredCutoffSummary(messages, turn.runId));
}

/** Remove the duplicate failure row from presentation once the same-run reply can be shown. */
export function projectRecoveredOutputCutoffMessages<T>(messages: T[]): T[] {
  const recovered = new Map<string, boolean>();
  return messages.filter(value => {
    if (!isPureOutputCutoffFailure(value)) return true;
    const runId = cutoffRunId(value);
    if (!runId) return true;
    if (!recovered.has(runId)) recovered.set(runId, recoveredCutoffSummary(messages, runId) !== undefined);
    return recovered.get(runId) !== true;
  });
}

export function readAssistantFailureDetail(value: unknown): string {
  const { message } = unwrapFailedRunMessage(value);
  const modelFailure =
    message?.role === 'assistant' ||
    (message?.role === 'system' && message[FAILED_RUN_MESSAGE_FLAG] === true);
  if (!(
    message &&
    modelFailure &&
    (message.stopReason ?? message.stop_reason) === 'error' &&
    typeof message.errorMessage === 'string' &&
    !isInternalManagedSubagentHandoffError(message.errorMessage)
  ))
    return '';
  return appendErrorDisplayDetail('', message.errorMessage);
}

export function readNativeFailureDetails(messages: readonly unknown[], runId: string): string {
  const details = messages.flatMap(value => {
    const { outer, message } = unwrapFailedRunMessage(value);
    const marker = asRecord(message?.__openclaw) ?? asRecord(outer?.__openclaw);
    const detail = readAssistantFailureDetail(value);
    return typeof marker?.id === 'string' &&
      marker.id.trim() &&
      nativeFailureRunId(value) === runId &&
      detail
      ? [detail]
      : [];
  });
  return [...new Set(details)].join(' · ');
}

/** Enrich only a presentation copy; native execution/terminal state remains unchanged. */
export function withFailureDetailsForDisplay(
  turn: AssistantTurn | null,
  messages: readonly unknown[],
  holdCutoffNotice = false,
): AssistantTurn | null {
  if (!turn || turn.status !== 'error') return turn;
  const { runId } = turn;
  const cutoff = cutoffTerminal(turn);
  if (cutoff) {
    const settledReply = turn.outputCutoffReply;
    const recoveredSummary = settledReply === undefined ? recoveredCutoffSummary(messages, runId) : settledReply;
    const isReplyContent = (item: AssistantTurn['items'][number]): item is ContentItem =>
      item.type === 'content' && item.runId === runId && item.preambleItemId === undefined &&
        !item.assistantTextScopeSuppressed && !item.assistantTextSourcePending;
    const alreadyDisplayed = recoveredSummary && turn.items.some(item =>
      isReplyContent(item) && item.text.trim() === recoveredSummary);
    if (alreadyDisplayed || holdCutoffNotice || settledReply) {
      // A terminal retraction can interrupt the summary preview. Replace only
      // its proven prefix after the last settled tool, keeping earlier text.
      const beforeCutoff = settledReply && !alreadyDisplayed ? turn.items.slice(0, turn.items.indexOf(cutoff)) : [];
      const lastTool = beforeCutoff.reduce((last, item, index) =>
        item.type === 'tool' && item.runId === runId && item.status === 'completed' ? index : last, -1);
      const replyTail = lastTool >= 0 ? beforeCutoff.slice(lastTool + 1).filter(isReplyContent) : [];
      const candidate = replyTail.length === 1 && replyTail[0].status === 'interrupted' ? replyTail[0] : undefined;
      const preview = settledReply && candidate?.text.trim() && settledReply.startsWith(candidate.text.trim())
        ? candidate : undefined;
      turn = { ...turn, items: turn.items.flatMap(item => {
        if (preview && item === preview && settledReply) {
          return [{ ...preview, status: 'completed' as const, sourceMode: 'snapshot' as const, text: settledReply }];
        }
        if (item !== cutoff) return [item];
        return settledReply && !alreadyDisplayed && !preview
          ? [{ ...cutoff, type: 'content' as const, status: 'completed' as const, sourceMode: 'snapshot' as const,
              text: settledReply }]
          : [];
      }) };
    }
  }
  const sources = messages.flatMap(value => {
    const detail = readNativeFailureDetails([value], runId);
    return detail ? [{ detail, summary: readNativeFailureSummary(value) }] : [];
  });
  if (!sources.length) return turn;
  let changed = false;
  const items = turn.items.map(item => {
    if (item.type !== 'terminal') return item;
    let detail = '';
    for (const source of sources) {
      let displayed = cleanFailureDisplayText(`${item.message}\n${detail}`);
      const parts: string[] = [];
      for (const part of [source.summary, source.detail].map(cleanFailureDisplayText)) {
        if (!part || displayed.includes(part)) continue;
        parts.push(part);
        displayed += `\n${part}`;
      }
      const block = parts.join('\n');
      if (block) detail = detail ? `${detail}\n\n${block}` : block;
    }
    const message = appendErrorDisplayDetail(item.message, detail);
    if (message === item.message) return item;
    changed = true;
    return { ...item, message };
  });
  return changed ? { ...turn, items } : turn;
}

export function readUncoveredFailureDetail(value: unknown, messages: readonly unknown[]): string {
  // Normalized failure rows already render their diagnostic as their content.
  // A source without a run id cannot use the cross-message coverage check below.
  if (isFailedRunMessage(value)) return '';
  const detail = readAssistantFailureDetail(value);
  const runId = nativeFailureRunId(value);
  return detail &&
    !(
      runId &&
      messages.some(
        message =>
          isFailedRunMessage(message) &&
          nativeFailureRunId(message) === runId &&
          readFailedRunMessageText(message).includes(detail),
      )
    )
    ? detail
    : '';
}

export function readFailedRunMessageModelRef(value: unknown): string {
  const { outer, message } = unwrapFailedRunMessage(value);
  const modelRef = readModelRef(message) ?? readModelRef(outer);
  return modelRef && !isGatewayInjectedModelRef(modelRef) ? modelRef : '';
}

export function readFailedRunMessageTimestamp(value: unknown): number | null {
  const { outer, message } = unwrapFailedRunMessage(value);
  for (const timestamp of [message?.timestamp, message?.ts, outer?.timestamp, outer?.ts]) {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
    if (typeof timestamp !== 'string' || !timestamp.trim()) continue;
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
