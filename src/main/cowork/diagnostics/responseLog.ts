import type { DiagnosticLogRecord } from '../../../shared/cowork/sessionDiagnostics';

/** Native closed result codes and fixed recovery messages; never retain their text. */
export function projectResponseLog(
  fields: Record<string, unknown>[],
  text: string,
  level: string,
): Pick<DiagnosticLogRecord, 'responseIssue' | 'responseRecovery' | 'basis'> | undefined {
  const codes = {
    reasoning_only_result: 'reasoning_only',
    empty_result: 'empty_response',
    planning_only_result: 'incomplete_response',
  } as const;
  for (const field of fields) {
    if (
      field.event === 'model_fallback_decision' &&
      field.decision === 'candidate_failed' &&
      typeof field.code === 'string' &&
      Object.hasOwn(codes, field.code)
    ) {
      return {
        responseIssue: codes[field.code as keyof typeof codes],
        basis: 'error_category',
        ...(field.fallbackStepFinalOutcome === 'chain_exhausted'
          ? { responseRecovery: 'exhausted' as const }
          : {}),
      };
    }
    if (
      field.event === 'embedded_run_failover_decision' &&
      field.failoverReason === 'empty_response' &&
      ['surface_error', 'fallback_model', 'retry_same_model'].includes(String(field.decision))
    )
      return { responseIssue: 'empty_response', basis: 'error_category' };
  }
  if (!['warn', 'error'].includes(level)) return;
  if (/\breasoning-only retries exhausted:/.test(text))
    return { responseIssue: 'reasoning_only', responseRecovery: 'exhausted', basis: 'error_text' };
  if (/\bempty response retries exhausted:/.test(text))
    return { responseIssue: 'empty_response', responseRecovery: 'exhausted', basis: 'error_text' };
  if (/\breasoning-only assistant turn detected:/.test(text))
    return { responseIssue: 'reasoning_only', responseRecovery: 'retrying', basis: 'error_text' };
  if (/\bempty response detected:/.test(text))
    return { responseIssue: 'empty_response', responseRecovery: 'retrying', basis: 'error_text' };
  if (/\b(?:incomplete turn|missing assistant terminal message) detected:/.test(text))
    return { responseIssue: 'incomplete_response', basis: 'error_text' };
}
