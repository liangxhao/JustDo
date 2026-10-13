import { useSyncExternalStore } from 'react';

export interface CollaborationContinueRequest {
  requestId: string;
  message: string;
  attachmentPaths?: string[];
}
export type CollaborationContinueStatus =
  'source_accepted' | 'target_accepted' | 'not_forwarded' | 'unknown' | 'rejected';
export type RequestCollaborationContinue = (
  input: CollaborationContinueRequest,
) => Promise<CollaborationContinueStatus>;
export interface CollaborationContinueLocator {
  roomId: string;
  sourceSessionId: string;
  targetAgentId: string;
  targetSessionId: string;
  targetSessionKey: string;
}
export function collaborationContinueDraftKey(
  locator: CollaborationContinueLocator,
  priorDeliveryId?: string,
): string {
  return JSON.stringify([
    locator.roomId,
    locator.sourceSessionId,
    locator.targetAgentId,
    locator.targetSessionId,
    locator.targetSessionKey,
    priorDeliveryId ?? null,
  ]);
}

interface ContinueDraft {
  text: string;
  attachments: string[];
  inputEpoch: number;
  pending?: CollaborationContinueRequest;
  status?: CollaborationContinueStatus;
  lastRequestId?: string;
}
const drafts = new Map<string, ContinueDraft>();
const listeners = new Set<() => void>();
let requestsRevision = 0;

export function getContinueDraft(key: string): ContinueDraft {
  let draft = drafts.get(key);
  if (!draft) {
    draft = { text: '', attachments: [], inputEpoch: 0 };
    drafts.set(key, draft);
  }
  return draft;
}
export function updateContinueDraft(key: string, update: Partial<ContinueDraft>): void {
  const previous = getContinueDraft(key);
  const next = { ...previous, ...update };
  drafts.set(key, next);
  if (
    previous.lastRequestId !== next.lastRequestId ||
    previous.status !== next.status ||
    previous.pending?.requestId !== next.pending?.requestId
  )
    requestsRevision++;
  listeners.forEach(listener => listener());
}
export function continueRequests(sourceSessionId: string): Array<{
  key: string;
  locator: CollaborationContinueLocator;
  requestId: string;
  status?: CollaborationContinueStatus;
}> {
  return [...drafts].flatMap(([key, draft]) => {
    if (!draft.lastRequestId) return [];
    try {
      const scope: unknown = JSON.parse(key);
      if (
        !Array.isArray(scope) ||
        scope.length !== 6 ||
        scope.slice(0, 5).some(item => typeof item !== 'string' || !item) ||
        scope[1] !== sourceSessionId
      )
        return [];
      return [
        {
          key,
          requestId: draft.lastRequestId,
          status: draft.status,
          locator: {
            roomId: scope[0],
            sourceSessionId: scope[1],
            targetAgentId: scope[2],
            targetSessionId: scope[3],
            targetSessionKey: scope[4],
          },
        },
      ];
    } catch {
      return [];
    }
  });
}
/** Request metadata changes trigger receipt checks; typing does not trigger history reads. */
export function useContinueRequestsRevision(): number {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requestsRevision,
  );
}
export function settleContinueDraft(
  key: string,
  requestId: string,
  status: CollaborationContinueStatus,
): void {
  const current = getContinueDraft(key);
  if (current.pending?.requestId !== requestId) return;
  const accepted = status === 'source_accepted' || status === 'target_accepted';
  const unchanged =
    current.text === current.pending.message &&
    JSON.stringify(current.attachments) === JSON.stringify(current.pending.attachmentPaths ?? []);
  updateContinueDraft(key, {
    status,
    ...(status !== 'unknown' ? { pending: undefined, inputEpoch: current.inputEpoch + 1 } : {}),
    ...(accepted && unchanged ? { text: '', attachments: [] } : {}),
  });
}
export function reconcileContinueDraft(
  key: string,
  requestId: string,
  status: CollaborationContinueStatus,
): void {
  const current = getContinueDraft(key);
  if (
    current.lastRequestId !== requestId ||
    current.status === 'target_accepted' ||
    current.status === 'rejected' ||
    current.status === status
  )
    return;
  if (current.pending?.requestId === requestId) settleContinueDraft(key, requestId, status);
  else updateContinueDraft(key, { status });
}
export function useContinueDraft(key: string): ContinueDraft {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getContinueDraft(key),
  );
}
