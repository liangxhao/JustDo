import { SessionRunBeginErrorCode } from '@shared/cowork/sessionRun';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import {
  clearCurrentSession,
  setConfig as setCoworkConfig,
  setCurrentSession,
  setSessionRuntimeActivity,
} from '@/features/cowork/coworkSlice';
import type { CoworkSession } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

describe('cowork session startup', () => {
  afterEach(() => {
    store.dispatch(clearCurrentSession());
    vi.unstubAllGlobals();
  });

  test('registers session promotion before selecting the canonical session', async () => {
    const session: CoworkSession = {
      id: 'session-1',
      title: 'New session',
      status: 'running',
      pinned: false,
      cwd: '',
      executionMode: 'local',
      permissionMode: 'ask',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          startSession: vi.fn().mockResolvedValue({ success: true, session }),
        },
      },
    });
    store.dispatch(clearCurrentSession());
    let selectedSessionIdDuringHook: string | null | undefined;

    await coworkService.startSession(
      { prompt: 'start' },
      {
        beforeSessionSelected: () => {
          selectedSessionIdDuringHook = store.getState().cowork.currentSessionId;
        },
      },
    );

    expect(selectedSessionIdDuringHook).toBeNull();
    expect(store.getState().cowork.currentSessionId).toBe('session-1');
  });
});

const setRuntimeStatusResponse = (response: {
  success: boolean;
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
}) => {
  vi.stubGlobal('window', {
    electron: {
      cowork: {
        getSessionRuntimeStatus: vi.fn().mockResolvedValue(response),
      },
    },
  });
};

