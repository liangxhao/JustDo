import type { AppUiState } from '@app-plugin/sdk/browser';
import { afterEach, expect, test } from 'vitest';

import {
  bindContinueDraftStorage,
  collaborationContinueDraftKey,
  getContinueDraft,
  updateContinueDraft,
} from '../../browser/collaboration/collaborationContinueDraft';
import {
  bindDiscussionDraftStorage,
  discussionPreparationRecoveryId,
  getDiscussionDraft,
  reconcileDiscussionPreparation,
  updateDiscussionDraft,
} from '../../browser/discussion/teamDiscussionDraft';

const releases: (() => void)[] = [];
afterEach(() =>
  releases
    .splice(0)
    .reverse()
    .forEach(release => release()),
);
function state(): AppUiState {
  const values = new Map<string, unknown>();
  return {
    get: key => structuredClone(values.get(key)),
    set: (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}

test('remount restores continuation text, attachment locators and the same frozen unknown receipt', () => {
  const saved = state();
  const key = collaborationContinueDraftKey(
    {
      roomId: 'room',
      sourceSessionId: 'source',
      targetAgentId: 'agent',
      targetSessionId: 'product',
      targetSessionKey: 'exact-native',
    },
    'prior-delivery',
  );
  const release = bindContinueDraftStorage(saved);
  updateContinueDraft(key, {
    text: 'user body',
    attachments: ['C:/user/image.png'],
    inputEpoch: 3,
    pending: {
      requestId: 'original-request',
      message: 'user body',
      attachmentPaths: ['C:/user/image.png'],
    },
    lastRequestId: 'original-request',
    status: 'unknown',
  });
  release();
  updateContinueDraft(key, { text: 'old module late callback', pending: undefined });
  releases.push(bindContinueDraftStorage(saved));
  expect(getContinueDraft(key)).toMatchObject({
    text: 'user body',
    inputEpoch: 3,
    status: 'unknown',
    pending: { requestId: 'original-request' },
    lastRequestId: 'original-request',
    attachments: ['C:/user/image.png'],
  });
});

test('remount keeps pending enqueue frozen and only exact persisted preparation results unlock preparation', () => {
  const saved = state();
  const release = bindDiscussionDraftStorage(saved);
  updateDiscussionDraft('preparing-room', {
    text: 'body',
    attachments: ['image.png'],
    submissionAttemptId: 'preparing-attempt',
    inputEpoch: 4,
  });
  updateDiscussionDraft('queued-room', {
    text: 'queued body',
    submissionAttemptId: 'send-attempt',
    pendingMode: 'enqueue',
    pending: {
      roomId: 'queued-room',
      requestId: 'original-enqueue',
      expectedRevision: 2,
      message: 'queued body',
      selectedAgentIds: [],
      rounds: 2,
    },
  });
  release();
  releases.push(bindDiscussionDraftStorage(saved));
  expect(discussionPreparationRecoveryId('preparing-room')).toBe('preparing-room');
  reconcileDiscussionPreparation('preparing-room', 'foreign-room', 'ready');
  reconcileDiscussionPreparation('preparing-room', 'preparing-room', 'preparing');
  expect(getDiscussionDraft('preparing-room').submissionAttemptId).toBe('preparing-attempt');
  reconcileDiscussionPreparation('preparing-room', 'preparing-room', 'ready');
  expect(getDiscussionDraft('preparing-room')).toMatchObject({
    text: 'body',
    attachments: ['image.png'],
    inputEpoch: 5,
    submissionAttemptId: undefined,
  });
  reconcileDiscussionPreparation('queued-room', 'queued-room', 'ready');
  expect(getDiscussionDraft('queued-room')).toMatchObject({
    pendingMode: 'enqueue',
    submissionAttemptId: 'send-attempt',
    pending: { requestId: 'original-enqueue' },
  });
  updateDiscussionDraft('current-attempt', { submissionAttemptId: 'not-restored' });
  reconcileDiscussionPreparation('current-attempt', 'current-attempt', 'ready');
  expect(getDiscussionDraft('current-attempt').submissionAttemptId).toBe('not-restored');
  updateDiscussionDraft('ordinary-ready', { text: 'typing', inputEpoch: 7 });
  expect(discussionPreparationRecoveryId('ordinary-ready')).toBeUndefined();
  reconcileDiscussionPreparation('ordinary-ready', 'ordinary-ready', 'ready');
  reconcileDiscussionPreparation('ordinary-ready', 'ordinary-ready', 'ready');
  expect(getDiscussionDraft('ordinary-ready')).toMatchObject({ text: 'typing', inputEpoch: 7 });
});
