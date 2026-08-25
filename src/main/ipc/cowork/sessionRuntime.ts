import { ipcMain } from 'electron';

import {
  GoalExecutionIpc,
  normalizeSessionGoal,
  type SessionGoal,
} from '../../../shared/sessionGoal';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../openclaw/sessions/openclawChannelSessionSync';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

const SESSION_LOOKUP_CACHE_TTL_MS = 750;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const readSessionGoal = (value: unknown): SessionGoal | undefined =>
  normalizeSessionGoal(value);

export const readUsage = (session: Record<string, unknown>) => {
  const reportedTotalTokens = nonNegativeNumber(session.totalTokens);
  const reportedTotalTokensFresh =
    typeof session.totalTokensFresh === 'boolean' ? session.totalTokensFresh : true;
  const hasActiveRun =
    session.hasActiveRun === true || session.status === 'running' || session.runState === 'active'
      ? true
      : session.hasActiveRun === false
        ? false
        : undefined;
  // Match OpenClaw webchat: totalTokens is the context snapshot, while
  // contextBudgetStatus.estimatedPromptTokens is a pre-dispatch planning
  // estimate. The estimate can describe an announce/internal run, include
  // content that is about to be compacted, and temporarily exceed the model
  // window, so it must never replace the user-facing context snapshot.
  const totalTokens = reportedTotalTokens ?? 0;
  const usageUpdatedAt = nonNegativeNumber(session.updatedAt);
  const provider = nonEmptyString(session.modelProvider);
  const model = nonEmptyString(session.model);
  const gatewaySessionId = [session.sessionId, session.id]
    .map(nonEmptyString)
    .find((value): value is string => value !== undefined);
  const compactionCount = Math.max(
    nonNegativeNumber(session.compactionCount) ?? 0,
    nonNegativeNumber(session.compactionCheckpointCount) ?? 0,
  );
  return {
    totalTokens,
    contextTokens:
      nonNegativeNumber(session.contextTokens) ??
      nonNegativeNumber(session.contextWindow) ??
      nonNegativeNumber(session.contextLength) ??
      nonNegativeNumber(session.maxContextTokens) ??
      nonNegativeNumber(session.totalContextTokens) ??
      0,
    totalTokensFresh: reportedTotalTokensFresh,
    usageSource: 'reported' as const,
    ...(usageUpdatedAt !== undefined ? { usageUpdatedAt } : {}),
    ...(hasActiveRun !== undefined ? { hasActiveRun } : {}),
    compactionCount,
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
    ...(model ? { modelRef: provider ? `${provider}/${model}` : model } : {}),
  };
};

