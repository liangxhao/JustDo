import { ipcMain } from 'electron';

import {
  type CoworkSubagentDescendantsResult,
  CoworkSubagentDetailsIpc,
  type CoworkSubagentDetailsResult,
} from '../../../shared/cowork/subagentDetails';
import type { OpenClawRuntimeAdapter } from '../../engine';
import { listGatewaySubagentDescendants } from '../../engine/openclaw/subagentGateway';
import {
  buildGatewaySessionDetailStats,
  type GatewaySessionUsageLoader,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getGatewaySessionUsage?: GatewaySessionUsageLoader;
}

export const loadCoworkSubagentDetails = async (
  loadSessionUsage: GatewaySessionUsageLoader | undefined,
  sessionKey: unknown,
): Promise<CoworkSubagentDetailsResult> => {
  const normalizedSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (!normalizedSessionKey) return { success: false, error: 'Session key is required' };
  if (!loadSessionUsage) {
    return { success: false, error: 'Gateway usage is not available' };
  }
  try {
    const stats = buildGatewaySessionDetailStats(
      await loadSessionUsage(normalizedSessionKey),
      null,
    );
    if (!stats) return { success: false, error: 'Subagent usage is not available' };
    return {
      success: true,
      stats,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get subagent details',
    };
  }
};

export const registerCoworkSubtaskHandlers = ({
  getRuntime,
  getGatewaySessionUsage,
}: Dependencies): void => {
  ipcMain.handle('cowork:subTask:status', async (_event, sessionId?: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: true, subagents: [] };
      const result = await runtime.getSubagentStatuses(sessionId);
      return { success: true, subagents: result.subagents || [] };
    } catch {
      return { success: false, subagents: [] };
    }
  });

  ipcMain.handle(
    CoworkSubagentDetailsIpc.Get,
    async (_event, sessionKey: unknown): Promise<CoworkSubagentDetailsResult> => {
      const loadSessionUsage =
        getGatewaySessionUsage ??
        (async (key: string) => {
          const client = getRuntime()?.getGatewayClient();
          if (!client) throw new Error('Gateway client not connected');
          return requestGatewaySessionUsage(client, key);
        });
      return loadCoworkSubagentDetails(loadSessionUsage, sessionKey);
    },
  );

  ipcMain.handle(
    CoworkSubagentDetailsIpc.ListDescendants,
    async (_event, sessionId: unknown): Promise<CoworkSubagentDescendantsResult> => {
      const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!normalizedSessionId) return { success: false, error: 'Session ID is required' };
      try {
        const runtime = getRuntime();
        const client = runtime?.getGatewayClient();
        if (!runtime || !client) {
          return { success: false, error: 'Gateway client not connected' };
        }
        return {
          success: true,
          subagents: await listGatewaySubagentDescendants(
            client,
            runtime.getSessionKeysForSession(normalizedSessionId),
          ),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list subagent descendants',
        };
      }
    },
  );
};
