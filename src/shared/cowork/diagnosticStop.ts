import { diagnosticResponseIssue } from './diagnosticResponse';
import type {
  DiagnosticLoopExit,
  DiagnosticReason,
  DiagnosticReport,
  DiagnosticResponseIssue,
  DiagnosticTimeoutPhase,
} from './sessionDiagnostics';

export interface DiagnosticStopAssessment {
  reason: DiagnosticReason | DiagnosticResponseIssue;
  basis: 'terminal' | 'history' | 'log' | 'unknown';
  /** Confirmed applies to a native whole-run terminal, not model quality. */
  confidence: 'confirmed' | 'observed' | 'unknown';
  eventIds: string[];
  logIds: string[];
  timeoutPhase?: DiagnosticTimeoutPhase;
  outputIssue?: DiagnosticResponseIssue;
  outputLimited?: boolean;
  recoveryExhausted?: boolean;
  loopExit?: DiagnosticLoopExit;
  modelReplyEnded?: boolean;
}

/** Explain the stop without rewriting native settlement or treating earlier retries as its cause. */
export function assessDiagnosticStop(report: DiagnosticReport): DiagnosticStopAssessment {
  const conclusion = report.conclusion;
  const terminals = report.events.filter(
    event =>
      conclusion.evidenceIds.includes(event.id) &&
      event.kind === 'lifecycle' &&
      event.executionSettled === true,
  );
  const settled = terminals.length > 0 && conclusion.confidence === 'confirmed';
  const response = report.history?.status === 'scanned' ? report.history.lastResponse : undefined;
  // Display history may hide a final silent reply, leaving an earlier attempt last.
  const resolvedReply =
    settled &&
    terminals.some(
      event => event.replyDisposition === 'silent' || event.replyDisposition === 'visible',
    );
  const shape =
    settled && ['completed', 'length'].includes(conclusion.reason)
      ? terminals.find(
          event =>
            event.responseShape &&
            ['stop', 'end_turn', 'completed', 'length', 'max_tokens'].includes(
              event.stopReason ?? '',
            ) &&
            event.phase === 'end',
        )?.responseShape
      : undefined;
  const nativeOutputIssue =
    shape === 'thinking_only' ? 'reasoning_only' : shape === 'empty' ? 'empty_response' : undefined;
  const hasNativeShape = settled && terminals.some(event => event.responseShape);
  const outputIssue = resolvedReply
    ? undefined
    : (nativeOutputIssue ?? (hasNativeShape ? undefined : diagnosticResponseIssue(response)));
  const result: DiagnosticStopAssessment = {
    reason: conclusion.reason,
    basis: settled ? 'terminal' : 'unknown',
    confidence: settled ? 'confirmed' : 'unknown',
    eventIds: conclusion.evidenceIds,
    logIds: [],
    ...(settled && terminals[0].timeoutPhase ? { timeoutPhase: terminals[0].timeoutPhase } : {}),
  };
  // Cancellation, timeout, replacement and yielding have known execution causes.
  // A thinking-only response can accompany a timeout, but must not replace it.
  if (outputIssue) {
    result.outputIssue = outputIssue;
    result.outputLimited =
      response?.stopReason === 'length' || response?.stopReason === 'max_tokens';
  }
  if (
    [
      'conflict',
      'waiting',
      'user_stopped',
      'aborted',
      'reply_aborted',
      'timeout',
      'restart',
      'superseded',
      'disconnected',
      'length',
    ].includes(conclusion.reason)
  )
    return result;
  const terminalIssue = settled ? terminals.find(event => event.responseIssue) : undefined;
  if (terminalIssue?.responseIssue)
    return {
      ...result,
      reason: terminalIssue.responseIssue,
      outputIssue: terminalIssue.responseIssue,
    };
  if (nativeOutputIssue && !resolvedReply && conclusion.reason === 'completed')
    return { ...result, reason: nativeOutputIssue, outputIssue: nativeOutputIssue };
  // Only the published whole-run terminal owns the exit branch; attempt events
  // can be followed by native recovery or fallback under the same run.
  const loopExit = settled ? terminals.find(event => event.loopExit)?.loopExit : undefined;
  if (
    loopExit &&
    (conclusion.reason === 'completed' ||
      (conclusion.reason === 'failed' &&
        ['tool_loop_guard', 'model_error', 'policy_stop', 'handoff'].includes(loopExit)))
  )
    return { ...result, loopExit };
  // Only an ended run can be described as stopping after an empty response.
  // A database state alone cannot confirm execution settlement.
  if (
    outputIssue &&
    (settled ||
      conclusion.reason === 'reply_ended' ||
      report.run?.state === 'completed' ||
      report.run?.state === 'failed')
  ) {
    return { ...result, reason: outputIssue, basis: 'history', confidence: 'observed' };
  }
  // Old runs already retain the model's own stop decision in native history.
  // Describe that fact without inventing a core-loop exit or pending queue state.
  if (
    conclusion.reason === 'completed' &&
    response?.complete &&
    response.association === 'run' &&
    response.text &&
    !response.toolCall &&
    !response.other &&
    response.endTurn !== false &&
    ['stop', 'end_turn'].includes(response.stopReason) &&
    !terminals.some(event => event.replyDisposition === 'silent')
  ) {
    return { ...result, modelReplyEnded: true, basis: 'history', confidence: 'observed' };
  }
  // Never turn a recovered retry into the reason a completed run stopped.
  if (
    !['completed', 'running', 'reply_ended'].includes(conclusion.reason) &&
    !(
      response &&
      ['stop', 'end_turn', 'toolUse'].includes(response.stopReason) &&
      (response.text || response.toolCall || response.other)
    )
  ) {
    const log = report.logs?.records.find(
      record =>
        record.association === 'run' &&
        record.responseIssue &&
        record.responseRecovery === 'exhausted',
    );
    if (log)
      return {
        ...result,
        reason: log.responseIssue!,
        basis: 'log',
        confidence: 'observed',
        logIds: [log.id],
        recoveryExhausted: true,
      };
  }
  return result;
}
