import { describe, expect, test } from 'vitest';

import coworkReducer, {
  addDraftAttachment,
  beginManualModelSelection,
  clearCurrentSession,
  completeManualModelSelection,
  confirmCurrentSessionModelSelection,
  confirmDefaultModelSelection,
  confirmManualModelSelection,
  hydrateDraftImageAttachment,
  rollbackManualModelSelection,
  setConfig,
  setCurrentSession,
  setSessionRuntimeSnapshot,
  setSessionRunTimings,
  setSessions,
  updateSessionStatus,
  updateSessionTitle,
} from './coworkSlice';

const createSession = (id: string, modelRef?: string) => ({
  id,
  title: 'Session',
  status: 'idle' as const,
  pinned: false,
  cwd: 'C:\\workspace',
  executionMode: 'local' as const,
  permissionMode: 'full' as const,
  activeSkillIds: [],
  agentId: 'main',
  messages: [],
  createdAt: 1,
  updatedAt: 2,
  modelRef,
});

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

describe('cowork session model ownership', () => {
  const modelA = { id: 'model-a', name: 'Model A', providerKey: 'provider-a' };
  const modelB = { id: 'model-b', name: 'Model B', providerKey: 'provider-b' };
  const modelC = { id: 'model-c', name: 'Model C', providerKey: 'provider-c' };

  test('preserves the selected model when the same session is reloaded', () => {
    const selected = coworkReducer(undefined, setCurrentSession(createSession('session-1', 'b')));

    const reloaded = coworkReducer(selected, setCurrentSession(createSession('session-1', 'a')));

    expect(reloaded.currentSession?.modelRef).toBe('b');
  });

  test('initializes the model when opening another session', () => {
    const selected = coworkReducer(undefined, setCurrentSession(createSession('session-1', 'b')));

    const opened = coworkReducer(selected, setCurrentSession(createSession('session-2', 'a')));

    expect(opened.currentSession?.modelRef).toBe('a');
  });

  test('applies a user-confirmed model when its session opens after completion', () => {
    const confirmed = coworkReducer(
      undefined,
      confirmCurrentSessionModelSelection({ sessionId: 'session-1', modelRef: 'b' }),
    );

    const opened = coworkReducer(confirmed, setCurrentSession(createSession('session-1', 'a')));

    expect(opened.currentSession?.modelRef).toBe('b');
  });

  test('keeps the latest optimistic selection while an older task confirms', () => {
    const firstPending = coworkReducer(
      undefined,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
        previousModel: modelA,
      }),
    );
    const secondPending = coworkReducer(
      firstPending,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 2,
        model: modelC,
        previousModel: modelB,
      }),
    );

    const firstConfirmed = coworkReducer(
      secondPending,
      confirmManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
      }),
    );
    const firstCompleted = coworkReducer(
      firstConfirmed,
      completeManualModelSelection({ contextKey: 'session-1\0main', taskId: 1 }),
    );

    expect(firstCompleted.manualModelSelections['session-1\0main']).toBe(modelC);
    expect(firstCompleted.pendingModelSelectionTaskIds['session-1\0main']).toBe(2);
  });

  test('rolls the latest failed selection back to the preceding confirmation', () => {
    const firstPending = coworkReducer(
      undefined,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
        previousModel: modelA,
      }),
    );
    const firstConfirmed = coworkReducer(
      firstPending,
      confirmManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
      }),
    );
    const secondPending = coworkReducer(
      firstConfirmed,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 2,
        model: modelC,
        previousModel: modelB,
      }),
    );

    const rolledBack = coworkReducer(
      secondPending,
      rollbackManualModelSelection({ contextKey: 'session-1\0main', taskId: 2 }),
    );

    expect(rolledBack.manualModelSelections['session-1\0main']).toBe(modelB);
    expect(rolledBack.pendingModelSelectionTaskIds['session-1\0main']).toBeUndefined();
  });

  test('updates the next-session default without replacing a newer pending home selection', () => {
    const homePending = coworkReducer(
      undefined,
      beginManualModelSelection({
        contextKey: '__home__\0main',
        taskId: 2,
        model: modelC,
        previousModel: modelA,
      }),
    );

    const sessionDefaultConfirmed = coworkReducer(
      homePending,
      confirmDefaultModelSelection({ contextKey: '__home__\0main', model: modelB }),
    );
    const rolledBack = coworkReducer(
      sessionDefaultConfirmed,
      rollbackManualModelSelection({ contextKey: '__home__\0main', taskId: 2 }),
    );

    expect(sessionDefaultConfirmed.manualModelSelections['__home__\0main']).toBe(modelC);
    expect(rolledBack.manualModelSelections['__home__\0main']).toBe(modelB);
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
