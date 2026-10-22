import { describe, expect, it } from 'vitest';

import { assessDiagnosticCoverage } from './diagnosticEvidenceCoverage';
import type { DiagnosticLogCoverage, DiagnosticReport } from './sessionDiagnostics';

function report(): DiagnosticReport {
  return {
    version: 1,
    snapshotId: 'snapshot',
    sessionId: 'session',
    collectedAt: 300,
    conclusion: { reason: 'unknown', confidence: 'unknown', evidenceIds: [], toolFailures: 0 },
    events: [],
    coverage: { partial: true, dropped: 0, storageFailed: false },
    connection: 'connected',
    environment: { status: 'not_requested' },
  };
}

function withSource(source: Partial<DiagnosticLogCoverage>): DiagnosticReport {
  const value = report();
  value.logs = {
    partial: true,
    scanMode: 'full_files',
    collectedAt: 300,
    window: { from: 0, to: 300 },
    localTimezoneOffsetMinutes: 0,
    records: [],
    sources: [
      {
        source: 'main',
        status: 'available',
        filesRead: 1,
        bytesRead: 100,
        recordsRead: 5,
        emitted: 5,
        suppressed: 0,
        parseFailures: 0,
        truncated: false,
        reasons: [],
        scanComplete: true,
        ...source,
      },
    ],
  };
  return value;
}

describe('diagnostic collection coverage', () => {
  it('separates unrequested sources from missing reads and the always-partial contract', () => {
    expect(assessDiagnosticCoverage(report())).toMatchObject({
      logsCollected: false,
      hasGaps: false,
    });
    expect(assessDiagnosticCoverage(withSource({}))).toMatchObject({
      logsCollected: true,
      hasGaps: false,
    });
  });

  it('does not mistake bounded preview or failure excerpts for incomplete scanning', () => {
    const value = withSource({ status: 'partial', outputOmitted: 20, reasons: ['output_limit'] });
    value.history = { status: 'scanned', omitted: 10, messagesScanned: 100, failures: [] };
    expect(assessDiagnosticCoverage(value)).toMatchObject({
      hasGaps: false,
      history: { status: 'scanned', omitted: 10 },
      sources: [{ previewOmitted: 20, hasGaps: false }],
    });
  });

  it.each([
    { parseFailures: 2 },
    { status: 'unavailable', reasons: ['native_unavailable'] },
    { scanComplete: false, reasons: ['source_changed'] },
    { truncated: true, reasons: ['limit'] },
    { reasons: ['read_timeout'] },
  ] satisfies Array<Partial<DiagnosticLogCoverage>>)(
    'exposes actual source gaps even after all discovered bytes were read: %j',
    source => {
      expect(assessDiagnosticCoverage(withSource(source))).toMatchObject({
        hasGaps: true,
        sources: [{ hasGaps: true }],
      });
    },
  );

  it('keeps recorder losses, process-wide losses and unavailable history distinct', () => {
    const value = report();
    value.coverage = { partial: true, dropped: 3, collectorDropped: 7, storageFailed: true };
    value.history = {
      status: 'changed',
      reason: 'history_changed',
      messagesScanned: 4,
      omitted: 0,
      failures: [],
    };
    expect(assessDiagnosticCoverage(value)).toMatchObject({
      hasGaps: true,
      eventLosses: 3,
      collectorLosses: 7,
      storageFailed: true,
      history: { status: 'changed', reason: 'history_changed' },
    });
  });
});
