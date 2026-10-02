import path from 'path';
import { describe, expect, test, vi } from 'vitest';

import { t } from '../../core/i18n';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { createSessionWorktree, discardPreparedWorktreeSession } from './worktreeSession';

const setup = () => {
  const sourceRoot = path.resolve('source-project');
  const worktreeRoot = path.resolve('native-worktrees', 'task');
  const session = {
    id: 'task-1', agentId: 'main', cwd: sourceRoot, permissionMode: 'ask',
  } as CoworkSession;
  const store = {
    bindNativeSession: vi.fn(() => { session.nativeSessionKey = 'agent:main:justdo:task-1'; }),
    updateSession: vi.fn(),
    getSession: vi.fn<() => CoworkSession | null>(() => session),
    deleteSession: vi.fn(),
  };
  const request = vi.fn().mockResolvedValue({
    key: 'agent:main:justdo:task-1',
    sessionId: 'gateway-task-1',
    entry: { sessionRoot: worktreeRoot, permissionMode: 'guarded', worktree: { id: 'tree-1' } },
    worktree: { id: 'tree-1', path: worktreeRoot },
  });
  return { sourceRoot, worktreeRoot, session, store, request };
};

describe('native worktree conversation creation', () => {
  test('binds the native identity and changes execution root only after Gateway confirmation', async () => {
    const { store, session, request, worktreeRoot, sourceRoot } = setup();
    await expect(createSessionWorktree(store as unknown as CoworkStore, session, request))
      .resolves.toBe(worktreeRoot);
    expect(request).toHaveBeenCalledWith('sessions.create', {
      key: 'agent:main:justdo:task-1', agentId: 'main', cwd: sourceRoot,
      permissionMode: 'guarded', worktree: true,
    });
    expect(store.bindNativeSession).toHaveBeenCalledWith('task-1', 'agent:main:justdo:task-1', null);
    expect(store.updateSession).toHaveBeenCalledWith('task-1', { cwd: worktreeRoot });
  });

  test('retains an inspectable native identity on uncertain creation failure', async () => {
    const { store, session, request } = setup();
    request.mockRejectedValueOnce(new Error('Disconnected after creation'));
    await expect(createSessionWorktree(store as unknown as CoworkStore, session, request))
      .rejects.toThrow('Disconnected after creation');
    expect(store.bindNativeSession).toHaveBeenCalledOnce();
    expect(store.updateSession).toHaveBeenCalledWith('task-1', { status: 'error' });
    expect(store.updateSession).not.toHaveBeenCalledWith('task-1', expect.objectContaining({ cwd: expect.anything() }));
  });

  test('rejects a response with an inconsistent worktree identity or execution root', async () => {
    const { store, session, request, worktreeRoot } = setup();
    request.mockResolvedValueOnce({
      key: 'agent:main:justdo:task-1', sessionId: 'gateway-task-1',
      entry: { sessionRoot: worktreeRoot, permissionMode: 'guarded', worktree: { id: 'other-tree' } },
      worktree: { id: 'tree-1', path: worktreeRoot },
    });
    await expect(createSessionWorktree(store as unknown as CoworkStore, session, request))
      .rejects.toThrow(t('worktreeCreateUnconfirmed'));
    expect(store.updateSession).toHaveBeenCalledWith('task-1', { status: 'error' });
  });

  test('removes the local row when a follow-up native read confirms creation was rejected', async () => {
    const { store, session, request } = setup();
    request.mockRejectedValueOnce(new Error('Not a Git repository'));
    request.mockResolvedValueOnce({ session: null });
    store.deleteSession.mockImplementationOnce(() => { store.getSession.mockReturnValue(null); });
    await expect(createSessionWorktree(store as unknown as CoworkStore, session, request))
      .rejects.toThrow('Not a Git repository');
    expect(request).toHaveBeenCalledWith('sessions.describe', { key: 'agent:main:justdo:task-1' });
    expect(store.deleteSession).toHaveBeenCalledWith('task-1');
  });

  test('cleans a cancelled preparation through native session deletion before deleting the local row', async () => {
    const { store, session, request } = setup();
    session.nativeSessionKey = 'agent:main:justdo:task-1';
    request.mockResolvedValueOnce({ ok: true, deleted: true });
    await discardPreparedWorktreeSession(store as unknown as CoworkStore, session.id, request);
    expect(request).toHaveBeenCalledWith('sessions.delete', {
      key: session.nativeSessionKey, deleteTranscript: true,
    });
    expect(store.deleteSession).toHaveBeenCalledWith(session.id);
  });

  test('retains the local inspection entry when cancellation cleanup preserves the native worktree', async () => {
    const { store, session, request } = setup();
    session.nativeSessionKey = 'agent:main:justdo:task-1';
    request.mockResolvedValueOnce({ ok: true, worktreePreserved: { id: 'tree-1' } });
    await expect(discardPreparedWorktreeSession(store as unknown as CoworkStore, session.id, request))
      .rejects.toThrow(t('worktreeCancellationRetained'));
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.updateSession).toHaveBeenCalledWith(session.id, { status: 'error' });
  });
});
