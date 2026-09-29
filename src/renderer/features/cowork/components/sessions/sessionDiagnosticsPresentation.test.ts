import type { DiagnosticFinding } from '@shared/cowork/diagnosticFindings';
import type { DiagnosticLogRecord, DiagnosticReport } from '@shared/cowork/sessionDiagnostics';
import { describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  presentDiagnosticFinding,
  summarizeDiagnosticFinding,
} from './sessionDiagnosticsPresentation';

const log: DiagnosticLogRecord = {
  id: 'log',
  source: 'native',
  timestamp: 1000,
  level: 'error',
  signal: 'storage',
  basis: 'error_category',
  association: 'run',
  inferred: true,
  metrics: {},
  errorCode: 'ENOENT',
  stage: 'command',
};
function project(
  record: DiagnosticLogRecord = log,
  association: DiagnosticFinding['association'] = 'run',
) {
  const finding: DiagnosticFinding = {
    signal: record.signal,
    association,
    eventIds: [],
    logIds: [record.id],
  };
  const report = { events: [], logs: { records: [record] } } as unknown as DiagnosticReport;
  return { finding, report, value: presentDiagnosticFinding(finding, report) };
}

describe('diagnostic finding presentation', () => {
  it('explains the affected operation and invalid arguments instead of just repeating failure', () => {
    i18nService.setLanguage('en', { persist: false });
    const finding: DiagnosticFinding = {
      signal: 'tool',
      association: 'event',
      eventIds: ['e'],
      logIds: [],
    };
    const report = {
      events: [
        {
          id: 'e',
          kind: 'tool',
          toolFailed: true,
          toolValidationFailed: true,
          operation: 'file_read',
          observedAt: 100,
        },
      ],
    } as unknown as DiagnosticReport;
    const result = presentDiagnosticFinding(finding, report);
    expect(result.rows[0].description).toContain('Read a file');
    expect(result.rows[0].description).toContain('invalid arguments');
    expect(result.advice).toContain('correct the arguments');
    expect(result.toolLimit).toBe(false);
  });

  it('directs missing-file errors to the missing file or program and preserves evidence in copied summaries', () => {
    i18nService.setLanguage('en', { persist: false });
    const { finding, report, value } = project();
    expect(value.advice).toContain('required file or executable exists');
    expect(value.advice).not.toContain('database');
    const text = summarizeDiagnosticFinding(finding, report);
    expect(text).toContain(value.rows[0].description);
    expect(text).toContain('Command execution');
    expect(text).toContain('ENOENT');
    expect(text).toContain('1970');
    expect(text).toContain(value.advice);
  });
  it('does not direct unknown-stage authentication failures to model settings', () => {
    i18nService.setLanguage('en', { persist: false });
    const { value } = project({
      ...log,
      signal: 'auth',
      stage: undefined,
      errorCode: undefined,
      basis: 'http_status',
      metrics: { statusCode: 401 },
    });
    expect(value.advice).toContain('which service');
    expect(value.advice).not.toContain('selected provider');
  });
  it('labels inferred clues without claiming a proven failure', () => {
    i18nService.setLanguage('en', { persist: false });
    const { value } = project({
      ...log,
      signal: 'network',
      basis: 'error_text',
      errorCode: undefined,
    });
    expect(value.title).toBe('Log suggests: Network');
  });
  it('retains the association caveat instead of action advice for nearby logs', () => {
    i18nService.setLanguage('en', { persist: false });
    const { value } = project(log, 'time_window');
    expect(value.advice).toContain('cannot establish a problem');
    expect(value.advice).not.toContain('required file');
  });
  it('explains command lifecycle failures with exit code, duration and command-specific advice', () => {
    i18nService.setLanguage('en', { persist: false });
    const finding: DiagnosticFinding = {
      signal: 'tool',
      association: 'event',
      eventIds: ['command'],
      logIds: [],
    };
    const report = {
      events: [
        {
          id: 'command',
          kind: 'command',
          phase: 'failed',
          observedAt: 1000,
          exitCode: 2,
          durationMs: 400,
        },
      ],
    } as unknown as DiagnosticReport;
    const value = presentDiagnosticFinding(finding, report);
    expect(value.rows[0].description).toContain('Exit code: 2');
    expect(value.rows[0].description).toContain('Duration (ms): 400');
    expect(value.advice).toContain('command result');
    expect(value.toolLimit).toBe(false);
  });
});
