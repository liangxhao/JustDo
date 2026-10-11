// @vitest-environment jsdom
import type {
  CollaborationDelivery,
  CollaborationRoom,
} from '@shared/cowork/agent-team/collaboration';
import { beforeEach, expect, it, vi } from 'vitest';

import { prepareCollaborationReference } from './collaborationReference';

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  dispatch: vi.fn(),
  state: {
    cowork: {
      currentSession: { id: 'source' },
      draftMessageQuotes: {} as Record<string, unknown[]>,
      draftPrompts: { source: 'Untouched draft' },
      draftAgentTeamModes: { source: { mode: 'group' } },
    },
  },
}));
vi.mock('@/store', () => ({
  store: { getState: () => mock.state, dispatch: mock.dispatch },
}));
const room: CollaborationRoom = {
  id: 'room',
  anchorSessionId: 'source',
  members: [
    { agentId: 'organizer', sessionId: 'source', sessionKey: 'agent:organizer:justdo:source' },
    { agentId: 'worker', sessionId: 'peer', sessionKey: 'agent:worker:justdo:peer' },
  ],
};
const member = room.members[1];
const delivery: CollaborationDelivery = {
  id: 'delivery',
  roomId: 'room',
  roundId: 'old-round',
  from: 'organizer',
  to: 'worker',
  toolCallId: 'tool',
  sourceRunId: 'source-run',
  state: 'accepted',
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  mock.dispatch.mockClear();
  mock.state.cowork.currentSession.id = 'source';
  mock.state.cowork.draftMessageQuotes = {};
  mock.read
    .mockReset()
    .mockResolvedValue({ success: true, value: { room, deliveries: [delivery] } });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { collaboration: { read: mock.read } },
  });
});

it('prepares only a locator for a managed peer without sending or consuming the main draft', async () => {
  await prepareCollaborationReference(room, member, 'Worker', delivery, () => true);
  expect(mock.read).toHaveBeenCalledExactlyOnceWith('source');
  expect(mock.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: 'cowork/addDraftMessageQuote',
      payload: {
        draftKey: 'source',
        quote: expect.objectContaining({
          kind: 'collaboration',
          roomId: 'room',
          targetSessionKey: member.sessionKey,
          priorRoundId: 'old-round',
          deliveryId: 'delivery',
          sourceSessionId: 'source',
        }),
      },
    }),
  );
  expect(mock.state.cowork.draftPrompts.source).toBe('Untouched draft');
  expect(mock.state.cowork.draftAgentTeamModes.source.mode).toBe('group');
  expect(JSON.stringify(mock.dispatch.mock.calls)).not.toContain('source-run');
});

it.each([
  'member-replaced',
  'room-deleted',
  'receipt-replaced',
  'source-changed',
  'detail-changed',
] as const)('does not add a stale reference after %s during validation', async reason => {
  mock.read.mockImplementation(async () => {
    if (reason === 'source-changed') mock.state.cowork.currentSession.id = 'other';
    return {
      success: true,
      value: {
        room:
          reason === 'room-deleted'
            ? { ...room, deleting: true }
            : reason === 'member-replaced'
              ? { ...room, members: [room.members[0], { ...member, sessionId: 'replacement' }] }
              : room,
        deliveries: reason === 'receipt-replaced' ? [] : [delivery],
      },
    };
  });
  let calls = 0;
  await expect(
    prepareCollaborationReference(
      room,
      member,
      'Worker',
      delivery,
      () => reason !== 'detail-changed' || ++calls === 1,
    ),
  ).rejects.toThrow('collaborationInvalidRecipient');
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it('preserves the main draft and all cards when the reference tray is full', async () => {
  mock.state.cowork.draftMessageQuotes.source = Array.from({ length: 8 }, (_, index) => ({
    id: String(index),
  }));
  await expect(
    prepareCollaborationReference(room, member, 'Worker', delivery, () => true),
  ).rejects.toThrow('teamReferenceLimit');
  expect(mock.dispatch).not.toHaveBeenCalled();
  expect(mock.state.cowork.draftMessageQuotes.source).toHaveLength(8);
});

it('does not use the source assistant as an owned peer', async () => {
  await expect(
    prepareCollaborationReference(room, room.members[0], 'Organizer', undefined, () => true),
  ).rejects.toThrow('collaborationInvalidRecipient');
  expect(mock.read).not.toHaveBeenCalled();
});
