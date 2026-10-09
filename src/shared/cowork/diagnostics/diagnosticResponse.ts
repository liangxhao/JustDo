import type { DiagnosticResponseObservation } from './sessionDiagnostics';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** Count only content kinds. Neither reasoning text nor normal assistant text leaves this function. */
export function projectDiagnosticResponse(
  value: unknown,
  timestamp: number,
  association: DiagnosticResponseObservation['association'],
): DiagnosticResponseObservation | undefined {
  const message = record(value);
  const meta = record(message.__openclaw);
  if (
    message.role !== 'assistant' ||
    message.phase === 'commentary' ||
    (!Array.isArray(message.content) && typeof message.content !== 'string')
  )
    return;
  const stopReasons: DiagnosticResponseObservation['stopReason'][] = [
    'stop',
    'end_turn',
    'length',
    'max_tokens',
    'toolUse',
    'error',
    'aborted',
  ];
  const result: DiagnosticResponseObservation = {
    timestamp,
    ...(typeof message.endTurn === 'boolean' ? { endTurn: message.endTurn } : {}),
    association,
    thinking: false,
    text: false,
    toolCall: false,
    other: false,
    // Native display-cap shortens each block's text, preserving its type. The
    // segment fallback can drop blocks; oversized/unknown truncation is unsafe.
    complete:
      meta.truncated !== true ||
      (meta.reason === 'display-cap' &&
        record(message.openclawStreamFallback).source !== 'segment'),
    stopReason: stopReasons.includes(
      message.stopReason as DiagnosticResponseObservation['stopReason'],
    )
      ? (message.stopReason as DiagnosticResponseObservation['stopReason'])
      : 'unknown',
  };
  if (typeof message.content === 'string') result.text = nonempty(message.content);
  else
    for (const raw of message.content as unknown[]) {
      const block = record(raw);
      if (['text', 'input_text', 'output_text'].includes(String(block.type)))
        result.text ||= nonempty(block.text);
      else if (['thinking', 'reasoning', 'redacted_thinking'].includes(String(block.type))) {
        result.thinking ||=
          block.type === 'redacted_thinking' ||
          nonempty(block.thinking) ||
          nonempty(block.text) ||
          nonempty(block.reasoning);
      } else if (
        ['toolcall', 'tool_call', 'tooluse', 'tool_use'].includes(String(block.type).toLowerCase())
      )
        result.toolCall = true;
      // Media, tool results, unknown blocks and malformed content must not look empty.
      else result.other = true;
    }
  // The native display boundary can move artifacts outside content.
  if (message.attachments || message.media || message.mediaUrl || message.mediaUrls)
    result.other = true;
  return result;
}

export function diagnosticResponseIssue(response: DiagnosticResponseObservation | undefined) {
  if (
    !response ||
    !response.complete ||
    response.text ||
    response.toolCall ||
    response.other ||
    !['stop', 'end_turn', 'length', 'max_tokens'].includes(response.stopReason)
  )
    return;
  return response.thinking ? ('reasoning_only' as const) : ('empty_response' as const);
}