describe('cowork session permission selection', () => {
  afterEach(() => {
    store.dispatch(clearCurrentSession());
    vi.unstubAllGlobals();
  });

  test('queues permission changes made while a temporary session is promoted', async () => {
    const temporarySession: CoworkSession = {
      id: 'temp-123',
      title: 'Starting',
      status: 'running',
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local',
      permissionMode: 'full',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
    };
    const canonicalSession: CoworkSession = {
      ...temporarySession,
      id: 'session-promoted',
      permissionMode: 'full',
    };
    let resolveStart!: (value: { success: true; session: CoworkSession }) => void;
    const startSession = vi.fn(
      () =>
        new Promise<{ success: true; session: CoworkSession }>(resolve => {
          resolveStart = resolve;
        }),
    );
    const setSessionPermissionMode = vi.fn().mockResolvedValue({
      success: true,
      deferred: true,
    });
    vi.stubGlobal('window', {
      electron: { cowork: { startSession, setSessionPermissionMode } },
    });
    store.dispatch(setCurrentSession(temporarySession));

    const starting = coworkService.startSession({ prompt: 'start' });
    await expect(coworkService.updatePermissionMode('ask')).resolves.toEqual({ success: true });
    expect(setSessionPermissionMode).not.toHaveBeenCalled();
    expect(store.getState().cowork.currentSession?.permissionMode).toBe('ask');

    resolveStart({ success: true, session: canonicalSession });
    await expect(starting).resolves.toMatchObject({
      session: { id: canonicalSession.id, permissionMode: 'ask' },
    });
    expect(setSessionPermissionMode).toHaveBeenCalledWith({
      sessionId: canonicalSession.id,
      permissionMode: 'ask',
      deferIfActive: true,
    });
  });

  test('promotes the latest temporary permission selected while an earlier update is in flight', async () => {
    const temporarySession: CoworkSession = {
      id: 'temp-racing-permission',
      title: 'Starting',
      status: 'running',
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local',
      permissionMode: 'full',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
    };
    const canonicalSession = { ...temporarySession, id: 'session-racing-permission' };
    let resolveStart!: (value: { success: true; session: CoworkSession }) => void;
    let resolveFirstUpdate!: (value: { success: true; deferred: true }) => void;
    const setSessionPermissionMode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ success: true; deferred: true }>(resolve => {
            resolveFirstUpdate = resolve;
          }),
      )
      .mockResolvedValue({ success: true, deferred: true });
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          startSession: vi.fn(
            () =>
              new Promise<{ success: true; session: CoworkSession }>(resolve => {
                resolveStart = resolve;
              }),
          ),
          setSessionPermissionMode,
        },
      },
    });
    store.dispatch(setCurrentSession(temporarySession));

    const starting = coworkService.startSession({ prompt: 'start' });
    await coworkService.updatePermissionMode('ask');
    resolveStart({ success: true, session: canonicalSession });
    await vi.waitFor(() => expect(setSessionPermissionMode).toHaveBeenCalledTimes(1));
    await coworkService.updatePermissionMode('auto');
    resolveFirstUpdate({ success: true, deferred: true });

    await expect(starting).resolves.toMatchObject({
      session: { id: canonicalSession.id, permissionMode: 'auto' },
    });
    expect(setSessionPermissionMode).toHaveBeenNthCalledWith(1, {
      sessionId: canonicalSession.id,
      permissionMode: 'ask',
      deferIfActive: true,
    });
    expect(setSessionPermissionMode).toHaveBeenNthCalledWith(2, {
      sessionId: canonicalSession.id,
      permissionMode: 'auto',
      deferIfActive: true,
    });
  });

  test('keeps the authoritative mode and notifies the user when temporary promotion fails', async () => {
    const temporarySession: CoworkSession = {
      id: 'temp-failed-permission',
      title: 'Starting',
      status: 'running',
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local',
      permissionMode: 'full',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
    };
    const canonicalSession = { ...temporarySession, id: 'session-failed-permission' };
    let resolveStart!: (value: { success: true; session: CoworkSession }) => void;
    const dispatchEvent = vi.fn();
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(
          public readonly type: string,
          public readonly init: { detail: string },
        ) {}

        get detail(): string {
          return this.init.detail;
        }
      },
    );
    vi.stubGlobal('window', {
      dispatchEvent,
      electron: {
        cowork: {
          startSession: vi.fn(
            () =>
              new Promise<{ success: true; session: CoworkSession }>(resolve => {
                resolveStart = resolve;
              }),
          ),
          setSessionPermissionMode: vi.fn().mockResolvedValue({
            success: false,
            error: 'SQLite unavailable',
          }),
        },
      },
    });
    store.dispatch(setCurrentSession(temporarySession));

    const starting = coworkService.startSession({ prompt: 'start' });
    await coworkService.updatePermissionMode('ask');
    resolveStart({ success: true, session: canonicalSession });

    await expect(starting).resolves.toMatchObject({
      session: { id: canonicalSession.id, permissionMode: 'full' },
    });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app:showToast',
        detail: i18nService.t('coworkPermissionModeUpdateFailed'),
      }),
    );
  });

  test('loads the persisted new-session permission default without changing it', async () => {
    store.dispatch(clearCurrentSession());
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
    );
    const setConfig = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getConfig: vi.fn(async () => ({
            success: true,
            config: {
              workingDirectory: 'C:\\workspace',
              executionMode: 'local',
              agentEngine: 'openclaw',
              permissionMode: 'ask',
            },
          })),
          setConfig,
        },
      },
    });

    await coworkService.loadConfig();

    expect(setConfig).not.toHaveBeenCalled();
    expect(store.getState().cowork.config.permissionMode).toBe('ask');
  });

  test('reflects a permission selection before runtime synchronization completes', async () => {
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
    );
    let finishSync: ((value: { success: true }) => void) | undefined;
    const pendingSync = new Promise<{ success: true }>(resolve => {
      finishSync = resolve;
    });
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          setConfig: vi.fn(() => pendingSync),
          getConfig: vi.fn().mockResolvedValue({
            success: true,
            config: {
              workingDirectory: 'C:\\workspace',
              executionMode: 'local',
              agentEngine: 'openclaw',
              permissionMode: 'auto',
            },
          }),
        },
      },
    });

    const updating = coworkService.updatePermissionMode('auto');

    expect(store.getState().cowork.config.permissionMode).toBe('auto');
    finishSync?.({ success: true });
    await expect(updating).resolves.toEqual({ success: true });
  });

  test('rolls back an optimistic permission selection when synchronization fails', async () => {
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'ask',
      }),
    );
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          setConfig: vi.fn().mockResolvedValue({ success: false, error: 'reload failed' }),
          getConfig: vi.fn(),
        },
      },
    });

    const result = await coworkService.updatePermissionMode('full');

    expect(result).toEqual({ success: false, error: 'reload failed' });
    expect(store.getState().cowork.config.permissionMode).toBe('ask');
  });

  test('restores an old session permission without changing the active runtime on view', async () => {
    store.dispatch(clearCurrentSession());
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'full',
      }),
    );
    const session = {
      id: 'session-permission-ask',
      title: 'Existing session',
      status: 'idle' as const,
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local' as const,
      permissionMode: 'ask' as const,
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 2,
    };
    const setConfig = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn().mockResolvedValue({ success: true, session }),
          setConfig,
          remoteManaged: vi.fn().mockResolvedValue({ success: true, remoteManaged: false }),
        },
      },
    });

    await coworkService.loadSession(session.id);

    expect(setConfig).not.toHaveBeenCalled();
    expect(store.getState().cowork.currentSession?.permissionMode).toBe('ask');
    expect(store.getState().cowork.config.permissionMode).toBe('full');
  });

  test('keeps a new session selected when an older session load finishes late', async () => {
    store.dispatch(clearCurrentSession());
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'full',
      }),
    );
    let resolveSession: ((value: { success: true; session: CoworkSession }) => void) | undefined;
    const pendingSession = new Promise<{ success: true; session: CoworkSession }>(resolve => {
      resolveSession = resolve;
    });
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(() => pendingSession),
          getConfig: vi.fn().mockResolvedValue({
            success: true,
            config: {
              workingDirectory: 'C:\\workspace',
              executionMode: 'local',
              agentEngine: 'openclaw',
              permissionMode: 'full',
            },
          }),
          setConfig: vi.fn().mockResolvedValue({ success: true }),
        },
      },
    });

    const loading = coworkService.loadSession('old-session');
    coworkService.clearSession();
    resolveSession?.({
      success: true,
      session: {
        id: 'old-session',
        title: 'Old session',
        status: 'idle',
        pinned: false,
        cwd: 'C:\\workspace',
        executionMode: 'local',
        permissionMode: 'ask',
        activeSkillIds: [],
        agentId: 'main',
        createdAt: 1,
        updatedAt: 2,
      },
    });
    await loading;

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().cowork.config.permissionMode).toBe('full');
  });

  test('updates the selected session without changing the new-session default', async () => {
    const session: CoworkSession = {
      id: 'session-current',
      title: 'Current session',
      status: 'idle',
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local',
      permissionMode: 'ask',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 2,
    };
    store.dispatch(clearCurrentSession());
    store.dispatch(
      setCoworkConfig({
        workingDirectory: 'C:\\workspace',
        executionMode: 'local',
        agentEngine: 'openclaw',
        permissionMode: 'full',
      }),
    );
    store.dispatch(setCurrentSession(session));
    const setSessionPermissionMode = vi.fn().mockResolvedValue({ success: true });
    const setConfig = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          setSessionPermissionMode,
          setConfig,
        },
      },
    });

    await expect(coworkService.updatePermissionMode('auto')).resolves.toEqual({ success: true });

    expect(setSessionPermissionMode).toHaveBeenCalledWith({
      sessionId: session.id,
      permissionMode: 'auto',
      deferIfActive: true,
    });
    expect(setConfig).not.toHaveBeenCalled();
    expect(store.getState().cowork.currentSession?.permissionMode).toBe('auto');
    expect(store.getState().cowork.config.permissionMode).toBe('full');
  });

  test('waits for an in-flight permission change before reconciling a send', async () => {
    const session: CoworkSession = {
      id: 'session-current',
      title: 'Current session',
      status: 'idle',
      pinned: false,
      cwd: 'C:\\workspace',
      executionMode: 'local',
      permissionMode: 'full',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 2,
    };
    store.dispatch(setCurrentSession(session));
    let resolveChange!: (value: { success: true }) => void;
    const setSessionPermissionMode = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ success: true }>(resolve => {
            resolveChange = resolve;
          }),
      )
      .mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electron: { cowork: { setSessionPermissionMode } } });

    const change = coworkService.updatePermissionMode('ask');
    const reconcile = coworkService.reconcileSessionPermissionMode(session.id);
    await Promise.resolve();
    expect(setSessionPermissionMode).toHaveBeenCalledTimes(1);

    resolveChange({ success: true });
    await expect(change).resolves.toEqual({ success: true });
    await expect(reconcile).resolves.toEqual({ success: true });

    expect(setSessionPermissionMode).toHaveBeenNthCalledWith(2, {
      sessionId: session.id,
      permissionMode: 'ask',
      deferIfActive: false,
    });
    expect(store.getState().cowork.currentSession?.permissionMode).toBe('ask');
  });
});

