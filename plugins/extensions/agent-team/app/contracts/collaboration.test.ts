import { describe, expect, it } from 'vitest';

import {
  buildCollaborationEdges,
  type CollaborationDelivery,
  type CollaborationRoom,
  parseCollaborationReview,
  parseCollaborationSend,
  validateCollaborationRoom,
} from './collaboration';

it('validates review verdicts and bounded exact receipt IDs without accepting prose or authority fields', () => {
  expect(parseCollaborationReview({ deliveryIds: ['b', 'a'], verdict: 'unverified' })).toEqual({
    deliveryIds: ['a', 'b'],
    verdict: 'unverified',
  });
  for (const value of [
    null,
    { deliveryIds: [], verdict: 'passed' },
    { deliveryIds: ['a', 'a'], verdict: 'passed' },
    { deliveryIds: ['a'], verdict: 'completed' },
    { deliveryIds: ['a'], verdict: 'passed', reviewerAgentId: 'forged' },
    { deliveryIds: ['a'], verdict: 'passed', evidence: 'untrusted prose' },
    { deliveryIds: ['../outside'], verdict: 'passed' },
    { deliveryIds: Array.from({ length: 17 }, (_, i) => `d${i}`), verdict: 'passed' },
  ])
    expect(() => parseCollaborationReview(value)).toThrow('collaborationInvalidReview');
});

const room: CollaborationRoom = {
  id: 'room',
  anchorSessionId: 'a',
  members: ['a', 'b', 'c'].map(agentId => ({
    agentId,
    sessionId: agentId,
    sessionKey: `agent:${agentId}:justdo:${agentId}`,
  })),
};
const delivery = (changes: Partial<CollaborationDelivery> = {}): CollaborationDelivery => ({
  id: 'message',
  roomId: 'room',
  roundId: 'turn',
  from: 'a',
  to: 'b',
  toolCallId: 'call',
  sourceRunId: 'source-run',
  state: 'queued',
  createdAt: 1,
  updatedAt: 1,
  ...changes,
});

describe('collaboration graph projection', () => {
  it('does not invent links for idle peers or subtask relationships', () => {
    expect(buildCollaborationEdges(room, [])).toEqual([]);
    expect(room.members).toHaveLength(3);
  });
  it('preserves direction and distinguishes acceptance, pending, uncertainty and failure', () => {
    const edges = buildCollaborationEdges(room, [
      delivery(),
      delivery({ state: 'accepted', updatedAt: 2 }),
      delivery({ id: 'reply', from: 'b', to: 'a', state: 'unknown' }),
      delivery({ id: 'failed', state: 'failed' }),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ from: 'a', to: 'b', accepted: 1, pending: 0, failed: 1 });
    expect(edges[0].deliveries).toHaveLength(2);
    expect(edges[1]).toMatchObject({ from: 'b', to: 'a', unknown: 1, accepted: 0 });
  });
  it('ignores receipts from another room and unknown members', () => {
    expect(
      buildCollaborationEdges(room, [
        delivery({ roomId: 'other' }),
        delivery({ from: 'stranger' }),
      ]),
    ).toEqual([]);
  });
  it('rejects a subagent native key masquerading as a peer', () => {
    expect(() =>
      validateCollaborationRoom({
        ...room,
        members: room.members.map((member, i) =>
          i === 0 ? { ...member, sessionKey: 'agent:a:subagent:child' } : member,
        ),
      }),
    ).toThrow();
  });
  it('accepts twelve task members and rejects a thirteenth', () => {
    const members = Array.from({ length: 12 }, (_, index) => ({
      agentId: `agent-${index}`,
      sessionId: index === 0 ? 'a' : `session-${index}`,
      sessionKey: `agent:agent-${index}:justdo:${index === 0 ? 'a' : `session-${index}`}`,
    }));
    expect(() => validateCollaborationRoom({ ...room, members })).not.toThrow();
    expect(() =>
      validateCollaborationRoom({
        ...room,
        members: [
          ...members,
          {
            agentId: 'agent-12',
            sessionId: 'session-12',
            sessionKey: 'agent:agent-12:justdo:session-12',
          },
        ],
      }),
    ).toThrow();
  });
  it('preserves message content while rejecting empty, oversized or extra fields', () => {
    expect(parseCollaborationSend({ to: 'b', message: '  exact content  ' }).message).toBe(
      '  exact content  ',
    );
    for (const value of [
      null,
      [],
      { to: 'b', message: '  ' },
      { to: 'b', message: 'x'.repeat(16001) },
      { to: 'b', message: 'ok', roomId: 'forged' },
    ])
      expect(() => parseCollaborationSend(value)).toThrow();
  });
});
