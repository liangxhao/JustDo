import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import path from 'path';

import {
  type CopyCoworkSessionInput,
  CoworkSessionCopyIpc,
} from '../../../shared/cowork/sessionCopy';
import {
  CoworkSessionForkIpc,
  type ForkCoworkSessionInput,
} from '../../../shared/cowork/sessionFork';
import { normalizeSessionGoal } from '../../../shared/cowork/sessionGoal';
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
import {
  isPermissionMode,
  type PermissionMode,
  toOpenClawSessionPermissionMode,
} from '../../../shared/openclaw/approvals';
import { OpenClawExtensionId, parsePlanModeState } from '../../../shared/openclaw/extensions';
import { t } from '../../core/i18n';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import { isWorkspacePathWithin } from '../../engine/openclaw/runtimeAdapterSupport';
import { listPersistedGatewaySessions } from '../../engine/openclaw/subagentGateway';
import type { PermissionModeOperationResult } from '../../openclaw/permissions/sessionPermissionModeCoordinator';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../openclaw/sessions/openclawSessionKeys';
import {
  parseCoworkSessionSearchOptions,
  searchCoworkSessionMessages,
} from '../../openclaw/sessions/openclawSessionSearch';
import type { CollaborationCoordinator } from './collaboration';

interface SessionHandlerDependencies {
  getCollaboration?: () => CollaborationCoordinator;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  setSessionPermissionMode: (
    sessionId: string,
    permissionMode: PermissionMode,
    options?: { deferIfActive?: boolean },
  ) => Promise<PermissionModeOperationResult>;
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
}

type GatewayRequest = NonNullable<SessionHandlerDependencies['requestGateway']>;

const clearInheritedSessionGoal = async (
  requestGateway: GatewayRequest,
  options: { sessionKey: string; gatewaySessionId: string; agentId: string },
): Promise<void> => {
  const described = await requestGateway<{
    session?: { sessionId?: unknown; goal?: unknown } | null;
  }>('sessions.describe', { key: options.sessionKey });
  if (!described.session) {
    throw new Error('OpenClaw did not return the copied session for Goal verification.');
  }
  if (described.session.goal === undefined || described.session.goal === null) return;
  const goal = normalizeSessionGoal(described.session.goal);
  if (!goal) throw new Error('OpenClaw returned invalid Goal metadata on the copied session.');
  const gatewaySessionId =
    typeof described.session.sessionId === 'string' && described.session.sessionId.trim()
      ? described.session.sessionId.trim()
      : options.gatewaySessionId;
  const operationId = randomUUID();
  const cleared = await requestGateway<{
    operationId?: unknown;
    action?: unknown;
    sessionId?: unknown;
    goalId?: unknown;
    status?: unknown;
  }>('sessions.goal.clear', {
    sessionKey: options.sessionKey,
    agentId: options.agentId,
    sessionId: gatewaySessionId,
    goalId: goal.id,
    operationId,
    issuedAtMs: Date.now(),
  });
  if (
    cleared.operationId !== operationId ||
    cleared.action !== 'clear' ||
    cleared.sessionId !== gatewaySessionId ||
    cleared.goalId !== goal.id ||
    cleared.status !== 'cleared'
  ) {
    throw new Error('OpenClaw did not confirm that the copied Goal was cleared.');
  }
  const verified = await requestGateway<{ session?: { goal?: unknown } | null }>(
    'sessions.describe',
    { key: options.sessionKey },
  );
  if (
    !verified.session ||
    (verified.session.goal !== undefined && verified.session.goal !== null)
  ) {
    throw new Error('OpenClaw did not clear Goal metadata from the copied session.');
  }
};

const isRestartCheckpoint = (timing: SessionRunTiming | undefined): boolean =>
  timing?.state === 'aborted' &&
  timing.startedAt === timing.acceptedAt &&
  timing.startedAt === timing.endedAt;

