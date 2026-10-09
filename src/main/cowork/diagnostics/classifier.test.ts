import { describe, expect, it } from 'vitest';

import type { DiagnosticEvent } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { projectDiagnosticEvent } from '../../engine/openclaw/runtimeDiagnostics';
import { classifyDiagnostics } from './classifier';

const event = (values: Partial<DiagnosticEvent>): DiagnosticEvent => ({
  id: 'event',
  runId: 'product-run',
  nativeRunId: 'native-run',
  epoch: 'connection',
  observedAt: 100,
  kind: 'lifecycle',
  phase: 'end',
  ...values,
});

describe('classifyDiagnostics', () => {
  it('does not elevate a failed attempt or finishing fence to execution failure', () => {
    expect(classifyDiagnostics([event({ phase: 'error' })]).reason).toBe('unknown');
    expect(
      classifyDiagnostics([event({ phase: 'finishing', stopReason: 'end_turn' })]).reason,
    ).toBe('unknown');
    const attempt = event({ id: 'attempt', phase: 'error' });
    const end = event({ id: 'end', executionSettled: true, stopReason: 'end_turn' });
    expect(classifyDiagnostics([attempt, end]).reason).toBe('completed');
    expect(classifyDiagnostics([end, attempt]).reason).toBe('completed');
  });

  it('distinguishes transport reply end from model completion and a stale start from current running', () => {
    expect(classifyDiagnostics([event({ kind: 'chat', phase: 'final' })]).reason).toBe(
      'reply_ended',
    );
    expect(classifyDiagnostics([event({ phase: 'start' })]).reason).toBe('unknown');
  });

  it('does not treat an early chat abort as settled execution or confirmed user cancellation', () => {
    const cancel = event({ id: 'cancel', kind: 'cancel', phase: 'requested', userInitiated: true });
    const reply = event({ id: 'reply', kind: 'chat', phase: 'aborted', observedAt: 101 });
    expect(classifyDiagnostics([cancel, reply])).toMatchObject({
      reason: 'reply_aborted',
      confidence: 'unknown',
      evidenceIds: ['reply'],
    });
    const terminal = event({
      id: 'settled',
      aborted: true,
      executionSettled: true,
      observedAt: 102,
    });
    expect(classifyDiagnostics([cancel, reply, terminal])).toMatchObject({
      reason: 'user_stopped',
      confidence: 'confirmed',
      evidenceIds: ['cancel', 'settled'],
    });
  });

  it('requires a matching user cancellation and terminal abort, not acknowledgement', () => {
    const cancel = event({
      id: 'cancel',
      kind: 'cancel',
      phase: 'requested',
      userInitiated: true,
      observedAt: 90,
    });
    const abort = event({ id: 'abort', executionSettled: true, aborted: true });
    expect(
      classifyDiagnostics([cancel, event({ kind: 'cancel', phase: 'acknowledged' })]).reason,
    ).toBe('unknown');
    expect(classifyDiagnostics([cancel, abort]).reason).toBe('user_stopped');
    expect(classifyDiagnostics([{ ...cancel, nativeRunId: 'other' }, abort]).reason).toBe(
      'aborted',
    );
    expect(classifyDiagnostics([{ ...cancel, userInitiated: false }, abort]).reason).toBe(
      'aborted',
    );
    expect(classifyDiagnostics([{ ...cancel, observedAt: 101 }, abort]).reason).toBe('aborted');
    expect(classifyDiagnostics([cancel, { ...abort, generation: 'new' }]).reason).toBe('aborted');
    expect(
      classifyDiagnostics([
        { ...cancel, generation: 'old' },
        { ...abort, generation: 'new' },
      ]).reason,
    ).toBe('aborted');
  });

  it('retains tool failure counts without failing a successfully settled execution', () => {
    const report = classifyDiagnostics([
      event({ id: 'tool', kind: 'tool', toolFailed: true }),
      event({ executionSettled: true, stopReason: 'end_turn' }),
    ]);
    expect(report.reason).toBe('completed');
    expect(report.toolFailures).toBe(1);
  });

  it('reports conflicting generations and outcomes independent of delivery order', () => {
    const end = event({ executionSettled: true, stopReason: 'end_turn', generation: 'one' });
    const error = event({ id: 'error', executionSettled: true, phase: 'error', generation: 'one' });
    expect(classifyDiagnostics([end, error]).reason).toBe('conflict');
    expect(classifyDiagnostics([error, end]).reason).toBe('conflict');
    expect(classifyDiagnostics([end, { ...end, generation: 'two' }]).reason).toBe('conflict');
  });

  it('retains waiting, length and timeout semantics only on settled evidence', () => {
    expect(classifyDiagnostics([event({ executionSettled: true, yielded: true })]).reason).toBe(
      'waiting',
    );
    expect(
      classifyDiagnostics([event({ executionSettled: true, stopReason: 'length' })]).reason,
    ).toBe('length');
    expect(
      classifyDiagnostics([event({ executionSettled: true, stopReason: 'timeout' })]).reason,
    ).toBe('timeout');
  });

  it.each([
    ['end', 'timeout', true, 'timeout'],
    ['error', 'timeout', true, 'timeout'],
    ['end', 'restart', true, 'restart'],
    ['error', 'restart', true, 'restart'],
    ['end', 'superseded', true, 'superseded'],
    ['error', 'superseded', true, 'superseded'],
    ['end', 'aborted', true, 'aborted'],
    ['error', 'aborted', true, 'aborted'],
    ['error', undefined, false, 'failed'],
    ['end', 'error', false, 'failed'],
    ['end', 'length', false, 'length'],
    ['end', 'max_tokens', false, 'length'],
    ['end', 'end_turn', false, 'waiting'],
    ['end', 'stop', false, 'waiting'],
    ['end', undefined, false, 'waiting'],
  ] as const)(
    'preserves native settled %s/%s outcome when yielded metadata remains',
    (phase, stopReason, aborted, expected) => {
      // OpenClaw command/lifecycle preserves yielded even on settled timeout/error frames.
      const projected = projectDiagnosticEvent(
        {
          event: 'agent',
          payload: {
            runId: 'native-run',
            lifecycleGeneration: 'generation',
            stream: 'lifecycle',
            data: { phase, stopReason, aborted, yielded: true, executionSettled: true },
          },
        },
        'connection',
        100,
      );
      expect(projected).toBeDefined();
      expect(classifyDiagnostics([{ ...projected!.event, runId: 'product-run' }])).toMatchObject({
        reason: expected,
        confidence: 'confirmed',
      });
    },
  );
});
