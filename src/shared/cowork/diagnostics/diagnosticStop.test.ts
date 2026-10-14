import { describe, expect, it } from 'vitest';

import { assessDiagnosticStop } from './diagnosticStop';
import type { DiagnosticReport } from './sessionDiagnostics';

function report(): DiagnosticReport {
  return {
    version: 1,
    snapshotId: 'snapshot',
    sessionId: 'session',
    collectedAt: 300,
    run: { id: 'run', startedAt: 100, endedAt: 200, state: 'completed' },
    conclusion: {
      reason: 'completed',
      confidence: 'confirmed',
      evidenceIds: ['end'],
      toolFailures: 0,
    },
    events: [
      {
        id: 'end',
        runId: 'run',
        epoch: 'e',
        observedAt: 200,
        kind: 'lifecycle',
        phase: 'end',
        executionSettled: true,
      },
    ],
    coverage: { partial: true, dropped: 0, storageFailed: false },
    connection: 'connected',
    environment: { status: 'not_requested' },
    history: {
      status: 'scanned',
      messagesScanned: 1,
      omitted: 0,
      failures: [],
      lastResponse: {
        timestamp: 180,
        association: 'run',
        thinking: true,
        text: false,
        toolCall: false,
        other: false,
        complete: true,
        stopReason: 'stop',
      },
    },
  };
}

describe('why a run stopped', () => {
  it('uses the native history reply stop marker without inventing a loop exit', () => {
    const value = report();
    value.history!.lastResponse!.text = true;
    expect(assessDiagnosticStop(value)).toMatchObject({
      modelReplyEnded: true,
      basis: 'history',
      confidence: 'observed',
    });
    value.history!.lastResponse!.endTurn = false;
    expect(assessDiagnosticStop(value).modelReplyEnded).toBeUndefined();
    value.history!.lastResponse!.endTurn = true;
    value.history!.lastResponse!.association = 'run_window';
    expect(assessDiagnosticStop(value).modelReplyEnded).toBeUndefined();
    value.history!.lastResponse!.association = 'run';
    value.history!.lastResponse!.toolCall = true;
    expect(assessDiagnosticStop(value).modelReplyEnded).toBeUndefined();
  });
  it('keeps settlement separate from the unknown internal loop exit when history is unavailable', () => {
    const value = report();
    value.history = undefined;
    value.events[0].stopReason = 'stop';
    expect(assessDiagnosticStop(value)).toMatchObject({
      reason: 'completed',
      basis: 'terminal',
      confidence: 'confirmed',
    });
    expect(assessDiagnosticStop(value)).not.toHaveProperty('loopExit');
    expect(assessDiagnosticStop(value).modelReplyEnded).toBeUndefined();
    expect(assessDiagnosticStop(value).outputIssue).toBeUndefined();
    value.events[0].executionSettled = false;
    expect(assessDiagnosticStop(value).confidence).toBe('unknown');
  });
  it('keeps native model errors authoritative over an earlier thinking-only history reply', () => {
    const value = report();
    value.conclusion.reason = 'failed';
    Object.assign(value.events[0], {
      phase: 'error',
      stopReason: 'error',
      errorCategory: 'auth',
    });
    expect(assessDiagnosticStop(value)).toMatchObject({
      reason: 'failed',
      basis: 'terminal',
    });
    expect(assessDiagnosticStop(value).outputIssue).toBeUndefined();
    value.events[0].phase = 'end';
    value.events[0].stopReason = 'stop';
    expect(assessDiagnosticStop(value).reason).toBe('failed');
    expect(assessDiagnosticStop(value).outputIssue).toBeUndefined();
  });
  it('distinguishes thinking-only from successful execution settlement', () => {
    const value = report();
    expect(assessDiagnosticStop(value)).toMatchObject({
      reason: 'reasoning_only',
      basis: 'history',
      confidence: 'observed',
    });
    expect(value.conclusion.reason).toBe('completed');
  });
  it('keeps provider timeout as the cause and output shape as secondary evidence', () => {
    const value = report();
    value.conclusion.reason = 'timeout';
    value.events[0].timeoutPhase = 'provider';
    expect(assessDiagnosticStop(value)).toMatchObject({
      reason: 'timeout',
      timeoutPhase: 'provider',
      outputIssue: 'reasoning_only',
    });
  });
  it.each(['silent', 'visible'] as const)(
    'does not blame older display history after a native %s reply',
    replyDisposition => {
      const value = report();
      value.events[0].replyDisposition = replyDisposition;
      expect(assessDiagnosticStop(value).reason).toBe('completed');
      expect(assessDiagnosticStop(value).outputIssue).toBeUndefined();
    },
  );
  it('ignores incomplete scans and does not call a running turn stopped', () => {
    const value = report();
    value.history!.status = 'partial';
    expect(assessDiagnosticStop(value).reason).toBe('completed');
    value.history!.status = 'scanned';
    value.conclusion = {
      reason: 'running',
      confidence: 'unknown',
      evidenceIds: [],
      toolFailures: 0,
    };
    value.run!.state = 'running';
    expect(assessDiagnosticStop(value).reason).toBe('running');
  });
  it('reports exhausted recovery only from run-associated evidence, never a recovered retry', () => {
    const value = report();
    value.history = undefined;
    value.logs = {
      records: [
        {
          id: 'log',
          association: 'run',
          responseIssue: 'reasoning_only',
          responseRecovery: 'exhausted',
        },
      ],
    } as DiagnosticReport['logs'];
    expect(assessDiagnosticStop(value).reason).toBe('completed');
    value.conclusion.reason = 'failed';
    expect(assessDiagnosticStop(value)).toMatchObject({
      reason: 'reasoning_only',
      basis: 'log',
      recoveryExhausted: true,
    });
    value.logs!.records[0].association = 'time_window';
    expect(assessDiagnosticStop(value).reason).toBe('failed');
  });
});
