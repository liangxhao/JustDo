import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';

import {
  type BeginSessionRunInput,
  SessionRunBeginErrorCode,
  SessionRunIpc,
  type SessionRunState,
  type SessionRuntimeSnapshot,
  type SessionRunTiming,
  type SessionRunUnknownInput,
} from '../../../shared/cowork/sessionRun';
import { CoworkSessionSearchIpc } from '../../../shared/cowork/sessionSearch';
import { isPermissionMode, type PermissionMode } from '../../../shared/openclaw/approvals';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import type { PermissionModeOperationResult } from '../../openclaw/permissions/sessionPermissionModeCoordinator';
import { searchCoworkSessionMessages } from '../../openclaw/sessions/openclawSessionSearch';

interface SessionHandlerDependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  setSessionPermissionMode: (
    sessionId: string,
    permissionMode: PermissionMode,
    options?: { deferIfActive?: boolean },
  ) => Promise<PermissionModeOperationResult>;
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
}

const isRestartCheckpoint = (timing: SessionRunTiming | undefined): boolean =>
  timing?.state === 'aborted' &&
  timing.startedAt === timing.acceptedAt &&
  timing.startedAt === timing.endedAt;

export const registerCoworkSessionHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  setSessionPermissionMode,
  requestGateway,
}: SessionHandlerDependencies): void => {
  const unknownAdmissions = new Map<string, { id: string; runId: string; cancelled: boolean }>();
  const stoppingSessions = new Map<string, Promise<{ success: boolean; error?: string }>>();
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
  const reconcileRuntimeStatus = async (
    sessionId: string,
    raw: {
      known: boolean;
      mainRunning: boolean;
      subagentRunning: boolean;
      running: boolean;
      rootRunId?: string;
    },
  ): Promise<SessionRuntimeSnapshot> => {
    const store = getCoworkStore();
    let timing = store.getLatestSessionRun(sessionId);

    if (stoppingSessions.has(sessionId) && !raw.running) {
      return {
        ...raw,
        known: false,
        running: true,
        revision: nextRevision(sessionId),
        ...(timing ? { timing } : {}),
      };
    }

    const unknownAdmission = unknownAdmissions.get(sessionId);
    if (unknownAdmission && timing?.id === unknownAdmission.id && timing.state === 'running') {
      // No-active-run is not a negative admission receipt. A request already
      // received by Gateway may still be inside asynchronous pre-admission.
      // Keep both its identity and any user cancellation intent until the
      // runtime supplies an actual terminal result for that exact request.
      try {
        if (requestGateway) {
          const result = await requestGateway<{
            runId?: string;
            status?: string;
            endedAt?: number;
            stopReason?: string;
            yielded?: boolean;
          }>('agent.wait', { runId: unknownAdmission.runId, timeoutMs: 0 });
          const matchesRun = !result.runId || result.runId === unknownAdmission.runId;
          if (matchesRun && result.status === 'ok' && result.yielded === true) {
            // Yield proves admission, but not completion of the user task. The
            // runtime transfers responsibility to descendants or a later root.
            // Bind this receipt and resume aggregate reconciliation instead of
            // waiting forever for the old run's cached yielded snapshot to change.
            const refreshed = await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
            const latest = store.getLatestSessionRun(sessionId);
            if (
              unknownAdmissions.get(sessionId) === unknownAdmission &&
              latest?.id === unknownAdmission.id &&
              latest.state === 'running' &&
              !stoppingSessions.has(sessionId) &&
              (!unknownAdmission.cancelled || (refreshed.known && !refreshed.running))
            ) {
              store.bindSessionRunRootRun(latest.id, unknownAdmission.runId);
              unknownAdmissions.delete(sessionId);
              if (unknownAdmission.cancelled) terminalOutcomes.set(sessionId, 'aborted');
              return reconcileRuntimeStatus(sessionId, refreshed);
            }
          }
          const terminal =
            !result.yielded &&
            (result.status === 'ok' ||
              result.status === 'error' ||
              (result.status === 'timeout' && typeof result.endedAt === 'number'));
          if (matchesRun && terminal) {
            const refreshed = await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
            const latest = store.getLatestSessionRun(sessionId);
            if (
              unknownAdmissions.get(sessionId) === unknownAdmission &&
              latest?.id === unknownAdmission.id &&
              latest.state === 'running' &&
              !stoppingSessions.has(sessionId) &&
              refreshed.known &&
              !refreshed.running
            ) {
              const state =
                unknownAdmission.cancelled ||
                result.stopReason === 'rpc' ||
                result.stopReason === 'aborted'
                  ? 'aborted'
                  : result.status === 'ok'
                    ? 'completed'
                    : 'failed';
              timing = store.finishSessionRun(latest.id, state, result.endedAt ?? Date.now());
              unknownAdmissions.delete(sessionId);
              terminalOutcomes.delete(sessionId);
              idleConfirmations.delete(sessionId);
              if (timing) finalizedOutcomes.set(sessionId, { id: timing.id, state });
              return {
                ...refreshed,
                running: false,
                revision: nextRevision(sessionId),
                ...(timing ? { timing } : {}),
              };
            }
          }
        }
      } catch {
        // Retain unknown and cancellation intent while the authority is unavailable.
      }
      const latest = store.getLatestSessionRun(sessionId);
      return {
        ...raw,
        known: false,
        running: latest?.state === 'running',
        revision: nextRevision(sessionId),
        ...(latest ? { timing: latest } : {}),
      };
    }

    if (timing?.state === 'running' && timing.acceptedAt === undefined && !raw.running) {
      if (terminalOutcomes.get(sessionId) === 'aborted') {
        // An acknowledged user stop also terminates submissions cancelled before
        // Gateway admission; they will never acquire acceptedAt.
        timing = store.finishSessionRun(timing.id, 'aborted', Date.now());
        terminalOutcomes.delete(sessionId);
        idleConfirmations.delete(sessionId);
        if (timing) finalizedOutcomes.set(sessionId, { id: timing.id, state: 'aborted' });
      } else if (requestGateway) {
        const pendingTimingId = timing.id;
        const pendingRootRunId = timing.rootRunId;
        try {
          const result = await requestGateway<{
            runId?: string;
            status?: string;
            endedAt?: number;
            stopReason?: string;
            yielded?: boolean;
          }>('agent.wait', { runId: timing.rootRunId ?? timing.clientTurnId, timeoutMs: 0 });
          const latest = store.getLatestSessionRun(sessionId);
          if (latest?.id !== pendingTimingId || latest.state !== 'running') {
            return {
              ...raw,
              known: false,
              running: latest?.state === 'running',
              revision: nextRevision(sessionId),
              ...(latest ? { timing: latest } : {}),
            };
          }
          if (
            stoppingSessions.has(sessionId) ||
            terminalOutcomes.has(sessionId) ||
            latest.acceptedAt !== undefined ||
            latest.rootRunId !== pendingRootRunId
          ) {
            return {
              ...raw,
              known: false,
              running: true,
              revision: nextRevision(sessionId),
              timing: latest,
            };
          }
          timing = latest;
          const matchesRun =
            !result.runId || result.runId === (timing.rootRunId ?? timing.clientTurnId);
          if (matchesRun && result.status === 'ok' && result.yielded === true) {
            // Main-started turns can lose their ACK without going through the
            // renderer unknown IPC. Yield still proves their admission.
            const refreshed = await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
            const current = store.getLatestSessionRun(sessionId);
            if (
              current?.id === pendingTimingId &&
              current.state === 'running' &&
              current.acceptedAt === undefined &&
              current.rootRunId === pendingRootRunId &&
              !stoppingSessions.has(sessionId) &&
              !terminalOutcomes.has(sessionId) &&
              !unknownAdmissions.has(sessionId)
            ) {
              store.bindSessionRunRootRun(current.id, current.rootRunId ?? current.clientTurnId);
            }
            return reconcileRuntimeStatus(sessionId, refreshed);
          }
          const terminal =
            !result.yielded &&
            (result.status === 'ok' ||
              result.status === 'error' ||
              (result.status === 'timeout' && typeof result.endedAt === 'number'));
          if (matchesRun && terminal && raw.known) {
            // agent.wait is asynchronous: children or a stop may have started
            // since the original snapshot. Never settle against that stale idle.
            const refreshed = await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, {
              includeSubagents: true,
              forceRefresh: true,
              fullScan: true,
            });
            const current = store.getLatestSessionRun(sessionId);
            if (
              !refreshed.known ||
              refreshed.running ||
              stoppingSessions.has(sessionId) ||
              terminalOutcomes.has(sessionId) ||
              current?.id !== pendingTimingId ||
              current.state !== 'running' ||
              current.acceptedAt !== undefined ||
              current.rootRunId !== pendingRootRunId
            ) {
              return {
                ...refreshed,
                known: false,
                running: current?.state === 'running',
                revision: nextRevision(sessionId),
                ...(current ? { timing: current } : {}),
              };
            }
            raw = refreshed;
            const state =
              result.stopReason === 'aborted' || result.stopReason === 'rpc'
                ? 'aborted'
                : result.status === 'ok'
                  ? 'completed'
                  : 'failed';
            timing = store.finishSessionRun(timing.id, state, result.endedAt ?? Date.now());
            idleConfirmations.delete(sessionId);
            if (timing) finalizedOutcomes.set(sessionId, { id: timing.id, state });
          } else {
            return {
              ...raw,
              known: false,
              running: true,
              revision: nextRevision(sessionId),
              timing,
            };
          }
        } catch {
          return { ...raw, known: false, running: true, revision: nextRevision(sessionId), timing };
        }
      }
    }

    if (raw.running) {
      idleConfirmations.delete(sessionId);
      if (!timing || timing.endedAt !== undefined) {
        const sameRootRun =
          Boolean(timing && raw.rootRunId) &&
          (timing.rootRunId === raw.rootRunId || timing.clientTurnId === raw.rootRunId);
        if (timing && (sameRootRun || (!raw.rootRunId && isRestartCheckpoint(timing)))) {
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
      // Unknown is absence of evidence, not evidence that the previous known-idle
      // observation became invalid. A later active snapshot or a new run clears
      // the confirmation; preserving it lets paginated discovery converge.
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

  ipcMain.handle('cowork:session:stop', (_event, sessionId: string) => {
    const unknown = unknownAdmissions.get(sessionId);
    if (unknown) unknown.cancelled = true;
    const existing = stoppingSessions.get(sessionId);
    if (existing) return existing;
    const pending = Promise.resolve().then(async () => {
      try {
        await getCoworkEngineRouter().stopSession(sessionId);
        if (unknownAdmissions.has(sessionId)) {
          return {
            success: false,
            error: 'The Gateway has not confirmed the cancelled message outcome yet.',
          };
        }
        terminalOutcomes.set(sessionId, 'aborted');
        return { success: true };
      } catch (error) {
        terminalOutcomes.delete(sessionId);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to stop session',
        };
      } finally {
        stoppingSessions.delete(sessionId);
      }
    });
    stoppingSessions.set(sessionId, pending);
    return pending;
  });

  ipcMain.handle('cowork:session:run:begin', async (_event, input: BeginSessionRunInput) => {
    try {
      if (stoppingSessions.has(input.sessionId) || unknownAdmissions.has(input.sessionId)) {
        return {
          success: false,
          errorCode: SessionRunBeginErrorCode.RuntimeActive,
          error: 'The session is still stopping.',
        };
      }
      const store = getCoworkStore();
      if (isRestartCheckpoint(store.getLatestSessionRun(input.sessionId))) {
        const raw = await getCoworkEngineRouter().getSessionRuntimeStatus(input.sessionId, {
          includeSubagents: true,
          forceRefresh: true,
          fullScan: true,
        });
        if (!raw.known) {
          return {
            success: false,
            errorCode: SessionRunBeginErrorCode.RuntimeUnknown,
          };
        }
        const snapshot = await reconcileRuntimeStatus(input.sessionId, raw);
        if (snapshot.running) {
          return {
            success: false,
            errorCode: SessionRunBeginErrorCode.RuntimeActive,
            snapshot,
          };
        }
      }
      if (stoppingSessions.has(input.sessionId)) {
        return { success: false, errorCode: SessionRunBeginErrorCode.RuntimeActive };
      }
      idleConfirmations.delete(input.sessionId);
      terminalOutcomes.delete(input.sessionId);
      finalizedOutcomes.delete(input.sessionId);
      const timing = store.beginSessionRun(input);
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

  ipcMain.handle(SessionRunIpc.Unknown, (_event, input: SessionRunUnknownInput) => {
    try {
      if (
        !input ||
        typeof input.sessionId !== 'string' ||
        typeof input.id !== 'string' ||
        (input.cancelled !== undefined && typeof input.cancelled !== 'boolean')
      ) {
        return { success: false, error: 'Invalid unknown session run input.' };
      }
      const store = getCoworkStore();
      let timing = store.getLatestSessionRun(input.sessionId);
      if (!timing || timing.id !== input.id) {
        return { success: false, error: 'The session run is no longer current.' };
      }
      const cancelled =
        input.cancelled === true ||
        stoppingSessions.has(input.sessionId) ||
        terminalOutcomes.get(input.sessionId) === 'aborted' ||
        timing.state === 'aborted' ||
        unknownAdmissions.get(input.sessionId)?.cancelled === true;
      if (timing.state !== 'running') {
        // The transport error may reach the renderer after an optimistic Stop
        // snapshot. Restore the receipt before allowing another submission.
        timing = store.reopenSessionRun(timing.id);
        if (!timing) return { success: false, error: 'Failed to restore the unknown session run.' };
      }
      const runId = timing.rootRunId ?? timing.clientTurnId;
      unknownAdmissions.set(input.sessionId, { id: timing.id, runId, cancelled });
      idleConfirmations.delete(input.sessionId);
      finalizedOutcomes.delete(input.sessionId);
      getCoworkEngineRouter().registerUnknownSessionRun(input.sessionId, runId, { cancelled });
      return {
        success: true,
        snapshot: {
          revision: nextRevision(input.sessionId),
          known: false,
          running: true,
          mainRunning: false,
          subagentRunning: false,
          timing,
        } satisfies SessionRuntimeSnapshot,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record unknown session run.',
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
          fullScan: true,
        });
        if (!raw.known || raw.running || unknownAdmissions.has(input.sessionId)) {
          return {
            success: true,
            snapshot: await reconcileRuntimeStatus(input.sessionId, raw),
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
      unknownAdmissions.delete(sessionId);
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
        unknownAdmissions.delete(sessionId);
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
    async (
      _event,
      options: { sessionId: string; permissionMode: unknown; deferIfActive?: unknown },
    ) => {
      try {
        if (!options?.sessionId || !isPermissionMode(options.permissionMode)) {
          return { success: false, error: 'Invalid session permission mode.' };
        }
        const result = await setSessionPermissionMode(options.sessionId, options.permissionMode, {
          deferIfActive: options.deferIfActive === true,
        });
        if ('error' in result) {
          return {
            success: false,
            error: result.error,
          };
        }
        return { success: true, ...(result.deferred ? { deferred: true } : {}) };
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

  ipcMain.handle(CoworkSessionSearchIpc.SearchMessages, async (_event, rawQuery: unknown) => {
    try {
      if (typeof rawQuery !== 'string') {
        return { success: false, error: 'Search query must be a string.' };
      }
      if (!requestGateway) {
        return { success: false, error: 'OpenClaw Gateway search is unavailable.' };
      }
      const result = await searchCoworkSessionMessages({
        query: rawQuery,
        store: getCoworkStore(),
        requestGateway,
      });
      return { success: true, ...result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search session messages',
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
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => {
      try {
        return {
          success: true,
          ...(await reconcileRuntimeStatus(
            sessionId,
            await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, options),
          )),
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
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => {
      try {
        return {
          success: true,
          statuses: Object.fromEntries(
            await Promise.all(
              Object.entries(
                await getCoworkEngineRouter().getSessionRuntimeStatuses(sessionIds, options),
              ).map(async ([sessionId, status]) => [
                sessionId,
                await reconcileRuntimeStatus(sessionId, status),
              ]),
            ),
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
