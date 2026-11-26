import { randomUUID } from 'node:crypto';

import {
  EXTERNAL_SESSION_GOAL_METHOD,
  SESSION_GOAL_REJECTED,
  type SessionGoalMutationReceipt,
} from '../../../../plugins/extensions/runtime-services/contracts/session-goal';
import {
  normalizeSessionGoal,
  type SessionGoal,
  SessionGoalStatus,
} from '../../../shared/cowork/sessionGoal';
import type { CoworkSession } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';
import { assertStorageExecutionAdmission } from '../../storage/relocationAdmission';
import type {
  ExternalAgentGoalSetRequest,
  ExternalAgentSessionIdentity,
} from './externalAgentTypes';

interface Dependencies {
  getRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  ensureReady: () => Promise<Pick<OpenClawEngineStatus, 'phase' | 'message'>>;
  onGoalChanged: (sessionId: string, goal: SessionGoal | null, activated: boolean) => void;
}

export interface ExternalAgentGoalTarget {
  session: CoworkSession;
  sessionKey: string;
  identity?: ExternalAgentSessionIdentity;
  hasExternalRun: boolean;
  assertCurrent: () => void;
  pinIdentity: (identity: ExternalAgentSessionIdentity) => void;
}

export type ExternalAgentGoalMutation =
  ({ action: 'set' } & ExternalAgentGoalSetRequest) | { action: 'clear' };

function readGoal(value: unknown): SessionGoal | null {
  if (value == null) return null;
  const goal = normalizeSessionGoal(value);
  if (!goal) throw new Error('Gateway returned an invalid Goal.');
  return goal;
}

