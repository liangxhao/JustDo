import { afterEach, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';
import { store } from '@/store';

import { CoworkService } from './coworkService';
import { confirmCurrentSessionModelSelection, setCurrentSession } from './coworkSlice';

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
  expect(store.getState().cowork.currentSession?.modelRef).toBe('p/new');
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
