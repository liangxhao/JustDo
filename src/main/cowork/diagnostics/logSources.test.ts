import { expect, it } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { orderDiagnosticMainLogs } from './logSources';

it('prioritizes the historical run day and its active file before rotations and newer unrelated days', () => {
  const entries = [
    'main-2026-09-28.log',
    'main-2026-09-26.old.log',
    'main-2026-09-25.log',
    'main-2026-09-26.log',
    'main-2026-09-27.log',
  ].map(archiveName => ({ archiveName, filePath: archiveName }));
  const report = {
    collectedAt: Date.parse('2026-09-28T10:00:00Z'),
    run: { endedAt: Date.parse('2026-09-26T23:59:00Z') },
  } as DiagnosticReport;
  expect(orderDiagnosticMainLogs(entries, report)).toEqual([
    'main-2026-09-26.log',
    'main-2026-09-26.old.log',
    'main-2026-09-27.log',
    'main-2026-09-25.log',
    'main-2026-09-28.log',
  ]);
  expect(entries[0].archiveName).toBe('main-2026-09-28.log');
});
