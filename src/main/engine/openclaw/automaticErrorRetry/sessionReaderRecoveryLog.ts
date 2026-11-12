const safeId = (value: string | undefined): string | undefined =>
  value && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;

type SessionReaderCheck =
  | { stage: 'chat_error'; outcome: 'gateway_unavailable' | 'candidate_unavailable' | 'identity_mismatch' }
  | { stage: 'agent.wait'; outcome: 'candidate_changed' | 'terminal_pending' | 'terminal_unconfirmed' | 'terminal_ineligible' | 'run_restarted' | 'run_superseded' | 'request_failed' }
  | { stage: 'sessions.describe'; outcome: 'candidate_changed' | 'session_changed' | 'identity_unconfirmed' | 'request_failed' }
  | { stage: 'settlement'; outcome: 'verified' | 'reconcile_failed'; providerStarted?: boolean }
  | { stage: 'execution_failure'; outcome: 'identity_unconfirmed' | 'failure_unconfirmed' | 'different_failure' | 'request_failed' | 'cancelled' }
  | { stage: 'chat.history'; outcome: 'identity_unconfirmed' | 'saved_input_mismatch' | 'failure_receipt_missing' | 'verified' | 'request_failed' | 'cancelled' }
  | { stage: 'continuation'; outcome: 'accepted' | 'rejected' | 'unknown' };

/** Only closed observations and bounded correlation IDs go into the local diagnostic log. */
export function logSessionReaderRecovery(
  identity: { sessionId: string; runId: string; successorRunId?: string },
  check: SessionReaderCheck,
): void {
  try {
    console.warn(JSON.stringify({
      message: '[AutomaticErrorRetry] Session reader recovery',
      event: 'session_reader_recovery',
      sessionId: safeId(identity.sessionId),
      runId: safeId(identity.runId),
      successorRunId: safeId(identity.successorRunId),
      ...check,
    }));
  } catch {
    // A logging failure must leave recovery behavior intact.
  }
}
