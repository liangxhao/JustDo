import type {
  TeamDiscussionPendingInput,
  TeamDiscussionRoom,
} from '../../contracts/teamDiscussion';
import { describe, expect, it } from 'vitest';

import {
  deleteDiscussionDraft,
  getDiscussionDraft,
  settleDiscussionDraft,
  updateDiscussionDraft,
} from './teamDiscussionDraft';
import {
  discussionPendingAccepted,
  discussionPendingCancellable,
  discussionPendingInputs,
  discussionQueueAvailable,
} from './teamDiscussionQueue';

const pending = (
  state: TeamDiscussionPendingInput['state'],
  createdAt = 1,
): TeamDiscussionPendingInput => ({
  requestId: String(createdAt),
  state,
  createdAt,
  rounds: 2,
  selectedAgentIds: ['peer'],
});
const room = (inputs: TeamDiscussionPendingInput[] = []): TeamDiscussionRoom => ({
  id: 'room',
  title: 'Group',
  members: [],
  rounds: 2,
  revision: 1,
  generation: 0,
  state: 'running',
  activeDiscussionId: 'active',
  cwd: '/project',
  permissionMode: 'ask',
  createdAt: 0,
  updatedAt: 0,
  pendingInputs: inputs,
});

describe('discussion queue admission projection', () => {
  it.each([
    'receiving',
    'receiving_unknown',
    'queued',
    'dispatching',
    'unknown',
    'blocked',
  ] as const)('retains capacity for %s even before an execution starts', state => {
    expect(
      discussionPendingInputs(room([pending(state, 1), pending(state, 2), pending(state, 3)])),
    ).toHaveLength(3);
    expect(
      discussionQueueAvailable(
        room([pending(state, 1), pending(state, 2), pending(state, 3)]),
        undefined,
      ),
    ).toBe(false);
  });
  it('orders pending metadata while leaving its authoritative snapshot intact', () => {
    const snapshot = room([
      pending('queued', 3),
      pending('dispatched', 2),
      pending('queued', 1),
      pending('cancelled', 4),
      pending('failed', 5),
    ]);
    expect(discussionPendingInputs(snapshot).map(input => input.requestId)).toEqual(['1', '3']);
    expect(snapshot.pendingInputs?.map(input => input.requestId)).toEqual([
      '3',
      '2',
      '1',
      '4',
      '5',
    ]);
    expect(discussionQueueAvailable(snapshot, undefined)).toBe(true);
  });
  it.each(['unknown', 'receiving_unknown', 'blocked'] as const)(
    'blocks fresh input behind an uncertain %s entry',
    state => {
      expect(discussionQueueAvailable(room([pending(state)]), undefined)).toBe(false);
    },
  );
  it.each(['stopping', 'interrupted', 'deleting', 'preparing', 'prepare_failed'] as const)(
    'rejects queue admission in %s rooms',
    state => {
      expect(discussionQueueAvailable({ ...room(), state }, undefined)).toBe(false);
    },
  );
  it.each(['unknown', 'stopping'] as const)('rejects admission while summary is %s', state => {
    expect(discussionQueueAvailable(room(), { discussionId: 'prior', state })).toBe(false);
  });
  it('allows pending and running summaries to hold a later input without executing it', () => {
    expect(discussionQueueAvailable(room(), { discussionId: 'prior', state: 'pending' })).toBe(
      true,
    );
    expect(discussionQueueAvailable(room(), { discussionId: 'prior', state: 'running' })).toBe(
      true,
    );
  });
  it('does not treat an unconfirmed native append as a saved input or offer to cancel an admitted execution', () => {
    expect(discussionPendingAccepted(pending('receiving_unknown'))).toBe(false);
    expect(discussionPendingAccepted(pending('queued'))).toBe(true);
    expect(discussionPendingCancellable(pending('queued'))).toBe(true);
    expect(discussionPendingCancellable(pending('dispatching'))).toBe(false);
    expect(discussionPendingCancellable(pending('unknown'))).toBe(false);
  });
});

it('an old queue ACK unlocks its request without clearing a newer draft from another view', () => {
  const id = 'queue-draft';
  deleteDiscussionDraft(id);
  updateDiscussionDraft(id, {
    text: 'Earlier',
    pendingMode: 'enqueue',
    pending: {
      roomId: id,
      requestId: 'first',
      expectedRevision: 1,
      message: 'Earlier',
      attachmentPaths: [],
      selectedAgentIds: [],
      rounds: 2,
    },
  });
  updateDiscussionDraft(id, {
    text: 'Newer',
    attachments: ['/new'],
    selected: ['peer'],
    quotes: [{ id: 'new', discussionId: 'new-batch' }],
  });
  settleDiscussionDraft(id, 'first', true);
  expect(getDiscussionDraft(id)).toMatchObject({
    text: 'Newer',
    attachments: ['/new'],
    selected: ['peer'],
    quotes: [{ id: 'new', discussionId: 'new-batch' }],
    pending: null,
    pendingMode: undefined,
  });
  deleteDiscussionDraft(id);
});
