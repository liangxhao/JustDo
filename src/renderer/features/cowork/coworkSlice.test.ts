import { describe, expect, test } from 'vitest';

import coworkReducer, {
  addDraftAttachment,
  addDraftBrowserAnnotation,
  addSession,
  beginManualModelSelection,
  clearCurrentSession,
  clearDraftBrowserAnnotations,
  completeManualModelSelection,
  confirmCurrentSessionModelSelection,
  confirmDefaultModelSelection,
  confirmManualModelSelection,
  deleteSession,
  deleteSessions,
  enqueuePendingInteraction,
  hydrateDraftImageAttachment,
  receiveSessionModelSelection,
  removeDraftBrowserAnnotation,
  rollbackManualModelSelection,
  setConfig,
  setCurrentSession,
  setPlanMode,
  setSessionRuntimeSnapshot,
  setSessionRunTimings,
  setSessions,
  touchSessionActivity,
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
  createdAt: 1,
  updatedAt: 2,
  modelRef,
});

describe('cowork session admission', () => {
  test('upserts a session already discovered by a racing sessions.changed refresh', () => {
    const discovered = {
      id: 'session-1',
      title: 'Initial title',
      status: 'idle' as const,
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    };
    const loaded = coworkReducer(undefined, setSessions([discovered]));
    const canonical = {
      ...createSession('session-1'),
      title: 'Submitted title',
      status: 'running' as const,
      updatedAt: 2,
    };

    const admitted = coworkReducer(loaded, addSession({ session: canonical, select: true }));

    expect(admitted.sessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        title: 'Submitted title',
        status: 'running',
        updatedAt: 2,
      }),
    ]);
    expect(admitted.currentSession).toEqual(canonical);
    expect(admitted.currentSessionId).toBe('session-1');
  });
});

describe('cowork session permissions', () => {
  test('preserves the configured default when clearing the current session', () => {
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

    expect(newSession.config.permissionMode).toBe('ask');
  });
});

describe('cowork Plan mode state', () => {
  test('removes per-session state when sessions are deleted', () => {
    let state = coworkReducer(undefined, setPlanMode({ sessionId: 'session-1', enabled: true }));
    state = coworkReducer(state, setPlanMode({ sessionId: 'session-2', enabled: true }));
    state = coworkReducer(
      state,
      enqueuePendingInteraction({
        sessionId: 'session-1',
        requestId: 'plan-1',
        toolName: 'PresentPlan',
        interactionKind: 'plan-approval',
        toolInput: { plan: 'First plan' },
      }),
    );
    state = coworkReducer(
      state,
      enqueuePendingInteraction({
        sessionId: 'session-2',
        requestId: 'plan-2',
        toolName: 'PresentPlan',
        interactionKind: 'plan-approval',
        toolInput: { plan: 'Second plan' },
      }),
    );

    state = coworkReducer(state, deleteSession('session-1'));
    expect(state.planModeBySession['session-1']).toBeUndefined();
    expect(state.planModeBySession['session-2']).toBe(true);
    expect(state.pendingInteractions.map(interaction => interaction.requestId)).toEqual(['plan-2']);

    state = coworkReducer(state, deleteSessions(['session-2']));
    expect(state.planModeBySession['session-2']).toBeUndefined();
    expect(state.pendingInteractions).toEqual([]);
  });
});

