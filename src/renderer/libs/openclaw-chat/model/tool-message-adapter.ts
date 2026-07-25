import { isToolErrorOutput } from '@/libs/openclaw-chat/pipeline/tool-cards';

export function asToolRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function unwrapToolMessage(value: unknown): Record<string, unknown> | null {
  const record = asToolRecord(value);
  if (!record) return null;
  return asToolRecord(record.message) ?? record;
}

function metadataOf(value: Record<string, unknown>): Record<string, unknown> | null {
  return asToolRecord(value.metadata);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
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

function hasMeaningfulToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function readToolCallId(
  value: Record<string, unknown>,
  fallback: string | null = null,
): string | null {
  const metadata = metadataOf(value);
  return (
    firstString(
      value.toolCallId,
      value.tool_call_id,
      value.toolUseId,
      value.tool_use_id,
      value.callId,
      value.id,
      metadata?.toolCallId,
      metadata?.tool_call_id,
      metadata?.toolUseId,
      metadata?.tool_use_id,
    ) ?? fallback
  );
}

export function readToolName(value: Record<string, unknown>, fallback = 'tool'): string {
  const metadata = metadataOf(value);
  return (
    firstString(
      value.name,
      value.toolName,
      value.tool_name,
      metadata?.toolName,
      metadata?.tool_name,
    ) ?? fallback
  );
}

export function readToolInput(value: Record<string, unknown>): unknown {
  const metadata = metadataOf(value);
  for (const candidate of [
    value.toolInput,
    value.tool_input,
    value.arguments,
    value.args,
    value.input,
    metadata?.toolInput,
    metadata?.tool_input,
    metadata?.arguments,
    metadata?.args,
    metadata?.input,
  ]) {
    const coerced = coerceToolInput(candidate);
    if (hasMeaningfulToolInput(coerced)) return coerced;
  }
  return coerceToolInput(value.partialArgs ?? metadata?.partialArgs);
}

function readableOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap(entry => {
      const record = asToolRecord(entry);
      if (!record) return typeof entry === 'string' ? [entry] : [];
      const text = firstString(record.text);
      if (text !== null) return [text];
      if (record.content !== undefined) return [readableOutput(record.content)];
      return [];
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

export function readToolOutput(value: Record<string, unknown>): string | null {
  const metadata = metadataOf(value);
  for (const candidate of [
    value.result,
    value.partialResult,
    value.output,
    value.content,
    value.text,
    value.toolResult,
    metadata?.toolResult,
  ]) {
    if (candidate !== undefined && candidate !== null) return readableOutput(candidate);
  }
  return null;
}

export function readToolError(
  value: Record<string, unknown>,
  output: string | null = readToolOutput(value),
): { failed: boolean; message: string | null } {
  const explicitFlag = value.isError ?? value.is_error;
  const status = firstString(value.status)?.toLowerCase() ?? '';
  const rawError = value.error;
  const failed =
    explicitFlag === true ||
    rawError === true ||
    (typeof rawError === 'string' && rawError.trim().length > 0) ||
    (Boolean(rawError) && typeof rawError === 'object') ||
    status === 'error' ||
    status === 'failed' ||
    status === 'timeout' ||
    isToolErrorOutput(output ?? undefined);
  const message =
    rawError === undefined || rawError === null || rawError === false
      ? null
      : readableOutput(rawError);
  return { failed, message };
}

export function isToolCallType(value: unknown): boolean {
  const type = typeof value === 'string' ? value.toLowerCase() : '';
  return type === 'toolcall' || type === 'tool_call' || type === 'tooluse' || type === 'tool_use';
}

export function isToolCallRecord(value: Record<string, unknown>): boolean {
  return (
    isToolCallType(value.type) ||
    (typeof value.name === 'string' &&
      (value.arguments !== undefined ||
        value.args !== undefined ||
        value.input !== undefined ||
        value.partialArgs !== undefined))
  );
}

export function isToolResultType(value: unknown): boolean {
  const type = typeof value === 'string' ? value.toLowerCase() : '';
  return type === 'toolresult' || type === 'tool_result';
}

export function attachedToolMessages(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.__justdoAttachedToolMessages)
    ? value.__justdoAttachedToolMessages
    : [];
}
