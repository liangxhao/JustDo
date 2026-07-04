import { ipcMain } from 'electron';

import type { CoworkStore } from '../../coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../libs/agentEngine';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
} from '../../libs/openclaw/sessions/openclawChannelSessionSync';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readUsage = (session: Record<string, unknown>) => {
  const budget =
    session.contextBudgetStatus && typeof session.contextBudgetStatus === 'object'
      ? (session.contextBudgetStatus as Record<string, unknown>)
      : undefined;
  return {
    totalTokens:
      numberValue(session.totalTokens) ??
      numberValue(session.usedTokens) ??
      numberValue(session.contextUsedTokens) ??
      numberValue(session.currentTokens) ??
      numberValue(budget?.estimatedPromptTokens) ??
      0,
    contextTokens:
      numberValue(session.contextTokens) ??
      numberValue(session.contextWindow) ??
      numberValue(session.contextLength) ??
      numberValue(session.maxContextTokens) ??
      numberValue(session.totalContextTokens) ??
      numberValue(budget?.contextTokenBudget) ??
      0,
    totalTokensFresh:
      typeof session.totalTokensFresh === 'boolean'
        ? session.totalTokensFresh || numberValue(budget?.estimatedPromptTokens) !== undefined
        : true,
  };
};

export const registerCoworkSessionRuntimeHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getRuntime,
}: Dependencies): void => {
  ipcMain.handle('cowork:session:contextUsage', async (_event, sessionId: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: false, error: 'OpenClaw runtime adapter not available' };
      if (runtime.isSessionActive(sessionId)) {
        return { success: false, error: 'Context usage is unavailable while a session is running' };
      }
      const client = runtime.getGatewayClient();
      if (!client) return { success: false, error: 'Gateway client not connected' };
      const agentId = getCoworkStore().getSession(sessionId)?.agentId || DEFAULT_MANAGED_AGENT_ID;
      const keys = new Set([
        ...runtime.getSessionKeysForSession(sessionId),
        buildManagedSessionKey(sessionId, agentId),
        buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
      ]);
      const result = await client.request<{
        sessions?: Array<{ key: string } & Record<string, unknown>>;
      }>('sessions.list', { agentId, limit: 100 });
      let session = result.sessions?.find(item => keys.has(item.key));
      if (!session && agentId !== DEFAULT_MANAGED_AGENT_ID) {
        const fallback = await client.request<{
          sessions?: Array<{ key: string } & Record<string, unknown>>;
        }>('sessions.list', { limit: 100 });
        session = fallback.sessions?.find(item => keys.has(item.key));
      }
      if (!session) {
        console.warn('[CoworkContextUsage] session not found in gateway', {
          sessionId,
          effectiveAgentId: agentId,
          sessionKeys: Array.from(keys),
          returnedKeys: result.sessions?.map(item => item.key).slice(0, 10) ?? [],
        });
        return { success: false, error: 'Session not found in gateway' };
      }
      const usage = readUsage(session);
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
