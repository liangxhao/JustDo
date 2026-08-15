import { describe, expect, test } from 'vitest';

import coworkReducer, {
  addDraftAttachment,
  clearCurrentSession,
  hydrateDraftImageAttachment,
  setConfig,
  setSessions,
  updateSessionStatus,
  updateSessionTitle,
} from './coworkSlice';

describe('cowork session permissions', () => {
  test('uses full access for a new session draft', () => {
    const restricted = coworkReducer(
      undefined,
      setConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
    );

    const newSession = coworkReducer(restricted, clearCurrentSession());

    expect(newSession.config.permissionMode).toBe('full');
  });
});

describe('cowork draft attachments', () => {
  test('hydrates an existing path attachment for vision after a model switch', () => {
    const withAttachment = coworkReducer(
      undefined,
      addDraftAttachment({
        draftKey: '__home__',
        attachment: { path: 'C:\\images\\draft.png', name: 'draft.png' },
      }),
    );

    const hydrated = coworkReducer(
      withAttachment,
      hydrateDraftImageAttachment({
        draftKey: '__home__',
        path: 'C:\\images\\draft.png',
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      }),
    );

    expect(hydrated.draftAttachments.__home__).toEqual([
      {
        path: 'C:\\images\\draft.png',
        name: 'draft.png',
        isImage: true,
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      },
    ]);
  });

  test('does not recreate an attachment removed while the image was being read', () => {
    const state = coworkReducer(
      undefined,
      hydrateDraftImageAttachment({
        draftKey: '__home__',
        path: 'C:\\images\\removed.png',
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
      }),
    );

    expect(state.draftAttachments.__home__).toBeUndefined();
  });
});

describe('cowork session recent activity', () => {
  const activityTime = 1_700_000_000_000;

  test('keeps activity time when status changes', () => {
    const loaded = coworkReducer(
      undefined,
      setSessions([
        {
          id: 'session-1',
          title: 'Session',
          status: 'idle',
          pinned: false,
          createdAt: activityTime,
          updatedAt: activityTime,
        },
      ]),
    );

    const updated = coworkReducer(
      loaded,
      updateSessionStatus({ sessionId: 'session-1', status: 'running' }),
    );

    expect(updated.sessions[0]).toMatchObject({ status: 'running', updatedAt: activityTime });
  });

  test('keeps activity time when title changes', () => {
    const loaded = coworkReducer(
      undefined,
      setSessions([
        {
          id: 'session-1',
          title: 'Session',
          status: 'idle',
          pinned: false,
          createdAt: activityTime,
          updatedAt: activityTime,
        },
      ]),
    );

    const updated = coworkReducer(
      loaded,
      updateSessionTitle({ sessionId: 'session-1', title: 'Renamed' }),
    );

    expect(updated.sessions[0]).toMatchObject({ title: 'Renamed', updatedAt: activityTime });
  });
});
