import type { DiagnosticFinding } from '@shared/cowork/diagnostics/diagnosticFindings';
import type {
  DiagnosticLogRecord,
  DiagnosticReport,
} from '@shared/cowork/diagnostics/sessionDiagnostics';
import { describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  presentDiagnosticCoverage,
  presentDiagnosticExport,
  presentDiagnosticFinding,
  presentDiagnosticStop,
  summarizeDiagnosticFinding,
  summarizeDiagnosticReport,
} from './sessionDiagnosticsPresentation';

const collectionReport = (overrides: Partial<DiagnosticReport> = {}): DiagnosticReport => ({
  version: 1,
  snapshotId: 'private-snapshot-id',
  sessionId: 'private-session-id',
  collectedAt: 1000,
  run: { id: 'private-run-id', startedAt: 100, endedAt: 500, state: 'completed' },
  conclusion: { reason: 'completed', confidence: 'confirmed', evidenceIds: [], toolFailures: 0 },
  events: [],
  coverage: { partial: true, dropped: 0, storageFailed: false },
  connection: 'offline',
  environment: { status: 'not_requested' },
  history: { status: 'scanned', messagesScanned: 10, omitted: 0, failures: [] },
  logs: {
    collectedAt: 1000,
    window: { from: 0, to: 1000 },
    localTimezoneOffsetMinutes: -480,
    partial: true,
    records: [],
    sources: [
      {
        source: 'main',
        status: 'available',
        scanComplete: true,
        filesRead: 1,
        bytesRead: 100,
        recordsRead: 2,
        emitted: 2,
        suppressed: 0,
        parseFailures: 0,
        truncated: false,
        reasons: [],
      },
    ],
  },
  ...overrides,
});

describe('diagnostic collection presentation', () => {
  it('separates complete reads from bounded preview and failure-excerpt sampling', () => {
    i18nService.setLanguage('en', { persist: false });
    const report = collectionReport();
    report.logs!.sources[0].outputOmitted = 5;
    report.logs!.sources[0].reasons = ['output_limit'];
    report.history!.omitted = 3;
    const value = presentDiagnosticCoverage(report);
    expect(presentDiagnosticStop(report).incomplete).toBe(false);
    expect(value.title).toBe('Collection finished for the discovered sources');
    expect(value.sourceLines.join('\n')).toContain('5 previews omitted');
    expect(value.notes.join('\n')).toContain('3 additional failure excerpts omitted');
  });

  it('shows parse gaps even when all discovered files were scanned', () => {
    i18nService.setLanguage('en', { persist: false });
    const report = collectionReport();
    report.logs!.sources[0].parseFailures = 2;
    const value = presentDiagnosticCoverage(report);
    expect(value.hasGaps).toBe(true);
    expect(presentDiagnosticStop(report).incomplete).toBe(true);
    expect(value.sourceLines.join('\n')).toContain('2 records could not be parsed');
  });

  it('copies source gaps and ownership limits without technical identities', () => {
    i18nService.setLanguage('en', { persist: false });
    const report = collectionReport();
    report.logs!.records = ['run', 'session', 'time_window'].map((association, index) => ({
      id: `private-log-${index}`,
      source: 'main',
      level: 'info',
      signal: 'unknown',
      inferred: true,
      association: association as DiagnosticLogRecord['association'],
      metrics: {},
    }));
    report.logs!.sources.push({
      source: 'native',
      status: 'unavailable',
      filesRead: 0,
      bytesRead: 0,
      recordsRead: 0,
      emitted: 0,
      suppressed: 0,
      parseFailures: 0,
      truncated: false,
      reasons: ['native_unavailable'],
    });
    const summary = summarizeDiagnosticReport(report);
    expect(summary).toContain('1 matching run · 1 matching conversation · 1 time window only');
    expect(summary).toContain('Selection window:');
    expect(summary).toContain('Native runtime logs: Unavailable');
    expect(summary).toContain('Native runtime logs are unavailable');
    expect(summary).not.toContain('private-');
  });

  it('describes an export without raw logs as a bundle with metadata and any failure excerpts', () => {
    i18nService.setLanguage('en', { persist: false });
    const text = presentDiagnosticExport({
      collectedAt: 1000,
      logRecords: 0,
      omittedLogRecords: 7,
      unavailableSources: ['native'],
      partialSources: ['main'],
    });
    expect(text).toContain('0 log records');
    expect(text).toContain('still contains diagnostic metadata');
    expect(text).toContain('Log sources unavailable: Native runtime logs');
    expect(text).toContain('7 log records omitted from the bundle');
  });
});

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
