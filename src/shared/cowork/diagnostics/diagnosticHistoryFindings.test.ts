import { describe, expect, it } from 'vitest';

import { diagnoseHistoryFailure, type DiagnosticHistoryFailure } from './diagnosticHistoryFindings';

const failure = (overrides: Partial<DiagnosticHistoryFailure>): DiagnosticHistoryFailure => ({
  timestamp: 1,
  kind: 'tool',
  excerpt: '',
  clipped: false,
  association: 'run_window',
  ...overrides,
});

describe('failure excerpt suggestions', () => {
  it('does not mistake file names, line numbers or counts for HTTP status codes', () => {
    for (const excerpt of ['Failed at line 401', 'Could not read 403.txt', '429 checks failed']) {
      expect(diagnoseHistoryFailure(failure({ excerpt }))).toMatchObject({
        adviceKey: 'diagnosticsAdvice_tool',
        inferred: false,
      });
    }
    expect(diagnoseHistoryFailure(failure({ excerpt: 'HTTP/1.1 401' })).signal).toBe('auth');
    expect(diagnoseHistoryFailure(failure({ excerpt: 'status code: 403' })).signal).toBe(
      'permission',
    );
    expect(diagnoseHistoryFailure(failure({ excerpt: 'status=429' })).signal).toBe('rate_limit');
  });
  it('points to file, credentials, service limits and context checks without asserting root causes', () => {
    expect(diagnoseHistoryFailure(failure({ excerpt: 'ENOENT: missing' }))).toMatchObject({
      adviceKey: 'diagnosticsRemedy_ENOENT',
      inferred: true,
    });
    expect(diagnoseHistoryFailure(failure({ excerpt: 'HTTP 401 unauthorized' }))).toMatchObject({
      adviceKey: 'diagnosticsRemedy_service_auth',
      inferred: true,
    });
    expect(
      diagnoseHistoryFailure(failure({ kind: 'model', excerpt: 'HTTP 429 too many requests' })),
    ).toMatchObject({ adviceKey: 'diagnosticsAdvice_rate_limit' });
    expect(
      diagnoseHistoryFailure(failure({ kind: 'model', excerpt: 'context_length_exceeded' })),
    ).toMatchObject({ adviceKey: 'diagnosticsAdvice_context' });
  });

  it('keeps blocked and interrupted steps distinct and gives a fallback for unknown errors', () => {
    expect(diagnoseHistoryFailure(failure({ outcome: 'aborted' })).adviceKey).toBe(
      'diagnosticsHistoryAdvice_aborted',
    );
    expect(diagnoseHistoryFailure(failure({ outcome: 'blocked' }))).toMatchObject({
      adviceKey: 'diagnosticsAdvice_permission',
      inferred: false,
    });
    expect(diagnoseHistoryFailure(failure({}))).toMatchObject({
      adviceKey: 'diagnosticsAdvice_tool',
      inferred: false,
    });
  });
});
