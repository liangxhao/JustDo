import type { AgentEventPayload, SessionTurn, ToolStreamEntry } from '../gateway/types';
import { isRecord } from '../utils/gatewayHelpers';

const TOOL_STREAM_LIMIT = 50;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

const truncateText = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... truncated (${text.length} chars, showing first ${limit}).`;
};

const extractToolOutputText = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.text === 'string') return value.text;
  const content = value.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map(item => {
      if (!isRecord(item)) return null;
      return item.type === 'text' && typeof item.text === 'string' ? item.text : null;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('\n') : null;
};

export const formatWebchatToolOutput = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
};

export const buildWebchatToolStreamMessage = (
  entry: ToolStreamEntry,
): Record<string, unknown> => {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'toolcall',
      name: entry.name,
      arguments: entry.args ?? {},
    },
  ];
  if (entry.output) {
    content.push({
      type: 'toolresult',
      name: entry.name,
      text: entry.output,
    });
  }
  return {
    role: 'assistant',
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
  };
};

export const resetWebchatToolStream = (turn: SessionTurn): void => {
  turn.toolStreamById.clear();
  turn.toolStreamOrder = [];
  turn.chatToolMessages = [];
  turn.chatStreamSegments = [];
};

export const syncWebchatToolStreamMessages = (turn: SessionTurn): void => {
  turn.chatToolMessages = turn.toolStreamOrder
    .map(id => turn.toolStreamById.get(id)?.message)
    .filter((message): message is Record<string, unknown> => Boolean(message));
};

const trimToolStream = (turn: SessionTurn): void => {
  if (turn.toolStreamOrder.length <= TOOL_STREAM_LIMIT) return;
  const removed = turn.toolStreamOrder.splice(0, turn.toolStreamOrder.length - TOOL_STREAM_LIMIT);
  for (const id of removed) {
    turn.toolStreamById.delete(id);
  }
};

export const handleWebchatToolEvent = (
  turn: SessionTurn,
  payload: AgentEventPayload,
): ToolStreamEntry | null => {
  if (payload.stream !== 'tool') return null;
  const data = isRecord(payload.data) ? payload.data : {};
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : '';
  if (!toolCallId) return null;

  const name = typeof data.name === 'string' ? data.name : 'tool';
  const phase = typeof data.phase === 'string' ? data.phase : '';
  const args = phase === 'start' ? data.args : undefined;
  const output =
    phase === 'update'
      ? formatWebchatToolOutput(data.partialResult)
      : phase === 'result'
        ? formatWebchatToolOutput(data.result)
        : undefined;
  const now = Date.now();
  let entry = turn.toolStreamById.get(toolCallId);
  if (!entry) {
    if (payload.runId === turn.runId && turn.chatStream.trim().length > 0) {
      turn.chatStreamSegments.push({ text: turn.chatStream, ts: now });
      turn.chatStream = '';
      turn.assistantMessageId = null;
    }
    entry = {
      toolCallId,
      runId: payload.runId || turn.runId,
      sessionKey: payload.sessionKey,
      name,
      args,
      output: output || undefined,
      startedAt: now,
      updatedAt: now,
      message: {},
    };
    turn.toolStreamById.set(toolCallId, entry);
    turn.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) entry.args = args;
    if (output !== undefined) entry.output = output || undefined;
    entry.updatedAt = now;
  }

  entry.message = buildWebchatToolStreamMessage(entry);
  trimToolStream(turn);
  syncWebchatToolStreamMessages(turn);
  return entry;
};
