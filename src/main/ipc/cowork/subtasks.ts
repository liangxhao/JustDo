import { ipcMain } from 'electron';

import {
  type CoworkSubagentDescendantsResult,
  CoworkSubagentDetailsIpc,
  type CoworkSubagentDetailsResult,
} from '../../../shared/cowork/subagentDetails';
import type { OpenClawRuntimeAdapter } from '../../engine';
import {
  type GatewaySubagent,
  getGatewaySubagentDetails,
  listGatewaySubagentDescendants,
} from '../../engine/openclaw/subagentGateway';
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
  options: {
    taskId?: unknown;
    loadSubagent?: (taskId: string) => Promise<GatewaySubagent | null>;
  } = {},
): Promise<CoworkSubagentDetailsResult> => {
  const normalizedSessionKey = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const normalizedTaskId = typeof options.taskId === 'string' ? options.taskId.trim() : '';
  if (!normalizedSessionKey) return { success: false, error: 'Session key is required' };
  if (!loadSessionUsage) {
    return { success: false, error: 'Gateway usage is not available' };
  }
  try {
    if (normalizedTaskId && !options.loadSubagent) {
      return { success: false, error: 'Gateway task details are not available' };
    }
    const subagent = normalizedTaskId ? await options.loadSubagent!(normalizedTaskId) : null;
    if (normalizedTaskId && !subagent) {
      return { success: false, error: 'Subagent task was not found' };
    }
    if (subagent && subagent.sessionKey !== normalizedSessionKey) {
      return { success: false, error: 'Task does not belong to the requested session' };
    }
    // Session updatedAt advances at run boundaries rather than for each usage
    // change. Active tasks must use a fresh discriminator on every poll so the
    // Gateway's outer stale-while-revalidate cache cannot freeze live totals.
    const usageRevision =
      subagent?.status === 'pending' || subagent?.status === 'running'
        ? undefined
        : subagent?.updatedAt;
    const usage = await loadSessionUsage(normalizedSessionKey, usageRevision);
    const stats = buildGatewaySessionDetailStats(usage, null);
    if (!stats) return { success: false, error: 'Subagent usage is not available' };
    return {
      success: true,
      stats,
      ...(subagent ? { subagent } : {}),
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
  ipcMain.handle(
    CoworkSubagentDetailsIpc.Status,
    async (_event, sessionId?: string, forceRefresh?: boolean) => {
      try {
        const runtime = getRuntime();
        if (!runtime) return { success: true, subagents: [] };
        const result = await runtime.getSubagentStatuses(sessionId, forceRefresh === true);
        return { success: true, subagents: result.subagents || [] };
      } catch {
        return { success: false, subagents: [] };
      }
    },
  );

  ipcMain.handle(
    CoworkSubagentDetailsIpc.Get,
    async (_event, sessionKey: unknown, taskId: unknown): Promise<CoworkSubagentDetailsResult> => {
      const runtime = getRuntime();
      const client = runtime?.getGatewayClient();
      const loadSessionUsage =
        getGatewaySessionUsage ??
        (async (key: string, revision?: number) => {
          if (!client) throw new Error('Gateway client not connected');
          return requestGatewaySessionUsage(client, key, {
            cacheDiscriminator: revision,
          });
        });
      return loadCoworkSubagentDetails(loadSessionUsage, sessionKey, {
        taskId,
        ...(client ? { loadSubagent: (id: string) => getGatewaySubagentDetails(client, id) } : {}),
      });
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
