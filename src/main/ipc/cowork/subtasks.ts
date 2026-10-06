import { ipcMain } from 'electron';

import {
  type CoworkSubagentAction,
  type CoworkSubagentChildrenResult,
  type CoworkSubagentControlResult,
  type CoworkSubagentDescendantsResult,
  CoworkSubagentDetailsIpc,
  type CoworkSubagentDetailsResult,
} from '../../../shared/cowork/subagentDetails';
import {
  buildSwarmInstruction,
  isSwarmOptions,
  SwarmIpc,
  type SwarmPrepareResult,
  type SwarmSnapshotResult,
} from '../../../shared/cowork/swarm';
import {
  SwarmFlowGateway,
  SwarmFlowIpc,
  validBatchOptions,
  validBatchPage,
  validFlowDetail,
  validFlowList,
  validSwarmIntervention,
} from '../../../shared/cowork/swarmFlow';
import type { OpenClawRuntimeAdapter } from '../../engine';
import {
  controlGatewaySubagent,
  type GatewaySubagent,
  getGatewaySubagentDetails,
  listGatewaySubagentChildren,
  listGatewaySubagentDescendants,
} from '../../engine/openclaw/subagentGateway';
import { readSwarmSnapshot } from '../../engine/openclaw/swarmGateway';
import {
  buildGatewaySessionDetailStats,
  type GatewaySessionUsageLoader,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  hasSession: (sessionId: string) => boolean;
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
    if (!loadSessionUsage) {
      return subagent
        ? { success: true, subagent }
        : { success: false, error: 'Gateway usage is not available' };
    }
    // Session updatedAt advances at run boundaries rather than for each usage
    // change. Active tasks must use a fresh discriminator on every poll so the
    // Gateway's outer stale-while-revalidate cache cannot freeze live totals.
    const usageRevision =
      subagent?.status === 'pending' || subagent?.status === 'running'
        ? undefined
        : subagent?.updatedAt;
    // Usage is optional enrichment. An unavailable usage backend must not hide
    // the verified task's lifecycle, prompt, model, or failure details.
    const usage = await loadSessionUsage(normalizedSessionKey, usageRevision).catch(
      (error: unknown): null => {
        if (!subagent) throw error;
        return null;
      },
    );
    const stats = buildGatewaySessionDetailStats(usage, null);
    if (!stats && !subagent) return { success: false, error: 'Subagent usage is not available' };
    return {
      success: true,
      ...(stats ? { stats } : {}),
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
  hasSession,
}: Dependencies): void => {
  const resolveOwnedRoot = (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !hasSession(sessionId))
      throw new Error('Product session was not found');
    const runtime = getRuntime();
    const client = runtime?.getGatewayClient();
    if (!runtime || !client) throw new Error('Gateway client not connected');
    return { runtime, client, keys: runtime.getSessionKeysForSession(sessionId) };
  };
  ipcMain.handle(
    SwarmIpc.Prepare,
    async (_event, options: unknown, sessionId?: unknown): Promise<SwarmPrepareResult> => {
      if (
        !isSwarmOptions(options) ||
        (sessionId !== undefined && (typeof sessionId !== 'string' || !hasSession(sessionId)))
      ) {
        return { success: false, reason: 'invalid' };
      }
      try {
        const health = await getRuntime()
          ?.getGatewayClient()
          ?.request<{ ready?: boolean }>(SwarmFlowGateway.Health, {});
        if (!health?.ready) return { success: false, reason: 'unavailable' };
      } catch {
        return { success: false, reason: 'unavailable' };
      }
      if (typeof sessionId === 'string') {
        try {
          const { runtime } = resolveOwnedRoot(sessionId);
          if ((await runtime.getPlanMode(sessionId)).enabled)
            return { success: false, reason: 'plan' };
          if (!hasSession(sessionId)) return { success: false, reason: 'invalid' };
        } catch {
          return { success: false, reason: 'unavailable' };
        }
      }
      return { success: true, instruction: buildSwarmInstruction(options) };
    },
  );
  ipcMain.handle(
    SwarmFlowIpc.Batch,
    async (_event, sessionId: unknown, id: unknown, stageId: unknown, options: unknown) => {
      try {
        if (
          typeof id !== 'string' ||
          !id ||
          id.length > 80 ||
          typeof stageId !== 'string' ||
          !stageId ||
          stageId.length > 80 ||
          !validBatchOptions(options)
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        const page = await client.request<unknown>(SwarmFlowGateway.Batch, {
          parentKeys: keys,
          id,
          stageId,
          ...options,
        });
        if (
          !hasSession(sessionId as string) ||
          !validBatchPage(page) ||
          page.flowId !== id ||
          page.stageId !== stageId
        )
          return { success: false };
        return { success: true, page };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(
    SwarmFlowIpc.RetryBatch,
    async (
      _event,
      sessionId: unknown,
      id: unknown,
      stageId: unknown,
      revision: unknown,
      operationId: unknown,
      itemIds: unknown,
    ) => {
      try {
        if (
          typeof id !== 'string' ||
          !id ||
          id.length > 80 ||
          typeof stageId !== 'string' ||
          !stageId ||
          stageId.length > 80 ||
          !Number.isSafeInteger(revision) ||
          Number(revision) <= 0 ||
          typeof operationId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(operationId) ||
          (itemIds !== undefined &&
            (!Array.isArray(itemIds) ||
              !itemIds.length ||
              itemIds.length > 100 ||
              new Set(itemIds).size !== itemIds.length ||
              itemIds.some(id => typeof id !== 'string' || !id || id.length > 80)))
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        const result = await client.request<{
          retried?: unknown;
          skipped?: unknown;
          reasons?: unknown;
        }>(SwarmFlowGateway.RetryBatch, {
          parentKeys: keys,
          id,
          stageId,
          revision,
          operationId,
          itemIds,
        });
        if (
          !hasSession(sessionId as string) ||
          !Array.isArray(result.retried) ||
          !Array.isArray(result.skipped) ||
          result.retried.length > 1000 ||
          result.skipped.length > 1000 ||
          [...result.retried, ...result.skipped].some(
            id => typeof id !== 'string' || id.length > 80,
          )
        )
          return { success: false };
        const reasons =
          result.reasons && typeof result.reasons === 'object' && !Array.isArray(result.reasons)
            ? (result.reasons as Record<string, unknown>)
            : {};
        return {
          success: true,
          retried: result.retried.length,
          skipped: result.skipped.length,
          reasons: [
            ...new Set(
              result.skipped
                .map(id => reasons[id])
                .filter(
                  (reason): reason is string => typeof reason === 'string' && reason.length <= 500,
                ),
            ),
          ],
        };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(SwarmFlowIpc.List, async (_event, sessionId: unknown) => {
    try {
      const { client, keys } = resolveOwnedRoot(sessionId);
      const result = await client.request<unknown>(SwarmFlowGateway.List, { parentKeys: keys });
      if (!hasSession(sessionId as string) || !validFlowList(result)) return { success: false };
      return { success: true, flows: result.flows };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle(
    SwarmFlowIpc.Detail,
    async (_event, sessionId: unknown, id: unknown, nodeId: unknown, sourceId?: unknown) => {
      try {
        if (
          typeof id !== 'string' ||
          !id ||
          typeof nodeId !== 'string' ||
          !nodeId ||
          (sourceId !== undefined && typeof sourceId !== 'string')
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        const detail = await client.request<unknown>(SwarmFlowGateway.Detail, {
          parentKeys: keys,
          id,
          nodeId,
          sourceId,
        });
        if (
          !hasSession(sessionId as string) ||
          !validFlowDetail(detail) ||
          detail.flowId !== id ||
          detail.nodeId !== nodeId
        )
          return { success: false };
        return { success: true, detail };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(
    SwarmFlowIpc.Intervene,
    async (
      _event,
      sessionId: unknown,
      id: unknown,
      nodeId: unknown,
      revision: unknown,
      intervention: unknown,
    ) => {
      try {
        if (
          typeof id !== 'string' ||
          !id ||
          typeof nodeId !== 'string' ||
          !nodeId ||
          !Number.isSafeInteger(revision) ||
          Number(revision) <= 0 ||
          !validSwarmIntervention(intervention)
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        // The Gateway resolves the node session and rechecks parent policy and revision.
        if (!hasSession(sessionId as string)) return { success: false };
        await client.request(SwarmFlowGateway.Intervene, {
          parentKeys: keys,
          id,
          nodeId,
          revision,
          intervention: {
            id: intervention.id,
            action: intervention.action,
            text: intervention.text,
          },
        });
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(
    SwarmFlowIpc.Control,
    async (_event, sessionId: unknown, id: unknown, revision: unknown, action: unknown) => {
      try {
        if (
          typeof id !== 'string' ||
          !Number.isSafeInteger(revision) ||
          !['pause', 'resume', 'stop', 'retry'].includes(String(action))
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        const result = await client.request<unknown>(SwarmFlowGateway.List, { parentKeys: keys });
        if (!validFlowList(result) || !result.flows.some(f => f.id === id))
          return { success: false };
        if (!hasSession(sessionId as string)) return { success: false };
        await client.request(SwarmFlowGateway.Control, { parentKeys: keys, id, revision, action });
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(
    SwarmIpc.Snapshot,
    async (_event, sessionId: unknown): Promise<SwarmSnapshotResult> => {
      try {
        const { client, keys } = resolveOwnedRoot(sessionId);
        const snapshot = await readSwarmSnapshot(client, keys);
        if (!hasSession(sessionId as string)) return { success: false };
        return { success: true, snapshot };
      } catch {
        return { success: false };
      }
    },
  );
  ipcMain.handle(
    CoworkSubagentDetailsIpc.ListChildren,
    async (
      _event,
      sessionId: unknown,
      parentTaskId?: unknown,
      cursor?: unknown,
    ): Promise<CoworkSubagentChildrenResult> => {
      try {
        const { client, keys } = resolveOwnedRoot(sessionId);
        if (
          parentTaskId !== undefined &&
          (typeof parentTaskId !== 'string' || !parentTaskId.trim())
        )
          throw new Error('Invalid parent task ID');
        if (cursor !== undefined && typeof cursor !== 'string')
          throw new Error('Invalid task cursor');
        return {
          success: true,
          ...(await listGatewaySubagentChildren(
            client,
            keys,
            parentTaskId as string | undefined,
            cursor as string | undefined,
          )),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load child tasks',
        };
      }
    },
  );
  ipcMain.handle(
    CoworkSubagentDetailsIpc.Control,
    async (
      _event,
      sessionId: unknown,
      taskId: unknown,
      action: unknown,
    ): Promise<CoworkSubagentControlResult> => {
      try {
        const { client, keys } = resolveOwnedRoot(sessionId);
        if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Task ID is required');
        if (typeof action !== 'string') throw new Error('Invalid subagent operation');
        return await controlGatewaySubagent(client, keys, taskId, action as CoworkSubagentAction);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to control subagent task',
        };
      }
    },
  );

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