describe('cowork runtime activity reconciliation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('keeps the previous running state when the Gateway result is unknown', async () => {
    const sessionId = 'runtime-unknown-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    setRuntimeStatusResponse({
      success: true,
      known: false,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });

    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
  });

  test('ignores an idle response that started before a new user run', async () => {
    const sessionId = 'runtime-begin-race-session';
    let resolveStatus:
      | ((value: {
          success: true;
          revision: number;
          known: true;
          mainRunning: false;
          subagentRunning: false;
          running: false;
        }) => void)
      | undefined;
    const getSessionRuntimeStatus = vi.fn(
      () =>
        new Promise(resolve => {
          resolveStatus = resolve;
        }),
    );
    const timing = {
      id: 'timing-race-1',
      sessionId,
      clientTurnId: 'turn-race-1',
      rootRunId: 'turn-race-1',
      startedAt: 1_000,
      state: 'running' as const,
    };
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSessionRuntimeStatus,
          beginSessionRun: vi.fn().mockResolvedValue({
            success: true,
            timing,
            snapshot: {
              revision: 2,
              known: true,
              mainRunning: true,
              subagentRunning: false,
              running: true,
              timing,
            },
          }),
        },
      },
    });

    const staleRefresh = coworkService.refreshSessionRuntimeActivity(sessionId, {
      includeSubagents: true,
    });
    await Promise.resolve();
    await coworkService.beginSessionRun({
      sessionId,
      clientTurnId: 'turn-race-1',
      startedAt: 1_000,
    });
    resolveStatus?.({
      success: true,
      revision: 1,
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });
    await staleRefresh;

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
    expect(store.getState().cowork.sessionRunTimings[sessionId]).toEqual([timing]);
  });

  test('applies an active recovery snapshot when beginning a new run is rejected', async () => {
    const sessionId = 'runtime-rejected-begin-session';
    const timing = {
      id: 'timing-recovered-1',
      sessionId,
      clientTurnId: 'turn-old',
      rootRunId: 'turn-old',
      startedAt: 1_000,
      acceptedAt: 1_100,
      state: 'running' as const,
    };
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          beginSessionRun: vi.fn().mockResolvedValue({
            success: false,
            errorCode: SessionRunBeginErrorCode.RuntimeActive,
            snapshot: {
              revision: 2,
              known: true,
              mainRunning: true,
              subagentRunning: false,
              running: true,
              timing,
            },
          }),
        },
      },
    });

    await expect(
      coworkService.beginSessionRun({
        sessionId,
        clientTurnId: 'turn-new',
        startedAt: 2_000,
      }),
    ).rejects.toThrow(i18nService.t('coworkSessionRuntimeActive'));

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
    expect(store.getState().cowork.sessionRunTimings[sessionId]).toEqual([timing]);
  });

  test('requires two known idle snapshots before clearing a running session', async () => {
    const sessionId = 'runtime-idle-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    setRuntimeStatusResponse({
      success: true,
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });

    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);

    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBeUndefined();
  });

  test('requires idle confirmation to restart after an unknown snapshot', async () => {
    const sessionId = 'runtime-interrupted-idle-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    const getSessionRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        known: true,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      })
      .mockResolvedValueOnce({
        success: true,
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      })
      .mockResolvedValue({
        success: true,
        known: true,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      });
    vi.stubGlobal('window', { electron: { cowork: { getSessionRuntimeStatus } } });

    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);

    await coworkService.refreshSessionRuntimeActivity(sessionId, { includeSubagents: true });
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBeUndefined();
  });

  test('clears running state only after a confirmed session stop', async () => {
    vi.useFakeTimers();
    const sessionId = 'confirmed-stop-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          stopSession: vi.fn().mockResolvedValue({ success: true }),
          getSessionRuntimeStatus: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              revision: 1,
              known: true,
              mainRunning: false,
              subagentRunning: false,
              running: true,
            })
            .mockResolvedValue({
              success: true,
              revision: 2,
              known: true,
              mainRunning: false,
              subagentRunning: false,
              running: false,
            }),
        },
      },
      setTimeout,
      clearTimeout,
    });

    await expect(coworkService.stopSession(sessionId)).resolves.toBe(true);

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBeUndefined();
  });

  test('keeps running state when a session stop is rejected', async () => {
    const sessionId = 'rejected-stop-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          stopSession: vi.fn().mockResolvedValue({
            success: false,
            error: 'Gateway did not confirm abort',
          }),
        },
      },
    });

    await expect(coworkService.stopSession(sessionId)).resolves.toBe(false);

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
  });

  test('quickly clears a completed session after two fresh idle snapshots', async () => {
    vi.useFakeTimers();
    const sessionId = 'terminal-idle-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
      success: true,
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionRuntimeStatus } },
      setTimeout,
      clearTimeout,
    });

    (
      coworkService as unknown as {
        confirmTerminalSessionIdle: (id: string) => void;
      }
    ).confirmTerminalSessionIdle(sessionId);
    await Promise.resolve();

    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
    expect(getSessionRuntimeStatus).toHaveBeenLastCalledWith(sessionId, {
      includeSubagents: true,
      forceRefresh: true,
      fullScan: true,
    });

    await vi.advanceTimersByTimeAsync(750);

    expect(getSessionRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBeUndefined();
  });

  test('keeps a completed main session running throughout the fast window for a subagent', async () => {
    vi.useFakeTimers();
    const sessionId = 'terminal-subagent-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
      success: true,
      known: true,
      mainRunning: false,
      subagentRunning: true,
      running: true,
    });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionRuntimeStatus } },
      setTimeout,
      clearTimeout,
    });

    (
      coworkService as unknown as {
        confirmTerminalSessionIdle: (id: string) => void;
      }
    ).confirmTerminalSessionIdle(sessionId);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(getSessionRuntimeStatus).toHaveBeenCalledTimes(5);
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
  });

  test('recovers from a transient running snapshot and clears after two fresh idle snapshots', async () => {
    vi.useFakeTimers();
    const sessionId = 'terminal-transient-running-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    const getSessionRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        known: true,
        mainRunning: true,
        subagentRunning: false,
        running: true,
      })
      .mockResolvedValue({
        success: true,
        known: true,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionRuntimeStatus } },
      setTimeout,
      clearTimeout,
    });

    (
      coworkService as unknown as {
        confirmTerminalSessionIdle: (id: string) => void;
      }
    ).confirmTerminalSessionIdle(sessionId);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(getSessionRuntimeStatus).toHaveBeenCalledTimes(3);
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBeUndefined();
  });

  test('cancels terminal idle confirmation when a new turn starts', async () => {
    vi.useFakeTimers();
    const sessionId = 'terminal-restarted-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
      success: true,
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });
    vi.stubGlobal('window', {
      electron: { cowork: { getSessionRuntimeStatus } },
      setTimeout,
      clearTimeout,
    });

    (
      coworkService as unknown as {
        confirmTerminalSessionIdle: (id: string) => void;
      }
    ).confirmTerminalSessionIdle(sessionId);
    await Promise.resolve();
    coworkService.markSessionInProgress(sessionId);
    await vi.advanceTimersByTimeAsync(750);

    expect(getSessionRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(store.getState().cowork.sessionRuntimeActivity[sessionId]).toBe(true);
  });
});
