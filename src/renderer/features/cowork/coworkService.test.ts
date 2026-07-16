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
});
