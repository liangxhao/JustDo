import { describe, expect, it } from 'vitest';

import { projectDiagnosticEvent } from './runtimeDiagnostics';

describe('projectDiagnosticEvent', () => {
  it('retains only closed loop exit and response shape metadata', () => {
    const make = (data: Record<string, unknown>) => projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'run', stream: 'lifecycle', data: { phase: 'end', executionSettled: true, ...data },
    } }, 'epoch');
    expect(make({ justDoLoopExit: 'no_pending_work', justDoResponseShape: 'thinking_only' })?.event)
      .toMatchObject({ loopExit: 'no_pending_work', responseShape: 'thinking_only' });
    expect(JSON.stringify(make({ justDoLoopExit: 'SECRET', justDoResponseShape: 'SECRET' }))).not.toContain('SECRET');
  });
  it('retains native timeout stage and reply disposition without reply content', () => {
    const make = (data: Record<string, unknown>) => projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'run', stream: 'lifecycle', data: { phase: 'end', executionSettled: true, ...data },
    } }, 'epoch');
    const value = make({ timeoutPhase: 'provider', terminalReply: { disposition: 'silent', text: 'SECRET' }, errorObservation: { failoverReason: 'empty_response' } });
    expect(value?.event).toMatchObject({ timeoutPhase: 'provider', replyDisposition: 'silent', responseIssue: 'empty_response' });
    expect(JSON.stringify(value)).not.toContain('SECRET');
    const unknown = make({ timeoutPhase: 'SECRET', terminalReply: { disposition: 'SECRET' } });
    expect(unknown?.event.timeoutPhase).toBeUndefined();
    expect(unknown?.event.replyDisposition).toBeUndefined();
  });
  it('projects real native command_output terminals without retaining command content or double-counting tool failures', () => {
    const projected = projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'native-run', stream: 'command_output', ts: 100,
      data: { phase: 'end', status: 'failed', exitCode: 127, durationMs: 42,
        name: 'SECRET-TOOL', title: 'SECRET-COMMAND', output: 'SECRET-OUTPUT', cwd: 'SECRET-PATH',
        toolCallId: 'SECRET-ID', itemId: 'SECRET-ITEM' },
    } }, 'e');
    expect(projected?.event).toMatchObject({ kind: 'command', phase: 'failed', exitCode: 127, durationMs: 42, occurredAt: 100 });
    expect(projected?.event.toolFailed).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });

  it('keeps successful commands successful and rejects invalid command metrics and nonterminal chunks', () => {
    const make = (data: Record<string, unknown>) => projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'r', stream: 'command_output', data,
    } }, 'e');
    expect(make({ phase: 'end', status: 'completed', exitCode: 0, durationMs: 0 })?.event)
      .toMatchObject({ kind: 'command', phase: 'end', exitCode: 0, durationMs: 0 });
    const invalid = make({ phase: 'end', status: 'failed', exitCode: 1.5, durationMs: Infinity });
    expect(invalid?.event.exitCode).toBeUndefined();
    expect(invalid?.event.durationMs).toBeUndefined();
    expect(make({ phase: 'delta', status: 'failed', exitCode: 2 })).toBeUndefined();
    expect(make({ phase: 'end', status: 'SECRET', exitCode: 2 })).toBeUndefined();
  });

  it('records finite tool error details for subsequent diagnosis without copying the error body', () => {
    const projected = projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'r', stream: 'tool', data: { phase: 'result', status: 'timeout',
        error: { code: 'ETIMEDOUT', message: 'SECRET' }, durationMs: 123, statusCode: 504 },
    } }, 'e');
    expect(projected?.event).toMatchObject({ toolFailed: true, stopReason: 'timeout', errorCode: 'ETIMEDOUT', durationMs: 123, statusCode: 504 });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    const rejected = projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'r', stream: 'tool', data: { phase: 'result', isError: true,
        errorCode: 'SECRET', durationMs: -1, statusCode: 999 },
    } }, 'e');
    expect(rejected?.event.errorCode).toBeUndefined();
    expect(rejected?.event.durationMs).toBeUndefined();
    expect(rejected?.event.statusCode).toBeUndefined();
  });

  it('retains only closed metadata from a lifecycle event with sensitive nested fields', () => {
    const projected = projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'native', sessionKey: 'session', seq: 3, stream: 'lifecycle',
      data: { phase: 'error', executionSettled: true, stopReason: 'SECRET-STOP',
        error: 'SECRET-ERROR', terminalReply: { content: 'SECRET-PROMPT' },
        errorObservation: { failoverReason: 'auth', httpStatus: 401,
          providerErrorMessagePreview: 'SECRET-TOKEN', provider: 'SECRET-ACCOUNT' },
      },
    } }, 'epoch', 100);
    expect(projected?.event).toMatchObject({ phase: 'error', executionSettled: true, stopReason: 'unknown' });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });

  it('maps the native errorObservation failoverReason contract rather than an invented category', () => {
    const projected = projectDiagnosticEvent({ event: 'agent', payload: {
      runId: 'native', stream: 'lifecycle', data: {
        phase: 'error', errorObservation: { failoverReason: 'auth', httpStatus: 401 },
      },
    } }, 'epoch');
    expect(projected?.event.errorCategory).toBe('auth');
  });

  it('rejects missing identity, deltas and child events', () => {
    expect(projectDiagnosticEvent({ event: 'agent', payload: { stream: 'lifecycle', data: { phase: 'end' } } }, 'e')).toBeUndefined();
    expect(projectDiagnosticEvent({ event: 'chat', payload: { runId: 'r', state: 'delta' } }, 'e')).toBeUndefined();
    expect(projectDiagnosticEvent({ event: 'agent', payload: { runId: 'r', spawnedBy: 'parent', stream: 'lifecycle', data: { phase: 'end' } } }, 'e')).toBeUndefined();
  });

  it('projects the native validation summary into a closed reason and operation without retaining names or input', () => {
    const payload = { runId: 'r', stream: 'tool', data: { phase: 'result', name: 'read', isError: true,
      toolErrorSummary: 'read tool validation failed: invalid arguments', result: 'SECRET', args: { path: 'SECRET' } } };
    const projected = projectDiagnosticEvent({ event: 'agent', payload }, 'e');
    expect(projected?.event).toMatchObject({ toolValidationFailed: true, operation: 'file_read', toolFailed: true });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(JSON.stringify(projected)).not.toContain('toolErrorSummary');
    expect(projectDiagnosticEvent({ event: 'agent', payload: { ...payload, data: { ...payload.data, isError: false } } }, 'e')?.event.toolValidationFailed).toBeUndefined();
    const custom = projectDiagnosticEvent({ event: 'agent', payload: { ...payload, data: { ...payload.data,
      name: 'SECRET-CUSTOM', toolErrorSummary: 'SECRET-CUSTOM tool validation failed: invalid arguments' } } }, 'e');
    expect(custom?.event.operation).toBeUndefined();
    expect(custom?.event.toolValidationFailed).toBe(true);
    expect(JSON.stringify(custom)).not.toContain('SECRET');
  });

  it('keeps tool errors as metadata and never keeps tool arguments, name or output', () => {
    const projected = projectDiagnosticEvent({ event: 'session.tool', payload: {
      runId: 'r', stream: 'tool', data: { phase: 'result', isError: true,
        name: 'SECRET-TOOL', args: { password: 'SECRET' }, result: 'SECRET-OUTPUT' },
    } }, 'e');
    expect(projected?.event).toMatchObject({ kind: 'tool', phase: 'end', toolFailed: true });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });
});
