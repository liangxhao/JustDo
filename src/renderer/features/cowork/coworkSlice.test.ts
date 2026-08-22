import { describe, expect, test } from 'vitest';

import coworkReducer, {
  addDraftAttachment,
  clearCurrentSession,
  hydrateDraftImageAttachment,
  setConfig,
  setSessionRuntimeSnapshot,
  setSessionRunTimings,
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

describe('cowork session runtime snapshot', () => {
  test('freezes activity and timing in one reducer transition', () => {
    const running = coworkReducer(
      undefined,
      setSessionRuntimeSnapshot({
        sessionId: 'session-1',
        snapshot: {
          revision: 1,
          known: true,
          mainRunning: true,
          subagentRunning: false,
          running: true,
          timing: {
            id: 'timing-1',
            sessionId: 'session-1',
            clientTurnId: 'run-1',
            startedAt: 1_000,
            state: 'running',
          },
        },
      }),
    );
    const completed = coworkReducer(
      running,
      setSessionRuntimeSnapshot({
        sessionId: 'session-1',
        snapshot: {
          revision: 2,
          known: true,
          mainRunning: false,
          subagentRunning: false,
          running: false,
          timing: {
            id: 'timing-1',
            sessionId: 'session-1',
            clientTurnId: 'run-1',
            startedAt: 1_000,
            endedAt: 6_000,
            state: 'completed',
          },
        },
      }),
    );

    expect(completed.sessionRuntimeActivity['session-1']).toBeUndefined();
    expect(completed.sessionMainRuntimeActivity['session-1']).toBeUndefined();
    expect(completed.sessionRunTimings['session-1']).toEqual([
      expect.objectContaining({ state: 'completed', endedAt: 6_000 }),
    ]);
  });

  test('preserves a failed run as an error session', () => {
    const loaded = coworkReducer(
      undefined,
      setSessions([
        {
          id: 'session-1',
          title: 'Session',
          status: 'running',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      ]),
    );
    const state = coworkReducer(
      loaded,
      setSessionRuntimeSnapshot({
        sessionId: 'session-1',
        snapshot: {
          revision: 1,
          known: true,
          mainRunning: false,
          subagentRunning: false,
          running: false,
          timing: {
            id: 'timing-1',
            sessionId: 'session-1',
            clientTurnId: 'run-1',
            startedAt: 1_000,
            endedAt: 2_000,
            state: 'failed',
          },
        },
      }),
    );

    expect(state.sessionRunTimings['session-1']?.[0]?.state).toBe('failed');
    expect(state.sessionRuntimeActivity['session-1']).toBeUndefined();
    expect(state.sessions[0]?.status).toBe('error');
  });

  test('does not drop a newly started timing when an older list response arrives', () => {
    const running = coworkReducer(
      undefined,
      setSessionRuntimeSnapshot({
        sessionId: 'session-1',
        snapshot: {
          revision: 2,
          known: true,
          mainRunning: true,
          subagentRunning: false,
          running: true,
          timing: {
            id: 'timing-new',
            sessionId: 'session-1',
            clientTurnId: 'run-new',
            startedAt: 2_000,
            state: 'running',
          },
        },
      }),
    );
    const merged = coworkReducer(
      running,
      setSessionRunTimings({
        sessionId: 'session-1',
        timings: [
          {
            id: 'timing-old',
            sessionId: 'session-1',
            clientTurnId: 'run-old',
            startedAt: 1_000,
            endedAt: 1_500,
            state: 'completed',
          },
        ],
      }),
    );

    expect(merged.sessionRunTimings['session-1']?.map(timing => timing.id)).toEqual([
      'timing-old',
      'timing-new',
    ]);
  });
});
