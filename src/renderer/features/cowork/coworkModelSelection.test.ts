import { afterEach, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';
import { store } from '@/store';

import { CoworkService } from './coworkService';
import { clearCurrentSession, confirmCurrentSessionModelSelection, setCurrentSession } from './coworkSlice';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const session = {
  id: 'model-selection-race',
  title: 'Session',
  status: 'idle' as const,
  pinned: false,
  cwd: '',
  executionMode: 'local' as const,
  permissionMode: 'full' as const,
  activeSkillIds: [],
  agentId: 'main',
  createdAt: 1,
  updatedAt: 1,
  modelRef: 'p/old',
};

test('ignores a read started before the user switched models', async () => {
  const service = new CoworkService();
  store.dispatch(setCurrentSession(session));
  let finishRead!: (result: unknown) => void;
  vi.stubGlobal('window', {
    electron: {
      cowork: {
        getSessionModel: vi.fn(
          () =>
            new Promise(resolve => {
              finishRead = resolve;
            }),
        ),
        patchSessionModel: vi.fn(async () => ({ success: true, modelRef: 'p/new' })),
      },
    },
  });
  const read = service.refreshSessionModel(session.id);
  await service.patchSessionModel({ sessionId: session.id, model: 'p/new' });
  store.dispatch(confirmCurrentSessionModelSelection({ sessionId: session.id, modelRef: 'p/new' }));
  finishRead({ success: true, source: 'gateway', modelRef: 'p/old' });
  await read;
  expect(store.getState().cowork.currentSession?.modelRef).toBe('p/new');
});

test('latest refresh wins when model reads complete in reverse order', async () => {
  const service = new CoworkService();
  store.dispatch(setCurrentSession(session));
  let finishOldRead!: (result: unknown) => void;
  const getSessionModel = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOldRead = resolve;
        }),
    )
    .mockResolvedValueOnce({ success: true, source: 'gateway', modelRef: 'p/new' });
  vi.stubGlobal('window', { electron: { cowork: { getSessionModel } } });
  const oldRead = service.refreshSessionModel(session.id);
  await service.refreshSessionModel(session.id);
  finishOldRead({ success: true, source: 'gateway', modelRef: 'p/old' });
  await oldRead;
  expect(store.getState().cowork.currentSession?.modelRef).toBe('p/new');
});

test('loading a conversation uses the native selection instead of the saved snapshot', async () => {
  const service = new CoworkService();
  vi.stubGlobal('window', {
    electron: {
      cowork: {
        getSession: vi.fn(async () => ({ success: true, session })),
        getSessionModel: vi.fn(async () => ({
          success: true,
          source: 'gateway',
          modelRef: 'p/new',
        })),
        remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
      },
    },
  });
  await service.loadSession(session.id);
  await vi.waitFor(() => expect(store.getState().cowork.currentSession?.modelRef).toBe('p/new'));
});

test('selects history before model metadata and continues hydration after the origin unmounts', async () => {
  const service = new CoworkService();
  const selected = { ...session, id: 'history-before-model', agentId: 'review' };
  const model = deferred<{ success: true; source: 'gateway'; modelRef: string }>();
  const getSessionModel = vi.fn(() => model.promise);
  vi.stubGlobal('window', { electron: { cowork: {
    getSession: vi.fn(async () => ({ success: true, session: selected })),
    getSessionModel,
    remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
  } } });
  let originMounted = true;
  await service.loadSession(selected.id, {
    canSelect: () => originMounted,
    onSelected: () => { originMounted = false; },
  });
  expect(store.getState().cowork.currentSession?.id).toBe(selected.id);
  expect(store.getState().cowork.currentSession?.modelRef).toBe('p/old');
  expect(getSessionModel).toHaveBeenCalledWith({ sessionId: selected.id, agentId: 'review' });
  model.resolve({ success: true, source: 'gateway', modelRef: 'p/native' });
  await vi.waitFor(() => expect(store.getState().cowork.currentSession?.modelRef).toBe('p/native'));
});

test.each(['navigate', 'home', 'confirm', 'newer-read'] as const)(
  'ignores late navigation model metadata after %s', async action => {
    const service = new CoworkService();
    const selected = { ...session, id: `late-navigation-model-${action}` };
    const model = deferred<{ success: true; source: 'gateway'; modelRef: string }>();
    const getSessionModel = vi.fn(() => model.promise);
    vi.stubGlobal('window', { electron: { cowork: {
      getSession: vi.fn(async () => ({ success: true, session: selected })),
      getSessionModel,
      remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
    } } });
    await service.loadSession(selected.id);
    if (action === 'navigate') store.dispatch(setCurrentSession({ ...session, id: 'other-model-session' }));
    if (action === 'home') service.clearSession();
    if (action === 'confirm') {
      store.dispatch(confirmCurrentSessionModelSelection({ sessionId: selected.id, modelRef: 'p/confirmed' }));
    }
    if (action === 'newer-read') {
      getSessionModel.mockImplementationOnce(async () => ({ success: true, source: 'gateway', modelRef: 'p/newer' }));
      await service.refreshSessionModel(selected.id);
    }
    const before = store.getState().cowork;
    model.resolve({ success: true, source: 'gateway', modelRef: 'p/stale' });
    await model.promise;
    await Promise.resolve();
    expect(store.getState().cowork.currentSession).toEqual(before.currentSession);
    expect(store.getState().cowork.userConfirmedSessionModelRefs[selected.id])
      .toBe(before.userConfirmedSessionModelRefs[selected.id]);
  },
);

test('keeps a user model confirmation made while navigation metadata was pending', async () => {
  const service = new CoworkService();
  const selected = { ...session, id: 'model-confirmed-during-navigation' };
  const metadata = deferred<{ success: true; session: typeof selected }>();
  const getSessionModel = vi.fn();
  store.dispatch(clearCurrentSession());
  vi.stubGlobal('window', { electron: { cowork: {
    getSession: vi.fn(() => metadata.promise), getSessionModel,
    remoteManaged: vi.fn(async () => ({ remoteManaged: false })),
  } } });
  const loading = service.loadSession(selected.id);
  store.dispatch(confirmCurrentSessionModelSelection({ sessionId: selected.id, modelRef: 'p/confirmed' }));
  metadata.resolve({ success: true, session: selected });
  await loading;
  expect(store.getState().cowork.currentSession?.modelRef).toBe('p/confirmed');
  expect(getSessionModel).not.toHaveBeenCalled();
});

test('only a confirmed main default updates the settings cache', async () => {
  const service = new CoworkService();
  const accept = vi
    .spyOn(configService, 'acceptDefaultModelSelection')
    .mockImplementation(() => undefined);
  const setDefaultModel = vi
    .fn()
    .mockResolvedValueOnce({ success: false })
    .mockResolvedValue({ success: true });
  vi.stubGlobal('window', { electron: { cowork: { setDefaultModel } } });
  await service.setDefaultModel({ modelId: 'failed', providerKey: 'p' });
  await service.setDefaultModel({ modelId: 'specialist', providerKey: 'p', agentId: 'review' });
  expect(accept).not.toHaveBeenCalled();
  await service.setDefaultModel({ modelId: 'selected', providerKey: 'p' });
  expect(accept).toHaveBeenCalledWith('selected', 'p');
});
