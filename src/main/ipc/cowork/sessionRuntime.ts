import { ipcMain } from 'electron';

import { isSessionGoalStatus, type SessionGoal } from '../../../shared/sessionGoal';
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

export const readSessionGoal = (value: unknown): SessionGoal | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const objective = typeof source.objective === 'string' ? source.objective.trim() : '';
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  if (source.schemaVersion !== 1 || !isSessionGoalStatus(source.status) || !objective || !id) {
    return undefined;
  }

  const numeric = (key: string, fallback = 0) => nonNegativeNumber(source[key]) ?? fallback;
  const optionalNumeric = (key: string) => {
    const result = nonNegativeNumber(source[key]);
    return result === undefined ? {} : { [key]: result };
  };
  const tokenBudget = nonNegativeNumber(source.tokenBudget);
  const lastStatusNote =
    typeof source.lastStatusNote === 'string' && source.lastStatusNote.trim()
      ? source.lastStatusNote.trim()
      : undefined;

  return {
    schemaVersion: 1,
    id,
    objective,
    status: source.status,
    createdAt: numeric('createdAt'),
    updatedAt: numeric('updatedAt'),
    tokenStart: numeric('tokenStart'),
    ...(typeof source.tokenStartFresh === 'boolean'
      ? { tokenStartFresh: source.tokenStartFresh }
      : {}),
    tokensUsed: numeric('tokensUsed'),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    continuationTurns: numeric('continuationTurns'),
    ...(lastStatusNote ? { lastStatusNote } : {}),
    ...optionalNumeric('pausedAt'),
    ...optionalNumeric('blockedAt'),
    ...optionalNumeric('completedAt'),
    ...optionalNumeric('usageLimitedAt'),
    ...optionalNumeric('budgetLimitedAt'),
  };
};

export const readUsage = (session: Record<string, unknown>) => {
  const budget =
    session.contextBudgetStatus && typeof session.contextBudgetStatus === 'object'
      ? (session.contextBudgetStatus as Record<string, unknown>)
      : undefined;
  const reportedTotalTokens =
    nonNegativeNumber(session.totalTokens) ??
    nonNegativeNumber(session.usedTokens) ??
    nonNegativeNumber(session.contextUsedTokens) ??
    nonNegativeNumber(session.currentTokens);
  const estimatedPromptTokens = nonNegativeNumber(budget?.estimatedPromptTokens);
  const reportedTotalTokensFresh =
    typeof session.totalTokensFresh === 'boolean' ? session.totalTokensFresh : true;
  const hasActiveRun =
    session.hasActiveRun === true || session.status === 'running' || session.runState === 'active';
  return {
    totalTokens:
      (hasActiveRun || !reportedTotalTokensFresh ? estimatedPromptTokens : reportedTotalTokens) ??
      reportedTotalTokens ??
      estimatedPromptTokens ??
      0,
    contextTokens:
      nonNegativeNumber(session.contextTokens) ??
      nonNegativeNumber(session.contextWindow) ??
      nonNegativeNumber(session.contextLength) ??
      nonNegativeNumber(session.maxContextTokens) ??
      nonNegativeNumber(session.totalContextTokens) ??
      nonNegativeNumber(budget?.contextTokenBudget) ??
      0,
    totalTokensFresh: reportedTotalTokensFresh || estimatedPromptTokens !== undefined,
  };
};

type GatewaySession = { key: string } & Record<string, unknown>;
type GatewaySessionResult = { session?: GatewaySession; error?: string };

const queryGatewaySession = async (
  dependencies: Pick<Dependencies, 'getCoworkStore' | 'getRuntime'>,
  sessionId: string,
): Promise<GatewaySessionResult> => {
  const runtime = dependencies.getRuntime();
  if (!runtime) return { error: 'OpenClaw runtime adapter not available' };
  const client = runtime.getGatewayClient();
  if (!client) return { error: 'Gateway client not connected' };
  const agentId =
    dependencies.getCoworkStore().getSession(sessionId)?.agentId || DEFAULT_MANAGED_AGENT_ID;
  const keys = new Set([
    ...runtime.getSessionKeysForSession(sessionId),
    buildManagedSessionKey(sessionId, agentId),
    buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
  ]);
  const result = await client.request<{ sessions?: GatewaySession[] }>('sessions.list', {
    agentId,
    limit: 100,
  });
  let session = result.sessions?.find(item => keys.has(item.key));
  if (!session && agentId !== DEFAULT_MANAGED_AGENT_ID) {
    const fallback = await client.request<{ sessions?: GatewaySession[] }>('sessions.list', {
      limit: 100,
    });
    session = fallback.sessions?.find(item => keys.has(item.key));
  }
  return session ? { session } : { error: 'Session not found in gateway' };
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

  ipcMain.handle('cowork:session:goal', async (_event, sessionId: string) => {
    try {
      const result = await findGatewaySession(sessionId);
      if (!result.session) return { success: false, error: result.error };
      return { success: true, goal: readSessionGoal(result.session.goal) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session goal',
      };
    }
  });

  ipcMain.handle('cowork:session:contextUsage', async (_event, sessionId: string) => {
    try {
      const result = await findGatewaySession(sessionId);
      if (!result.session) return { success: false, error: result.error };
      const usage = readUsage(result.session);
      if (usage.totalTokens <= 0 || usage.contextTokens <= 0) {
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
        return { success: result.ok, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to patch session model',
        };
      }
    },
  );
};
