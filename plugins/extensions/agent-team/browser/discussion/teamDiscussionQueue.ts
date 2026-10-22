import {
  TEAM_DISCUSSION_MAX_PENDING_INPUTS,
  type TeamDiscussionPendingInput,
  type TeamDiscussionRoom,
  TeamDiscussionState,
  type TeamDiscussionSummary,
} from '../../contracts/teamDiscussion';

export const DISCUSSION_PENDING_LIMIT = TEAM_DISCUSSION_MAX_PENDING_INPUTS;
const TERMINAL_PENDING_STATES = new Set(['dispatched', 'cancelled', 'failed']);
const SAVED_PENDING_STATES = new Set(['queued', 'blocked', 'dispatching', 'dispatched']);
const QUEUE_ROOM_STATES = new Set<string>([
  TeamDiscussionState.READY,
  TeamDiscussionState.RUNNING,
  TeamDiscussionState.SUBMITTING,
]);

export function discussionPendingInputs(
  room: TeamDiscussionRoom | null,
): TeamDiscussionPendingInput[] {
  return (room?.pendingInputs ?? [])
    .filter(input => !TERMINAL_PENDING_STATES.has(input.state))
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** UI admission is advisory; Main rechecks capacity, policy and the exact room generation. */
export function discussionQueueAvailable(
  room: TeamDiscussionRoom | null,
  summary: TeamDiscussionSummary | undefined,
): boolean {
  return (
    !!room &&
    QUEUE_ROOM_STATES.has(room.state) &&
    summary?.state !== 'unknown' &&
    summary?.state !== 'stopping' &&
    discussionPendingInputs(room).length < DISCUSSION_PENDING_LIMIT &&
    !(room.pendingInputs ?? []).some(input =>
      ['unknown', 'receiving_unknown', 'blocked', 'stopping'].includes(input.state),
    )
  );
}

export function discussionPendingAccepted(input: TeamDiscussionPendingInput): boolean {
  return SAVED_PENDING_STATES.has(input.state);
}

export function discussionPendingCancellable(input: TeamDiscussionPendingInput): boolean {
  return ['receiving', 'receiving_unknown', 'queued', 'blocked'].includes(input.state);
}
