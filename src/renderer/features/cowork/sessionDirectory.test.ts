import type { SessionDirectoryEntry } from '@shared/cowork/sessionDirectory';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { store } from '@/store';

import { CoworkService } from './coworkService';
import reducer, {
  addSession,
  clearCurrentSession,
  deleteSession,
  moveSessionToGroup,
  setCurrentSession,
  setSessionDirectory,
  setSessionRuntimeActivity,
  setSessions,
  touchSessionActivity,
  updateSessionPinned,
  updateSessionTitle,
  upsertSessionSummaries,
} from './coworkSlice';
import type { CoworkSession, CoworkSessionSummary } from './coworkTypes';

const entry = (id: string, changes: Partial<SessionDirectoryEntry> = {}): SessionDirectoryEntry => ({
  id, status: 'idle', pinned: false, agentId: 'main', groupId: null,
  createdAt: 1, updatedAt: 1, ...changes,
});
const summary = (id: string): CoworkSessionSummary => ({ ...entry(id), title: id });
const fullSession = (id: string, updatedAt = 1): CoworkSession => ({
  ...summary(id), updatedAt, cwd: 'E:\\project', permissionMode: 'ask',
  executionMode: 'local', activeSkillIds: [], agentId: 'main',
});

afterEach(() => {
  store.dispatch(setSessionDirectory([]));
  vi.unstubAllGlobals();
});

describe('complete directory and partial row summaries', () => {
  test('keeps an optimistic session out of navigation while pending and after a failed start', () => {
    let state = reducer(undefined, setSessionDirectory([]));

    state = reducer(state, setCurrentSession(fullSession('temp-pending')));

    expect(state.currentSessionId).toBe('temp-pending');
    expect(state.currentSession?.id).toBe('temp-pending');
    expect(state.sessions).toEqual([]);
    expect(state.sessionDirectory).toEqual([]);

    state = reducer(state, clearCurrentSession());
    expect(state.currentSession).toBeNull();
    expect(state.sessionDirectory).toEqual([]);
  });

  test('admits only the canonical session after an optimistic start', () => {
    let state = reducer(undefined, setSessionDirectory([]));
    state = reducer(state, setCurrentSession(fullSession('temp-pending')));

    state = reducer(state, addSession({ session: fullSession('canonical'), select: true }));

    expect(state.currentSessionId).toBe('canonical');
    expect(state.sessions.map(session => session.id)).toEqual(['canonical']);
    expect(state.sessionDirectory?.map(session => session.id)).toEqual(['canonical']);
  });

  test.each([
    { detailTime: 1, expectedTime: 100 },
    { detailTime: 200, expectedTime: 200 },
  ])('preserves the latest activity when selecting an unloaded session: $detailTime', ({ detailTime, expectedTime }) => {
    let state = reducer(undefined, setSessionDirectory([entry('old')]));
    state = reducer(state, touchSessionActivity({ sessionId: 'old', timestamp: 100 }));
    expect(state.sessions).toEqual([]);

    state = reducer(state, setCurrentSession(fullSession('old', detailTime)));

    expect(state.sessionDirectory?.[0].updatedAt).toBe(expectedTime);
    expect(state.sessions[0].updatedAt).toBe(expectedTime);
    expect(state.currentSession?.updatedAt).toBe(expectedTime);
  });

  test('a partial row read preserves unread hidden history and full directory membership', () => {
    let state = reducer(undefined, setSessions([summary('old'), summary('today')]));
    state = reducer(state, touchSessionActivity({ sessionId: 'old', timestamp: 2 }));
    state = reducer(state, setSessionDirectory([entry('old'), entry('today')]));
    state = reducer(state, upsertSessionSummaries([summary('today')]));
    expect(state.unreadSessionIds).toEqual(['old']);
    expect(state.sessionDirectory?.map(row => row.id)).toEqual(['old', 'today']);
    expect(state.sessionDirectory?.[0].updatedAt).toBe(2);
  });

  test('a late row response cannot restore a deleted directory entry', () => {
    let state = reducer(undefined, setSessionDirectory([entry('old')]));
    state = reducer(state, deleteSession('old'));
    state = reducer(state, upsertSessionSummaries([summary('old')]));
    expect(state.sessions).toEqual([]);
    expect(state.sessionDirectory).toEqual([]);
  });

  test('pin, move and activity changes update unloaded directory entries', () => {
    let state = reducer(undefined, setSessionDirectory([entry('old')]));
    state = reducer(state, updateSessionPinned({ sessionId: 'old', pinned: true }));
    state = reducer(state, moveSessionToGroup({ sessionId: 'old', groupId: 'work' }));
    state = reducer(state, touchSessionActivity({ sessionId: 'old', timestamp: 9 }));
    expect(state.sessions).toEqual([]);
    expect(state.sessionDirectory?.[0]).toMatchObject({
      pinned: true, groupId: 'work', updatedAt: 9,
    });
  });

  test('a non-running activity update preserves completed or failed directory status', () => {
    let state = reducer(undefined, setSessionDirectory([entry('old', { status: 'error' })]));
    state = reducer(state, setSessionRuntimeActivity({ sessionId: 'old', running: false }));
    expect(state.sessionDirectory?.[0].status).toBe('error');
  });

  test('selecting a session explicitly moved out of a group clears its directory group', () => {
    let state = reducer(undefined, setSessionDirectory([entry('old', { groupId: 'work' })]));
    state = reducer(state, setCurrentSession({
      ...summary('old'), groupId: null, cwd: 'E:\\project', permissionMode: 'ask',
      executionMode: 'local', activeSkillIds: [], agentId: 'main',
    } as CoworkSession));
    expect(state.sessionDirectory?.[0].groupId).toBeNull();
  });
});

