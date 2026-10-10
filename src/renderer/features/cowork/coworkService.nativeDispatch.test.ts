import type {
  NativeSessionDispatchRequest,
  NativeSessionDispatchResponse,
} from '@shared/cowork/nativeSessionDispatch';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import {
  clearCurrentSession,
  deleteSession,
  setCurrentSession,
} from '@/features/cowork/coworkSlice';
import type { CoworkSession } from '@/features/cowork/coworkTypes';
import { store } from '@/store';

const temporary: CoworkSession = {
  id: 'temp-native-service',
  title: 'Synthetic',
  status: 'running',
  pinned: false,
  cwd: '',
  executionMode: 'local',
  permissionMode: 'ask',
  activeSkillIds: [],
  agentId: 'main',
  createdAt: 1,
  updatedAt: 1,
};
const canonical: CoworkSession = {
  ...temporary,
  id: 'canonical-native-service',
  nativeSessionKey: 'agent:main:native-prepared-service',
};
const request: NativeSessionDispatchRequest = {
  requestId: 'handoff-service',
  clientTurnId: 'turn-service',
  sessionId: canonical.id,
  sessionKey: canonical.nativeSessionKey!,
  params: {
    sessionKey: canonical.nativeSessionKey,
    idempotencyKey: 'turn-service',
    message: 'Synthetic',
  },
};

function setup(success = true) {
  let listener: ((input: NativeSessionDispatchRequest) => void) | undefined;
  let finish!: (result: unknown) => void;
  const nativeResult = new Promise(resolve => {
    finish = resolve;
  });
  const unsubscribe = vi.fn();
  const respond = vi.fn(async (response: NativeSessionDispatchResponse) => {
    finish(
      response.success && success
        ? { success: true, session: canonical }
        : { success: false, error: 'Synthetic pre-send failure' },
    );
    return { success: true };
  });
  const start = vi.fn(() => nativeResult);
  vi.stubGlobal('window', {
    location: { protocol: 'http:' },
    dispatchEvent: vi.fn(),
    electron: {
      cowork: {
        onNativeSessionDispatch: (fn: typeof listener) => {
          listener = fn;
          return unsubscribe;
        },
        respondNativeSessionDispatch: respond,
        getSession: vi.fn().mockResolvedValue({ success: true, session: canonical }),
        startSession: start,
      },
    },
  });
  store.dispatch(setCurrentSession(temporary));
  return { start, respond, unsubscribe, deliver: () => listener!(request) };
}

