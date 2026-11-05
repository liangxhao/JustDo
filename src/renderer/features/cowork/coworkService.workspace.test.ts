import { afterEach, expect, test, vi } from 'vitest';

import { store } from '@/store';

import { coworkService } from './coworkService';
import {
  clearCurrentSession,
  setCurrentSession,
  updateCurrentSessionWorkspace,
} from './coworkSlice';
import type { CoworkSession } from './coworkTypes';

const session = { id: 'session', cwd: '/old', permissionMode: 'ask' } as CoworkSession;
afterEach(() => {
  store.dispatch(clearCurrentSession());
  vi.unstubAllGlobals();
});

test('captures the workspace before asynchronous permission preparation', async () => {
  store.dispatch(setCurrentSession(session));
  const setSessionPermissionMode = vi.fn(async () => {
    store.dispatch(updateCurrentSessionWorkspace({ sessionId: session.id, cwd: '/new' }));
    return { success: true };
  });
  vi.stubGlobal('window', { electron: { cowork: { setSessionPermissionMode } } });
  await expect(coworkService.reconcileSessionPermissionMode(session.id)).resolves.toMatchObject({
    success: true,
    workspaceRoot: '/old',
  });
  expect(store.getState().cowork.currentSession?.cwd).toBe('/new');
});

test('updates only confirmed workspace metadata and never selects a previously active session', async () => {
  store.dispatch(setCurrentSession(session));
  const setSessionWorkspace = vi.fn(async () => ({ success: false, reason: 'busy' }));
  vi.stubGlobal('window', { electron: { cowork: { setSessionWorkspace } } });
  const input = { sessionId: session.id, cwd: '/new', expectedCwd: '/old' };
  await coworkService.setSessionWorkspace(input);
  expect(store.getState().cowork.currentSession?.cwd).toBe('/old');
  setSessionWorkspace.mockImplementation(async () => {
    store.dispatch(setCurrentSession({ ...session, id: 'another' }));
    return { success: true, cwd: '/new' } as never;
  });
  await coworkService.setSessionWorkspace(input);
  expect(store.getState().cowork.currentSession).toMatchObject({ id: 'another', cwd: '/old' });
});

test('refreshes the selected workspace and clears unavailable historical-folder presentation', async () => {
  store.dispatch(
    setCurrentSession({ ...session, historyBinding: { workspaceUnavailable: true } as never }),
  );
  vi.stubGlobal('window', {
    electron: {
      cowork: {
        setSessionWorkspace: vi.fn().mockResolvedValue({ success: true, cwd: '/new' }),
      },
    },
  });
  await coworkService.setSessionWorkspace({
    sessionId: session.id,
    cwd: '/new',
    expectedCwd: '/old',
  });
  expect(store.getState().cowork.currentSession).toMatchObject({
    cwd: '/new',
    historyBinding: { workspaceUnavailable: false },
  });
});
