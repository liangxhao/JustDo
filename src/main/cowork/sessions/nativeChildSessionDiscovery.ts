import path from 'path';

import type { SessionDirectoryEntry } from '../../../shared/cowork/sessionDirectory';
import type { CoworkStore } from '../../data/coworkStore';
import { createPersistedGatewaySessionReader } from '../../engine/openclaw/subagentGateway';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import {
  isVisibleNativeChildSession,
  readNativeSessionPermissionMode,
  readNativeSessionWorkspace,
} from '../../openclaw/sessions/visibleChildSession';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  isParentDeleting?: (sessionId: string) => boolean;
}

function nativeKey(
  session: Pick<SessionDirectoryEntry, 'id' | 'agentId' | 'nativeSessionKey' | 'external'>,
): string {
  return (
    session.nativeSessionKey ||
    session.external?.sessionKey ||
    buildManagedSessionKey(session.id, session.agentId)
  );
}

/** Coalesce discovery of child execution bindings without publishing them to the sidebar. */
export const createNativeChildSessionDiscovery = ({
  getCoworkStore,
  requestGateway,
  isParentDeleting,
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
      try {
        const store = getCoworkStore();
        const nativeSessions = await readNativeSessions();
        const parents = new Map(
          (store.listSessionDirectory?.() ?? store.listSessions()).map(session => [
            nativeKey(session),
            session.id,
          ]),
        );
        for (const native of nativeSessions) {
          const key = native.key;
          const parentKey = native.parentSessionKey;
          if (
            typeof key !== 'string' ||
            typeof parentKey !== 'string' ||
            typeof native.sessionId !== 'string' ||
            !native.sessionId.trim()
          )
            continue;
          const parentId = parents.get(parentKey);
          if (!parentId || isParentDeleting?.(parentId) || store.getSessionByNativeKey(key)) continue;
          const parent = store.getSession(parentId);
          if (!parent || !isVisibleNativeChildSession(native, parent.agentId)) continue;
          const described = await requestGateway<{ session?: Record<string, unknown> | null }>(
            'sessions.describe',
            { key },
          );
          const entry = described.session;
          const currentParent = store.getSession(parentId);
          if (
            !entry ||
            entry.key !== key ||
            entry.sessionId !== native.sessionId ||
            entry.lifecycleRevision !== native.lifecycleRevision ||
            entry.parentSessionKey !== parentKey ||
            !currentParent ||
            isParentDeleting?.(parentId) ||
            nativeKey(currentParent) !== parentKey ||
            !isVisibleNativeChildSession(entry, currentParent.agentId)
          )
            continue;
          if (entry.worktree !== undefined) {
            const worktree = entry.worktree as { id?: unknown } | null;
            if (!worktree || typeof worktree.id !== 'string' || !worktree.id.trim()) continue;
          }
          const permissionMode = readNativeSessionPermissionMode(entry.permissionMode);
          if (!permissionMode) continue;
          const cwd = readNativeSessionWorkspace(entry);
          if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
          const title =
            typeof entry.label === 'string' && entry.label.trim()
              ? entry.label.trim()
              : typeof entry.displayName === 'string' && entry.displayName.trim()
                ? entry.displayName.trim()
                : key;
          const child = store.adoptNativeSession(
            key,
            currentParent,
            title,
            cwd,
            permissionMode,
          );
          parents.set(key, child.id);
        }
      } catch (error) {
        console.warn('[CoworkSessions] Failed to discover visible native child sessions', error);
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