describe('cowork session model ownership', () => {
  const modelA = { id: 'model-a', name: 'Model A', providerKey: 'provider-a' };
  const modelB = { id: 'model-b', name: 'Model B', providerKey: 'provider-b' };
  const modelC = { id: 'model-c', name: 'Model C', providerKey: 'provider-c' };

  test('keeps the background default visible and pending after navigating to a new chat', () => {
    const homeKey = '__home__\0main';
    let state = coworkReducer(undefined, setCurrentSession(createSession('session-1', 'provider-b/model-b')));
    state = coworkReducer(state, beginManualModelSelection({
      contextKey: homeKey, taskId: 1, model: modelB, previousModel: modelA,
    }));
    state = coworkReducer(state, clearCurrentSession());
    expect(state.manualModelSelections[homeKey]).toEqual(modelB);
    expect(state.pendingModelSelectionTaskIds[homeKey]).toBe(1);
    expect(state.pendingModelSelectionTaskIds['session-1\0main']).toBeUndefined();
    state = coworkReducer(state, rollbackManualModelSelection({ contextKey: homeKey, taskId: 1 }));
    expect(state.manualModelSelections[homeKey]).toBeUndefined();
    expect(state.pendingModelSelectionTaskIds[homeKey]).toBeUndefined();
  });

  test('an older session default save cannot replace or release a newer home selection', () => {
    const contextKey = '__home__\0main';
    let state = coworkReducer(undefined, beginManualModelSelection({
      contextKey, taskId: 2, model: modelC, previousModel: modelA,
    }));
    state = coworkReducer(state, beginManualModelSelection({
      contextKey, taskId: 1, model: modelB, previousModel: modelA,
    }));
    state = coworkReducer(state, confirmDefaultModelSelection({ contextKey, model: modelB }));
    state = coworkReducer(state, completeManualModelSelection({ contextKey, taskId: 1 }));
    state = coworkReducer(state, rollbackManualModelSelection({ contextKey, taskId: 1 }));
    expect(state.manualModelSelections[contextKey]).toEqual(modelC);
    expect(state.pendingModelSelectionTaskIds[contextKey]).toBe(2);
    expect(state.confirmedModelSelections[contextKey]).toEqual(modelB);
    state = coworkReducer(state, completeManualModelSelection({ contextKey, taskId: 2 }));
    expect(state.pendingModelSelectionTaskIds[contextKey]).toBeUndefined();
  });

  test('accepts a freshly read selection when the same session is reloaded', () => {
    const selected = coworkReducer(undefined, setCurrentSession(createSession('session-1', 'b')));

    const reloaded = coworkReducer(selected, setCurrentSession(createSession('session-1', 'a')));

    expect(reloaded.currentSession?.modelRef).toBe('a');
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

    const opened = coworkReducer(confirmed, setCurrentSession(createSession('session-1')));

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

  test('releases a failed choice while retaining the preceding confirmed session model', () => {
    const firstPending = coworkReducer(
      coworkReducer(undefined, setCurrentSession(createSession('session-1', 'provider-a/model-a'))),
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
    const confirmedSession = coworkReducer(
      firstConfirmed,
      confirmCurrentSessionModelSelection({
        sessionId: 'session-1',
        modelRef: 'provider-b/model-b',
      }),
    );
    const secondPending = coworkReducer(
      confirmedSession,
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

    expect(rolledBack.manualModelSelections['session-1\0main']).toBeUndefined();
    expect(rolledBack.confirmedModelSelections['session-1\0main']).toBeUndefined();
    expect(rolledBack.currentSession?.modelRef).toBe('provider-b/model-b');
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
    expect(rolledBack.manualModelSelections['__home__\0main']).toBeUndefined();
    expect(rolledBack.confirmedModelSelections['__home__\0main']).toBeUndefined();
    const nextChoice = coworkReducer(
      rolledBack,
      beginManualModelSelection({
        contextKey: '__home__\0main',
        taskId: 3,
        model: modelB,
        previousModel: modelC,
      }),
    );
    expect(nextChoice.confirmedModelSelections['__home__\0main']).toBe(modelC);
  });

  test('a failed default update retains the successful session patch and accepts later refreshes', () => {
    let state = coworkReducer(
      undefined,
      setCurrentSession(createSession('session-1', 'provider-a/model-a')),
    );
    state = coworkReducer(
      state,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
        previousModel: modelA,
      }),
    );
    state = coworkReducer(
      state,
      confirmManualModelSelection({ contextKey: 'session-1\0main', taskId: 1, model: modelB }),
    );
    state = coworkReducer(
      state,
      confirmCurrentSessionModelSelection({
        sessionId: 'session-1',
        modelRef: 'provider-b/model-b',
      }),
    );
    state = coworkReducer(
      state,
      rollbackManualModelSelection({ contextKey: 'session-1\0main', taskId: 1 }),
    );
    expect(state.currentSession?.modelRef).toBe('provider-b/model-b');
    expect(state.manualModelSelections['session-1\0main']).toBeUndefined();
    state = coworkReducer(
      state,
      receiveSessionModelSelection({
        sessionId: 'session-1',
        agentId: 'main',
        modelRef: 'provider-c/model-c',
      }),
    );
    expect(state.currentSession?.modelRef).toBe('provider-c/model-c');
  });

  test('releases optimistic state after confirmation and accepts the next authoritative selection', () => {
    let state = coworkReducer(
      undefined,
      setCurrentSession(createSession('session-1', 'provider-a/model-a')),
    );
    state = coworkReducer(
      state,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
        previousModel: modelA,
      }),
    );
    state = coworkReducer(
      state,
      confirmCurrentSessionModelSelection({
        sessionId: 'session-1',
        modelRef: 'provider-b/model-b',
      }),
    );
    state = coworkReducer(
      state,
      completeManualModelSelection({ contextKey: 'session-1\0main', taskId: 1 }),
    );
    expect(state.manualModelSelections['session-1\0main']).toBeUndefined();
    expect(state.currentSession?.modelRef).toBe('provider-b/model-b');
    state = coworkReducer(
      state,
      receiveSessionModelSelection({
        sessionId: 'session-1',
        agentId: 'main',
        modelRef: 'provider-c/model-c',
      }),
    );
    expect(state.currentSession?.modelRef).toBe('provider-c/model-c');
  });

  test('an authoritative refresh cannot replace a pending user selection', () => {
    let state = coworkReducer(
      undefined,
      setCurrentSession(createSession('session-1', 'provider-a/model-a')),
    );
    state = coworkReducer(
      state,
      beginManualModelSelection({
        contextKey: 'session-1\0main',
        taskId: 1,
        model: modelB,
        previousModel: modelA,
      }),
    );
    state = coworkReducer(
      state,
      receiveSessionModelSelection({
        sessionId: 'session-1',
        agentId: 'main',
        modelRef: 'provider-c/model-c',
      }),
    );
    expect(state.manualModelSelections['session-1\0main']).toBe(modelB);
    expect(state.currentSession?.modelRef).toBe('provider-a/model-a');
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

describe('cowork draft browser annotations', () => {
  const annotation = {
    id: 'annotation-1',
    modelContext: 'Untrusted browser context',
    title: 'Example',
    displayUrl: 'example.com',
    markedRegionCount: 1,
    inspectedElement: false,
    dataUrl: 'data:image/png;base64,YWJj',
    fileName: 'browser-annotation.png',
    addedAt: 1,
  };

  test('isolates annotations by draft key and removes only the submitted id', () => {
    const home = coworkReducer(
      undefined,
      addDraftBrowserAnnotation({ draftKey: '__home__', annotation }),
    );
    const sessions = coworkReducer(
      home,
      addDraftBrowserAnnotation({
        draftKey: 'session-1',
        annotation: { ...annotation, id: 'annotation-2' },
      }),
    );
    const removed = coworkReducer(
      sessions,
      removeDraftBrowserAnnotation({ draftKey: '__home__', annotationId: annotation.id }),
    );

    expect(removed.draftBrowserAnnotations.__home__).toBeUndefined();
    expect(removed.draftBrowserAnnotations['session-1']).toHaveLength(1);
  });

  test('clears only the requested annotation ids', () => {
    const first = coworkReducer(
      undefined,
      addDraftBrowserAnnotation({ draftKey: '__home__', annotation }),
    );
    const second = coworkReducer(
      first,
      addDraftBrowserAnnotation({
        draftKey: '__home__',
        annotation: { ...annotation, id: 'annotation-new' },
      }),
    );
    const cleared = coworkReducer(
      second,
      clearDraftBrowserAnnotations({ draftKey: '__home__', annotationIds: [annotation.id] }),
    );

    expect(cleared.draftBrowserAnnotations.__home__?.map(item => item.id)).toEqual([
      'annotation-new',
    ]);
  });

  test('releases annotation images when their session is deleted', () => {
    const withAnnotation = coworkReducer(
      undefined,
      addDraftBrowserAnnotation({ draftKey: 'session-1', annotation }),
    );

    const deleted = coworkReducer(withAnnotation, deleteSession('session-1'));

    expect(deleted.draftBrowserAnnotations['session-1']).toBeUndefined();
  });
});

describe('cowork session recent activity', () => {
  const activityTime = 1_700_000_000_000;

  test('refreshes the selected external session status and native session key', () => {
    const selected = coworkReducer(
      undefined,
      setCurrentSession({
        ...createSession('session-1'),
        status: 'running',
        external: {
          origin: 'multica',
          readOnly: true,
          status: 'running',
          sessionKey: 'agent:main:multica:one',
        },
      }),
    );

    const updated = coworkReducer(
      selected,
      setSessions([
        {
          id: 'session-1',
          title: 'Session',
          status: 'completed',
          pinned: false,
          agentId: 'main',
          external: {
            origin: 'multica',
            readOnly: true,
            status: 'completed',
            sessionKey: 'agent:main:multica:one',
          },
          createdAt: 1,
          updatedAt: activityTime,
        },
      ]),
    );

    expect(updated.currentSession).toMatchObject({
      status: 'completed',
      updatedAt: activityTime,
      external: { status: 'completed', sessionKey: 'agent:main:multica:one' },
    });
  });

  test('updates and marks a background session unread without storing a message', () => {
    const loaded = coworkReducer(
      undefined,
      setSessions([createSession('session-1'), createSession('session-2')]),
    );
    const selected = coworkReducer(loaded, setCurrentSession(createSession('session-1')));

    const updated = coworkReducer(
      selected,
      touchSessionActivity({ sessionId: 'session-2', timestamp: activityTime }),
    );

    expect(updated.sessions.find(session => session.id === 'session-2')?.updatedAt).toBe(
      activityTime,
    );
    expect(updated.unreadSessionIds).toContain('session-2');
    expect(updated.currentSession).not.toHaveProperty('messages');
  });

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

  test('updates the visible fork source title when its source session is renamed', () => {
    const source = createSession('source-session');
    const branch = {
      ...createSession('branch-session'),
      forkSource: {
        sessionId: source.id,
        title: source.title,
        entryId: 'source-entry',
      },
    };
    const selected = coworkReducer(undefined, setCurrentSession(branch));

    const updated = coworkReducer(
      selected,
      updateSessionTitle({ sessionId: source.id, title: 'Renamed source' }),
    );

    expect(updated.currentSession?.forkSource?.title).toBe('Renamed source');
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
