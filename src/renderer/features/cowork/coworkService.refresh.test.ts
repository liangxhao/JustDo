import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../../store';
import { CoworkService } from './coworkService';
import { clearCurrentSession, setCurrentSession, setSessionListStatus, setSessionRuntimeActivity, setSessions } from './coworkSlice';
import type { CoworkSession } from './coworkTypes';

const session: CoworkSession = {
  id: 'refresh-current', title: 'Current', status: 'idle', pinned: false,
  cwd: 'C:\\workspace', executionMode: 'local', permissionMode: 'ask',
  activeSkillIds: [], agentId: 'main', createdAt: 1, updatedAt: 1,
};

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('session change refreshes', () => {
  let service: CoworkService;
  let notify: () => void;
  let listSessions: ReturnType<typeof vi.fn>;
  let modelRefresh: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    service = new CoworkService();
    listSessions = vi.fn().mockResolvedValue({ success: true, sessions: [session] });
    vi.stubGlobal('window', {
      setTimeout, clearTimeout,
      electron: { cowork: {
        listSessions,
        onSessionActivity: vi.fn(() => () => {}),
        onStreamInteraction: vi.fn(() => () => {}),
        onStreamInteractionDismiss: vi.fn(() => () => {}),
        onStreamComplete: vi.fn(() => () => {}),
        onStreamError: vi.fn(() => () => {}),
        replayPendingInteractions: vi.fn().mockResolvedValue({ success: true }),
        onSessionsChanged: vi.fn((callback: () => void) => {
          notify = callback;
          return () => {};
        }),
      } },
    });
    vi.spyOn(service, 'loadConfig').mockResolvedValue(undefined);
    vi.spyOn(service, 'loadGroups').mockResolvedValue(undefined);
    modelRefresh = vi.spyOn(service, 'refreshSessionModel').mockResolvedValue(undefined);
    store.dispatch(setCurrentSession(session));
    await service.init();
    listSessions.mockClear();
  });

  afterEach(() => {
    service.destroy();
    store.dispatch(clearCurrentSession());
    store.dispatch(setSessions([]));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('combines notification bursts without postponing refresh indefinitely', async () => {
    notify();
    await vi.advanceTimersByTimeAsync(70);
    notify();
    notify();
    expect(listSessions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(listSessions).toHaveBeenCalledOnce();
    expect(modelRefresh).toHaveBeenCalledOnce();
  });

  test('does not infer completion when the backend omits the final status', () => {
    service.markSessionInProgress(session.id);
    const callback = vi.mocked(window.electron.cowork.onStreamComplete).mock.calls[0][0];

    callback({ sessionId: session.id } as Parameters<typeof callback>[0]);

    expect(store.getState().cowork.currentSession?.status).toBe('running');
    expect(store.getState().cowork.sessionRuntimeActivity[session.id]).toBe(true);
    expect(modelRefresh).not.toHaveBeenCalled();
    store.dispatch(setSessionRuntimeActivity({ sessionId: session.id, running: false }));
  });

  test('loads the initial sidebar when development mounts initialize concurrently', async () => {
    service.destroy();
    store.dispatch(setSessions([]));
    store.dispatch(setSessionListStatus('loading'));
    const completions: Array<(value: unknown) => void> = [];
    listSessions.mockImplementation(() => new Promise(resolve => { completions.push(resolve); }));

    const first = service.init();
    const repeated = service.init();
    await flush();
    completions[0]({ success: true, sessions: [session] });
    await flush();
    completions[1]?.({ success: true, sessions: [session] });
    await Promise.all([first, repeated]);

    expect(store.getState().cowork.sessionListStatus).toBe('ready');
    expect(store.getState().cowork.sessions).toEqual([session]);
    expect(listSessions).toHaveBeenCalledOnce();
  });

  test('removes early listeners and does not register them again when an abandoned read finishes', async () => {
    service.destroy();
    const onSessionsChanged = vi.mocked(window.electron.cowork.onSessionsChanged);
    onSessionsChanged.mockClear();
    const unsubscribe = vi.fn();
    onSessionsChanged.mockImplementationOnce(() => unsubscribe);
    store.dispatch(setSessions([]));
    store.dispatch(setSessionListStatus('loading'));
    let finish!: (value: unknown) => void;
    listSessions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const abandoned = service.init();
    await flush();
    service.destroy();
    finish({ success: true, sessions: [session] });
    await abandoned;

    expect(onSessionsChanged).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(store.getState().cowork.sessions).toEqual([]);
    await service.init();
    expect(onSessionsChanged).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessionListStatus).toBe('ready');
  });

  test('retains a replacement initialization while an older destroyed one finishes', async () => {
    service.destroy();
    const onSessionsChanged = vi.mocked(window.electron.cowork.onSessionsChanged);
    onSessionsChanged.mockClear();
    const obsoleteUnsubscribe = vi.fn();
    onSessionsChanged.mockImplementationOnce(() => obsoleteUnsubscribe);
    const completions: Array<(value: unknown) => void> = [];
    listSessions.mockImplementation(() => new Promise(resolve => { completions.push(resolve); }));
    const abandoned = service.init();
    await flush();
    service.destroy();
    const replacement = service.init();
    await flush();
    completions[0]({ success: true, sessions: [] });
    await abandoned;
    const joining = service.init();
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(onSessionsChanged).toHaveBeenCalledTimes(2);
    expect(obsoleteUnsubscribe).toHaveBeenCalledOnce();
    completions[1]({ success: true, sessions: [session] });
    await Promise.all([replacement, joining]);
    expect(onSessionsChanged).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessions).toEqual([session]);
  });

  test('shares an initialization failure and permits a fresh attempt', async () => {
    service.destroy();
    store.dispatch(setSessionListStatus('loading'));
    let fail!: (error: Error) => void;
    listSessions.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = service.init();
    const repeated = service.init();
    const failures = Promise.all([
      expect(first).rejects.toThrow('IPC unavailable'),
      expect(repeated).rejects.toThrow('IPC unavailable'),
    ]);
    await flush();
    fail(new Error('IPC unavailable'));
    await failures;

    expect(store.getState().cowork.sessionListStatus).toBe('error');
    expect(listSessions).toHaveBeenCalledOnce();
    await service.init();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessionListStatus).toBe('ready');
  });

  test('waits for an in-flight refresh and reads once more for later notifications', async () => {
    let finish!: (value: unknown) => void;
    listSessions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    notify();
    await vi.advanceTimersByTimeAsync(100);
    notify();
    notify();
    await vi.advanceTimersByTimeAsync(500);
    expect(listSessions).toHaveBeenCalledOnce();
    finish({ success: true, sessions: [session] });
    await vi.advanceTimersByTimeAsync(100);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(modelRefresh).toHaveBeenCalledTimes(2);
  });

  test('continues with a queued refresh after a failed read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail!: (error: Error) => void;
    listSessions.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    notify();
    await vi.advanceTimersByTimeAsync(100);
    notify();
    fail(new Error('IPC unavailable'));
    await vi.advanceTimersByTimeAsync(100);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessionListStatus).toBe('ready');
  });

  test('cancels a scheduled refresh when listeners are removed', async () => {
    notify();
    service.destroy();
    await vi.advanceTimersByTimeAsync(500);
    expect(listSessions).not.toHaveBeenCalled();
    expect(modelRefresh).not.toHaveBeenCalled();
  });

  test('does not apply or queue a late result from a destroyed listener lifetime', async () => {
    let finish!: (value: unknown) => void;
    listSessions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    notify();
    await vi.advanceTimersByTimeAsync(100);
    notify();
    service.destroy();
    store.dispatch(setSessions([]));
    finish({ success: true, sessions: [session] });
    await vi.advanceTimersByTimeAsync(500);
    expect(listSessions).toHaveBeenCalledOnce();
    expect(store.getState().cowork.sessions).toEqual([]);
  });
});
