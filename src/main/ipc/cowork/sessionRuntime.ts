import { ipcMain } from 'electron';

import {
  CoworkSessionDetailsIpc,
  type CoworkSessionDetailsResult,
} from '../../../shared/cowork/sessionDetails';
import {
  GoalExecutionIpc,
  normalizeSessionGoal,
  normalizeSessionGoalMutationRequest,
  type SessionGoal,
  SessionGoalIpc,
} from '../../../shared/sessionGoal';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';
import {
  buildGatewaySessionDetailStats,
  type GatewaySessionHistoryLoader,
  type GatewaySessionUsageLoader,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../openclaw/sessions/openclawSessionKeys';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getGatewaySessionUsage?: GatewaySessionUsageLoader;
  getGatewaySessionHistory?: GatewaySessionHistoryLoader;
}

const SESSION_LOOKUP_CACHE_TTL_MS = 750;
// Only one session details modal can be visible. Retaining one revision avoids
// repeated full-history reads without pinning transcripts from older sessions.
const SESSION_HISTORY_CACHE_MAX = 1;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readGatewayActivityTimestamp = (session: Record<string, unknown>): number | undefined =>
  nonNegativeNumber(session.lastActivityAt) ??
  nonNegativeNumber(session.lastInteractionAt) ??
  nonNegativeNumber(session.updatedAt);

export const createRevisionedSessionHistoryLoader = (
  loader: GatewaySessionHistoryLoader,
  maxEntries = SESSION_HISTORY_CACHE_MAX,
): GatewaySessionHistoryLoader => {
  const entries = new Map<string, { revision: number; promise: Promise<unknown[] | null> }>();
  return (sessionKey, fallbackSessionId, revision) => {
    if (revision === undefined) return loader(sessionKey, fallbackSessionId, revision);
    const cacheKey = `${sessionKey}\u0000${fallbackSessionId ?? ''}`;
    const cached = entries.get(cacheKey);
    if (cached?.revision === revision) return cached.promise;
    const promise = loader(sessionKey, fallbackSessionId, revision)
      .then(result => {
        if (result === null && entries.get(cacheKey)?.promise === promise) {
          entries.delete(cacheKey);
        }
        return result;
      })
      .catch(error => {
        if (entries.get(cacheKey)?.promise === promise) entries.delete(cacheKey);
        throw error;
      });
    entries.delete(cacheKey);
    entries.set(cacheKey, { revision, promise });
    while (entries.size > Math.max(1, maxEntries)) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
    return promise;
  };
};

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
    ...runtime.getSessionKeysForSession(sessionId),
    buildManagedSessionKey(sessionId, agentId),
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

export const loadCoworkSessionDetails = async (
  dependencies: SessionDetailsDependencies,
  sessionId: string,
): Promise<CoworkSessionDetailsResult<CoworkSession>> => {
  const store = dependencies.getCoworkStore();
  const session = store.getSession(sessionId);
  if (!session) return { success: false, error: 'Session not found' };

  const lookupGatewaySession =
    dependencies.lookupGatewaySession ?? ((id: string) => queryGatewaySession(dependencies, id));
  const gatewayResult = await lookupGatewaySession(sessionId).catch(
    (error): GatewaySessionResult => ({
      error: error instanceof Error ? error.message : 'Failed to resolve Gateway session',
    }),
  );

  if (!gatewayResult.session) {
    return {
      success: false,
      error: gatewayResult.error || 'Session statistics are not available from Gateway',
    };
  }

  const gatewaySessionId = readGatewaySessionId(gatewayResult.session);
  let stats;
  try {
    const usageLoader =
      dependencies.getGatewaySessionUsage ??
      (async (sessionKey: string, revision?: number) => {
        const client = dependencies.getRuntime()?.getGatewayClient();
        if (!client) throw new Error('Gateway client not connected');
        return requestGatewaySessionUsage(client, sessionKey, {
          cacheDiscriminator: revision,
        });
      });
    const historyLoader =
      dependencies.getGatewaySessionHistory ??
      (async (sessionKey: string, fallbackSessionId?: string) => {
        const history = await dependencies
          .getRuntime()
          ?.fetchSessionHistoryByKey(sessionKey, fallbackSessionId);
        return history?.messages ?? null;
      });
    // Session updatedAt advances at run boundaries, not for every transcript
    // append. Active sessions must bypass the revision cache so live message
    // and tool counts do not freeze until the run ends.
    const sessionRevision =
      nonNegativeNumber(gatewayResult.session.updatedAt) ??
      readGatewayActivityTimestamp(gatewayResult.session);
    const historyRevision =
      gatewayResult.session.hasActiveRun === true ? undefined : sessionRevision;
    const [usage, historyMessages] = await Promise.all([
      usageLoader(gatewayResult.session.key, historyRevision),
      historyLoader(gatewayResult.session.key, gatewaySessionId, historyRevision),
    ]);
    if (!historyMessages) throw new Error('Gateway session history is not available');
    stats = buildGatewaySessionDetailStats(usage, null, historyMessages);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Session statistics are not available from Gateway',
    };
  }
  if (!stats) {
    return { success: false, error: 'Session statistics are not available from Gateway' };
  }

  const lastActivity =
    readGatewayActivityTimestamp(gatewayResult.session) ?? stats.lastActivity ?? session.updatedAt;

  return {
    success: true,
    session: lastActivity !== session.updatedAt ? { ...session, updatedAt: lastActivity } : session,
    stats,
    ...(gatewaySessionId ? { gatewaySessionId } : {}),
  };
};

export const registerCoworkSessionRuntimeHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getRuntime,
  getGatewaySessionUsage,
  getGatewaySessionHistory,
}: Dependencies): void => {
  const sessionDependencies = { getCoworkStore, getRuntime };
  const sessionHistoryLoader = createRevisionedSessionHistoryLoader(
    getGatewaySessionHistory ??
      (async (sessionKey: string, fallbackSessionId?: string) => {
        const history = await getRuntime()?.fetchSessionHistoryByKey(
          sessionKey,
          fallbackSessionId,
        );
        return history?.messages ?? null;
      }),
  );
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
          getGatewaySessionHistory: sessionHistoryLoader,
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

  ipcMain.handle(SessionGoalIpc.Mutate, async (_event, sessionId: string, value: unknown) => {
    try {
      const request = normalizeSessionGoalMutationRequest(value);
      if (!request) return { success: false, error: 'Invalid session goal operation' };
      const runtime = getRuntime();
      if (!runtime) return { success: false, error: 'OpenClaw runtime adapter not available' };
      const outcome = await runtime.mutateSessionGoal(sessionId, request);
      return { success: true, ...outcome };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session goal',
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