export function createExternalAgentGoalOperations(deps: Dependencies) {
  type Listener = (goal: SessionGoal | null) => void;
  const watches = new Map<string, ReturnType<typeof createWatch>>();
  let observedRuntime: OpenClawRuntimeAdapter | null = null;
  const onEvent = (event: GatewayEventFrame) => {
    if (event.event !== 'sessions.changed' && event.event !== 'agent') return;
    const payload = event.payload as
      | {
          key?: unknown;
          sessionKey?: unknown;
          stream?: unknown;
          session?: { key?: unknown };
          data?: { executionSettled?: unknown };
        }
      | undefined;
    const sessionKey = payload?.session?.key ?? payload?.sessionKey ?? payload?.key;
    if (typeof sessionKey !== 'string') return;
    if (
      event.event === 'agent' &&
      (payload?.stream !== 'lifecycle' || payload.data?.executionSettled !== true)
    )
      return;
    watches.get(sessionKey)?.refresh();
  };
  const onReady = () => {
    for (const group of watches.values()) group.refresh();
  };
  const observeRuntime = (runtime: OpenClawRuntimeAdapter | null) => {
    if (runtime === observedRuntime) return;
    observedRuntime?.off('gatewayEvent', onEvent);
    observedRuntime?.off('gatewayReady', onReady);
    observedRuntime = runtime;
    runtime?.on('gatewayEvent', onEvent);
    runtime?.on('gatewayReady', onReady);
  };

  function gateway(target: ExternalAgentGoalTarget, signal: AbortSignal) {
    const runtime = deps.getRuntime();
    const client = runtime?.getGatewayClient();
    const context = runtime?.captureGatewayResponseContext();
    if (!runtime || !client || !context?.isCurrent())
      throw new Error('Gateway is unavailable for Goal operations.');
    if (watches.size > 0) observeRuntime(runtime);
    const assertIdentityCurrent = () => {
      target.assertCurrent();
      if (
        deps.getRuntime() !== runtime ||
        runtime.getGatewayClient() !== client ||
        !context.isCurrent()
      )
        throw new Error('Gateway connection changed during the Goal operation.');
    };
    const assertCurrent = () => {
      signal.throwIfAborted();
      assertIdentityCurrent();
    };
    const describe = async (identity: ExternalAgentSessionIdentity) => {
      assertCurrent();
      const { session } = await client.request<{
        session?: {
          key?: string;
          sessionId?: string;
          lifecycleRevision?: string;
          goal?: unknown;
          activeRunIds?: unknown;
        };
      }>('sessions.describe', { key: identity.sessionKey }, { signal });
      assertCurrent();
      if (
        session?.key !== identity.sessionKey ||
        session.sessionId !== identity.sessionId ||
        session.lifecycleRevision !== identity.lifecycleRevision
      )
        throw new Error('Native conversation identity changed during the Goal operation.');
      return session;
    };
    return { client, context, assertCurrent, assertIdentityCurrent, describe };
  }

  const read = async (
    target: ExternalAgentGoalTarget,
    signal: AbortSignal,
  ): Promise<SessionGoal | null> => {
    signal.throwIfAborted();
    target.assertCurrent();
    if (!target.identity) return null;
    return readGoal((await gateway(target, signal).describe(target.identity)).goal);
  };

  const mutate = async (
    target: ExternalAgentGoalTarget,
    request: ExternalAgentGoalMutation,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    target.assertCurrent();
    assertStorageExecutionAdmission();
    let identity = target.identity;
    if (!identity) {
      if (request.action === 'clear') return { goal: null, cleared: false };
      if (!request.objective) throw new Error('An objective is required to create a Goal.');
      const readiness = await deps.ensureReady();
      signal.throwIfAborted();
      target.assertCurrent();
      if (readiness.phase !== 'running')
        throw new Error(readiness.message || 'Execution runtime is unavailable.');
      const prepared = await deps.getRouter().prepareSession(target.session.id, {
        agentId: target.session.agentId,
        workspaceRoot: target.session.cwd,
        permissionMode: target.session.permissionMode,
        modelRef: target.session.modelRef,
        signal,
      });
      if (
        prepared.sessionKey !== target.sessionKey ||
        !prepared.gatewaySessionId ||
        !prepared.lifecycleRevision
      )
        throw new Error('The native conversation could not be prepared for a Goal.');
      identity = {
        sessionKey: prepared.sessionKey,
        sessionId: prepared.gatewaySessionId,
        lifecycleRevision: prepared.lifecycleRevision,
      };
    }

    const { client, context, assertCurrent, assertIdentityCurrent, describe } = gateway(target, signal);
    const session = await describe(identity);
    if (!target.identity) target.pinIdentity(identity);
    const operationId = randomUUID();
    const active =
      target.hasExternalRun ||
      !Array.isArray(session.activeRunIds) ||
      session.activeRunIds.length > 0 ||
      deps.getRouter().isSessionActive(target.session.id);
    const currentGoal = readGoal(session.goal);
    assertStorageExecutionAdmission();
    assertCurrent();
    const unknown = () => {
      watches.get(identity.sessionKey)?.refresh();
      return new Error('GOAL_OUTCOME_UNKNOWN: Read the current Goal before making another change.');
    };
    let receipt: SessionGoalMutationReceipt;
    try {
      // Once submitted, closing the external peer cannot undo the native write.
      // Keep its receipt available for other subscribed peers on the current Gateway.
      receipt = await client.request<SessionGoalMutationReceipt>(EXTERNAL_SESSION_GOAL_METHOD, {
        ...identity,
        operationId,
        expectedGoalId: currentGoal?.id ?? null,
        ...request,
        ...(request.action === 'set' ? { allowReplacement: !active } : {}),
      });
      assertIdentityCurrent();
    } catch (error) {
      const details = (error as { details?: { code?: unknown } } | null)?.details;
      if (context.isResponseError(error) && details?.code === SESSION_GOAL_REJECTED) throw error;
      throw unknown();
    }
    if (
      receipt?.operationId !== operationId ||
      receipt.sessionKey !== identity.sessionKey ||
      receipt.sessionId !== identity.sessionId ||
      receipt.lifecycleRevision !== identity.lifecycleRevision ||
      typeof receipt.start !== 'boolean' ||
      typeof receipt.cleared !== 'boolean'
    )
      throw unknown();
    const goal = normalizeSessionGoal(receipt.goal) ?? null;
    if (
      request.action === 'set' ? !goal || receipt.cleared : receipt.goal !== null || receipt.start
    )
      throw unknown();
    if (request.action === 'set' || receipt.cleared) {
      watches.get(identity.sessionKey)?.adopt(goal);
      try {
        deps.onGoalChanged(target.session.id, goal, receipt.start && !signal.aborted);
      } catch {
        // Window output cannot invalidate a verified native receipt.
      }
    }
    return {
      goal,
      cleared: receipt.cleared,
      ...(goal?.status === SessionGoalStatus.Active && receipt.start && !active && !signal.aborted
        ? { start: identity }
        : {}),
    };
  };

  const watch = (getTarget: () => ExternalAgentGoalTarget, onChange: Listener) => {
    const { sessionKey } = getTarget();
    observeRuntime(deps.getRuntime());
    const group = watches.get(sessionKey) ?? createWatch(getTarget);
    watches.set(sessionKey, group);
    group.listeners.add(onChange);
    return () => {
      group.listeners.delete(onChange);
      if (group.listeners.size > 0 || watches.get(sessionKey) !== group) return;
      group.close();
      watches.delete(sessionKey);
      if (watches.size === 0) observeRuntime(null);
    };
  };

  function createWatch(getTarget: () => ExternalAgentGoalTarget) {
    const controller = new AbortController();
    const listeners = new Set<Listener>();
    let last: string | undefined;
    let mutationRevision = 0;
    let pending = false;
    let reading = false;
    const refresh = async () => {
      pending = true;
      if (reading) return;
      reading = true;
      try {
        while (pending && !controller.signal.aborted) {
          pending = false;
          try {
            const revision = mutationRevision;
            const goal = await read(getTarget(), controller.signal);
            if (controller.signal.aborted) return;
            if (revision !== mutationRevision) {
              pending = true;
              continue;
            }
            const current = JSON.stringify(goal);
            const changed = last !== undefined && current !== last;
            last = current;
            if (changed) {
              for (const listener of [...listeners]) if (listeners.has(listener)) listener(goal);
            }
          } catch {
            // A retired connection or unreadable snapshot cannot prove Goal removal.
          }
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    return {
      listeners,
      refresh: () => {
        void refresh();
      },
      adopt: (goal: SessionGoal | null) => {
        mutationRevision++;
        last = JSON.stringify(goal);
      },
      close: () => controller.abort(),
    };
  }
  const refresh = (sessionKey: string, published: SessionGoal | null) => {
    const group = watches.get(sessionKey);
    if (!group) return;
    group.adopt(published);
    group.refresh();
  };
  return { read, mutate, watch, refresh };
}
