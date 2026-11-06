import type { NormalizedAgentEvent } from '../../shared/openclaw/agentEvent';
import { PRODUCT_NAME } from '../../shared/productMetadata';
import {
  AppServerNotificationMethod,
  type AppServerNotify,
  isAppServerRecord,
} from './appServerProtocol';

const MAX_TOOL_COUNT = 10_000;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const ToolStatus = { InProgress: 'inProgress', Completed: 'completed', Failed: 'failed' } as const;

interface ToolItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
  status: (typeof ToolStatus)[keyof typeof ToolStatus];
  appContext: null;
  mcpAppUi: null;
  pluginId: null;
  readOnlyHint: null;
  result: { content: unknown[]; structuredContent: unknown; _meta: unknown } | null;
  error: { message: string } | null;
  durationMs: number | null;
}

interface PendingTool {
  item: ToolItem;
  startedAtMs: number | null;
  bytes: number;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Bounded per-turn progress only; completed tool output remains owned by native history. */
export class CodexAppServerToolProgress {
  private readonly pending = new Map<string, PendingTool>();
  private readonly completed = new Set<string>();
  private readonly hidden = new Set<string>();
  private pendingBytes = 0;
  private identityBytes = 0;

  constructor(
    private readonly notify: AppServerNotify,
    private readonly fail: (message: string) => void,
    private readonly beforeTool: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  accept(event: NormalizedAgentEvent): void {
    const data = event.data;
    const id = nonEmptyString(data.toolCallId);
    if (event.stream !== 'tool' || !id || this.completed.has(id) || this.hidden.has(id)) return;

    const previous = this.pending.get(id);
    const identityBytes = previous ? 0 : Buffer.byteLength(id);
    if (data.hideFromChannelProgress === true) {
      if (!previous && !this.admitsIdentity(identityBytes)) return;
      this.identityBytes += identityBytes;
      this.hidden.add(id);
      if (previous) {
        this.pendingBytes -= previous.bytes;
        this.pending.delete(id);
      }
      return;
    }
    if (data.phase !== 'start' && data.phase !== 'update' && data.phase !== 'result') return;

    const item: ToolItem = previous ? { ...previous.item } : {
      type: 'mcpToolCall',
      id,
      server: PRODUCT_NAME,
      tool: 'tool',
      arguments: {},
      status: ToolStatus.InProgress,
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
    item.tool = nonEmptyString(data.name) ?? item.tool;
    if (data.args !== undefined) item.arguments = data.args;

    const current = this.encode(item);
    if (!current) return;
    if (!previous && !this.admitsIdentity(identityBytes)) return;
    if (this.pendingBytes - (previous?.bytes ?? 0) + current.bytes > MAX_PENDING_BYTES) {
      this.fail('Pending tool output exceeded the buffer limit.');
      return;
    }
    const now = this.now();
    const state: PendingTool = {
      item: current.item,
      startedAtMs: previous?.startedAtMs ?? (data.phase === 'start' ? now : null),
      bytes: current.bytes,
    };
    this.pendingBytes += current.bytes - (previous?.bytes ?? 0);
    this.identityBytes += identityBytes;
    this.pending.set(id, state);
    if (!previous) {
      this.beforeTool();
      this.notify(AppServerNotificationMethod.ItemStarted, { item: state.item, startedAtMs: now });
    }
    if (data.phase !== 'result') return;

    const rawOutput = [data.result, data.output, data.partialResult].find(value => value !== undefined);
    const rawRecord = isAppServerRecord(rawOutput) ? rawOutput : undefined;
    const failed = data.isError === true || rawRecord?.isError === true;
    const result = this.result(rawOutput);
    if (result === undefined) return;
    const errorRecord = isAppServerRecord(data.error) ? data.error : undefined;
    const rawError = isAppServerRecord(rawRecord?.error) ? rawRecord.error : undefined;
    const complete = this.encode({
      ...state.item,
      status: failed ? ToolStatus.Failed : ToolStatus.Completed,
      result,
      error: failed ? {
        message: nonEmptyString(data.error) ?? nonEmptyString(errorRecord?.message) ??
          nonEmptyString(rawError?.message) ?? nonEmptyString(data.toolErrorSummary) ??
          'Tool execution failed.',
      } : null,
      durationMs: state.startedAtMs === null ? null : Math.max(0, now - state.startedAtMs),
    });
    if (!complete) return;
    this.pendingBytes -= state.bytes;
    this.pending.delete(id);
    this.completed.add(id);
    this.notify(AppServerNotificationMethod.ItemCompleted, { item: complete.item, completedAtMs: now });
  }

  private admitsIdentity(bytes: number): boolean {
    if (
      this.pending.size + this.completed.size + this.hidden.size >= MAX_TOOL_COUNT ||
      this.identityBytes + bytes > MAX_PENDING_BYTES
    ) {
      this.fail('Tool output exceeded the event limit.');
      return false;
    }
    return true;
  }

  private result(raw: unknown): ToolItem['result'] | undefined {
    if (raw === undefined) return null;
    if (isAppServerRecord(raw) && Array.isArray(raw.content)) {
      return {
        content: raw.content,
        structuredContent: raw.structuredContent === undefined
          ? raw.details ?? null
          : raw.structuredContent,
        _meta: raw._meta ?? null,
      };
    }
    let text: string;
    try {
      text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (typeof text !== 'string') throw new Error('Invalid tool result.');
    } catch {
      this.fail('Tool output could not be serialized.');
      return undefined;
    }
    return {
      content: [{ type: 'text', text }],
      structuredContent: typeof raw === 'string' ? null : raw,
      _meta: null,
    };
  }

  private encode(item: ToolItem): { item: ToolItem; bytes: number } | undefined {
    try {
      const raw = JSON.stringify(item);
      const bytes = Buffer.byteLength(raw);
      if (bytes > MAX_ITEM_BYTES) {
        this.fail('Tool output exceeded the event limit.');
        return undefined;
      }
      return { item: JSON.parse(raw) as ToolItem, bytes };
    } catch {
      this.fail('Tool output could not be serialized.');
      return undefined;
    }
  }
}
