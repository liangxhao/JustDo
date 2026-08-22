type SessionLike = {
  id: string;
};

type CoworkDeleteStateShape = {
  sessions: SessionLike[];
  unreadSessionIds: string[];
  currentSessionId: string | null;
  currentSession: SessionLike | null;
  isStreaming: boolean;
  sessionMainRuntimeActivity?: Record<string, boolean>;
  sessionRuntimeActivity?: Record<string, boolean>;
  sessionRunTimings?: Record<string, unknown[]>;
};

export const removeSessionFromState = (state: CoworkDeleteStateShape, sessionId: string): void => {
  state.sessions = state.sessions.filter(session => session.id !== sessionId);
  state.unreadSessionIds = state.unreadSessionIds.filter(id => id !== sessionId);
  if (state.sessionMainRuntimeActivity) {
    delete state.sessionMainRuntimeActivity[sessionId];
  }
  if (state.sessionRuntimeActivity) {
    delete state.sessionRuntimeActivity[sessionId];
  }
  if (state.sessionRunTimings) delete state.sessionRunTimings[sessionId];

  if (state.currentSessionId === sessionId) {
    state.currentSessionId = null;
    state.currentSession = null;
    state.isStreaming = false;
  }
};

export const removeSessionsFromState = (
  state: CoworkDeleteStateShape,
  sessionIds: string[],
): void => {
  const sessionIdSet = new Set(sessionIds);
  state.sessions = state.sessions.filter(session => !sessionIdSet.has(session.id));
  state.unreadSessionIds = state.unreadSessionIds.filter(id => !sessionIdSet.has(id));
  for (const sessionId of sessionIds) {
    if (state.sessionMainRuntimeActivity) {
      delete state.sessionMainRuntimeActivity[sessionId];
    }
    if (state.sessionRuntimeActivity) {
      delete state.sessionRuntimeActivity[sessionId];
    }
    if (state.sessionRunTimings) delete state.sessionRunTimings[sessionId];
  }

  if (state.currentSessionId && sessionIdSet.has(state.currentSessionId)) {
    state.currentSessionId = null;
    state.currentSession = null;
    state.isStreaming = false;
  }
};
