import { describe, expect, test } from 'vitest';

import { removeSessionFromState, removeSessionsFromState } from './coworkDeleteState';

type TestSession = {
  id: string;
};

type TestState = {
  sessions: TestSession[];
  unreadSessionIds: string[];
  currentSessionId: string | null;
  currentSession: TestSession | null;
  isStreaming: boolean;
  sessionMainRuntimeActivity?: Record<string, boolean>;
  sessionRuntimeActivity?: Record<string, boolean>;
};

describe('coworkDeleteState', () => {
  test('removeSessionFromState clears streaming when deleting the current session', () => {
    const state: TestState = {
      sessions: [{ id: 's1' }, { id: 's2' }],
      unreadSessionIds: ['s1', 's2'],
      currentSessionId: 's1',
      currentSession: { id: 's1' },
      isStreaming: true,
      sessionMainRuntimeActivity: { s1: true, s2: true },
      sessionRuntimeActivity: { s1: true, s2: true },
    };

    removeSessionFromState(state, 's1');

    expect(state).toMatchObject({
      currentSessionId: null,
      currentSession: null,
      isStreaming: false,
      sessions: [{ id: 's2' }],
      unreadSessionIds: ['s2'],
      sessionMainRuntimeActivity: { s2: true },
      sessionRuntimeActivity: { s2: true },
    });
  });

  test('removeSessionFromState keeps streaming when deleting a non-current session', () => {
    const state: TestState = {
      sessions: [{ id: 's1' }, { id: 's2' }],
      unreadSessionIds: ['s2'],
      currentSessionId: 's1',
      currentSession: { id: 's1' },
      isStreaming: true,
    };

    removeSessionFromState(state, 's2');

    expect(state).toMatchObject({
      currentSessionId: 's1',
      currentSession: { id: 's1' },
      isStreaming: true,
      sessions: [{ id: 's1' }],
      unreadSessionIds: [],
    });
  });

  test('removeSessionsFromState clears streaming when deleting the current session in batch', () => {
    const state: TestState = {
      sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      unreadSessionIds: ['s2', 's3'],
      currentSessionId: 's2',
      currentSession: { id: 's2' },
      isStreaming: true,
      sessionMainRuntimeActivity: { s1: true, s2: true, s3: true },
      sessionRuntimeActivity: { s1: true, s2: true, s3: true },
    };

    removeSessionsFromState(state, ['s1', 's2']);

    expect(state).toMatchObject({
      currentSessionId: null,
      currentSession: null,
      isStreaming: false,
      sessions: [{ id: 's3' }],
      unreadSessionIds: ['s3'],
      sessionMainRuntimeActivity: { s3: true },
      sessionRuntimeActivity: { s3: true },
    });
  });
});
