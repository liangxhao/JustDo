import {
  type DiagnosticConclusion,
  type DiagnosticEvent,
  DiagnosticReason,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';

function terminalReason(event: DiagnosticEvent): DiagnosticReason {
  switch (event.stopReason) {
    case 'timeout':
      return DiagnosticReason.Timeout;
    case 'restart':
      return DiagnosticReason.Restart;
    case 'superseded':
      return DiagnosticReason.Superseded;
    case 'length':
    case 'max_tokens':
      return DiagnosticReason.Length;
  }
  if (event.aborted || event.stopReason === 'aborted') return DiagnosticReason.Aborted;
  if (event.phase === 'error' || event.stopReason === 'error') return DiagnosticReason.Failed;
  // Native settlement can retain yielded metadata alongside a later interruption.
  // The explicit terminal outcome must take precedence over the earlier yield.
  if (event.yielded) return DiagnosticReason.Waiting;
  if (['stop', 'end_turn', 'completed'].includes(event.stopReason ?? ''))
    return DiagnosticReason.Completed;
  return DiagnosticReason.Unknown;
}

export function classifyDiagnostics(events: DiagnosticEvent[]): DiagnosticConclusion {
  const toolFailures = events.filter(event => event.kind === 'tool' && event.toolFailed).length;
  const result = (
    reason: DiagnosticReason,
    evidence: DiagnosticEvent[],
    confirmed = true,
  ): DiagnosticConclusion => ({
    reason,
    confidence: confirmed ? 'confirmed' : 'unknown',
    evidenceIds: evidence.map(event => event.id),
    toolFailures,
  });
  const settled = events.filter(
    event =>
      event.kind === 'lifecycle' &&
      event.executionSettled === true &&
      (event.phase === 'end' || event.phase === 'error'),
  );
  if (settled.length) {
    const reasons = new Set(settled.map(terminalReason));
    const identities = new Set(
      settled.map(event => `${event.nativeRunId ?? ''}:${event.generation ?? ''}`),
    );
    if (reasons.size > 1 || identities.size > 1)
      return result(DiagnosticReason.Conflict, settled, false);
    const reason = terminalReason(settled[0]);
    if (reason === DiagnosticReason.Aborted) {
      const terminal = settled[0];
      const requested = events.find(
        event =>
          event.kind === 'cancel' &&
          event.phase === 'requested' &&
          event.userInitiated === true &&
          !!event.nativeRunId &&
          event.nativeRunId === terminal.nativeRunId &&
          event.runId === terminal.runId &&
          event.observedAt <= terminal.observedAt &&
          event.generation === terminal.generation,
      );
      if (requested) return result(DiagnosticReason.UserStopped, [requested, ...settled]);
    }
    return result(reason, settled, reason !== DiagnosticReason.Unknown);
  }
  const aborted = events.filter(event => event.kind === 'chat' && event.phase === 'aborted');
  // chat.abort is broadcast before execution has necessarily released/settled.
  if (aborted.length) return result(DiagnosticReason.ReplyAborted, aborted, false);
  const reply = events.filter(event => event.kind === 'chat' && event.phase === 'final');
  if (reply.length) return result(DiagnosticReason.ReplyEnded, reply);
  const disconnected = events.filter(
    event => event.kind === 'connection' && event.phase === 'disconnected',
  );
  if (disconnected.length) return result(DiagnosticReason.Disconnected, disconnected, false);
  const start = events.filter(event => event.kind === 'lifecycle' && event.phase === 'start');
  // A historical start is evidence of admission, not proof it is still running now.
  return result(DiagnosticReason.Unknown, start, false);
}
