import type { EngineDiagnosticReport, EngineLogCoverage } from '@shared/openclaw/engineDiagnostics';

import { i18nService } from '@/services/i18n';

export const engineDiagnosticDate = (time: number) => new Date(time).toLocaleString();
export const engineLogCoverageText = (coverage: EngineLogCoverage) =>
  [
    i18nService
      .t('engineDiagnosticsSourceStats')
      .replace('{scanned}', String(coverage.scannedFiles))
      .replace('{files}', String(coverage.files))
      .replace('{matched}', String(coverage.matched))
      .replace('{omitted}', String(coverage.omitted)),
    ...coverage.issues.map(issue => i18nService.t(`engineDiagnosticsIssue_${issue}`)),
  ].join(' · ');

/** Copy exactly the viewed snapshot, including evidence and gaps, without rereading logs. */
export function engineDiagnosticText(report: EngineDiagnosticReport, commandError?: string | null) {
  const lines = [
    i18nService.t('engineDiagnosticsTitle'),
    `${i18nService.t('engineDiagnosticsCollectedAt')}: ${engineDiagnosticDate(report.collectedAt)}`,
    `${i18nService.t('engineDiagnosticsWindow')}: ${engineDiagnosticDate(report.window.from)} — ${engineDiagnosticDate(report.window.to)}`,
    `diagnosticId: ${report.context.id}; processGeneration: ${report.context.processGeneration}; version: ${report.context.status.version ?? 'unknown'}`,
    i18nService.t('engineDiagnosticsCorrelation'),
    ...(report.engineChanged ? [i18nService.t('engineDiagnosticsChanged')] : []),
    ...(commandError ? [commandError] : []),
    '',
    i18nService.t('engineDiagnosticsFindings'),
    ...report.findings.flatMap(id => {
      const item = report.evidence.find(e => e.id === id);
      return item
        ? [`[${item.id}] ${i18nService.t(`engineDiagnosticsCause_${item.category}`)}`, item.text]
        : [];
    }),
    '',
    i18nService.t('engineDiagnosticsSources'),
    ...report.coverage.map(item => `${item.source}: ${engineLogCoverageText(item)}`),
    '',
    i18nService.t('engineDiagnosticsEvidence'),
    ...report.evidence.map(
      item =>
        `[${item.id}] [${item.source}] [${engineDiagnosticDate(item.timestamp)}] [${item.level}]${item.truncated ? ` [${i18nService.t('engineDiagnosticsTruncated')}]` : ''}\n${item.text}`,
    ),
  ];
  return lines.join('\n');
}
