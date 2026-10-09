import { describe, expect, it } from 'vitest';

import { buildDiagnosticFindings } from './diagnosticFindings';
import type { DiagnosticEvent, DiagnosticLogRecord, DiagnosticReport } from './sessionDiagnostics';

const event = (extra: Partial<DiagnosticEvent>): DiagnosticEvent => ({
  id: 'event',
  runId: 'run',
  epoch: 'epoch',
  observedAt: 100,
  kind: 'lifecycle',
  phase: 'end',
  ...extra,
});
const log = (extra: Partial<DiagnosticLogRecord>): DiagnosticLogRecord => ({
  id: 'log',
  source: 'native',
  level: 'info',
  association: 'time_window',
  signal: 'unknown',
  inferred: true,
  basis: 'error_category',
  metrics: {},
  ...extra,
});
const report = (
  events: DiagnosticEvent[],
  records: DiagnosticLogRecord[] = [],
): DiagnosticReport => ({
  version: 1,
  snapshotId: 'snapshot',
  sessionId: 'session',
  collectedAt: 100,
  conclusion: { reason: 'completed', confidence: 'confirmed', evidenceIds: [], toolFailures: 0 },
  events,
  coverage: { dropped: 0, storageFailed: false, partial: true },
  connection: 'offline',
  environment: { status: 'not_requested' },
  logs: {
    collectedAt: 100,
    window: { from: 0, to: 100 },
    localTimezoneOffsetMinutes: 0,
    partial: true,
    sources: [],
    records,
  },
});

describe('diagnostic problem findings', () => {
  it('combines native command failure detail with its tool observation and ignores successful commands', () => {
    const input = report([
      event({ id: 'tool', kind: 'tool', toolFailed: true }),
      event({ id: 'command', kind: 'command', phase: 'failed', exitCode: 127 }),
      event({ id: 'success', kind: 'command', phase: 'end', exitCode: 0 }),
    ]);
    expect(buildDiagnosticFindings(input)).toEqual([
      { signal: 'tool', association: 'event', eventIds: ['tool', 'command'], logIds: [] },
    ]);
    expect(input.conclusion.reason).toBe('completed');
  });

  it('retains exact-run detail alongside a tool failure but excludes unrelated log details', () => {
    const findings = buildDiagnosticFindings(
      report(
        [event({ kind: 'tool', toolFailed: true })],
        [
          log({
            id: 'detail',
            signal: 'tool',
            association: 'run',
            basis: 'command_exit',
            metrics: { exitCode: 2 },
          }),
          log({ id: 'unrelated', signal: 'tool', association: 'time_window' }),
        ],
      ),
    );
    expect(findings[0]).toMatchObject({
      association: 'event',
      eventIds: ['event'],
      logIds: ['detail'],
    });
  });

  it('does not turn ordinary keyword matches or legacy info records into problems', () => {
    expect(
      buildDiagnosticFindings(
        report(
          [],
          [
            log({ signal: 'auth', basis: 'keyword' }),
            log({
              signal: 'unknown',
              basis: 'routine',
              level: 'warn',
              association: 'run',
              metrics: { exitCode: 0 },
            }),
            log({ signal: 'context', basis: undefined }),
            log({ signal: 'auth', basis: undefined, metrics: { statusCode: 200 } }),
          ],
        ),
      ),
    ).toEqual([]);
  });
  it('surfaces intermediate tool and model failures without changing a normal terminal outcome', () => {
    const input = report([
      event({ id: 'tool', kind: 'tool', toolFailed: true }),
      event({ id: 'model', phase: 'error', errorCategory: 'rate_limit' }),
      event({ id: 'terminal', executionSettled: true, stopReason: 'completed' }),
    ]);
    expect(buildDiagnosticFindings(input)).toEqual([
      { signal: 'rate_limit', association: 'event', eventIds: ['model'], logIds: [] },
      { signal: 'tool', association: 'event', eventIds: ['tool'], logIds: [] },
    ]);
    expect(input.conclusion.reason).toBe('completed');
  });

  it('keeps historical time-only clues explicitly uncertain', () => {
    expect(buildDiagnosticFindings(report([], [log({ signal: 'auth' })]))).toEqual([
      { signal: 'auth', association: 'time_window', eventIds: [], logIds: ['log'] },
    ]);
  });

  it('uses the strongest evidence per category without promoting weaker log records', () => {
    const findings = buildDiagnosticFindings(
      report(
        [],
        [
          log({ id: 'nearby', signal: 'timeout' }),
          log({ id: 'session', signal: 'timeout', association: 'session' }),
          log({ id: 'exact', signal: 'timeout', association: 'run' }),
          log({ id: 'duplicate-source', signal: 'timeout', association: 'run', source: 'main' }),
        ],
      ),
    );
    expect(findings).toEqual([
      {
        signal: 'timeout',
        association: 'run',
        eventIds: [],
        logIds: ['exact', 'duplicate-source'],
      },
    ]);
  });

  it('does not diagnose ordinary queue, reconnect or successful tool activity as a problem', () => {
    expect(
      buildDiagnosticFindings(
        report(
          [event({ kind: 'tool', toolFailed: false })],
          [log({ signal: 'queue' }), log({ signal: 'reconnect' }), log({})],
        ),
      ),
    ).toEqual([]);
  });

  it('retains actual chat errors but leaves unclassified log warnings in technical evidence', () => {
    expect(
      buildDiagnosticFindings(report([event({ kind: 'chat', phase: 'error' })]))[0],
    ).toMatchObject({ signal: 'unknown', association: 'event' });
    expect(buildDiagnosticFindings(report([], [log({ level: 'warn' })]))).toEqual([]);
  });

  it('does not expose arbitrary category strings', () => {
    const input = report(
      [event({ errorCategory: 'SECRET' as DiagnosticEvent['errorCategory'] })],
      [log({ signal: 'SECRET' as DiagnosticLogRecord['signal'] })],
    );
    expect(buildDiagnosticFindings(input)).toEqual([]);
  });
});