describe('bounded row loading', () => {
  test('cold startup reads only the directory and does not hydrate hidden rows', async () => {
    store.dispatch(setSessionDirectory([]));
    const readSessionSummaries = vi.fn();
    vi.stubGlobal('window', { electron: { cowork: {
      listSessionDirectory: vi.fn().mockResolvedValue({ success: true, entries: [entry('old')] }),
      readSessionSummaries,
    } } });
    await new CoworkService().loadSessions();
    expect(store.getState().cowork.sessionDirectory?.map(row => row.id)).toEqual(['old']);
    expect(store.getState().cowork.sessions).toEqual([]);
    expect(readSessionSummaries).not.toHaveBeenCalled();
  });

  test('subscribes before discovery can notify while session groups are still loading', async () => {
    store.dispatch(setSessionDirectory([]));
    const service = new CoworkService();
    let finishGroups!: () => void;
    const groups = new Promise<void>(resolve => { finishGroups = resolve; });
    vi.spyOn(service, 'loadConfig').mockResolvedValue();
    vi.spyOn(service, 'loadGroups').mockReturnValue(groups);
    vi.spyOn(service, 'loadOpenClawEngineStatus').mockResolvedValue(null);
    const subscribe = vi.fn(() => () => undefined);
    const onSessionsChanged = vi.fn(() => () => undefined);
    const listSessionDirectory = vi.fn(async () => {
      expect(onSessionsChanged).toHaveBeenCalledOnce();
      return { success: true, entries: [entry('old')] };
    });
    vi.stubGlobal('window', { electron: { cowork: {
      onSessionActivity: subscribe,
      onStreamInteraction: subscribe,
      onStreamInteractionDismiss: subscribe,
      onStreamComplete: subscribe,
      onStreamError: subscribe,
      onSessionsChanged,
      replayPendingInteractions: vi.fn().mockResolvedValue({ success: true }),
      listSessionDirectory,
      readSessionSummaries: vi.fn(),
    } } });
    const initializing = service.init();
    await vi.waitFor(() => expect(service.loadGroups).toHaveBeenCalled());
    expect(listSessionDirectory).toHaveBeenCalledOnce();
    finishGroups();
    await initializing;
    service.destroy();
  });

  test('coalesces concurrent requests and bounds each IPC batch to 200 IDs', async () => {
    const entries = Array.from({ length: 201 }, (_, i) => entry('row-' + i));
    store.dispatch(setSessionDirectory(entries));
    const readSessionSummaries = vi.fn(async (ids: string[]) => ({
      success: true, sessions: ids.map(summary),
    }));
    vi.stubGlobal('window', { electron: { cowork: { readSessionSummaries } } });
    const service = new CoworkService();
    expect(await Promise.all([
      service.ensureSessionSummaries(entries.map(row => row.id)),
      service.ensureSessionSummaries(['row-0']),
    ])).toEqual([true, true]);
    expect(readSessionSummaries.mock.calls.map(([ids]) => ids.length)).toEqual([200, 1]);
  });

  test('does not restore an entry deleted while a row request is pending', async () => {
    store.dispatch(setSessionDirectory([entry('old')]));
    let finish!: (result: { success: true; sessions: CoworkSessionSummary[] }) => void;
    const response = new Promise<{ success: true; sessions: CoworkSessionSummary[] }>(
      resolve => { finish = resolve; },
    );
    vi.stubGlobal('window', { electron: { cowork: {
      readSessionSummaries: vi.fn(() => response),
    } } });
    const loading = new CoworkService().ensureSessionSummaries(['old']);
    await Promise.resolve();
    store.dispatch(deleteSession('old'));
    finish({ success: true, sessions: [summary('old')] });
    expect(await loading).toBe(true);
    expect(store.getState().cowork.sessions).toEqual([]);
  });

  test('a delayed refresh does not overwrite a title renamed during the read', async () => {
    store.dispatch(setSessionDirectory([entry('old')]));
    store.dispatch(upsertSessionSummaries([summary('old')]));
    let finish!: (value: { success: true; sessions: CoworkSessionSummary[] }) => void;
    const response = new Promise<{ success: true; sessions: CoworkSessionSummary[] }>(
      resolve => { finish = resolve; },
    );
    vi.stubGlobal('window', { electron: { cowork: {
      readSessionSummaries: vi.fn(() => response),
    } } });
    const loading = new CoworkService().ensureSessionSummaries(['old'], true);
    await Promise.resolve();
    store.dispatch(updateSessionTitle({ sessionId: 'old', title: 'Renamed task' }));
    finish({ success: true, sessions: [summary('old')] });
    expect(await loading).toBe(true);
    expect(store.getState().cowork.sessions[0].title).toBe('Renamed task');
  });

  test('a forced refresh waits for an older read and then requests a fresh snapshot', async () => {
    store.dispatch(setSessionDirectory([entry('old')]));
    let finish!: (value: { success: true; sessions: CoworkSessionSummary[] }) => void;
    const response = new Promise<{ success: true; sessions: CoworkSessionSummary[] }>(
      resolve => { finish = resolve; },
    );
    const readSessionSummaries = vi.fn()
      .mockReturnValueOnce(response)
      .mockResolvedValueOnce({
        success: true, sessions: [{ ...summary('old'), title: 'Fresh server title' }],
      });
    vi.stubGlobal('window', { electron: { cowork: { readSessionSummaries } } });
    const service = new CoworkService();
    const first = service.ensureSessionSummaries(['old']);
    await Promise.resolve();
    const refresh = service.ensureSessionSummaries(['old'], true);
    finish({ success: true, sessions: [summary('old')] });
    expect(await first).toBe(true);
    expect(await refresh).toBe(true);
    expect(readSessionSummaries).toHaveBeenCalledTimes(2);
    expect(store.getState().cowork.sessions[0].title).toBe('Fresh server title');
  });
});
