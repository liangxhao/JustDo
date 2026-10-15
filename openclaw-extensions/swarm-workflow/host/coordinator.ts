import {
  SwarmWorkflowGateway,
  validBatchOptions,
  validBatchPage,
  validFlowDetail,
  validFlowList,
  validSwarmWorkflowIntervention,
} from '../contracts/workflow';
import { buildSwarmWorkflowInstruction } from '../prompt/request';
import { isSwarmWorkflowOptions } from '../contracts/options';
import type { SwarmWorkflowApi, SwarmWorkflowPrepareResult } from '../contracts/api';
import type { SwarmWorkflowDependencies } from './ports';
export type { SwarmWorkflowDependencies } from './ports';

// Main owns product-session authority; the plugin owns native flow execution and state.
export function createSwarmWorkflowCoordinator({
  getRuntime,
  hasSession,
}: SwarmWorkflowDependencies): SwarmWorkflowApi {
  const resolveOwnedRoot = (sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !hasSession(sessionId))
      throw new Error('Product session was not found');
    const runtime = getRuntime();
    const client = runtime?.getGatewayClient();
    if (!runtime || !client) throw new Error('Gateway client not connected');
    return { runtime, client, keys: runtime.getSessionKeysForSession(sessionId) };
  };

  const operations: SwarmWorkflowApi = {
    prepareSwarmWorkflow: async (
      options: unknown,
      sessionId?: unknown,
    ): Promise<SwarmWorkflowPrepareResult> => {
      if (
        !isSwarmWorkflowOptions(options) ||
        (sessionId !== undefined && (typeof sessionId !== 'string' || !hasSession(sessionId)))
      ) {
        return { success: false, reason: 'invalid' };
      }
      try {
        const health = await getRuntime()
          ?.getGatewayClient()
          ?.request<{ ready?: boolean }>(SwarmWorkflowGateway.Health, {});
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
      return { success: true, instruction: buildSwarmWorkflowInstruction(options) };
    },
    getSwarmWorkflowBatch: async (
      sessionId: unknown,
      id: unknown,
      stageId: unknown,
      options: unknown,
    ) => {
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
        const page = await client.request<unknown>(SwarmWorkflowGateway.Batch, {
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
    retrySwarmWorkflowBatch: async (
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
        }>(SwarmWorkflowGateway.RetryBatch, {
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
    getSwarmWorkflows: async (sessionId: unknown) => {
      try {
        const { client, keys } = resolveOwnedRoot(sessionId);
        const result = await client.request<unknown>(SwarmWorkflowGateway.List, {
          parentKeys: keys,
        });
        if (!hasSession(sessionId as string) || !validFlowList(result)) return { success: false };
        return {
          success: true,
          flows: result.flows,
          ...(result.running === undefined ? {} : { running: result.running }),
        };
      } catch {
        return { success: false };
      }
    },
    getSwarmWorkflowDetail: async (
      sessionId: unknown,
      id: unknown,
      nodeId: unknown,
      sourceId?: unknown,
    ) => {
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
        const detail = await client.request<unknown>(SwarmWorkflowGateway.Detail, {
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
    interveneSwarmWorkflow: async (
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
          !validSwarmWorkflowIntervention(intervention)
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        // The Gateway resolves the node session and rechecks parent policy and revision.
        if (!hasSession(sessionId as string)) return { success: false };
        await client.request(SwarmWorkflowGateway.Intervene, {
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
    controlSwarmWorkflow: async (
      sessionId: unknown,
      id: unknown,
      revision: unknown,
      action: unknown,
    ) => {
      try {
        if (
          typeof id !== 'string' ||
          !Number.isSafeInteger(revision) ||
          !['pause', 'resume', 'stop', 'retry'].includes(String(action))
        )
          return { success: false };
        const { client, keys } = resolveOwnedRoot(sessionId);
        const result = await client.request<unknown>(SwarmWorkflowGateway.List, {
          parentKeys: keys,
        });
        if (!validFlowList(result) || !result.flows.some(f => f.id === id))
          return { success: false };
        if (!hasSession(sessionId as string)) return { success: false };
        await client.request(SwarmWorkflowGateway.Control, {
          parentKeys: keys,
          id,
          revision,
          action,
        });
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  };
  return operations;
}
