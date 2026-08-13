import type { NormalizedAgentEvent, NormalizedChatEvent } from './agentEvent';

export type MessageDomainAdmission =
  | 'admitted'
  | 'bind-provisional-run'
  | 'start-run'
  | 'ignored-session'
  | 'ignored-run'
  | 'ignored-sequence'
  | 'ignored-terminal';

export interface MessageDomainRun {
  runId: string;
  sessionId: string | null;
  lifecycleGeneration: string | null;
  lastAgentSeq: number;
  status: 'running' | 'final' | 'aborted' | 'error';
}

/**
 * Gateway events may use either `justdo:<id>` or
 * `agent:<agent-id>:justdo:<id>` for the same managed session. No other suffix
 * relationship is an alias.
 */
export function normalizeMessageSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  const managed = /^(?:agent:[^:]+:)?justdo:([^:]+)$/.exec(trimmed);
  return managed ? `justdo:${managed[1]}` : trimmed;
}

export function messageSessionMatches(
  selected: { sessionKey: string; sessionId: string | null },
  event: { sessionKey: string | null; sessionId: string | null },
): boolean {
  if (event.sessionId && selected.sessionId && event.sessionId !== selected.sessionId) return false;
  if (!event.sessionKey) return true;
  return (
    normalizeMessageSessionKey(event.sessionKey) ===
    normalizeMessageSessionKey(selected.sessionKey)
  );
}

export function classifyAgentEvent(params: {
  selected: { sessionKey: string; sessionId: string | null };
  activeRun: MessageDomainRun | null;
  event: NormalizedAgentEvent;
  terminalRun?: boolean;
}): MessageDomainAdmission {
  const { activeRun, event } = params;
  if (!messageSessionMatches(params.selected, event)) return 'ignored-session';
  if (params.terminalRun) return 'ignored-terminal';
  if (!activeRun) return event.spawnedBy ? 'ignored-run' : 'start-run';
  if (activeRun.runId !== event.runId) {
    if (activeRun.status !== 'running') return event.spawnedBy ? 'ignored-run' : 'start-run';
    return activeRun.runId.startsWith('justdo-') ? 'bind-provisional-run' : 'ignored-run';
  }
  if (activeRun.sessionId && event.sessionId && activeRun.sessionId !== event.sessionId) {
    return 'ignored-session';
  }
  if (
    activeRun.lifecycleGeneration &&
    event.lifecycleGeneration &&
    activeRun.lifecycleGeneration !== event.lifecycleGeneration
  ) {
    return 'ignored-run';
  }
  if (event.agentSeq <= activeRun.lastAgentSeq) return 'ignored-sequence';
  return 'admitted';
}

export function classifyChatEvent(params: {
  selected: { sessionKey: string; sessionId: string | null };
  activeRun: MessageDomainRun | null;
  event: NormalizedChatEvent;
}): MessageDomainAdmission {
  const { activeRun, event } = params;
  if (!messageSessionMatches(params.selected, event)) return 'ignored-session';
  if (!activeRun) return event.state === 'delta' && event.runId ? 'start-run' : 'ignored-run';
  if (event.runId && activeRun.runId !== event.runId) {
    return activeRun.runId.startsWith('justdo-') ? 'bind-provisional-run' : 'ignored-run';
  }
  if (event.sessionId && activeRun.sessionId && event.sessionId !== activeRun.sessionId) {
    return 'ignored-session';
  }
  if (
    event.lifecycleGeneration &&
    activeRun.lifecycleGeneration &&
    event.lifecycleGeneration !== activeRun.lifecycleGeneration
  ) {
    return 'ignored-run';
  }
  return 'admitted';
}

export function normalizeToolTerminalStatus(
  phase: unknown,
  failed: boolean,
): 'running' | 'completed' | 'failed' | 'cancelled' {
  const normalized = typeof phase === 'string' ? phase.trim().toLowerCase() : '';
  if (failed || normalized === 'error' || normalized === 'failed') return 'failed';
  if (
    normalized === 'cancel' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'aborted'
  ) {
    return 'cancelled';
  }
  if (
    normalized === 'result' ||
    normalized === 'end' ||
    normalized === 'complete' ||
    normalized === 'completed' ||
    normalized === 'done' ||
    normalized === 'finish' ||
    normalized === 'finished'
  ) {
    return 'completed';
  }
  return 'running';
}

export interface NormalizedToolEvent {
  toolCallId: string | null;
  name: string;
  input?: unknown;
  output: string | null;
  error: string | null;
  failed: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readableToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap(entry => {
      const record = asRecord(entry);
      if (!record) return typeof entry === 'string' ? [entry] : [];
      if (typeof record.text === 'string') return [record.text];
      return record.content === undefined ? [] : [readableToolValue(record.content)];
    });
    if (parts.length > 0) return parts.join('\n');
  }
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function meaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return Boolean(value.trim() && value.trim() !== '{}');
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== 'object' || Object.keys(value).length > 0;
}

function coerceToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function outputIndicatesToolFailure(output: string | null): boolean {
  if (!output) return false;
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (/^tool not found\.?$/i.test(trimmed)) return true;
  if (trimmed.length > 20_000 || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return false;
    if (record.isError === true || record.is_error === true) return true;
    if (typeof record.error === 'string') return Boolean(record.error.trim());
    if (record.error === true || (record.error && typeof record.error === 'object')) return true;
    const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
    return status === 'error' || status === 'failed' || status === 'timeout';
  } catch {
    return false;
  }
}

export function normalizeToolEvent(
  data: Record<string, unknown>,
  fallbackName = 'tool',
): NormalizedToolEvent {
  const metadata = asRecord(data.metadata);
  const toolCallId = firstString(
    data.toolCallId,
    data.tool_call_id,
    data.toolUseId,
    data.tool_use_id,
    data.callId,
    data.id,
    metadata?.toolCallId,
    metadata?.toolUseId,
  );
  const name =
    firstString(data.name, data.toolName, data.tool_name, metadata?.toolName) ?? fallbackName;
  let input: unknown;
  for (const candidate of [
    data.toolInput,
    data.tool_input,
    data.arguments,
    data.args,
    data.input,
    metadata?.toolInput,
    metadata?.arguments,
    metadata?.args,
    metadata?.input,
    data.partialArgs,
  ]) {
    const coerced = coerceToolInput(candidate);
    if (meaningfulToolInput(coerced)) {
      input = coerced;
      break;
    }
  }
  let output: string | null = null;
  for (const candidate of [
    data.result,
    data.partialResult,
    data.output,
    data.content,
    data.text,
    data.toolResult,
    data.summary,
    metadata?.toolResult,
  ]) {
    if (candidate !== undefined && candidate !== null) {
      output = readableToolValue(candidate);
      break;
    }
  }
  const rawError = data.error;
  const phase = typeof data.phase === 'string' ? data.phase.trim().toLowerCase() : '';
  const rawStatus = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
  const failed =
    data.isError === true ||
    data.is_error === true ||
    rawError === true ||
    (typeof rawError === 'string' && Boolean(rawError.trim())) ||
    (Boolean(rawError) && typeof rawError === 'object') ||
    rawStatus === 'error' ||
    rawStatus === 'failed' ||
    rawStatus === 'timeout' ||
    outputIndicatesToolFailure(output);
  const error =
    rawError === undefined || rawError === null || rawError === false
      ? null
      : readableToolValue(rawError);
  return {
    toolCallId,
    name,
    ...(input !== undefined ? { input } : {}),
    output,
    error,
    failed,
    status: normalizeToolTerminalStatus(phase, failed),
  };
}
