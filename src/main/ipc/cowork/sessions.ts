import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';

import type {
  BeginSessionRunInput,
  SessionRunState,
  SessionRuntimeSnapshot,
} from '../../../shared/cowork/sessionRun';
import { isPermissionMode, type PermissionMode } from '../../../shared/openclaw/approvals';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import type { PermissionModeOperationResult } from '../../openclaw/permissions/sessionPermissionModeCoordinator';

interface SessionHandlerDependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  setSessionPermissionMode: (
    sessionId: string,
    permissionMode: PermissionMode,
  ) => Promise<PermissionModeOperationResult>;
}

export const registerCoworkSessionHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  setSessionPermissionMode,
}: SessionHandlerDependencies): void => {
  const idleConfirmations = new Map<string, { count: number; observedAt: number }>();
  const revisions = new Map<string, number>();
  const terminalOutcomes = new Map<string, Exclude<SessionRunState, 'running' | 'completed'>>();
  const finalizedOutcomes = new Map<
    string,
    { id: string; state: Exclude<SessionRunState, 'running'> }
  >();
  const nextRevision = (sessionId: string): number => {
    const revision = Math.max(Date.now(), (revisions.get(sessionId) ?? 0) + 1);
    revisions.set(sessionId, revision);
    return revision;
  };
  const reconcileRuntimeStatus = (
    sessionId: string,
    raw: {
      known: boolean;
      mainRunning: boolean;
      subagentRunning: boolean;
      running: boolean;
      rootRunId?: string;
    },
  ): SessionRuntimeSnapshot => {
    const store = getCoworkStore();
    let timing = store.getLatestSessionRun(sessionId);

    if (raw.running) {
      idleConfirmations.delete(sessionId);
      if (!timing || timing.endedAt !== undefined) {
        const sameRootRun =
          Boolean(timing && raw.rootRunId) &&
          (timing.rootRunId === raw.rootRunId || timing.clientTurnId === raw.rootRunId);
        if (timing && sameRootRun) {
          const finalized = finalizedOutcomes.get(sessionId);
          if (finalized?.id === timing.id && finalized.state !== 'completed') {
            terminalOutcomes.set(sessionId, finalized.state);
          }
          timing = store.reopenSessionRun(timing.id);
        } else {
          const startedAt = Date.now();
          timing = store.beginSessionRun({
            sessionId,
            clientTurnId: `runtime-recovery-${randomUUID()}`,
            startedAt,
          });
          if (raw.rootRunId) timing = store.bindSessionRunRootRun(timing.id, raw.rootRunId);
        }
      } else if (
        timing?.state === 'running' &&
        raw.rootRunId &&
        timing.rootRunId !== raw.rootRunId
      ) {
        if (!timing.rootRunId || timing.rootRunId === timing.clientTurnId) {
          timing = store.bindSessionRunRootRun(timing.id, raw.rootRunId);
        } else {
          const now = Date.now();
          const state =
            terminalOutcomes.get(sessionId) ??
            (store.getSession(sessionId)?.status === 'error' ? 'failed' : 'completed');
          const finished = store.finishSessionRun(timing.id, state, now);
          if (finished) finalizedOutcomes.set(sessionId, { id: finished.id, state });
          terminalOutcomes.delete(sessionId);
          timing = store.beginSessionRun({
            sessionId,
            clientTurnId: `runtime-recovery-${randomUUID()}`,
            startedAt: now,
          });
          timing = store.bindSessionRunRootRun(timing.id, raw.rootRunId);
        }
      }
      if (timing?.state === 'running' && timing.acceptedAt === undefined) {
        timing = store.bindSessionRunRootRun(
          timing.id,
          raw.rootRunId ?? timing.rootRunId ?? timing.clientTurnId,
        );
      }
      return {
        ...raw,
        running: true,
        revision: nextRevision(sessionId),
        ...(timing ? { timing } : {}),
      };
    }

    if (!raw.known) {
      idleConfirmations.delete(sessionId);
      return {
        ...raw,
        running: timing?.state === 'running',
        revision: nextRevision(sessionId),
        ...(timing ? { timing } : {}),
      };
    }

    if (timing?.state === 'running' && timing.acceptedAt === undefined) {
      idleConfirmations.delete(sessionId);
      return { ...raw, running: true, revision: nextRevision(sessionId), timing };
    }

    if (timing?.state === 'running') {
      const now = Date.now();
      const previous = idleConfirmations.get(sessionId);
      const confirmation =
        previous && now - previous.observedAt >= 750
          ? { count: previous.count + 1, observedAt: now }
          : (previous ?? { count: 1, observedAt: now });
      idleConfirmations.set(sessionId, confirmation);
      if (confirmation.count < 2) {
        return { ...raw, running: true, revision: nextRevision(sessionId), timing };
      }
      idleConfirmations.delete(sessionId);
      const sessionState = store.getSession(sessionId)?.status;
      const state =
        terminalOutcomes.get(sessionId) ?? (sessionState === 'error' ? 'failed' : 'completed');
      terminalOutcomes.delete(sessionId);
      timing = store.finishSessionRun(timing.id, state, now);
      if (timing) finalizedOutcomes.set(sessionId, { id: timing.id, state });
    }

    return {
      ...raw,
      running: false,
      revision: nextRevision(sessionId),
      ...(timing ? { timing } : {}),
    };
  };

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    terminalOutcomes.set(sessionId, 'aborted');
    try {
      await getCoworkEngineRouter().stopSession(sessionId);
      return { success: true };
    } catch (error) {
      terminalOutcomes.delete(sessionId);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:run:begin', (_event, input: BeginSessionRunInput) => {
    try {
      idleConfirmations.delete(input.sessionId);
      terminalOutcomes.delete(input.sessionId);
      finalizedOutcomes.delete(input.sessionId);
      const timing = getCoworkStore().beginSessionRun(input);
      return {
        success: true,
        timing,
        snapshot: {
          revision: nextRevision(input.sessionId),
          known: true,
          mainRunning: true,
          subagentRunning: false,
          running: true,
          timing,
        } satisfies SessionRuntimeSnapshot,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to begin session run',
      };
    }
  });

  ipcMain.handle('cowork:session:run:bind', (_event, input: { id: string; rootRunId: string }) => {
    try {
      return {
        success: true,
        timing: getCoworkStore().bindSessionRunRootRun(input.id, input.rootRunId),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to bind session run',
      };
    }
  });

  ipcMain.handle('cowork:session:run:list', (_event, sessionId: string) => {
    try {
      return { success: true, timings: getCoworkStore().getSessionRuns(sessionId) };
    } catch (error) {
      return {
        success: false,
        timings: [],
        error: error instanceof Error ? error.message : 'Failed to list session runs',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:run:fail',
    async (_event, input: { sessionId: string; id: string; endedAt: number }) => {
      try {
        const raw = await getCoworkEngineRouter().getSessionRuntimeStatus(input.sessionId, {
          includeSubagents: true,
          forceRefresh: true,
        });
        if (!raw.known || raw.running) {
          return {
            success: true,
            snapshot: reconcileRuntimeStatus(input.sessionId, raw),
          };
        }
        idleConfirmations.delete(input.sessionId);
        terminalOutcomes.delete(input.sessionId);
        const timing = getCoworkStore().finishSessionRun(input.id, 'failed', input.endedAt);
        if (timing) finalizedOutcomes.set(input.sessionId, { id: timing.id, state: 'failed' });
        return {
          success: true,
          snapshot: {
            revision: nextRevision(input.sessionId),
            known: true,
            mainRunning: false,
            subagentRunning: false,
            running: false,
            ...(timing ? { timing } : {}),
          } satisfies SessionRuntimeSnapshot,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fail session run',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      await getCoworkEngineRouter().stopSession(sessionId, { bestEffort: true });
      const store = getCoworkStore();
      idleConfirmations.delete(sessionId);
      terminalOutcomes.delete(sessionId);
      finalizedOutcomes.delete(sessionId);
      revisions.delete(sessionId);
      const agentId = store.getSession(sessionId)?.agentId || 'main';
      store.deleteSession(sessionId);
      try {
        getCoworkEngineRouter().onSessionDeleted(sessionId, agentId);
      } catch {
        // The persisted deletion succeeded; cache cleanup is best effort.
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:message:delete', async (_event, sessionId: string, messageId: string) => {
    try {
      return { success: getCoworkStore().deleteMessage(sessionId, messageId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete message',
      };
    }
  });

  ipcMain.handle(
    'cowork:message:deleteFrom',
    async (_event, sessionId: string, messageId: string) => {
      try {
        return { success: getCoworkStore().deleteMessagesFrom(sessionId, messageId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete messages',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      const router = getCoworkEngineRouter();
      const store = getCoworkStore();
      const agentIds = new Map(
        sessionIds.map(sessionId => [sessionId, store.getSession(sessionId)?.agentId || 'main']),
      );
      await Promise.all(
        sessionIds.map(sessionId => router.stopSession(sessionId, { bestEffort: true })),
      );
      store.deleteSessions(sessionIds);
      sessionIds.forEach(sessionId => {
        try {
          router.onSessionDeleted(sessionId, agentIds.get(sessionId) || 'main');
        } catch {
          // The persisted deletion succeeded; cache cleanup is best effort.
        }
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:pin',
    async (_event, options: { sessionId: string; pinned: boolean }) => {
      try {
        getCoworkStore().setSessionPinned(options.sessionId, options.pinned);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update session pin',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:rename',
    async (_event, options: { sessionId: string; title: string }) => {
      try {
        const title = options.title.trim();
        if (!title) return { success: false, error: 'Title is required' };
        getCoworkStore().updateSession(options.sessionId, { title });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename session',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:setPermissionMode',
    async (_event, options: { sessionId: string; permissionMode: unknown }) => {
      try {
        if (!options?.sessionId || !isPermissionMode(options.permissionMode)) {
          return { success: false, error: 'Invalid session permission mode.' };
        }
        const result = await setSessionPermissionMode(options.sessionId, options.permissionMode);
        if ('error' in result) {
          return {
            success: false,
            error: result.error,
            ...(result.status ? { engineStatus: result.status } : {}),
          };
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update session permission.',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      return { success: true, session: getCoworkStore().getSession(sessionId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async (_event, agentId?: string) => {
    try {
      return { success: true, sessions: getCoworkStore().listSessions(agentId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:remoteManaged', async (_event, sessionId: string) => {
    try {
      const agentId = getCoworkStore().getSession(sessionId)?.agentId;
      return { success: true, remoteManaged: !!agentId && agentId !== 'main' };
    } catch (error) {
      return {
        success: false,
        remoteManaged: false,
        error: error instanceof Error ? error.message : 'Failed to check remote managed status',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:runtimeStatus',
    async (
      _event,
      sessionId: string,
      options?: { includeSubagents?: boolean; forceRefresh?: boolean },
    ) => {
      try {
        return {
          success: true,
          ...reconcileRuntimeStatus(
            sessionId,
            await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, options),
          ),
        };
      } catch (error) {
        return {
          success: false,
          known: false,
          mainRunning: false,
          subagentRunning: false,
          running: false,
          error: error instanceof Error ? error.message : 'Failed to get session runtime status',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:sessions:runtimeStatus',
    async (
      _event,
      sessionIds: string[],
      options?: { includeSubagents?: boolean; forceRefresh?: boolean },
    ) => {
      try {
        return {
          success: true,
          statuses: Object.fromEntries(
            Object.entries(
              await getCoworkEngineRouter().getSessionRuntimeStatuses(sessionIds, options),
            ).map(([sessionId, status]) => [sessionId, reconcileRuntimeStatus(sessionId, status)]),
          ),
        };
      } catch (error) {
        return {
          success: false,
          statuses: {},
          error: error instanceof Error ? error.message : 'Failed to get session runtime statuses',
        };
      }
    },
  );
};
