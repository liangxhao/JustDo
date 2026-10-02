import path from 'path';

import { toOpenClawSessionPermissionMode } from '../../../shared/openclaw/approvals';
import { t } from '../../core/i18n';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { buildManagedSessionKey } from './openclawSessionKeys';

export async function createSessionWorktree(
  store: CoworkStore,
  session: CoworkSession,
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>,
): Promise<string> {
  const key = buildManagedSessionKey(session.id, session.agentId);
  // Bind before admission so uncertain creation outcomes retain a native identity
  // that can be inspected or deleted without allocating another checkout.
  store.bindNativeSession(session.id, key, null);
  try {
    const permissionMode = toOpenClawSessionPermissionMode(session.permissionMode);
    const created = await requestGateway<{
      key?: unknown;
      sessionId?: unknown;
      entry?: { sessionRoot?: unknown; permissionMode?: unknown; worktree?: { id?: unknown } };
      worktree?: { id?: unknown; path?: unknown };
    }>('sessions.create', {
      key,
      agentId: session.agentId,
      cwd: session.cwd,
      permissionMode,
      worktree: true,
    });
    const root = created.entry?.sessionRoot;
    if (
      created.key !== key ||
      typeof created.sessionId !== 'string' || !created.sessionId.trim() ||
      created.entry?.permissionMode !== permissionMode ||
      typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof created.worktree?.id !== 'string' || !created.worktree.id ||
      created.entry.worktree?.id !== created.worktree.id ||
      typeof created.worktree.path !== 'string' ||
      path.resolve(created.worktree.path) !== path.resolve(root)
    ) {
      throw new Error(t('worktreeCreateUnconfirmed'));
    }
    store.updateSession(session.id, { cwd: root });
    return root;
  } catch (error) {
    try {
      const described = await requestGateway<{
        session?: { sessionRoot?: unknown; spawnedCwd?: unknown; worktree?: unknown } | null;
      }>('sessions.describe', { key });
      if (described.session === null) {
        // A negative native read confirms that no checkout-owning session exists.
        store.deleteSession(session.id);
      } else {
        const nativeRoot = described.session?.sessionRoot ?? described.session?.spawnedCwd;
        if (described.session?.worktree && typeof nativeRoot === 'string' && path.isAbsolute(nativeRoot)) {
          store.updateSession(session.id, { cwd: nativeRoot });
        }
      }
    } catch {
      // A failed read cannot establish that creation failed; retain its identity.
    }
    if (store.getSession(session.id)) store.updateSession(session.id, { status: 'error' });
    throw error;
  }
}

export async function discardPreparedWorktreeSession(
  store: CoworkStore,
  sessionId: string,
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session?.nativeSessionKey) throw new Error(t('worktreeIdentityMissing'));
  try {
    const deleted = await requestGateway<{ ok?: unknown; worktreePreserved?: unknown }>(
      'sessions.delete', { key: session.nativeSessionKey, deleteTranscript: true },
    );
    if (deleted.ok !== true || deleted.worktreePreserved) {
      throw new Error(t('worktreeCancellationRetained'));
    }
    store.deleteSession(sessionId);
  } catch (error) {
    store.updateSession(sessionId, { status: 'error' });
    throw error;
  }
}
