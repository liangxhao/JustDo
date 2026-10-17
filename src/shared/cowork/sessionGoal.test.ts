import { describe, expect, it } from 'vitest';

import {
  isDefinitiveSessionGoalGatewayError,
  normalizeSessionGoal,
  normalizeSessionGoalMutationRequest,
  SESSION_GOAL_MAX_NOTE_LENGTH,
  SESSION_GOAL_MAX_OBJECTIVE_LENGTH,
} from './sessionGoal';

describe('isDefinitiveSessionGoalGatewayError', () => {
  it.each(['receipt-invalid', 'expired', 'unrecognized-reason'])(
    'retains unknown outcomes for typed %s rejections',
    reason => {
      expect(
        isDefinitiveSessionGoalGatewayError({
          gatewayCode: 'INVALID_REQUEST',
          details: { code: 'GOAL_OPERATION_REJECTED', reason },
        }),
      ).toBe(false);
      expect(
        isDefinitiveSessionGoalGatewayError({
          gatewayCode: 'INVALID_REQUEST',
          details: { reason: `goal-${reason}` },
        }),
      ).toBe(false);
    },
  );

  it.each(['invalid', 'capacity', 'operation-conflict', 'session-rebound', 'goal-rebound'])(
    'retires a typed pre-commit %s rejection',
    reason => {
      expect(
        isDefinitiveSessionGoalGatewayError({
          gatewayCode: 'INVALID_REQUEST',
          details: { code: 'GOAL_OPERATION_REJECTED', reason },
        }),
      ).toBe(true);
    },
  );
  it('retains ambiguous unavailable failures even when clients default retryable to false', () => {
    expect(
      isDefinitiveSessionGoalGatewayError({ gatewayCode: 'UNAVAILABLE', retryable: false }),
    ).toBe(false);
    expect(isDefinitiveSessionGoalGatewayError({ gatewayCode: 'UNKNOWN' })).toBe(false);
    expect(isDefinitiveSessionGoalGatewayError({ gatewayCode: 'INVALID_REQUEST' })).toBe(true);
  });
});

describe('normalizeSessionGoalMutationRequest', () => {
  it('preserves literal edit objectives and resume notes', () => {
    expect(
      normalizeSessionGoalMutationRequest({
        action: 'edit',
        goalId: ' goal-1 ',
        objective: '  Ship\nexactly  ',
      }),
    ).toEqual({ action: 'edit', goalId: 'goal-1', objective: '  Ship\nexactly  ' });
    expect(
      normalizeSessionGoalMutationRequest({
        action: 'resume',
        goalId: 'goal-1',
        note: '  CI passed.  ',
      }),
    ).toEqual({ action: 'resume', goalId: 'goal-1', note: '  CI passed.  ' });
  });

  it('enforces the native objective and note bounds', () => {
    expect(
      normalizeSessionGoalMutationRequest({
        action: 'edit',
        goalId: 'goal-1',
        objective: 'x'.repeat(SESSION_GOAL_MAX_OBJECTIVE_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(
      normalizeSessionGoalMutationRequest({
        action: 'resume',
        goalId: 'goal-1',
        note: 'x'.repeat(SESSION_GOAL_MAX_NOTE_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(
      normalizeSessionGoalMutationRequest({ action: 'edit', goalId: 'goal-1', objective: '  ' }),
    ).toBeUndefined();
  });

  it('rejects unknown actions and payloads without a fenced Goal id', () => {
    expect(
      normalizeSessionGoalMutationRequest({ action: 'replace', goalId: 'goal-1' }),
    ).toBeUndefined();
    expect(normalizeSessionGoalMutationRequest({ action: 'clear', goalId: '  ' })).toBeUndefined();
  });
});

describe('normalizeSessionGoal', () => {
  it('preserves literal text and distinct limited states', () => {
    expect(
      normalizeSessionGoal({
        schemaVersion: 1,
        id: ' goal-1 ',
        objective: '  Ship exactly  ',
        status: 'budget_limited',
        lastStatusNote: '  Budget exhausted  ',
      }),
    ).toMatchObject({
      id: 'goal-1',
      objective: '  Ship exactly  ',
      status: 'budget_limited',
      lastStatusNote: '  Budget exhausted  ',
    });
  });
});
