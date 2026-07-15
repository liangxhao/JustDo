import { describe, expect, it } from 'vitest';

import { readSessionGoal } from './sessionRuntime';

describe('readSessionGoal', () => {
  it('normalizes a valid Gateway goal', () => {
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: '  Ship the goal UI  ',
        status: 'blocked',
        createdAt: 10,
        updatedAt: 20,
        tokenStart: 100,
        tokensUsed: 25,
        tokenBudget: 50,
        continuationTurns: 2,
        lastStatusNote: '  Waiting for review  ',
      }),
    ).toMatchObject({
      id: 'goal-1',
      objective: 'Ship the goal UI',
      status: 'blocked',
      tokensUsed: 25,
      tokenBudget: 50,
      lastStatusNote: 'Waiting for review',
    });
  });

  it('rejects malformed or unknown goal states', () => {
    expect(readSessionGoal({ id: 'goal-1', objective: '', status: 'active' })).toBeUndefined();
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'mystery',
      }),
    ).toBeUndefined();
  });

  it('does not expose invalid negative counters', () => {
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'active',
        tokensUsed: -1,
        tokenBudget: -10,
        pausedAt: -20,
      }),
    ).toMatchObject({ tokensUsed: 0 });
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'active',
        tokenBudget: -10,
      }),
    ).not.toHaveProperty('tokenBudget');
  });
});
