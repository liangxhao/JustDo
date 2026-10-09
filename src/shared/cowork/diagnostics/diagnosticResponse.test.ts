import { describe, expect, it } from 'vitest';

import { diagnosticResponseIssue, projectDiagnosticResponse } from './diagnosticResponse';

describe('model response shape evidence', () => {
  const project = (content: unknown, extra = {}) =>
    projectDiagnosticResponse(
      { role: 'assistant', content, stopReason: 'stop', ...extra },
      100,
      'run',
    );
  it('detects reasoning-only and empty output without retaining content', () => {
    const response = project([{ type: 'thinking', thinking: 'SECRET' }]);
    expect(diagnosticResponseIssue(response)).toBe('reasoning_only');
    expect(JSON.stringify(response)).not.toContain('SECRET');
    expect(diagnosticResponseIssue(project([]))).toBe('empty_response');
    expect(diagnosticResponseIssue(project([{ type: 'redacted_thinking' }]))).toBe(
      'reasoning_only',
    );
  });
  it.each([
    [{ type: 'text', text: 'answer' }],
    [{ type: 'toolCall', id: 'call' }],
    [{ type: 'image' }],
    [{ type: 'unknown' }],
    [null],
  ])('does not mistake usable or unknown blocks for empty output: %j', block => {
    expect(diagnosticResponseIssue(project([block]))).toBeUndefined();
  });
  it('requires a complete response with a known finish reason', () => {
    expect(
      diagnosticResponseIssue(project([], { __openclaw: { truncated: true } })),
    ).toBeUndefined();
    expect(diagnosticResponseIssue(project([], { stopReason: 'error' }))).toBeUndefined();
    expect(diagnosticResponseIssue(project([], { mediaUrl: 'image.png' }))).toBeUndefined();
    expect(project([], { phase: 'commentary' })).toBeUndefined();
    expect(project(undefined)).toBeUndefined();
  });
  it('recognizes long thinking under the native per-block display cap only', () => {
    const content = [{ type: 'thinking', thinking: 'x'.repeat(8000) }];
    expect(
      diagnosticResponseIssue(
        project(content, { __openclaw: { truncated: true, reason: 'display-cap' } }),
      ),
    ).toBe('reasoning_only');
    expect(
      diagnosticResponseIssue(
        project(content, { __openclaw: { truncated: true, reason: 'oversized' } }),
      ),
    ).toBeUndefined();
    expect(
      diagnosticResponseIssue(
        project(content, {
          __openclaw: { truncated: true, reason: 'display-cap' },
          openclawStreamFallback: { source: 'segment' },
        }),
      ),
    ).toBeUndefined();
  });
});
