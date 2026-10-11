import type {
  CollaborationDelivery,
  CollaborationSnapshot,
} from '@shared/cowork/agent-team/collaboration';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { describe, expect, it } from 'vitest';

import {
  collaborationContinueDraftKey,
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
  sessionId: 'source',
  clientTurnId: 'justdo-continue-request',
  rootRunId: 'real-source-run',
  startedAt: 1,
  acceptedAt: 2,
  state: 'running',
};
const delivery: CollaborationDelivery = {
  id: 'delivery',
  roomId: 'room',
  roundId: 'new-round',
  from: 'custom-source',
  to: 'peer',
  toolCallId: 'call',
  sourceRunId: 'real-source-run',
  state: 'accepted',
  runId: 'real-peer-run',
  createdAt: 2,
  updatedAt: 2,
};
const snapshot = (deliveries: CollaborationDelivery[] = []): CollaborationSnapshot => ({
  room: {
    id: 'room',
    anchorSessionId: 'source',
    members: [
      {
        agentId: 'custom-source',
        sessionId: 'source',
        sessionKey: 'agent:custom-source:justdo:source',
      },
      { agentId: 'peer', sessionId: 'member', sessionKey: locator.targetSessionKey },
    ],
  },
  deliveries,
});
const status = (deliveries: CollaborationDelivery[], sourceTiming = timing, fresh = true) =>
  collaborationContinueStatus(locator, 'request', snapshot(deliveries), [sourceTiming], fresh);

describe('continued collaboration acceptance evidence', () => {
  it.each(['real-source-run', 'justdo-continue-request'])(
    'matches only the new source identity %s and a real accepted peer run',
    sourceRunId => {
      expect(status([{ ...delivery, sourceRunId }])).toBe('target_accepted');
    },
  );
  it.each([
    { sourceRunId: 'old-source-run' },
    { from: 'main' },
    { to: 'other' },
    { roomId: 'other' },
    { runId: undefined },
  ])('does not treat mismatched receipt %o as member execution', change => {
    expect(status([{ ...delivery, ...change }])).toBe('source_accepted');
  });
  it('does not infer execution from the newest round or a request without its source timing', () => {
    expect(
      collaborationContinueStatus(locator, 'other-request', snapshot([delivery]), [timing], true),
    ).toBeUndefined();
  });
  it('requires the exact managed member identity rather than accepting a replaced selection', () => {
    expect(
      collaborationContinueStatus(
        { ...locator, targetSessionId: 'replaced' },
        'request',
        snapshot([delivery]),
        [timing],
        true,
      ),
    ).toBeUndefined();
  });
  it('waits for a snapshot read after the exact source terminal before declaring no handoff', () => {
    const terminal = { ...timing, state: 'completed' as const, endedAt: 5 };
    expect(status([], terminal, false)).toBe('source_accepted');
    expect(status([], terminal, true)).toBe('not_forwarded');
    expect(status([], { ...terminal, endedAt: undefined }, true)).toBe('source_accepted');
  });
  it.each(['queued', 'dispatching'] as const)(
    'keeps %s handoffs pending after source completion',
    state => {
      expect(
        status([{ ...delivery, state, runId: undefined }], {
          ...timing,
          state: 'completed',
          endedAt: 5,
        }),
      ).toBe('source_accepted');
    },
  );
  it('keeps a real unknown delivery frozen until exact acceptance is observed', () => {
    expect(status([{ ...delivery, state: 'unknown', runId: undefined }])).toBe('unknown');
    expect(status([{ ...delivery, state: 'unknown' }, delivery])).toBe('target_accepted');
  });
  it('does not turn a product begin receipt alone into native source acceptance', () => {
    expect(status([], { ...timing, acceptedAt: undefined })).toBeUndefined();
  });
});

it('does not regress an accepted target or change a newer request when an old snapshot updates', () => {
  const key = collaborationContinueDraftKey(locator);
  updateContinueDraft(key, { text: 'New draft', lastRequestId: 'new', status: 'source_accepted' });
  reconcileContinueDraft(key, 'old', 'target_accepted');
  expect(getContinueDraft(key).status).toBe('source_accepted');
  reconcileContinueDraft(key, 'new', 'target_accepted');
  reconcileContinueDraft(key, 'new', 'not_forwarded');
  expect(getContinueDraft(key)).toMatchObject({
    text: 'New draft',
    lastRequestId: 'new',
    status: 'target_accepted',
  });
});
