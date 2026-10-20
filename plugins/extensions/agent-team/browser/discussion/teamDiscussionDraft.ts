import { useSyncExternalStore } from 'react';
import type { AppUiState } from '@app-plugin/sdk/browser';

import type { TeamDiscussionRunSummary, TeamDiscussionSend } from '../../contracts/teamDiscussion';

type Quote = { id: string; discussionId: string };
export interface DiscussionDraft {
  text: string;
  attachments: string[];
  quotes: Quote[];
  selected: string[];
  inputEpoch: number;
  rounds?: number;
  pending: TeamDiscussionSend | null;
  pendingMode?: 'send' | 'enqueue';
  submissionAttemptId?: string;
}
const drafts = new Map<string, DiscussionDraft>();
const listeners = new Set<() => void>();
let storage: AppUiState | undefined;
const restoredPreparations = new Map<string, string>();
export function bindDiscussionDraftStorage(state: AppUiState): () => void {
  drafts.clear();
  restoredPreparations.clear();
  const saved = state.get('discussion-drafts');
  if (Array.isArray(saved))
    for (const entry of saved) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        entry[1] &&
        typeof entry[1].text === 'string' &&
        Array.isArray(entry[1].attachments) &&
        Array.isArray(entry[1].quotes) &&
        Array.isArray(entry[1].selected) &&
        Number.isSafeInteger(entry[1].inputEpoch)
      ) {
        drafts.set(entry[0], entry[1]);
        if (entry[1].submissionAttemptId && !entry[1].pending)
          restoredPreparations.set(entry[0], entry[1].submissionAttemptId);
      }
    }
  storage = state;
  return () => {
    if (storage === state) storage = undefined;
  };
}
export function discussionPreparationRecoveryId(id: string): string | undefined {
  const attempt = restoredPreparations.get(id);
  return typeof attempt === 'string' && attempt.length > 0 && attempt === getDiscussionDraft(id).submissionAttemptId
    ? id
    : undefined;
}
/** A restored preparation can unlock only after reading its exact persisted room result. */
export function reconcileDiscussionPreparation(id: string, roomId: string, state: string): void {
  if (
    roomId !== id ||
    !discussionPreparationRecoveryId(id) ||
    getDiscussionDraft(id).pending ||
    !['ready', 'prepare_failed'].includes(state)
  )
    return;
  restoredPreparations.delete(id);
  updateDiscussionDraft(id, {
    submissionAttemptId: undefined,
    inputEpoch: getDiscussionDraft(id).inputEpoch + 1,
  });
}

export function getDiscussionDraft(id: string, text = ''): DiscussionDraft {
  let draft = drafts.get(id);
  if (!draft) {
    draft = { text, attachments: [], quotes: [], selected: [], inputEpoch: 0, pending: null };
    drafts.set(id, draft);
  }
  return draft;
}
export function updateDiscussionDraft(id: string, update: Partial<DiscussionDraft>): void {
  const next = { ...getDiscussionDraft(id), ...update };
  if ('submissionAttemptId' in update) restoredPreparations.delete(id);
  // Preserve user references, never cache fetched transcript text in the draft store.
  next.quotes = next.quotes.map(({ id, discussionId }) => ({ id, discussionId }));
  drafts.set(id, next);
  storage?.set('discussion-drafts', [...drafts]);
  listeners.forEach(listener => listener());
}
export function settleDiscussionDraft(id: string, requestId: string, accepted: boolean): void {
  const current = getDiscussionDraft(id);
  const pending = current.pending;
  if (pending?.requestId !== requestId) return;
  // A confirmation belongs to its frozen payload, never to a newer draft from another view.
  const unchanged =
    current.text === pending.message &&
    (current.rounds === undefined || current.rounds === pending.rounds) &&
    JSON.stringify(current.attachments) === JSON.stringify(pending.attachmentPaths ?? []) &&
    JSON.stringify(current.selected) === JSON.stringify(pending.selectedAgentIds) &&
    JSON.stringify(current.quotes) ===
      JSON.stringify(
        (pending.quotes ?? []).map(({ messageId, discussionId }) => ({
          id: messageId,
          discussionId,
        })),
      );
  updateDiscussionDraft(
    id,
    accepted && unchanged
      ? {
          pending: null,
          pendingMode: undefined,
          inputEpoch: current.inputEpoch + 1,
          text: '',
          attachments: [],
          quotes: [],
          selected: [],
        }
      : { pending: null, pendingMode: undefined, inputEpoch: current.inputEpoch + 1 },
  );
}
/** A successful replay envelope proves only that its original receipt was read. */
export function settleDiscussionDraftFromRun(
  id: string,
  run: TeamDiscussionRunSummary | undefined,
): void {
  if (!run || run.requestId !== getDiscussionDraft(id).pending?.requestId) return;
  if (run.state === 'running' || run.state === 'completed')
    settleDiscussionDraft(id, run.requestId, true);
  else if (run.state === 'failed' || run.state === 'cancelled')
    // Keep the payload for an explicit new submission, including already-sent native failures.
    settleDiscussionDraft(id, run.requestId, false);
}
export function deleteDiscussionDraft(id: string): void {
  drafts.delete(id);
  restoredPreparations.delete(id);
  storage?.set('discussion-drafts', [...drafts]);
  listeners.forEach(listener => listener());
}
export function useDiscussionDraft(id: string, text = ''): DiscussionDraft {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => getDiscussionDraft(id, text),
  );
}