export const readGatewaySessionId = (session: Record<string, unknown>): string | undefined => {
  for (const value of [session.sessionId, session.id]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

type GatewaySession = { key: string } & Record<string, unknown>;
type GatewaySessionResult = { session?: GatewaySession; error?: string };

const resolveGatewaySessionWithActiveRunState = async (
  client: NonNullable<ReturnType<OpenClawRuntimeAdapter['getGatewayClient']>>,
  session: GatewaySession,
  agentId: string,
): Promise<GatewaySession> => {
  try {
    // sessions.describe is the authoritative exact row lookup, but OpenClaw
    // currently projects its active-run registry only on sessions.list.
    const result = await client.request<{ sessions?: GatewaySession[] }>('sessions.list', {
      search: session.key,
      limit: 20,
      agentId,
    });
    const activeRow = result.sessions?.find(row => row.key === session.key);
    if (activeRow?.hasActiveRun === true) return { ...session, hasActiveRun: true };
    if (activeRow?.hasActiveRun !== false) return session;
    // Once the registry reports idle, re-read the exact row. Combining the
    // later false flag with the earlier describe row could manufacture an
    // impossible old-usage/idle snapshot when a run ends between the RPCs.
    const refreshed = await client.request<{ session?: GatewaySession | null }>(
      'sessions.describe',
      { key: session.key },
    );
    if (!refreshed.session) return session;
    return refreshed.session.hasActiveRun === true
      ? refreshed.session
      : { ...refreshed.session, hasActiveRun: false };
  } catch {
    return session;
  }
};

export const queryGatewaySession = async (
  dependencies: Pick<Dependencies, 'getCoworkStore' | 'getRuntime'>,
  sessionId: string,
): Promise<GatewaySessionResult> => {
  const runtime = dependencies.getRuntime();
  if (!runtime) return { error: 'OpenClaw runtime adapter not available' };
  const client = runtime.getGatewayClient();
  if (!client) return { error: 'Gateway client not connected' };
  const agentId =
    dependencies.getCoworkStore().getSession(sessionId)?.agentId || DEFAULT_MANAGED_AGENT_ID;
  const keys = [
    buildManagedSessionKey(sessionId, agentId),
    ...runtime.getSessionKeysForSession(sessionId),
    buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
  ];
  for (const key of new Set(keys)) {
    const result = await client.request<{ session?: GatewaySession | null }>('sessions.describe', {
      key,
    });
    if (result.session) {
      return {
        session: await resolveGatewaySessionWithActiveRunState(client, result.session, agentId),
      };
    }
  }
  return { error: 'Session not found in gateway' };
};

export const createSingleFlightTtlLookup = <T>(
  loader: (key: string) => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): ((key: string) => Promise<T>) => {
  const entries = new Map<string, { promise: Promise<T>; settled: boolean; expiresAt: number }>();

  return (key: string) => {
    const cached = entries.get(key);
    if (cached && (!cached.settled || cached.expiresAt > now())) {
      return cached.promise;
    }

    let entry: { promise: Promise<T>; settled: boolean; expiresAt: number };
    const promise = loader(key)
      .then(result => {
        entry.settled = true;
        entry.expiresAt = now() + ttlMs;
        return result;
      })
      .catch(error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    entry = { promise, settled: false, expiresAt: 0 };
    entries.set(key, entry);
    return promise;
  };
};

export const registerCoworkSessionRuntimeHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getRuntime,
}: Dependencies): void => {
  const sessionDependencies = { getCoworkStore, getRuntime };
  const findGatewaySession = createSingleFlightTtlLookup(
    sessionId => queryGatewaySession(sessionDependencies, sessionId),
    SESSION_LOOKUP_CACHE_TTL_MS,
  );

  ipcMain.handle('cowork:session:gatewaySessionId', async (_event, sessionId: string) => {
    try {
      const result = await findGatewaySession(sessionId);
      if (!result.session) return { success: false, error: result.error };
      const gatewaySessionId = readGatewaySessionId(result.session);
      return gatewaySessionId
        ? { success: true, sessionId: gatewaySessionId }
        : { success: false, error: 'Gateway session has no sessionId' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get Gateway session ID',
      };
    }
  });

  ipcMain.handle('cowork:session:goal', async (_event, sessionId: string) => {
    try {
      // Goal transitions are event-driven and must not be hidden by the usage lookup TTL.
      const result = await queryGatewaySession(sessionDependencies, sessionId);
      if (!result.session) return { success: false, error: result.error };
      return { success: true, goal: readSessionGoal(result.session.goal) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session goal',
      };
    }
  });

  ipcMain.handle(GoalExecutionIpc.Get, (_event, sessionId: string) => {
    const runtime = getRuntime();
    return runtime
      ? { success: true, execution: runtime.getGoalExecution(sessionId) ?? undefined }
      : { success: false, error: 'OpenClaw runtime adapter not available' };
  });

  ipcMain.handle(GoalExecutionIpc.Continue, async (_event, sessionId: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: false, error: 'OpenClaw runtime adapter not available' };
      const execution = await runtime.continueGoal(sessionId);
      return { success: true, execution };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session goal',
      };
    }
  });

  ipcMain.handle(GoalExecutionIpc.ResumeForUserInput, async (_event, sessionId: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: false, error: 'OpenClaw runtime adapter not available' };
      await runtime.resumeGoalForUserInput(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resume blocked goal',
      };
    }
  });

  ipcMain.handle(
    GoalExecutionIpc.RestartCompletedForFeedback,
    async (_event, options: { sessionId: string; goalId: string; objective?: string }) => {
      try {
        const runtime = getRuntime();
        if (!runtime) return { success: false, error: 'OpenClaw runtime adapter not available' };
        const result = await runtime.restartCompletedGoalForFeedback(
          options.sessionId,
          options.goalId,
          options.objective,
        );
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to restart completed goal',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:contextUsage', async (_event, sessionId: string) => {
    try {
      const result = await findGatewaySession(sessionId);
      if (!result.session) return { success: false, error: result.error };
      const usage = readUsage(result.session);
      if (usage.totalTokens <= 0) {
        return {
          success: false,
          error: 'Context usage is not available from OpenClaw session state',
        };
      }
      return { success: true, ...usage };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get context usage',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:patchModel',
    async (_event, options: { sessionId: string; model: string; agentId?: string }) => {
      try {
        const result = await getCoworkEngineRouter().patchSessionModel(
          options.sessionId,
          options.model,
          options.agentId,
        );
        if ('error' in result) {
          return {
            success: false,
            error: result.error,
            modelRef: result.modelRef,
            source: result.source,
          };
        }
        return {
          success: true,
          modelRef: result.modelRef,
          appliesTo: result.appliesTo,
          source: result.source,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to patch session model',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:model',
    async (_event, options: { sessionId: string; agentId?: string }) => {
      try {
        const result = await getCoworkEngineRouter().getSessionModel(
          options.sessionId,
          options.agentId,
        );
        if ('error' in result) return { success: false, error: result.error };
        return { success: true, modelRef: result.modelRef, source: result.source };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session model',
        };
      }
    },
  );
};
