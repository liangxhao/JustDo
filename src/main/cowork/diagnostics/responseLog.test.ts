import { describe, expect, it } from 'vitest';

import { projectResponseLog } from './responseLog';

describe('native model recovery evidence', () => {
  it('recognizes native closed result codes and exhaustion', () => {
    expect(
      projectResponseLog(
        [
          {
            event: 'model_fallback_decision',
            decision: 'candidate_failed',
            code: 'reasoning_only_result',
            fallbackStepFinalOutcome: 'chain_exhausted',
            secret: 'SECRET',
          },
        ],
        '',
        'warn',
      ),
    ).toEqual({
      responseIssue: 'reasoning_only',
      responseRecovery: 'exhausted',
      basis: 'error_category',
    });
    expect(
      projectResponseLog(
        [{ event: 'model_fallback_decision', decision: 'succeeded', code: 'empty_result' }],
        '',
        'info',
      ),
    ).toBeUndefined();
  });
  it('distinguishes retry from exhaustion without keeping the log text', () => {
    expect(
      projectResponseLog([], 'reasoning-only assistant turn detected: runId=SECRET', 'warn'),
    ).toEqual({
      responseIssue: 'reasoning_only',
      responseRecovery: 'retrying',
      basis: 'error_text',
    });
    expect(
      projectResponseLog([], 'empty response retries exhausted: runId=SECRET', 'warn'),
    ).toEqual({
      responseIssue: 'empty_response',
      responseRecovery: 'exhausted',
      basis: 'error_text',
    });
    expect(
      projectResponseLog([], 'reasoning-only assistant turn detected:', 'info'),
    ).toBeUndefined();
  });
});
