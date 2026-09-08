import { describe, expect, it } from 'vitest';

import {
  canStartWorkboardCard,
  type WorkboardCard,
  workboardCardSessionKey,
} from './workboard';

const card = (patch: Partial<WorkboardCard> = {}): WorkboardCard => ({
  id: 'card-1',
  title: 'Card',
  status: 'todo',
  priority: 'normal',
  labels: [],
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe('workboard card execution state', () => {
  it('resolves a linked session from either the card or execution', () => {
    expect(workboardCardSessionKey(card({ sessionKey: ' agent:main:subagent:one ' }))).toBe(
      'agent:main:subagent:one',
    );
    expect(
      workboardCardSessionKey(
        card({
          execution: {
            id: 'execution-1',
            kind: 'agent-session',
            mode: 'autonomous',
            status: 'review',
            sessionKey: 'agent:main:subagent:two',
            startedAt: 1,
            updatedAt: 2,
          },
        }),
      ),
    ).toBe('agent:main:subagent:two');
  });

  it.each(['backlog', 'todo', 'ready'] as const)('allows an unclaimed %s card to start', status => {
    expect(canStartWorkboardCard(card({ status }), 100)).toBe(true);
  });

  it.each(['triage', 'scheduled', 'running', 'review', 'blocked', 'done'] as const)(
    'does not offer start for a %s card',
    status => {
      expect(canStartWorkboardCard(card({ status }), 100)).toBe(false);
    },
  );

  it('does not offer start when an execution link, task, or active claim exists', () => {
    expect(canStartWorkboardCard(card({ sessionKey: 'agent:main:subagent:one' }), 100)).toBe(false);
    expect(canStartWorkboardCard(card({ taskId: 'task-1' }), 100)).toBe(false);
    expect(
      canStartWorkboardCard(
        card({
          metadata: {
            claim: {
              ownerId: 'main',
              token: 'secret',
              claimedAt: 1,
              lastHeartbeatAt: 2,
              expiresAt: 101,
            },
          },
        }),
        100,
      ),
    ).toBe(false);
    expect(canStartWorkboardCard(card({ metadata: { archivedAt: 1 } }), 100)).toBe(false);
  });
});
