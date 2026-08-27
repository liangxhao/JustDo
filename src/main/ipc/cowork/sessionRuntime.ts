import { ipcMain } from 'electron';

import {
  buildLocalSessionDetailStats,
  CoworkSessionDetailsIpc,
  type CoworkSessionDetailsResult,
} from '../../../shared/cowork/sessionDetails';
import {
  GoalExecutionIpc,
  normalizeSessionGoal,
  type SessionGoal,
} from '../../../shared/sessionGoal';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../openclaw/sessions/openclawChannelSessionSync';
import {
  buildGatewaySessionDetailStats,
  type GatewaySessionUsageLoader,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getGatewaySessionUsage?: GatewaySessionUsageLoader;
}

const SESSION_LOOKUP_CACHE_TTL_MS = 750;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const readSessionGoal = (value: unknown): SessionGoal | undefined =>
  normalizeSessionGoal(value);

export const readUsage = (session: Record<string, unknown>) => {
  const budget =
    session.contextBudgetStatus && typeof session.contextBudgetStatus === 'object'
      ? (session.contextBudgetStatus as Record<string, unknown>)
      : undefined;
  const reportedTotalTokens = nonNegativeNumber(session.totalTokens);
  const estimatedPromptTokens = nonNegativeNumber(budget?.estimatedPromptTokens);
  const reportedTotalTokensFresh =
    typeof session.totalTokensFresh === 'boolean' ? session.totalTokensFresh : true;
  const hasActiveRun =
    typeof session.hasActiveRun === 'boolean'
      ? session.hasActiveRun
      : session.status === 'running' || session.runState === 'active'
        ? true
        : undefined;
  // Match OpenClaw webchat once a usable context snapshot exists. A newly
  // created active session can expose totalTokens: 0 with fresh: true while
  // the live pre-prompt estimate is already available. Treat that zero as a
  // bootstrap placeholder only when JustDo's provenance-guarded marker and
  // the Gateway's explicit active-run projection both agree. Positive and
  // idle Gateway snapshots always win.
  const useBootstrapEstimate =
    session.hasActiveRun === true &&
    (reportedTotalTokens === undefined || reportedTotalTokens === 0) &&
    budget?.justdoUsageBootstrap === true &&
    estimatedPromptTokens !== undefined &&
    estimatedPromptTokens > 0;
  const totalTokens = useBootstrapEstimate ? estimatedPromptTokens : (reportedTotalTokens ?? 0);
  const usageUpdatedAt = nonNegativeNumber(
    useBootstrapEstimate ? budget?.updatedAt : session.updatedAt,
  );
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
    totalTokensFresh: useBootstrapEstimate ? false : reportedTotalTokensFresh,
    usageSource: useBootstrapEstimate ? ('estimate' as const) : ('reported' as const),
    ...(usageUpdatedAt !== undefined ? { usageUpdatedAt } : {}),
    ...(hasActiveRun !== undefined ? { hasActiveRun } : {}),
    compactionCount,
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
    ...(model ? { modelRef: provider ? `${provider}/${model}` : model } : {}),
  };
};

export const readAvailableUsage = (session: Record<string, unknown>) => {
  const usage = readUsage(session);
  const hasReportedSnapshot = nonNegativeNumber(session.totalTokens) !== undefined;
  return hasReportedSnapshot || usage.usageSource === 'estimate' ? usage : undefined;
};

export const readGatewaySessionId = (session: Record<string, unknown>): string | undefined => {
  return nonEmptyString(session.sessionId);
};

type GatewaySession = { key: string } & Record<string, unknown>;
type GatewaySessionResult = { session?: GatewaySession; error?: string };

type SessionDetailsDependencies = Dependencies & {
  lookupGatewaySession?: (sessionId: string) => Promise<GatewaySessionResult>;
};

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

const addModel = (models: Set<string>, value: unknown): void => {
  const model = nonEmptyString(value);
  if (model) models.add(model);
};

const readGatewayModelRef = (session: GatewaySession | undefined): string | undefined => {
  if (!session) return undefined;
  const provider = nonEmptyString(session.modelProvider);
  const model = nonEmptyString(session.model);
  return model ? (provider ? `${provider}/${model}` : model) : undefined;
};

export const loadCoworkSessionDetails = async (
  dependencies: SessionDetailsDependencies,
  sessionId: string,
): Promise<CoworkSessionDetailsResult<CoworkSession>> => {
  const store = dependencies.getCoworkStore();
  const session = store.getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found' };

  const localStats = buildLocalSessionDetailStats(session);
  const lookupGatewaySession =
    dependencies.lookupGatewaySession ?? ((id: string) => queryGatewaySession(dependencies, id));
  const [gatewayResult, modelResult] = await Promise.all([
    lookupGatewaySession(sessionId).catch((error): GatewaySessionResult => ({
      error: error instanceof Error ? error.message : 'Failed to resolve Gateway session',
    })),
    dependencies
      .getCoworkEngineRouter()
      .getSessionModel(sessionId, session.agentId)
      .catch((): null => null),
  ]);

  let stats = localStats;
  const gatewaySessionId = readGatewaySessionId(gatewayResult.session);
  if (gatewayResult.session) {
    try {
      const usageLoader =
        dependencies.getGatewaySessionUsage ??
        (async (sessionKey: string) => {
          const client = dependencies.getRuntime()?.getGatewayClient();
          if (!client) throw new Error('Gateway client not connected');
          return requestGatewaySessionUsage(client, sessionKey);
        });
      const gatewayStats = buildGatewaySessionDetailStats(
        await usageLoader(gatewayResult.session.key),
        localStats.summary,
        localStats,
      );
      if (gatewayStats) stats = gatewayStats;
    } catch {
      // Preserve the complete SQLite fallback if raw transcript usage is unavailable.
    }
  }

  if (stats.models.length === 0) {
    const models = new Set<string>();
    for (const model of localStats.models) addModel(models, model);
    for (const run of store.getSessionRuns(sessionId)) addModel(models, run.modelRef);
    addModel(models, readGatewayModelRef(gatewayResult.session));
    addModel(models, modelResult && 'modelRef' in modelResult ? modelResult.modelRef : undefined);
    addModel(models, session.modelRef);
    if (models.size === 0) addModel(models, store.getAgent(session.agentId)?.model);
    stats = { ...stats, models: [...models] };
  }

  return {
    success: true,
    session,
    stats,
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
  };
};

export const registerCoworkSessionRuntimeHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getRuntime,
  getGatewaySessionUsage,
}: Dependencies): void => {
  const sessionDependencies = { getCoworkStore, getRuntime };
  const findGatewaySession = createSingleFlightTtlLookup(
    sessionId => queryGatewaySession(sessionDependencies, sessionId),
    SESSION_LOOKUP_CACHE_TTL_MS,
  );

  ipcMain.handle(CoworkSessionDetailsIpc.Get, async (_event, sessionId: string) => {
    try {
      return await loadCoworkSessionDetails(
        {
          getCoworkStore,
          getCoworkEngineRouter,
          getRuntime,
          getGatewaySessionUsage,
          lookupGatewaySession: findGatewaySession,
        },
        sessionId,
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session details',
      };
    }
  });

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
      const usage = readAvailableUsage(result.session);
      if (!usage) {
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