export const registerCoworkSessionHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  setSessionPermissionMode,
  requestGateway,
  getCollaboration,
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
        await getCoworkEngineRouter().stopSession(sessionId, { diagnosticUserInitiated: true });
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
    if (getCollaboration?.().read(input.sessionId).room?.deleting)
      return { success: false, error: 'collaborationDeletePending' };
    try {
      if (stoppingSessions.has(input.sessionId) || unknownAdmissions.has(input.sessionId)) {
        return {
          success: false,
          errorCode: SessionRunBeginErrorCode.RuntimeActive,
          error: 'The session is still stopping.',
        };
      }
      const store = getCoworkStore();
      const owner = store.getSession(input.sessionId)?.agentId;
      if (owner && !store.getAgent(owner)?.enabled)
        return { success: false, error: 'agentUnavailable' };
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
      if (getCoworkStore().hasNativeChildSessions(sessionId)) {
        throw new Error('Delete independent child sessions before deleting this session.');
      }
      if (await getCollaboration?.().deleteTask(sessionId)) return { success: true };
      await getCoworkEngineRouter().stopSession(sessionId, { bestEffort: true });
      const store = getCoworkStore();
      idleConfirmations.delete(sessionId);
      terminalOutcomes.delete(sessionId);
      finalizedOutcomes.delete(sessionId);
      revisions.delete(sessionId);
      const persistedSession = store.getSession(sessionId);
      const agentId = persistedSession?.agentId || 'main';
      if (persistedSession?.nativeSessionKey) {
        if (
          store.listSessions().some(summary => {
            if (summary.id === sessionId) return false;
            const other = store.getSession(summary.id);
            return other && isWorkspacePathWithin(other.cwd, persistedSession.cwd);
          })
        ) {
          throw new Error(t('worktreeSharedWorkspaceDeleteBlocked'));
        }
        if (!requestGateway) throw new Error('Gateway is unavailable for native session deletion.');
        let worktreePreserved = false;
        try {
          const deleted = await requestGateway<{ worktreePreserved?: unknown }>('sessions.delete', {
            key: persistedSession.nativeSessionKey,
            deleteTranscript: true,
          });
          worktreePreserved = !!deleted.worktreePreserved;
        } catch (error) {
          const described = await requestGateway<{ session?: unknown }>('sessions.describe', {
            key: persistedSession.nativeSessionKey,
          });
          if (described.session) throw error;
        }
        if (worktreePreserved) {
          throw new Error(
            'The session was removed but its worktree was preserved. Inspect it in Settings → Worktrees.',
          );
        }
      }
      unknownAdmissions.delete(sessionId);
      const planWorkspaceRoots = store
        .listPlanHandoffs(sessionId)
        .map(handoff => handoff.artifact.workspaceRoot)
        .filter((root): root is string => typeof root === 'string');
      if (persistedSession?.cwd) planWorkspaceRoots.push(persistedSession.cwd);
      store.deleteSession(sessionId);
      try {
        getCoworkEngineRouter().onSessionDeleted(
          sessionId,
          agentId,
          persistedSession?.nativeSessionKey ? [persistedSession.nativeSessionKey] : [],
          planWorkspaceRoots,
        );
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

  ipcMain.handle(CoworkSessionCopyIpc.Copy, async (_event, input: CopyCoworkSessionInput) => {
    const sourceSessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!sourceSessionId || !title) {
      return { success: false, error: 'A source session and title are required.' };
    }

    const store = getCoworkStore();
    const router = getCoworkEngineRouter();
    const source = store.getSession(sourceSessionId);
    if (!source) return { success: false, error: 'Source session not found.' };
    if (source.nativeSessionKey) return { success: false, error: t('worktreeCopyUnavailable') };
    if (getCollaboration?.().read(sourceSessionId).room)
      return { success: false, error: 'collaborationCopyUnavailable' };
    if (!requestGateway) {
      return { success: false, error: 'OpenClaw Gateway session copy is unavailable.' };
    }

    let copiedSession: ReturnType<CoworkStore['createSession']> | null = null;
    let copiedSessionKey = '';
    try {
      const runtime = await router.getSessionRuntimeStatus(sourceSessionId, {
        includeSubagents: true,
        forceRefresh: true,
        fullScan: true,
      });
      if (!runtime.known) {
        return {
          success: false,
          error: 'The current session activity could not be verified. Try again in a moment.',
        };
      }
      if (runtime.running) {
        return { success: false, error: 'Wait for the current session to finish before copying.' };
      }

      const parentSessionKey =
        source.nativeSessionKey ||
        buildManagedSessionKey(sourceSessionId, source.agentId || DEFAULT_MANAGED_AGENT_ID);
      if (getCollaboration?.().read(sourceSessionId).room)
        throw new Error('collaborationCopyUnavailable');
      const described = await requestGateway<{ session?: { pluginExtensions?: unknown } }>(
        'sessions.describe',
        { key: parentSessionKey },
      );
      const pluginExtensions = Array.isArray(described.session?.pluginExtensions)
        ? described.session.pluginExtensions
        : [];
      const planExtension = pluginExtensions.find(candidate => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const extension = candidate as Record<string, unknown>;
        return (
          extension.pluginId === OpenClawExtensionId.PLAN_MODE && extension.namespace === 'state'
        );
      }) as Record<string, unknown> | undefined;
      const copyPlanMode = parsePlanModeState(planExtension?.value).enabled;
      copiedSession = store.createSession(
        title,
        source.cwd,
        source.executionMode,
        source.activeSkillIds,
        source.agentId,
        source.permissionMode,
        source.modelRef,
      );
      copiedSessionKey = buildManagedSessionKey(
        copiedSession.id,
        copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
      );
      const created = await requestGateway<{
        key?: unknown;
        sessionId?: unknown;
        entry?: { sessionId?: unknown };
      }>('sessions.create', {
        key: copiedSessionKey,
        parentSessionKey,
        fork: true,
        cwd: source.cwd,
        permissionMode: toOpenClawSessionPermissionMode(source.permissionMode),
      });
      const gatewaySessionId =
        typeof created.sessionId === 'string'
          ? created.sessionId.trim()
          : typeof created.entry?.sessionId === 'string'
            ? created.entry.sessionId.trim()
            : '';
      const returnedKey = typeof created.key === 'string' ? created.key.trim() : copiedSessionKey;
      if (!gatewaySessionId || returnedKey !== copiedSessionKey) {
        throw new Error('OpenClaw did not create the requested copied session.');
      }
      if (copyPlanMode) {
        const patched = await requestGateway<{ ok?: unknown }>('sessions.pluginPatch', {
          key: copiedSessionKey,
          agentId: copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
          pluginId: OpenClawExtensionId.PLAN_MODE,
          namespace: 'state',
          value: { enabled: true, updatedAt: Date.now() },
        });
        if (patched.ok !== true) {
          throw new Error('OpenClaw did not preserve Plan mode on the copied session.');
        }
      }

      // Adopting the explicit key verifies the copied workspace and permission
      // boundary and records the runtime key in the adapter cache.
      const prepared = await router.prepareSession(copiedSession.id);
      await clearInheritedSessionGoal(requestGateway, {
        sessionKey: copiedSessionKey,
        gatewaySessionId: prepared.gatewaySessionId || gatewaySessionId,
        agentId: copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
      });
      if (getCollaboration?.().read(sourceSessionId).room)
        throw new Error('collaborationCopyUnavailable');
      store.copyTerminalSessionRuns(source.id, copiedSession.id);
      return { success: true, session: copiedSession, planModeEnabled: copyPlanMode };
    } catch (error) {
      if (copiedSession) {
        try {
          store.deleteSession(copiedSession.id);
        } catch {
          // Preserve the original copy failure; local cleanup is best effort.
        }
        try {
          router.onSessionDeleted(
            copiedSession.id,
            copiedSession.agentId,
            copiedSessionKey ? [copiedSessionKey] : [],
            [copiedSession.cwd],
          );
        } catch {
          // Preserve the original copy failure; runtime cleanup is best effort.
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to copy session.',
      };
    }
  });

  ipcMain.handle(CoworkSessionForkIpc.Fork, async (_event, input: ForkCoworkSessionInput) => {
    const sourceSessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const entryId = typeof input?.entryId === 'string' ? input.entryId.trim() : '';
    if (!sourceSessionId || !title || !entryId) {
      return {
        success: false,
        error: 'A source session, title, and entry are required.',
      };
    }

    const store = getCoworkStore();
    const router = getCoworkEngineRouter();
    const source = store.getSession(sourceSessionId);
    if (!source) return { success: false, error: 'Source session not found.' };
    if (source.nativeSessionKey) return { success: false, error: t('worktreeCopyUnavailable') };
    if (!requestGateway) {
      return { success: false, error: 'OpenClaw Gateway session fork is unavailable.' };
    }
    if (getCollaboration?.().read(sourceSessionId).room)
      return { success: false, error: 'collaborationCopyUnavailable' };

    const sourceSessionKey =
      source.nativeSessionKey ||
      buildManagedSessionKey(sourceSessionId, source.agentId || DEFAULT_MANAGED_AGENT_ID);

    let forkedSession: ReturnType<CoworkStore['createSession']> | null = null;
    let forkedSessionKey = '';
    try {
      const runtime = await router.getSessionRuntimeStatus(sourceSessionId, {
        includeSubagents: true,
        forceRefresh: true,
        fullScan: true,
      });
      if (!runtime.known) {
        return {
          success: false,
          error: 'The current session activity could not be verified. Try again in a moment.',
        };
      }
      if (runtime.running) {
        return { success: false, error: 'Wait for the current session to finish before forking.' };
      }

      forkedSession = store.createSession(
        title,
        source.cwd,
        source.executionMode,
        source.activeSkillIds,
        source.agentId,
        source.permissionMode,
        source.modelRef,
        { sessionId: source.id, title: source.title, entryId },
      );
      forkedSessionKey = buildManagedSessionKey(
        forkedSession.id,
        forkedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
      );
      const forked = await requestGateway<{ sessionKey?: unknown }>('sessions.fork', {
        sessionKey: sourceSessionKey,
        agentId: source.agentId || DEFAULT_MANAGED_AGENT_ID,
        entryId,
        targetKey: forkedSessionKey,
        includeEntry: true,
      });
      const returnedKey = typeof forked.sessionKey === 'string' ? forked.sessionKey.trim() : '';
      if (returnedKey !== forkedSessionKey) {
        throw new Error('OpenClaw did not create the requested forked session.');
      }

      const prepared = await router.prepareSession(forkedSession.id);
      await clearInheritedSessionGoal(requestGateway, {
        sessionKey: forkedSessionKey,
        gatewaySessionId: prepared.gatewaySessionId,
        agentId: forkedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
      });
      if (getCollaboration?.().read(sourceSessionId).room)
        throw new Error('collaborationCopyUnavailable');
      store.copyTerminalSessionRuns(source.id, forkedSession.id);
      return { success: true, session: forkedSession };
    } catch (error) {
      if (forkedSession) {
        try {
          store.deleteSession(forkedSession.id);
        } catch {
          // Preserve the original fork failure; local cleanup is best effort.
        }
        try {
          router.onSessionDeleted(
            forkedSession.id,
            forkedSession.agentId,
            forkedSessionKey ? [forkedSessionKey] : [],
            [forkedSession.cwd],
          );
        } catch {
          // Preserve the original fork failure; runtime cleanup is best effort.
        }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fork session.',
      };
    }
  });

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    const deletedSessionIds: string[] = [];
    const errors: string[] = [];
    try {
      if (sessionIds.some(id => getCoworkStore().getSession?.(id)?.nativeSessionKey)) {
        return {
          success: false,
          deletedSessionIds,
          error: 'Delete native worktree sessions individually so Gateway cleanup can be verified.',
        };
      }
      if (sessionIds.some(id => getCoworkStore().hasNativeChildSessions?.(id))) {
        return {
          success: false,
          deletedSessionIds,
          error: 'Delete independent child sessions before deleting their parent.',
        };
      }
      const standalone: string[] = [];
      const processed = new Set<string>();
      for (const id of sessionIds) {
        const room = getCollaboration?.().read(id).room;
        if (room) {
          if (!processed.has(room.id)) {
            processed.add(room.id);
            try {
              await getCollaboration!().deleteTask(id);
              deletedSessionIds.push(...room.members.map(member => member.sessionId));
            } catch (error) {
              errors.push(error instanceof Error ? error.message : 'collaborationDeletePending');
            }
          }
        } else standalone.push(id);
      }
      sessionIds = standalone;
      if (!sessionIds.length)
        return {
          success: errors.length === 0,
          deletedSessionIds,
          ...(errors.length ? { error: errors[0] } : {}),
        };
      const router = getCoworkEngineRouter();
      const store = getCoworkStore();
      const agentIds = new Map(
        sessionIds.map(sessionId => [sessionId, store.getSession(sessionId)?.agentId || 'main']),
      );
      const planWorkspaceRoots = new Map(
        sessionIds.map(sessionId => [
          sessionId,
          [
            ...store
              .listPlanHandoffs(sessionId)
              .map(handoff => handoff.artifact.workspaceRoot)
              .filter((root): root is string => typeof root === 'string'),
            ...(store.getSession(sessionId)?.cwd ? [store.getSession(sessionId)!.cwd] : []),
          ],
        ]),
      );
      await Promise.all(
        sessionIds.map(sessionId => router.stopSession(sessionId, { bestEffort: true })),
      );
      store.deleteSessions(sessionIds);
      deletedSessionIds.push(...sessionIds);
      sessionIds.forEach(sessionId => {
        unknownAdmissions.delete(sessionId);
        try {
          router.onSessionDeleted(
            sessionId,
            agentIds.get(sessionId) || 'main',
            [],
            planWorkspaceRoots.get(sessionId),
          );
        } catch {
          // The persisted deletion succeeded; cache cleanup is best effort.
        }
      });
      return {
        success: errors.length === 0,
        deletedSessionIds,
        ...(errors.length ? { error: errors[0] } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
        deletedSessionIds,
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
      if (requestGateway) {
        const store = getCoworkStore();
        try {
          const nativeSessions = await listPersistedGatewaySessions({ request: requestGateway });
          const parents = new Map(
            store
              .listSessions()
              .map(session => [
                store.getSession(session.id)?.nativeSessionKey ||
                  buildManagedSessionKey(session.id, session.agentId),
                session.id,
              ]),
          );
          for (const native of nativeSessions) {
            if (typeof native.key !== 'string') continue;
            if (!native.worktree || typeof native.worktree !== 'object') continue;
            const parentKey =
              typeof native.parentSessionKey === 'string'
                ? native.parentSessionKey
                : native.spawnedBy;
            if (typeof parentKey !== 'string') continue;
            const parentId = parents.get(parentKey);
            if (!parentId || store.getSessionByNativeKey(native.key)) continue;
            const parent = store.getSession(parentId);
            if (!parent) continue;
            if (!native.key.startsWith(`agent:${parent.agentId}:`)) continue;
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
            // Do not broaden a native mode that the product cannot represent.
            if (!permissionMode) continue;
            const cwd = entry?.sessionRoot ?? entry?.spawnedCwd ?? entry?.spawnedWorkspaceDir;
            if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
            const title =
              typeof entry?.label === 'string' && entry.label.trim()
                ? entry.label.trim()
                : typeof entry?.displayName === 'string' && entry.displayName.trim()
                  ? entry.displayName.trim()
                  : native.key;
            const child = store.adoptNativeSession(native.key, parent, title, cwd, permissionMode);
            parents.set(native.key, child.id);
          }
        } catch (error) {
          console.warn('[CoworkSessions] Failed to discover native worktree sessions', error);
        }
      }
      return { success: true, sessions: getCoworkStore().listSessions(agentId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  ipcMain.handle(
    CoworkSessionSearchIpc.SearchMessages,
    async (_event, rawQuery: unknown, rawOptions: unknown) => {
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
          options: parseCoworkSessionSearchOptions(rawOptions),
        });
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to search session messages',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:remoteManaged', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      return { success: true, remoteManaged: !!session?.external };
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
