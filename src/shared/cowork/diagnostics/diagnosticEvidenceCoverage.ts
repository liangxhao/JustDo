import type { DiagnosticLogCoverage, DiagnosticReport } from './sessionDiagnostics';

const GAP_REASONS: ReadonlySet<DiagnosticLogCoverage['reasons'][number]> = new Set([
  'missing',
  'unreadable',
  'unsafe_file',
  'limit',
  'malformed',
  'native_unavailable',
  'source_changed',
  'read_timeout',
  'canceled',
]);

/** Missing reads and parsing failures differ from intentionally bounded previews. */
export function diagnosticSourceHasGaps(source: DiagnosticLogCoverage): boolean {
  return (
    source.status === 'unavailable' ||
    source.scanComplete === false ||
    source.truncated ||
    source.parseFailures > 0 ||
    source.reasons.some(reason => GAP_REASONS.has(reason)) ||
    (source.status === 'partial' && source.scanComplete !== true && !source.reasons.length)
  );
}

/** Coverage describes this collection, never the completeness of native history. */
export function assessDiagnosticCoverage(report: DiagnosticReport) {
  const sources = (report.logs?.sources ?? []).map(source => ({
    source: source.source,
    status: source.status,
    scanComplete: source.scanComplete,
    matched: source.matched ?? source.emitted,
    emitted: source.emitted,
    previewOmitted: source.outputOmitted ?? 0,
    parseFailures: source.parseFailures,
    truncated: source.truncated,
    reasons: source.reasons,
    hasGaps: diagnosticSourceHasGaps(source),
  }));
  const eventLosses = report.coverage.dropped;
  const collectorLosses = report.coverage.collectorDropped ?? 0;
  const history = {
    status: report.history?.status,
    reason: report.history?.reason,
    omitted: report.history?.omitted ?? 0,
  };
  return {
    hasGaps: Boolean(
      eventLosses ||
      collectorLosses ||
      report.coverage.storageFailed ||
      (history.status && history.status !== 'scanned') ||
      sources.some(source => source.hasGaps),
    ),
    logsCollected: report.logs !== undefined,
    eventLosses,
    collectorLosses,
    storageFailed: report.coverage.storageFailed,
    history,
    sources,
  };
}