afterEach(() => {
  store.dispatch(clearCurrentSession());
  store.dispatch(deleteSession(canonical.id));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('actual service initial native handoff', () => {
  it('promotes the native session before one real transport call, even if the handoff repeats', async () => {
    const fixture = setup();
    const before = vi.fn(() =>
      expect(store.getState().cowork.currentSession?.id).toBe(temporary.id),
    );
    const dispatch = vi.fn(async (input: NativeSessionDispatchRequest) => {
      expect(store.getState().cowork.currentSession?.nativeSessionKey).toBe(input.sessionKey);
      return { runId: input.clientTurnId };
    });
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { beforeSessionSelected: before, dispatchInitialTurn: dispatch },
    );
    fixture.deliver();
    fixture.deliver();
    await expect(pending).resolves.toMatchObject({ session: { id: canonical.id } });
    expect(before).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ rendererDispatch: true }));
    expect(fixture.respond).toHaveBeenCalledTimes(1);
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('clears streaming for the promoted selection after a definite pre-send failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = setup(false);
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      {
        dispatchInitialTurn: async () => {
          throw Object.assign(new Error('Not ready'), { requestSent: false });
        },
      },
    );
    fixture.deliver();
    await expect(pending).resolves.toMatchObject({ session: null });
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, requestSent: false }),
    );
    expect(store.getState().cowork.currentSession?.id).toBe(canonical.id);
    expect(store.getState().cowork.isStreaming).toBe(false);
  });

  it('does not submit or take over a different selected conversation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = setup(false);
    const dispatch = vi.fn();
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { dispatchInitialTurn: dispatch },
    );
    store.dispatch(setCurrentSession({ ...temporary, id: 'other-conversation' }));
    fixture.deliver();
    await pending;
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, requestSent: false }),
    );
    expect(store.getState().cowork.currentSession?.id).toBe('other-conversation');
  });

  it('fences a canonical initial send before deleting a session that is still waiting for ready', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = setup(false);
    const cancel = vi.fn().mockResolvedValue({ success: true });
    const remove = vi.fn().mockResolvedValue({ success: true });
    Object.assign(window.electron.cowork, { cancelSessionStart: cancel, deleteSession: remove });
    let ready!: () => void;
    const barrier = new Promise<void>(resolve => {
      ready = resolve;
    });
    const nativeSend = vi.fn();
    const dispatch = vi.fn(
      async (_request: NativeSessionDispatchRequest, isCancelled: () => boolean) => {
        await barrier;
        if (isCancelled())
          throw Object.assign(new Error('Cancelled before ready'), { requestSent: false });
        return nativeSend();
      },
    );
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { dispatchInitialTurn: dispatch },
    );
    fixture.deliver();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await expect(coworkService.deleteSession(canonical.id)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith({ clientTurnId: request.clientTurnId });
    expect(remove).toHaveBeenCalledWith(canonical.id);
    ready();
    await pending;
    expect(nativeSend).not.toHaveBeenCalled();
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, requestSent: false }),
    );
  });

  it('does not resurrect a deleted canonical session after its delayed successful admission', async () => {
    const fixture = setup();
    const cancel = vi.fn().mockResolvedValue({ success: true });
    const remove = vi.fn().mockResolvedValue({ success: true });
    Object.assign(window.electron.cowork, { cancelSessionStart: cancel, deleteSession: remove });
    let acknowledge!: () => void;
    const admission = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const dispatch = vi.fn(async () => {
      await admission;
      return { runId: request.clientTurnId };
    });
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { dispatchInitialTurn: dispatch },
    );
    fixture.deliver();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await expect(coworkService.deleteSession(canonical.id)).resolves.toBe(true);
    expect(store.getState().cowork.sessions.some(session => session.id === canonical.id)).toBe(
      false,
    );
    acknowledge();
    await expect(pending).resolves.toMatchObject({ session: null, cancelled: true });
    expect(store.getState().cowork.sessions.some(session => session.id === canonical.id)).toBe(
      false,
    );
    expect(store.getState().cowork.currentSession).toBeNull();
  });

  it('keeps deletion coordinated while initial permission promotion is still awaiting Main', async () => {
    const fixture = setup();
    const cancel = vi.fn().mockResolvedValue({ success: true });
    const remove = vi.fn().mockResolvedValue({ success: true });
    let finishPermission!: (result: { success: boolean }) => void;
    const permission = new Promise<{ success: boolean }>(resolve => {
      finishPermission = resolve;
    });
    const updatePermission = vi.fn(() => permission);
    Object.assign(window.electron.cowork, {
      cancelSessionStart: cancel,
      deleteSession: remove,
      setSessionPermissionMode: updatePermission,
    });
    await coworkService.updatePermissionMode('full');
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { dispatchInitialTurn: async () => ({ runId: request.clientTurnId }) },
    );
    fixture.deliver();
    await vi.waitFor(() => expect(updatePermission).toHaveBeenCalled());
    await expect(coworkService.deleteSession(canonical.id)).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith({ clientTurnId: request.clientTurnId });
    finishPermission({ success: true });
    await expect(pending).resolves.toMatchObject({ session: null, cancelled: true });
    expect(store.getState().cowork.sessions.some(session => session.id === canonical.id)).toBe(
      false,
    );
  });

  it('retains the canonical session when deleting a pending initial start fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = setup();
    const cancel = vi.fn().mockResolvedValue({ success: true });
    const remove = vi.fn().mockResolvedValue({ success: false, error: 'Synthetic delete failure' });
    Object.assign(window.electron.cowork, { cancelSessionStart: cancel, deleteSession: remove });
    let acknowledge!: () => void;
    const admission = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const dispatch = vi.fn(async () => {
      await admission;
      return { runId: request.clientTurnId };
    });
    const pending = coworkService.startSession(
      { prompt: 'Synthetic', clientTurnId: request.clientTurnId },
      { dispatchInitialTurn: dispatch },
    );
    fixture.deliver();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await expect(coworkService.deleteSession(canonical.id)).resolves.toBe(false);
    acknowledge();
    await expect(pending).resolves.toMatchObject({ session: { id: canonical.id } });
    expect(store.getState().cowork.sessions.some(session => session.id === canonical.id)).toBe(
      true,
    );
  });
});
