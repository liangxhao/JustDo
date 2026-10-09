import { diagnosticErrorCodes } from './diagnosticLogDetails';
import type { DiagnosticHistoryEvidence, DiagnosticLogSignal } from './sessionDiagnostics';

export type DiagnosticHistoryFailure = DiagnosticHistoryEvidence['failures'][number];

/** Suggestions from an already failed step. Text hints never establish a run outcome. */
export function diagnoseHistoryFailure(failure: DiagnosticHistoryFailure) {
  const code = diagnosticErrorCodes.find(value =>
    new RegExp(`\\b${value}\\b`).test(failure.excerpt),
  );
  let signal: DiagnosticLogSignal =
    failure.kind === 'model' ? 'provider' : failure.kind === 'runtime' ? 'unknown' : 'tool';
  const hints: Array<[DiagnosticLogSignal, RegExp]> = [
    ['billing', /\b(?:insufficient_quota|insufficient.quota|billing|credit.balance)\b/i],
    [
      'auth',
      /\b(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[\s:=]+)401|unauthorized|invalid.api.key|authentication.failed)\b/i,
    ],
    [
      'permission',
      /\b(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[\s:=]+)403|forbidden|permission.denied|EACCES|EPERM)\b/i,
    ],
    [
      'rate_limit',
      /\b(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[\s:=]+)429|rate.limit|too.many.requests)\b/i,
    ],
    [
      'context',
      /\b(?:context_length_exceeded|context.overflow|maximum.context.length|prompt.too.large)\b/i,
    ],
    ['timeout', /\b(?:timed.out|timeout|ETIMEDOUT)\b/i],
    [
      'tls',
      /\b(?:certificate|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i,
    ],
    ['network', /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch.failed)\b/i],
    ['storage', /\b(?:ENOSPC|SQLITE_BUSY|SQLITE_FULL)\b/i],
  ];
  const hint = hints.find(([, pattern]) => pattern.test(failure.excerpt));
  if (hint) signal = hint[0];
  if (failure.outcome === 'blocked') signal = 'permission';
  const adviceKey =
    failure.cause === 'state_contention'
      ? 'diagnosticsHistoryAdvice_state_contention'
      : failure.outcome === 'aborted'
        ? 'diagnosticsHistoryAdvice_aborted'
        : failure.outcome === 'blocked'
          ? 'diagnosticsAdvice_permission'
          : code
            ? `diagnosticsRemedy_${code}`
            : failure.kind === 'tool' &&
                ['auth', 'rate_limit', 'billing', 'provider', 'network'].includes(signal)
              ? `diagnosticsRemedy_service_${signal}`
              : `diagnosticsAdvice_${signal}`;
  return {
    signal,
    adviceKey,
    inferred:
      Boolean(hint || code) &&
      !failure.cause &&
      failure.outcome !== 'blocked' &&
      failure.outcome !== 'aborted',
  };
}
