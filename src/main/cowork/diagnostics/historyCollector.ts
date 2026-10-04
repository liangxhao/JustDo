import type {
  DiagnosticHistoryEvidence,
  DiagnosticReport,
} from '../../../shared/cowork/sessionDiagnostics';
import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  parseChatHistoryCursorResultV2026_9_8,
  parseChatHistoryResultV2026_9_8,
} from '../../engine/openclaw/wire/v2026_9_8';
import { redactDiagnosticLog } from './exportLogs';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Read the native database through its owner, processing one page at a time. */
export async function collectDiagnosticHistory(
  report: DiagnosticReport,
  client: GatewayClientLike | null | undefined,
  sessionKey: string | null,
  signal?: AbortSignal,
): Promise<DiagnosticHistoryEvidence> {
  const evidence: DiagnosticHistoryEvidence = {
    status: 'unavailable',
    messagesScanned: 0,
    omitted: 0,
    failures: [],
  };
  if (!client || !report.run || !sessionKey || signal?.aborted) return evidence;
  const runIds = new Set(report.events.map(event => event.nativeRunId).filter(Boolean));
  const seen = new Set<string>();
  const request = async (params: Record<string, unknown>) => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.request('chat.history', { sessionKey, ...params }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const inspect = (raw: unknown) => {
    const message = record(raw);
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
    const candidates = [
      message,
      ...(Array.isArray(message.content) ? message.content.map(record) : []),
    ];
    for (const item of candidates) {
      const tool = ['toolResult', 'tool_result', 'tool', 'function'].includes(
        text(item.role) || text(item.type),
      );
      const details = record(item.details);
      const exitCode = details.exitCode;
      const failed =
        item.isError === true ||
        details.status === 'error' ||
        (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode !== 0);
      const model =
        item.role === 'assistant' && (item.stopReason === 'error' || item.stopReason === 'aborted');
      if (!(tool && failed) && !model) continue;
      const content = Array.isArray(item.content)
        ? item.content
            .map(block => record(block))
            .filter(block => block.type === 'text')
            .map(block => text(block.text))
            .join('\n')
        : text(item.content);
      const original =
        text(item.errorMessage) ||
        content ||
        text(item.text) ||
        text(details.error) ||
        text(details.aggregated);
      // Redact before clipping so truncation cannot expose a partial credential.
      const sanitized = redactDiagnosticLog(original);
      const excerpt = sanitized.slice(0, 1600);
      const name = redactDiagnosticLog(text(item.toolName) || text(item.name)).slice(0, 100);
      const identity = JSON.stringify([text(item.toolCallId), timestamp, name, excerpt]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (evidence.failures.length >= 40) {
        evidence.omitted++;
        continue;
      }
      evidence.failures.push({
        timestamp,
        kind: tool ? 'tool' : 'model',
        ...(name ? { tool: name } : {}),
        excerpt,
        clipped: sanitized.length > 1600 || metadata.truncated === true,
        association: runId && runIds.has(runId) ? 'run' : 'run_window',
      });
    }
  };
  let needsVerification = false;
  try {
    let offset = 0;
    let total: number | undefined;
    let cursor: string | undefined;
    evidence.status = 'partial';
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = parseChatHistoryResultV2026_9_8(
        await request({ limit: 200, offset, maxChars: 8000 }),
      );
      signal?.throwIfAborted();
      if (pageNumber === 0) {
        total = page.totalMessages;
        cursor = page.deltaCursor;
        needsVerification = Boolean(cursor);
      } else if (total !== page.totalMessages) {
        evidence.status = 'changed';
        evidence.failures = [];
        return evidence;
      }
      for (const message of page.messages) {
        evidence.messagesScanned++;
        inspect(message);
      }
      if (!page.hasMore) {
        evidence.status = 'scanned';
        break;
      }
      if (page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    if (cursor) {
      const delta = parseChatHistoryCursorResultV2026_9_8(await request({ cursor }));
      needsVerification = false;
      if (delta.kind === 'reset') {
        evidence.status = 'changed';
        evidence.failures = [];
      } else
        for (const message of delta.messages) {
          evidence.messagesScanned++;
          inspect(message);
        }
    }
  } catch {
    // A failed page or final check can leave rows from mixed history generations.
    if (needsVerification) evidence.failures = [];
    evidence.status = evidence.messagesScanned ? 'partial' : 'unavailable';
  }
  evidence.failures.sort((a, b) => a.timestamp - b.timestamp);
  return evidence;
}
