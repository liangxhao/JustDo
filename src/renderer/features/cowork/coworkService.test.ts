import { afterEach, describe, expect, test, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { setSessionRuntimeActivity } from '@/features/cowork/coworkSlice';
import { store } from '@/store';

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
    const sessionId = 'confirmed-stop-session';
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          stopSession: vi.fn().mockResolvedValue({ success: true }),
        },
      },
    });

    await expect(coworkService.stopSession(sessionId)).resolves.toBe(true);

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
