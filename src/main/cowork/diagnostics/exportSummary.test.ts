import { describe, expect, it } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { DiagnosticExportLogs } from './exportLogs';
import { buildDiagnosticReadableFiles } from './exportSummary';

const at = Date.parse('2026-10-22T04:00:00Z');
const report = (): DiagnosticReport => ({
  version: 1,
  snapshotId: 'snapshot',
  sessionId: 'private-session',
  collectedAt: at,
  run: { id: 'private-run', startedAt: at - 1000, endedAt: at, state: 'failed' },
  conclusion: {
    reason: 'failed',
    confidence: 'confirmed',
    evidenceIds: ['terminal'],
    toolFailures: 0,
  },
  events: [
    {
      id: 'terminal',
      runId: 'private-run',
      nativeRunId: 'private-native',
      epoch: 'private-epoch',
      kind: 'lifecycle',
      phase: 'error',
      executionSettled: true,
      observedAt: at,
      stopReason: 'error',
    },
  ],
  coverage: { partial: true, dropped: 0, storageFailed: false },
  connection: 'offline',
  environment: { status: 'not_requested' },
});
const aliaser = () => {
  const aliases = new Map<string, string>();
  return (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  };
};

describe('readable diagnostic archive overview', () => {
  it.each(['en', 'zh'] as const)(
    'explains replay rejection with unknown private checks in %s',
    language => {
      const input = report();
      input.events[0].runtimeFailure = 'replay_admission_rejected';
      input.events[0].executionSettled = undefined;
      const files = buildDiagnosticReadableFiles(input, language, aliaser());
      expect(files['summary.md']).toContain('replay_admission_rejected');
      expect(files['summary.md']).toContain(
        language === 'en'
          ? 'does not distinguish the three internal checks'
          : '不能区分三个内部校验位置',
      );
      expect(files['evidence-timeline.md']).toContain('runtimeFailure=replay');
      expect(files['summary.md']).not.toContain('private-');
    },
  );

  it('keeps a window-only replay receipt below the whole-run conclusion', () => {
    const input = report();
    input.history = {
      status: 'scanned',
      messagesScanned: 1,
      omitted: 0,
      failures: [
        {
          timestamp: at,
          kind: 'runtime',
          association: 'run_window',
          basis: 'failure_receipt',
          cause: 'replay_admission_rejected',
          clipped: false,
          excerpt: 'Persisted user turn changed before replay admission',
        },
      ],
    };
    const summary = buildDiagnosticReadableFiles(input, 'en', aliaser())['summary.md'];
    expect(summary).toContain('run_window');
    expect(summary.indexOf('Observed error: replay_admission_rejected')).toBeGreaterThan(
      summary.indexOf('## Failure excerpts from conversation history'),
    );
    expect(input.conclusion.reason).toBe('failed');
  });

  it('places missing source evidence and zero log text before run details', () => {
    const input = report();
    input.logs = {
      collectedAt: at,
      window: { from: at - 2000, to: at + 2000 },
      localTimezoneOffsetMinutes: -480,
      partial: true,
      records: [],
      sources: [
        {
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
        },
      ],
    };
    const files = buildDiagnosticReadableFiles(
      input,
      'en',
      aliaser(),
      new DiagnosticExportLogs().finish(),
    );
    const summary = files['summary.md'];
    expect(summary).toContain('No log text was obtained');
    expect(summary.indexOf('native_unavailable')).toBeLessThan(summary.indexOf('## Selected run'));
    expect(summary).toContain('2026-10-22T04:00:00.000Z');
    expect(summary).not.toContain('private-');
  });

  it('includes concrete redacted failure excerpts and identifies temporal history association', () => {
    const input = report();
    input.history = {
      status: 'scanned',
      messagesScanned: 2,
      omitted: 3,
      failures: [
        {
          timestamp: at,
          kind: 'runtime',
          association: 'run_window',
          excerpt: 'Persisted turn changed; password=PRIVATE',
          clipped: false,
          basis: 'failure_receipt',
        },
      ],
    };
    const files = buildDiagnosticReadableFiles(input, 'zh', aliaser());
    expect(files['summary.md']).toContain('Persisted turn changed');
    expect(files['summary.md']).not.toContain('PRIVATE');
    expect(files['summary.md']).toContain('run_window');
    expect(files['summary.md']).toContain('被省略的失败节选: 3');
    expect(files['evidence-timeline.md']).toContain('session\\-evidence');
  });

  it('does not mistake a bounded safe preview for a failed log scan', () => {
    const input = report();
    input.history = { status: 'scanned', messagesScanned: 2, omitted: 0, failures: [] };
    input.logs = {
      collectedAt: at,
      window: { from: at - 2000, to: at + 2000 },
      localTimezoneOffsetMinutes: -480,
      partial: true,
      records: [],
      sources: [
        {
          source: 'main',
          status: 'partial',
          filesRead: 1,
          filesDiscovered: 1,
          filesCompleted: 1,
          scanComplete: true,
          bytesRead: 1000,
          recordsRead: 500,
          matched: 500,
          emitted: 100,
          outputOmitted: 400,
          suppressed: 0,
          parseFailures: 0,
          truncated: false,
          reasons: ['output_limit', 'outside_window', 'no_safe_fields'],
        },
      ],
    };
    const files = buildDiagnosticReadableFiles(input, 'en', aliaser());
    expect(files['summary.md']).toContain(
      'No additional read failures or log-text omissions were reported',
    );
    expect(files['summary.md']).toContain('100 / 400');
    expect(files['summary.md']).not.toContain('complete source scan not confirmed');
  });

  it('keeps runtime versions explicitly scoped to the current collection environment', () => {
    const input = report();
    input.runtimeInfo = {
      scope: 'collection_environment',
      collectedAt: at,
      wireVersion: 'v2026.10.4',
      gateway: { status: 'connected', version: '2026.10.4' },
      installedArtifact: { version: '2026.10.5' },
    };
    const summary = buildDiagnosticReadableFiles(input, 'en', aliaser())['summary.md'];
    expect(summary).toContain('Current Gateway: 2026.10.4');
    expect(summary).toContain('Currently installed artifact: 2026.10.5');
    expect(summary).toContain('not the selected historical run');
  });

  it('keeps a generic completed terminal distinct from an explained reason for stopping', () => {
    const input = report();
    input.conclusion.reason = 'completed';
    input.events[0].phase = 'end';
    input.events[0].stopReason = 'stop';
    const summary = buildDiagnosticReadableFiles(input, 'en', aliaser())['summary.md'];
    expect(summary).toContain('Evidence strength: more evidence needed');
    expect(summary).toContain('does not prove task completion');
  });

  it('includes the native timeout stage and flags log text unavailable in the timeline', () => {
    const input = report();
    input.conclusion.reason = 'timeout';
    input.events[0].stopReason = 'timeout';
    input.events[0].timeoutPhase = 'provider';
    input.logs = {
      collectedAt: at,
      window: { from: at - 2000, to: at + 2000 },
      localTimezoneOffsetMinutes: 0,
      partial: true,
      sources: [],
      records: [
        {
          id: 'log-main-1',
          source: 'main',
          timestamp: at,
          level: 'error',
          association: 'run',
          signal: 'timeout',
          inferred: true,
          metrics: {},
        },
      ],
    };
    const files = buildDiagnosticReadableFiles(
      input,
      'en',
      aliaser(),
      new DiagnosticExportLogs().finish(),
    );
    expect(files['summary.md']).toContain('Timeout stage: waiting on the model provider');
    expect(files['evidence-timeline.md']).toContain('log text unavailable or omitted by retention');
  });
});
