import type { CollaborationDelivery, CollaborationSnapshot } from '../../../contracts/collaboration';
import type { SessionRunTiming } from '@app-plugin/sdk/application';
import { describe, expect, it } from 'vitest';

import {
  collaborationContinueDraftKey,
  collaborationMemberTurnId,
  getContinueDraft,
  reconcileContinueDraft,
  updateContinueDraft,
} from './collaborationContinueDraft';
import { collaborationContinueStatus } from './collaborationContinueStatus';

const locator = {
  roomId: 'room',
  sourceSessionId: 'source',
  targetAgentId: 'peer',
  targetSessionId: 'member',
  targetSessionKey: 'agent:peer:justdo:member',
};
const timing: SessionRunTiming = {
  id: 'timing',
  sessionId: 'member',
  clientTurnId: collaborationMemberTurnId('request'),
  rootRunId: 'real-member-run',
  startedAt: 1,
  acceptedAt: 2,
  state: 'running',
};
const snapshot: CollaborationSnapshot = {
  room: {
    id: 'room',
    anchorSessionId: 'source',
    members: [
      { agentId: 'organizer', sessionId: 'source', sessionKey: 'agent:organizer:justdo:source' },
      { agentId: 'peer', sessionId: 'member', sessionKey: locator.targetSessionKey },
    ],
  },
  deliveries: [],
};

it('recovers a lost response only from exact member native acceptance', () => {
  expect(collaborationContinueStatus(locator, 'request', snapshot, [timing])).toBe(
    'target_accepted',
  );
  expect(
    collaborationContinueStatus(locator, 'request', snapshot, [{ ...timing, sessionId: 'source' }]),
  ).toBeUndefined();
  expect(collaborationContinueStatus(locator, 'other', snapshot, [timing])).toBeUndefined();
  expect(
    collaborationContinueStatus({ ...locator, targetSessionKey: 'replaced' }, 'request', snapshot, [
      timing,
    ]),
  ).toBeUndefined();
});

it('does not treat local begin, idle or a product terminal as native acceptance', () => {
  for (const state of ['running', 'completed', 'failed', 'aborted'] as const) {
    expect(
      collaborationContinueStatus(locator, 'request', snapshot, [
        {
          ...timing,
          state,
          acceptedAt: undefined,
          endedAt: 5,
        },
      ]),
    ).toBeUndefined();
  }
});

it('does not regress accepted input or change a newer member draft on an old response', () => {
  const key = collaborationContinueDraftKey(locator);
  updateContinueDraft(key, { text: 'New draft', lastRequestId: 'new', status: 'unknown' });
  reconcileContinueDraft(key, 'old', 'target_accepted');
  expect(getContinueDraft(key).status).toBe('unknown');
  reconcileContinueDraft(key, 'new', 'target_accepted');
  reconcileContinueDraft(key, 'new', 'unknown');
  expect(getContinueDraft(key)).toMatchObject({
    text: 'New draft',
    lastRequestId: 'new',
    status: 'target_accepted',
  });
});
