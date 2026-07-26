import { describe, expect, test } from 'vitest';

import { parseExecutionPlanUpdate } from './executionPlan';

describe('parseExecutionPlanUpdate', () => {
  test('normalizes a valid plan and optional explanation', () => {
    expect(
      parseExecutionPlanUpdate({
        explanation: '  Starting implementation  ',
        plan: [
          { step: ' Inspect the code ', status: 'completed', ignored: true },
          { step: 'Implement the UI', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' },
        ],
        unknown: true,
      }),
    ).toEqual({
      explanation: 'Starting implementation',
      plan: [
        { step: 'Inspect the code', status: 'completed' },
        { step: 'Implement the UI', status: 'in_progress' },
        { step: 'Run tests', status: 'pending' },
      ],
    });
  });

  test.each([
    null,
    [],
    {},
    { plan: [] },
    { explanation: null, plan: [{ step: 'Valid', status: 'pending' }] },
    { explanation: 123, plan: [{ step: 'Valid', status: 'pending' }] },
    { plan: [{ step: '', status: 'pending' }] },
    { plan: [{ step: 'Invalid', status: 'failed' }] },
    {
      plan: [
        { step: 'One', status: 'in_progress' },
        { step: 'Two', status: 'in_progress' },
      ],
    },
    {
      plan: [
        { step: 'Valid', status: 'completed' },
        { step: '', status: 'pending' },
      ],
    },
  ])('rejects an invalid plan atomically', candidate => {
    expect(parseExecutionPlanUpdate(candidate)).toBeNull();
  });
});
