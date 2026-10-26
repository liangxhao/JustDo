import { afterEach, expect, test, vi } from 'vitest';

import { store } from '@/store';

import { coworkService } from './coworkService';
import { setCurrentSession } from './coworkSlice';
import type { CoworkSession } from './coworkTypes';

function session(id: string): CoworkSession {
  return {
    id, title: 'Selected conversation', status: 'idle', pinned: false, cwd: '/workspace',
    executionMode: 'local', permissionMode: 'ask', activeSkillIds: [], agentId: 'main',
    createdAt: 1, updatedAt: 1,
  };
}

function bridge(getSession: ReturnType<typeof vi.fn>) {
  const remoteManaged = vi.fn().mockResolvedValue({ success: true, remoteManaged: false });
  vi.stubGlobal('window', { electron: { cowork: { getSession, remoteManaged } } });
  return { remoteManaged };
}

afterEach(() => {
  coworkService.clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('preserves the optimistic session without looking up its temporary ID', async () => {
  const temporary = { ...session('temp-pending'), status: 'running' as const };
  store.dispatch(setCurrentSession(temporary));
  const getSession = vi.fn();
  bridge(getSession);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(coworkService.loadSession(temporary.id)).resolves.toBeNull();
  expect(getSession).not.toHaveBeenCalled();
  expect(store.getState().cowork.currentSession).toEqual(temporary);
  expect(log).not.toHaveBeenCalled();
});

test.each([
  { success: false, error: 'Session not found.' },
  { success: true, session: null },
  { success: false },
])('records the requested ID and a useful reason for a missing or failed response: %j', async result => {
  store.dispatch(setCurrentSession(session('existing')));
  const getSession = vi.fn().mockResolvedValue(result);
  const { remoteManaged } = bridge(getSession);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const onSelected = vi.fn();
  await expect(coworkService.loadSession('missing', { onSelected })).resolves.toBeNull();
  expect(log).toHaveBeenCalledWith('Failed to load session:', expect.any(Error), 'sessionId=missing');
  expect((log.mock.calls[0][1] as Error).message).toBe(result.error || 'Session response did not include a session.');
  expect(store.getState().cowork.currentSession?.id).toBe('existing');
  expect(onSelected).not.toHaveBeenCalled();
  expect(remoteManaged).not.toHaveBeenCalled();
});

test.each(['clear', 'new-selection'])('ignores a failed session read superseded by %s', async kind => {
  let finish!: (value: unknown) => void;
  const getSession = vi.fn().mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ success: true, session: session('new-selected') });
  bridge(getSession);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const oldRead = coworkService.loadSession('old-selected');
  if (kind === 'clear') coworkService.clearSession();
  else await coworkService.loadSession('new-selected');
  finish({ success: false, error: 'Old session not found' });
  await expect(oldRead).resolves.toBeNull();
  expect(log).not.toHaveBeenCalled();
  expect(store.getState().cowork.currentSession?.id ?? null).toBe(kind === 'clear' ? null : 'new-selected');
});

test('does not let a focus refresh replace a newly started temporary conversation', async () => {
  const old = session('persisted');
  store.dispatch(setCurrentSession(old));
  let finish!: (value: unknown) => void;
  const getSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const { remoteManaged } = bridge(getSession);
  const oldRead = coworkService.loadSession(old.id, {
    canSelect: () => store.getState().cowork.currentSession?.id === old.id,
  });
  const temporary = { ...session('temp-next'), status: 'running' as const };
  store.dispatch(setCurrentSession(temporary));
  finish({ success: true, session: old });
  await expect(oldRead).resolves.toBeNull();
  expect(store.getState().cowork.currentSession).toEqual(temporary);
  expect(remoteManaged).not.toHaveBeenCalled();
});
