import type { DiagnosticLogSignal, DiagnosticReport } from './sessionDiagnostics';

const signals: DiagnosticLogSignal[] = [
  'auth',
  'rate_limit',
  'billing',
  'context',
  'timeout',
  'network',
  'tls',
  'provider',
  'tool',
  'permission',
  'storage',
  'process_exit',
  'disconnect',
  'retry',
  'unknown',
];
export interface DiagnosticFinding {
  signal: DiagnosticLogSignal;
  association: 'event' | 'run' | 'session' | 'time_window';
  eventIds: string[];
  logIds: string[];
}
const strength = { event: 3, run: 2, session: 1, time_window: 0 } as const;

/** Summarize observations, never replace authoritative execution outcomes or infer recovery. */
export function buildDiagnosticFindings(report: DiagnosticReport): DiagnosticFinding[] {
  const findings = new Map<DiagnosticLogSignal, DiagnosticFinding>();
  const add = (
    signal: DiagnosticLogSignal,
    association: DiagnosticFinding['association'],
    id: string,
  ) => {
    if (!signals.includes(signal)) return;
    let finding = findings.get(signal);
    if (finding && finding.association === 'event' && association === 'run') {
      if (!finding.logIds.includes(id)) finding.logIds.push(id);
      return;
    }
    if (finding && strength[finding.association] > strength[association]) return;
    if (!finding || strength[finding.association] < strength[association]) {
      finding = { signal, association, eventIds: [], logIds: [] };
      findings.set(signal, finding);
    }
    const ids = association === 'event' ? finding.eventIds : finding.logIds;
    if (!ids.includes(id)) ids.push(id);
  };
  for (const event of report.events.slice(0, 232)) {
    if (event.responseIssue) add('provider', 'event', event.id);
    if (event.kind === 'tool' && event.toolFailed) add('tool', 'event', event.id);
    if (event.kind === 'command' && event.phase === 'failed') {
      add('tool', 'event', event.id);
      continue;
    }
    if (event.errorCategory) add(event.errorCategory, 'event', event.id);
    else if (event.stopReason === 'timeout') add('timeout', 'event', event.id);
    else if (!event.toolFailed && (event.phase === 'error' || event.phase === 'failed'))
      add('unknown', 'event', event.id);
    if (event.kind === 'connection' && event.phase === 'disconnected')
      add('disconnect', 'event', event.id);
  }
  for (const record of (report.logs?.records ?? []).slice(0, 400)) {
    // A topic mentioned by routine logging is not evidence of a failed operation.
    if (record.basis === 'keyword' || record.basis === 'routine') continue;
    const status = record.metrics.statusCode;
    const httpFailure =
      status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599;
    if (!record.basis && !['warn', 'error'].includes(record.level) && !httpFailure) continue;
    // Routine queue/reconnect activity and unclassified info are not problems.
    // Unclassified logs provide no location or diagnosis; retain them only in technical evidence.
    if (record.signal === 'unknown') continue;
    if (!['run', 'session', 'time_window'].includes(record.association)) continue;
    add(record.signal, record.association, record.id);
  }
  return [...findings.values()].sort(
    (a, b) =>
      strength[b.association] - strength[a.association] ||
      signals.indexOf(a.signal) - signals.indexOf(b.signal),
  );
}
