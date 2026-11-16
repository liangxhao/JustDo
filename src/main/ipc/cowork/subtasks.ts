import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  type CoworkSubagentAction,
  type CoworkSubagentChildrenResult,
  type CoworkSubagentControlResult,
  type CoworkSubagentConversationResult,
  type CoworkSubagentDescendantsResult,
  CoworkSubagentDetailsIpc,
  type CoworkSubagentDetailsResult,
} from '../../../shared/cowork/subagentDetails';
import { SwarmIpc, type SwarmSnapshotResult } from '../../../shared/cowork/swarm';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawRuntimeAdapter } from '../../engine';
import { areWorkspacePathsEquivalent } from '../../engine/openclaw/runtimeAdapterSupport';
import {
  controlGatewaySubagent,
  type GatewaySubagent,
  getGatewaySubagentDetails,
  listGatewaySubagentChildren,
  listGatewaySubagentDescendants,
  requireGatewaySubagentForBrowsing,
} from '../../engine/openclaw/subagentGateway';
import { readSwarmSnapshot } from '../../engine/openclaw/swarmGateway';
import {
  buildGatewaySessionDetailStats,
  type GatewaySessionUsageLoader,
  requestGatewaySessionUsage,
} from '../../openclaw/sessions/openclawSessionDetails';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import {
  isNativeDashboardSessionKey,
  isVisibleNativeChildSession,
  readNativeSessionWorkspace,
} from '../../openclaw/sessions/visibleChildSession';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  hasSession: (sessionId: string) => boolean;
  getGatewaySessionUsage?: GatewaySessionUsageLoader;
  conversation?: {
    isAllowedSender: (event: IpcMainInvokeEvent) => boolean;
    getStore: () => CoworkStore;
    discoverNativeChildSessions: () => Promise<void>;
  };
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
  conversation,
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
    CoworkSubagentDetailsIpc.GetConversation,
    async (event, parentSessionId: unknown, sessionKey: unknown, sessionId: unknown): Promise<CoworkSubagentConversationResult> => {
      try {
        if (!conversation?.isAllowedSender(event)) throw new Error('Subagent conversation is unavailable');
        if (typeof parentSessionId !== 'string' || !parentSessionId.trim() ||
          typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid subagent conversation');
        const store = conversation.getStore();
        const root = store.getSession(parentSessionId);
        if (!root) throw new Error('Product session was not found');
        if (typeof sessionKey !== 'string') throw new Error('Invalid subagent conversation');
        let child = store.getSessionByNativeKey(sessionKey);
        const dashboard = isNativeDashboardSessionKey(sessionKey, root.agentId);
        const legacyWorktree = sessionKey.startsWith(`agent:${root.agentId}:subagent:`) &&
          child?.nativeParentSessionId;
        if (!dashboard && !legacyWorktree) return { success: true };
        const { client, keys, runtime } = resolveOwnedRoot(parentSessionId);
        const generation = runtime.getGatewayClientGeneration();
        const readChild = () => requireGatewaySubagentForBrowsing(client, keys, sessionKey);
        let row = await readChild();
        if (row.sessionId !== sessionId) throw new Error('Subagent conversation changed');
        if (dashboard && !isVisibleNativeChildSession(row, root.agentId)) return { success: true };
        if (!child) {
          await conversation.discoverNativeChildSessions();
          row = await readChild();
          child = store.getSessionByNativeKey(sessionKey);
        }
        const currentRoot = store.getSession(parentSessionId);
        if (getRuntime() !== runtime || runtime.getGatewayClient() !== client ||
          runtime.getGatewayClientGeneration() !== generation ||
          !currentRoot || currentRoot.agentId !== root.agentId ||
          currentRoot.nativeSessionKey !== root.nativeSessionKey ||
          currentRoot.external?.sessionKey !== root.external?.sessionKey ||
          row.sessionId !== sessionId || (dashboard && !isVisibleNativeChildSession(row, root.agentId))) {
          throw new Error('Subagent conversation changed');
        }
        const parent = child?.nativeParentSessionId && store.getSession(child.nativeParentSessionId);
        const parentKey = parent && (parent.nativeSessionKey || parent.external?.sessionKey ||
          buildManagedSessionKey(parent.id, parent.agentId));
        const nativeParentKey = dashboard ? row.parentSessionKey : row.spawnedBy;
        if (legacyWorktree && typeof (row.worktree as { id?: unknown } | undefined)?.id !== 'string') {
          return { success: true };
        }
        const cwd = readNativeSessionWorkspace(row);
        if (!child || !parent || child.agentId !== root.agentId || parentKey !== nativeParentKey ||
          typeof cwd !== 'string' || !areWorkspacePathsEquivalent(cwd, child.cwd)) return { success: true };
        return {
          success: true,
          target: {
            productSessionId: child.id,
            parentProductSessionId: parent.id,
            sessionKey,
            sessionId,
            agentId: child.agentId,
            workingDirectory: child.cwd,
            ...(typeof row.lifecycleRevision === 'string' ? { lifecycleRevision: row.lifecycleRevision } : {}),
            ...(!dashboard ? { canSend: false as const } : {}),
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Subagent conversation is unavailable' };
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
