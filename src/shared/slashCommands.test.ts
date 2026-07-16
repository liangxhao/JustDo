import { describe, expect, it } from 'vitest';

import { parseGoalStartObjective } from './slashCommands';

describe('parseGoalStartObjective', () => {
  it('extracts bare and explicit goal objectives', () => {
    expect(parseGoalStartObjective('/goal build a release dashboard')).toBe(
      'build a release dashboard',
    );
    expect(parseGoalStartObjective('/goal start ship the desktop app')).toBe(
      'ship the desktop app',
    );
    expect(parseGoalStartObjective('/goal --tokens 50K improve startup time')).toBe(
      'improve startup time',
    );
  });

  it('does not treat lifecycle controls as new goals', () => {
    expect(parseGoalStartObjective('/goal')).toBeNull();
    expect(parseGoalStartObjective('/goal status')).toBeNull();
    expect(parseGoalStartObjective('/goal complete')).toBeNull();
    expect(parseGoalStartObjective('write a goal')).toBeNull();
  });
});
