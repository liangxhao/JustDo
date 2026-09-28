import { describe, expect, it } from 'vitest';

import { projectDiagnosticEvent } from './runtimeDiagnostics';

describe('projectDiagnosticEvent', () => {
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

  it('keeps tool errors as metadata and never keeps tool arguments, name or output', () => {
    const projected = projectDiagnosticEvent({ event: 'session.tool', payload: {
      runId: 'r', stream: 'tool', data: { phase: 'result', isError: true,
        name: 'SECRET-TOOL', args: { password: 'SECRET' }, result: 'SECRET-OUTPUT' },
    } }, 'e');
    expect(projected?.event).toMatchObject({ kind: 'tool', phase: 'end', toolFailed: true });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });
});
