import path from 'path';

import { normalizeSessionDisplayName } from '../../../../plugins/extensions/runtime-services/contracts/session-display-name';
import { toOpenClawSessionPermissionMode } from '../../../shared/security/approvals';
import { createProjectGitRunner } from '../../core/filesystem/projectGit';
import { t } from '../../core/i18n';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { buildManagedSessionKey } from './openclawSessionKeys';

/** A known repository rejection with the uncreated session reconciled. */
export class WorktreeRepositoryNoCommitsError extends Error {}

export async function readWorktreeSourceCommit(cwd: string): Promise<string | undefined> {
  const git = createProjectGitRunner(cwd);
  const output = await git?.(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    env: { GIT_NO_LAZY_FETCH: '1' },
  }).catch((): undefined => undefined);
  const commit = output?.trim();
  return commit && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) ? commit : undefined;
}

export async function createSessionWorktree(
  store: CoworkStore,
  session: CoworkSession,
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>,
  sourceCommit?: string,
): Promise<string> {
  const key = buildManagedSessionKey(session.id, session.agentId);
  // Bind before admission so uncertain creation outcomes retain a native identity
  // that can be inspected or deleted without allocating another checkout.
  store.bindNativeSession(session.id, key, null);
  try {
    const permissionMode = toOpenClawSessionPermissionMode(session.permissionMode);
    const displayName = normalizeSessionDisplayName(session.title);
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
      ...(displayName ? { displayName } : {}),
      worktree: true,
      ...(sourceCommit ? { worktreeBaseRef: sourceCommit } : {}),
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
    let confirmedAbsent = false;
    try {
      const described = await requestGateway<{
        session?: { sessionRoot?: unknown; spawnedCwd?: unknown; worktree?: unknown } | null;
      }>('sessions.describe', { key });
      if (described.session === null) {
        // A negative native read confirms that no checkout-owning session exists.
        store.deleteSession(session.id);
        confirmedAbsent = true;
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
    // The Gateway currently exposes this repository reason only in its error message.
    if (
      error instanceof Error &&
      'gatewayCode' in error && error.gatewayCode === 'INVALID_REQUEST' &&
      error.message.startsWith('git checkout has no commits:') &&
      error.message.endsWith('Create an initial commit, then retry.')
    ) {
      if (confirmedAbsent) {
        throw new WorktreeRepositoryNoCommitsError(t('worktreeRepositoryNoCommits'), { cause: error });
      }
      throw new Error(t('worktreeCreateUnconfirmed'), { cause: error });
    }
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
