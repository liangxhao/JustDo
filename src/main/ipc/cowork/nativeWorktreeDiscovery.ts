import path from 'path';

import type { PermissionMode } from '../../../shared/security/approvals';
import type { CoworkStore } from '../../data/coworkStore';
import { createPersistedGatewaySessionReader } from '../../engine/openclaw/subagentGateway';
import {
  buildManagedSessionKey,
  isCustodySessionKey,
} from '../../openclaw/sessions/openclawSessionKeys';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  onSessionsChanged?: () => void;
}

/** Coalesce a trailing fresh pass; navigation reads never have to wait for Gateway. */
export const createNativeWorktreeDiscovery = ({
  getCoworkStore,
  requestGateway,
  onSessionsChanged,
}: Dependencies): (() => Promise<void>) => {
  const readNativeSessions = requestGateway
    ? createPersistedGatewaySessionReader({ request: requestGateway })
    : null;
  let running: Promise<void> | null = null;
  let queued: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  const start = (): Promise<void> => {
    if (!requestGateway || !readNativeSessions) return Promise.resolve();
    running = (async () => {
      let adopted = false;
      try {
        const store = getCoworkStore();
        const nativeSessions = await readNativeSessions();
        const parents = new Map(
          (store.listSessionDirectory?.() ?? store.listSessions()).map(session => [
            session.nativeSessionKey ||
              session.external?.sessionKey ||
              buildManagedSessionKey(session.id, session.agentId),
            session.id,
          ]),
        );
        for (const native of nativeSessions) {
          if (typeof native.key !== 'string') continue;
          if (isCustodySessionKey(native.key)) continue;
          if (!native.worktree || typeof native.worktree !== 'object') continue;
          const parentKey =
            typeof native.parentSessionKey === 'string'
              ? native.parentSessionKey
              : native.spawnedBy;
          if (typeof parentKey !== 'string') continue;
          const parentId = parents.get(parentKey);
          if (!parentId || store.getSessionByNativeKey(native.key)) continue;
          const parent = store.getSession(parentId);
          if (!parent || !native.key.startsWith(`agent:${parent.agentId}:`)) continue;
          const described = await requestGateway<{ session?: Record<string, unknown> | null }>(
            'sessions.describe',
            { key: native.key },
          );
          const entry = described.session;
          if (!entry?.worktree || typeof entry.worktree !== 'object') continue;
          const permissionMode: PermissionMode | undefined =
            entry.permissionMode === 'full'
              ? 'full'
              : entry.permissionMode === 'workspace'
                ? 'auto'
                : entry.permissionMode === 'guarded' || entry.permissionMode === undefined
                  ? 'ask'
                  : undefined;
          if (!permissionMode) continue;
          const cwd = entry.sessionRoot ?? entry.spawnedCwd ?? entry.spawnedWorkspaceDir;
          if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
          const title =
            typeof entry.label === 'string' && entry.label.trim()
              ? entry.label.trim()
              : typeof entry.displayName === 'string' && entry.displayName.trim()
                ? entry.displayName.trim()
                : native.key;
          const child = store.adoptNativeSession(native.key, parent, title, cwd, permissionMode);
          parents.set(native.key, child.id);
          adopted = true;
        }
      } catch (error) {
        console.warn('[CoworkSessions] Failed to discover native worktree sessions', error);
      } finally {
        if (adopted) onSessionsChanged?.();
      }
    })().finally(() => {
      running = null;
      const next = queued;
      queued = null;
      if (next) void start().then(next.resolve, next.reject);
    });
    return running;
  };
  return () => {
    if (!running) return start();
    if (!queued) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      queued = { promise, resolve, reject };
    }
    return queued.promise;
  };
};
