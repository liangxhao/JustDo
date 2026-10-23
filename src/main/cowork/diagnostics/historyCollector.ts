import { projectDiagnosticResponse } from '../../../shared/cowork/diagnostics/diagnosticResponse';
import { identifyDiagnosticRuntimeFailure } from '../../../shared/cowork/diagnostics/diagnosticRuntimeFailure';
import type {
  DiagnosticHistoryEvidence,
  DiagnosticReport,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  parseChatHistoryCursorResultV2026_10_4,
  parseChatHistoryResultV2026_10_4,
} from '../../engine/openclaw/wire/v2026_10_4';
import { redactDiagnosticLog } from './exportLogs';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const toolResult = (item: Record<string, unknown>) =>
  ['toolresult', 'tool_result', 'tool', 'function'].includes(
    (text(item.role) || text(item.type)).toLowerCase(),
  );

/** Read the native database through its owner, processing one page at a time. */
export async function collectDiagnosticHistory(
  report: DiagnosticReport,
  client: GatewayClientLike | null | undefined,
  sessionKey: string | null,
  signal?: AbortSignal,
  nativeRunIds: readonly string[] = [],
): Promise<DiagnosticHistoryEvidence> {
  const evidence: DiagnosticHistoryEvidence = {
    status: 'unavailable',
    messagesScanned: 0,
    omitted: 0,
    failures: [],
  };
  if (!client || !report.run || !sessionKey || signal?.aborted) {
    evidence.reason = signal?.aborted
      ? 'canceled'
      : !report.run
        ? 'no_run'
        : !sessionKey
          ? 'no_binding'
          : 'offline';
    return evidence;
  }
  const runIds = new Set([
    ...report.events.map(event => event.nativeRunId).filter(Boolean),
    ...nativeRunIds,
  ]);
  const seen = new Set<string>();
  const latestResponses = new Map<string, NonNullable<DiagnosticHistoryEvidence['lastResponse']>>();
  let anonymousResponse = 0;
  const request = async (params: Record<string, unknown>) => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        client.request('chat.history', { sessionKey, ...params }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 5000);
          onAbort = () => reject(new Error('canceled'));
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  const inspect = (raw: unknown, activities: Map<string, Record<string, unknown>[]>) => {
    const message = record(raw);
    if (message.role === 'user' || message.role === 'system') return;
    const metadata = record(message.__openclaw);
    const rawTime = message.timestamp;
    const timestamp = typeof rawTime === 'number' ? rawTime : Date.parse(text(rawTime));
    const runId = text(message.runId) || text(metadata.runId);
    if (runId && runIds.size && !runIds.has(runId)) return;
    if (
      !Number.isFinite(timestamp) ||
      timestamp < report.run!.startedAt ||
      timestamp > (report.run!.endedAt ?? report.collectedAt)
    )
      return;
    const response = projectDiagnosticResponse(
      message,
      timestamp,
      runId && runIds.has(runId) ? 'run' : 'run_window',
    );
    if (response && (!evidence.lastResponse || timestamp >= evidence.lastResponse.timestamp)) {
      if (!evidence.lastResponse || timestamp > evidence.lastResponse.timestamp)
        latestResponses.clear();
      // Native byte-budget pagination can replay a boundary record. Replace that
      // observation, while distinct/unidentified replies at the same time stay uncertain.
      const responseId = text(metadata.id)
        ? JSON.stringify([metadata.id, record(metadata.transcriptPosition).source])
        : `anonymous:${++anonymousResponse}`;
      latestResponses.set(responseId, response);
      evidence.lastResponse = {
        ...response,
        complete: response.complete && latestResponses.size === 1,
      };
    }
    // Native fallback IDs count only tool-bearing blocks, including calls.
    // Result envelopes own a single outcome even if their content mirrors it.
    const blocks = (Array.isArray(message.content) ? message.content.map(record) : []).filter(
      item =>
        ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'toolresult', 'tool_result'].includes(
          text(item.type).toLowerCase(),
        ),
    );
    const candidates = toolResult(message) ? [message] : [message, ...blocks];
    // 9.8 strips execution details from display messages. The sidecar is built
    // before sanitation and is the native authority for failed/blocked steps.
    const activity = activities.get(text(metadata.id)) ?? [];
    for (const [index, item] of candidates.entries()) {
      const tool = toolResult(item);
      const callId =
        text(item.toolCallId).trim() ||
        text(item.tool_call_id).trim() ||
        text(item.toolUseId).trim() ||
        text(item.tool_use_id).trim() ||
        (item !== message ? text(item.id).trim() : '') ||
        (text(metadata.id)
          ? `history:${text(metadata.id)}:${item === message ? 0 : index - 1}`
          : '');
      const native = activity.find(
        entry => text(entry.toolCallId) === callId && callId && entry.phase === 'end',
      );
      const details = record(item.details);
      const exitCode = details.exitCode;
      const failed =
        native?.status === 'failed' ||
        native?.status === 'blocked' ||
        item.isError === true ||
        item.is_error === true ||
        ['error', 'failed', 'timeout', 'blocked'].includes(text(details.status)) ||
        (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode !== 0);
      const model =
        item.role === 'assistant' && (item.stopReason === 'error' || item.stopReason === 'aborted');
      const runtime = item.role === 'custom' && item.customType === 'run-failed-before-reply';
      if (!(tool && failed) && !model && !runtime) continue;
      const content = Array.isArray(item.content)
        ? item.content
            .map(block => record(block))
            .filter(block => block.type === 'text')
            .map(block => text(block.text))
            .join('\n')
        : text(item.content);
      const original =
        text(item.errorMessage) ||
        text(native?.error) ||
        content ||
        text(item.text) ||
        text(details.error) ||
        text(details.aggregated) ||
        text(native?.summary);
      // Redact before clipping so truncation cannot expose a partial credential.
      const sanitized = redactDiagnosticLog(original);
      const excerpt = sanitized.slice(0, 1600);
      const name = redactDiagnosticLog(
        text(item.toolName) || text(item.name) || text(native?.name),
      ).slice(0, 100);
      const identity = JSON.stringify([text(metadata.id), callId, timestamp, name, excerpt]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const cause = runtime
        ? details.errorKind === 'state_contention'
          ? ('state_contention' as const)
          : metadata.truncated === true
            ? undefined
            : identifyDiagnosticRuntimeFailure(content || text(item.text))
        : undefined;
      const failure: DiagnosticHistoryEvidence['failures'][number] = {
        timestamp,
        kind: tool ? 'tool' : runtime ? 'runtime' : 'model',
        ...(name ? { tool: name } : {}),
        excerpt,
        clipped: sanitized.length > 1600 || metadata.truncated === true,
        association: runId && runIds.has(runId) ? 'run' : 'run_window',
        ...(cause ? { cause } : {}),
        basis: runtime
          ? 'failure_receipt'
          : model
            ? 'model'
            : native?.status === 'failed' || native?.status === 'blocked'
              ? 'activity'
              : 'result',
        outcome:
          item.stopReason === 'aborted'
            ? 'aborted'
            : native?.status === 'blocked' || details.status === 'blocked'
              ? 'blocked'
              : 'failed',
      };
      if (evidence.failures.length >= 40) {
        evidence.omitted++;
        const rank = (item: DiagnosticHistoryEvidence['failures'][number]) =>
          (item.association === 'run' ? 4 : 0) + (item.kind === 'tool' ? 0 : 2);
        // Preserve exact-run evidence first, then model/runtime failures.
        // Within the same class, retain recent failures rather than only early noise.
        const weakest = evidence.failures.reduce(
          (index, item, candidate) =>
            rank(item) < rank(evidence.failures[index]) ||
            (rank(item) === rank(evidence.failures[index]) &&
              item.timestamp < evidence.failures[index].timestamp)
              ? candidate
              : index,
          0,
        );
        const previous = evidence.failures[weakest];
        if (
          rank(failure) < rank(previous) ||
          (rank(failure) === rank(previous) && failure.timestamp < previous.timestamp)
        )
          continue;
        evidence.failures.splice(weakest, 1);
      }
      evidence.failures.push(failure);
    }
  };
  const inspectPage = (page: { messages: unknown[]; activity?: unknown[] }, delta = false) => {
    const activities = new Map<string, Record<string, unknown>[]>();
    for (const raw of page.activity ?? []) {
      const entry = record(raw);
      if (typeof entry.messageId === 'string' && Array.isArray(entry.items))
        activities.set(entry.messageId, entry.items.map(record));
    }
    for (const raw of page.messages) {
      let message = raw;
      if (delta) {
        // Cursor deltas contain session.message envelopes, unlike full pages.
        const envelope = record(raw);
        const nested = record(envelope.message);
        const metadata = record(nested.__openclaw);
        if (envelope.sessionKey !== sessionKey) throw new Error('history_changed');
        if (typeof nested.role !== 'string') throw new Error('invalid_delta');
        if (
          (envelope.messageId && metadata.id && envelope.messageId !== metadata.id) ||
          (envelope.runId && metadata.runId && envelope.runId !== metadata.runId) ||
          (envelope.runId && nested.runId && envelope.runId !== nested.runId)
        )
          throw new Error('history_changed');
        message = {
          ...nested,
          ...(text(envelope.runId) ? { runId: envelope.runId } : {}),
          __openclaw: {
            ...metadata,
            ...(text(envelope.messageId) ? { id: envelope.messageId } : {}),
          },
        };
      }
      evidence.messagesScanned++;
      inspect(message, activities);
    }
  };
  let needsVerification = false;
  try {
    let offset = 0;
    let total: number | undefined;
    let cursor: string | undefined;
    evidence.status = 'partial';
    evidence.reason = 'page_limit';
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = parseChatHistoryResultV2026_10_4(
        await request({ limit: 200, offset, maxChars: 8000 }),
      );
      signal?.throwIfAborted();
      if (pageNumber === 0) {
        total = page.totalMessages;
        cursor = page.deltaCursor;
        needsVerification = Boolean(cursor);
      } else if (total !== page.totalMessages) {
        evidence.status = 'changed';
        evidence.reason = 'history_changed';
        evidence.failures = [];
        delete evidence.lastResponse;
        return evidence;
      }
      inspectPage(page);
      if (!page.hasMore) {
        evidence.status = 'scanned';
        delete evidence.reason;
        break;
      }
      if (page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    if (cursor) {
      const delta = parseChatHistoryCursorResultV2026_10_4(await request({ cursor }));
      needsVerification = false;
      if (delta.kind === 'reset') {
        evidence.status = 'changed';
        evidence.reason = 'history_changed';
        evidence.failures = [];
        delete evidence.lastResponse;
      } else inspectPage(delta, true);
    }
  } catch (error) {
    // A failed page or final check can leave rows from mixed history generations.
    const changed = error instanceof Error && error.message === 'history_changed';
    if (needsVerification || changed) {
      evidence.failures = [];
      delete evidence.lastResponse;
    }
    evidence.status = changed ? 'changed' : evidence.messagesScanned ? 'partial' : 'unavailable';
    evidence.reason = changed
      ? 'history_changed'
      : signal?.aborted
        ? 'canceled'
        : error instanceof Error && error.message === 'timeout'
          ? 'timeout'
          : 'read_failed';
  }
  evidence.failures.sort((a, b) => a.timestamp - b.timestamp);
  return evidence;
}
