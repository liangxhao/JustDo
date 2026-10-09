import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';

/** UTC filenames only prioritize reads; record timestamps still decide inclusion. */
export function orderDiagnosticMainLogs(
  entries: Array<{ archiveName: string; filePath: string }>,
  report: DiagnosticReport,
): string[] {
  const anchor = report.run?.endedAt ?? report.collectedAt;
  const day = Math.floor(anchor / 86_400_000) * 86_400_000;
  const timestamp = (name: string) => Date.parse(`${name.slice(5, 15)}T00:00:00Z`);
  return [...entries]
    .sort(
      (left, right) =>
        Math.abs(timestamp(left.archiveName) - day) -
          Math.abs(timestamp(right.archiveName) - day) ||
        right.archiveName.slice(5, 15).localeCompare(left.archiveName.slice(5, 15)) ||
        Number(left.archiveName.includes('.old')) - Number(right.archiveName.includes('.old')),
    )
    .map(entry => entry.filePath);
}
