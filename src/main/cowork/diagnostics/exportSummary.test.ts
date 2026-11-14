import { describe, expect, it } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { DiagnosticExportLogs } from './exportLogs';
import { buildDiagnosticSummary } from './exportSummary';

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
      const summary = buildDiagnosticSummary(input, language, aliaser());
      expect(summary).toContain('replay_admission_rejected');
      expect(summary).toContain(
        language === 'en'
          ? 'does not distinguish the three internal checks'
          : '不能区分三个内部校验位置',
      );
      expect(summary).not.toContain('private-');
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
    const summary = buildDiagnosticSummary(input, 'en', aliaser());
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
    const summary = buildDiagnosticSummary(
      input,
      'en',
      aliaser(),
      new DiagnosticExportLogs().finish(),
    );
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
          excerpt: 'Persisted turn changed; password=PRIVATE\n  at worker.js:12',
          clipped: false,
          basis: 'failure_receipt',
        },
      ],
    };
    const summary = buildDiagnosticSummary(input, 'zh', aliaser());
    expect(summary).toContain('Persisted turn changed');
    expect(summary).not.toContain('PRIVATE');
    expect(summary).not.toContain('worker.js');
    expect(summary).toContain('run_window');
    expect(summary).toContain('被省略的失败节选: 3');
    expect(summary).toContain('report.json → history.failures[0]');
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
    const summary = buildDiagnosticSummary(input, 'en', aliaser());
    expect(summary).not.toContain('Evidence gaps to check first');
    expect(summary).toContain('| main | Read |');
    expect(summary).not.toContain('100 / 400');
    expect(summary).not.toContain('scanComplete');
    expect(summary).not.toContain('complete source scan not confirmed');
  });

  it('keeps runtime versions explicitly scoped to the current collection environment', () => {
    const input = report();
    input.runtimeInfo = {
      scope: 'collection_environment',
      collectedAt: at,
      wireVersion: 'v2026.10.6',
      gateway: { status: 'connected', version: '2026.10.4' },
      installedArtifact: { version: '2026.10.5' },
    };
    const summary = buildDiagnosticSummary(input, 'en', aliaser());
    expect(summary).toContain('Current Gateway: 2026.10.4');
    expect(summary).toContain('Currently installed artifact: 2026.10.5');
    expect(summary).toContain('not the selected historical run');
  });

  it('keeps a generic completed terminal distinct from an explained reason for stopping', () => {
    const input = report();
    input.conclusion.reason = 'completed';
    input.events[0].phase = 'end';
    input.events[0].stopReason = 'stop';
    const summary = buildDiagnosticSummary(input, 'en', aliaser());
    expect(summary).not.toContain('Evidence strength');
    expect(summary).toContain('does not prove task completion');
    expect(summary).not.toContain('## Failure excerpts');
    expect(summary).not.toContain('## Issues and log clues');
    expect(summary).not.toContain('## Source coverage');
  });

  it('prioritizes context and inventory gaps and reports only collected request counts', () => {
    const input = report();
    input.history = { status: 'scanned', messagesScanned: 0, omitted: 0, failures: [] };
    const summary = buildDiagnosticSummary(input, 'en', aliaser(), undefined, 0, undefined, {
      context: { status: 'unavailable', reasons: ['offline'], messages: 0 },
      pluginsFile: 'plugins.json',
      turns: 512,
      callOmitted: 5,
      fallbackOmitted: 2,
      turnsLimited: true,
      pluginGaps: 3,
    });

    const runStart = summary.indexOf('## Selected run');
    for (const line of [
      'Conversation context could not be exported (`offline`).',
      'Model-call records omitted: 5',
      'Fallback decisions omitted: 2',
      'The report contains only the most recent saved turns.',
      'Plugin inventory has gaps in 3 sections.',
    ]) {
      expect(summary).toContain(line);
      expect(summary.indexOf(line)).toBeLessThan(runStart);
    }
    expect(summary).toContain('report.json lists 512 saved turns.');
    expect(summary).not.toContain('0 model-call records');
  });

  it('describes exhausted retries as log evidence when a final reply was not verified', () => {
    const input = report();
    input.events = [];
    input.conclusion = {
      reason: 'unknown',
      confidence: 'unknown',
      evidenceIds: [],
      toolFailures: 0,
    };
    input.logs = {
      collectedAt: at,
      window: { from: at - 2000, to: at + 2000 },
      localTimezoneOffsetMinutes: 0,
      partial: true,
      sources: [],
      records: [
        {
          id: 'log-native-1',
          source: 'native',
          timestamp: at,
          level: 'warn',
          association: 'run',
          signal: 'provider',
          inferred: true,
          metrics: {},
          responseIssue: 'empty_response',
          responseRecovery: 'exhausted',
        },
      ],
    };
    const summary = buildDiagnosticSummary(input, 'en', aliaser());
    expect(summary).toContain('Run logs record exhausted retries');
    expect(summary).toContain('Any later recovery is unconfirmed.');
    expect(summary).not.toContain('The last eligible response');
  });

  it('includes the native timeout stage when log text is unavailable', () => {
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
    const summary = buildDiagnosticSummary(
      input,
      'en',
      aliaser(),
      new DiagnosticExportLogs().finish(),
    );
    expect(summary).toContain('Timeout stage: waiting on the model provider');
  });
});
