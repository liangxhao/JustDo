import { describe, expect, it } from 'vitest';

import {
  inferInitialGoalObjective,
  resolveGoalClearFetch,
  resolvePendingGoalObjectiveOnSessionChange,
} from '@/features/cowork/components/goalPendingObjective';

describe('goal pending objective', () => {
  it('infers a goal only before the session produces an assistant message', () => {
    expect(
      inferInitialGoalObjective([{ type: 'user', content: '/goal write two poems' }], true),
    ).toBe('write two poems');
    expect(
      inferInitialGoalObjective(
        [
          { type: 'user', content: '/goal write two poems' },
          { type: 'assistant', content: 'Done' },
        ],
        true,
      ),
    ).toBeNull();
    expect(
      inferInitialGoalObjective([{ type: 'user', content: '/goal write two poems' }], false),
    ).toBeNull();
  });

  it('does not infer an optimistic goal from the edit lifecycle command', () => {
    expect(
      inferInitialGoalObjective(
        [{ type: 'user', content: '/goal edit refine the release dashboard' }],
        true,
      ),
    ).toBeNull();
  });

  it('carries an optimistic goal from a temporary session into its canonical session', () => {
    expect(
      resolvePendingGoalObjectiveOnSessionChange({
        previousSessionId: 'temp-123',
        nextSessionId: 'session-123',
        currentObjective: 'write two poems',
        initialObjective: null,
      }),
    ).toBe('write two poems');
  });

  it('does not restore an old objective during an ordinary update or goal clear', () => {
    expect(
      resolvePendingGoalObjectiveOnSessionChange({
        previousSessionId: 'session-123',
        nextSessionId: 'session-123',
        currentObjective: 'write two poems',
        initialObjective: null,
      }),
    ).toBeNull();
  });

  it('ignores the cleared Goal but accepts a newer Goal generation', () => {
    expect(resolveGoalClearFetch('goal-1', 'goal-1')).toBe('ignore_old_goal');
    expect(resolveGoalClearFetch('goal-1', null)).toBe('cleared');
    expect(resolveGoalClearFetch('goal-1', 'goal-2')).toBe('accept_new_goal');
  });
});
