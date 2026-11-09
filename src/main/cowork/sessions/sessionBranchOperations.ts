import { randomUUID } from 'crypto';

import { parsePlanModeState } from '../../../shared/cowork/interactions/planMode';
import { type CopyCoworkSessionInput, SessionCopyErrorCode } from '../../../shared/cowork/sessionCopy';
import type { ForkCoworkSessionInput } from '../../../shared/cowork/sessionFork';
import { normalizeSessionGoal } from '../../../shared/cowork/sessionGoal';
import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import { toOpenClawSessionPermissionMode } from '../../../shared/security/approvals';
import { t } from '../../core/i18n';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import { buildManagedSessionKey, DEFAULT_MANAGED_AGENT_ID } from '../../openclaw/sessions/openclawSessionKeys';
import {
  hasSessionBranchCreationResponse,
  readSessionBranchRunIds,
  recoverFailedSessionBranch,
  type SessionBranchGatewayRequest,
} from './sessionBranching';

type SessionBranchStore = Pick<CoworkStore,
  'getSession' | 'createSession' | 'markSessionBranchPending' | 'clearSessionBranchPending' |
  'copyTerminalSessionRuns' | 'deleteSession' | 'updateSession'
>;
type SessionBranchRouter = Pick<CoworkEngineRouter,
  'getSessionRuntimeStatus' | 'prepareSession' | 'onSessionDeleted'
>;

export interface SessionBranchOperationDependencies {
  getCoworkStore: () => SessionBranchStore;
  getCoworkEngineRouter: () => SessionBranchRouter;
  requestGateway?: SessionBranchGatewayRequest;
  isManagedSession?: (sessionId: string) => boolean | undefined;
}

type SessionBranchOperationResult =
  | { success: true; session: CoworkSession; planModeEnabled?: boolean }
  | { success: false; session?: CoworkSession; error: string; errorCode?: SessionCopyErrorCode };

type GatewayRequest = SessionBranchGatewayRequest;

const clearInheritedSessionGoal = async (
  requestGateway: GatewayRequest,
  options: { sessionKey: string; gatewaySessionId: string; agentId: string },
): Promise<void> => {
  const described = await requestGateway<{
    session?: { sessionId?: unknown; goal?: unknown } | null;
  }>('sessions.describe', { key: options.sessionKey });
  if (!described.session) {
    throw new Error('OpenClaw did not return the copied session for Goal verification.');
  }
  if (described.session.sessionId !== options.gatewaySessionId) {
    throw new Error('The copied session identity changed during Goal verification.');
  }
  if (described.session.goal === undefined || described.session.goal === null) return;
  const goal = normalizeSessionGoal(described.session.goal);
  if (!goal) throw new Error('OpenClaw returned invalid Goal metadata on the copied session.');
  const gatewaySessionId = options.gatewaySessionId;
  const operationId = randomUUID();
  const cleared = await requestGateway<{
    operationId?: unknown;
    action?: unknown;
    sessionId?: unknown;
    goalId?: unknown;
    status?: unknown;
  }>('sessions.goal.clear', {
    sessionKey: options.sessionKey,
    agentId: options.agentId,
    sessionId: gatewaySessionId,
    goalId: goal.id,
    operationId,
    issuedAtMs: Date.now(),
  });
  if (
    cleared.operationId !== operationId ||
    cleared.action !== 'clear' ||
    cleared.sessionId !== gatewaySessionId ||
    cleared.goalId !== goal.id ||
    cleared.status !== 'cleared'
  ) {
    throw new Error('OpenClaw did not confirm that the copied Goal was cleared.');
  }
  const verified = await requestGateway<{
    session?: { sessionId?: unknown; goal?: unknown } | null;
  }>('sessions.describe', { key: options.sessionKey });
  if (
    !verified.session ||
    verified.session.sessionId !== gatewaySessionId ||
    (verified.session.goal !== undefined && verified.session.goal !== null)
  ) {
    throw new Error('OpenClaw did not clear Goal metadata from the copied session.');
  }
};

export async function copyCoworkSession(
  { getCoworkStore, getCoworkEngineRouter, requestGateway, isManagedSession }: SessionBranchOperationDependencies,
  input: CopyCoworkSessionInput,
): Promise<SessionBranchOperationResult> {
  const { sessionId: sourceSessionId, title } = input;
  const store = getCoworkStore();
  const router = getCoworkEngineRouter();
  const source = store.getSession(sourceSessionId);
  if (!source) {
    return { success: false, errorCode: SessionCopyErrorCode.SourceUnavailable, error: 'Source session not found.' };
  }
  if (source.branchCreationPending) {
    return { success: false, errorCode: SessionCopyErrorCode.SourceUnavailable, error: t('coworkBranchCreationPending') };
  }
  if (source.nativeSessionKey && !source.historyBinding) {
    return { success: false, errorCode: SessionCopyErrorCode.SourceRestricted, error: t('worktreeCopyUnavailable') };
  }
  if (isManagedSession?.(sourceSessionId)) {
    return { success: false, errorCode: SessionCopyErrorCode.SourceRestricted, error: 'collaborationCopyUnavailable' };
  }
  if (!requestGateway) {
    return {
      success: false,
      errorCode: SessionCopyErrorCode.GatewayUnavailable,
      error: 'OpenClaw Gateway session copy is unavailable.',
    };
  }

  let copiedSession: ReturnType<CoworkStore['createSession']> | null = null;
  let copiedSessionKey = '';
  let creationResponseReceived = false;
  let creationRequestIssued = false;
  try {
    const runtime = await router.getSessionRuntimeStatus(sourceSessionId, {
      includeSubagents: true,
      forceRefresh: true,
      ...(source.external ? { fullScan: true } : { targeted: true }),
    });
    if (!runtime.known) {
      return {
        success: false,
        errorCode: SessionCopyErrorCode.RuntimeUnknown,
        error: 'The current session activity could not be verified. Try again in a moment.',
      };
    }
    if (runtime.running) {
      return {
        success: false,
        errorCode: SessionCopyErrorCode.RuntimeActive,
        error: 'Wait for the current session to finish before copying.',
      };
    }
    if (source.historyBinding) {
      const prepared = await router.prepareSession(sourceSessionId);
      if (
        prepared.sessionKey !== source.historyBinding.sessionKey ||
        prepared.gatewaySessionId !== source.historyBinding.nativeSessionId
      )
        throw new Error('The historical source identity changed before copying.');
    }

    const parentSessionKey =
      source.nativeSessionKey ||
      buildManagedSessionKey(sourceSessionId, source.agentId || DEFAULT_MANAGED_AGENT_ID);
    if (isManagedSession?.(sourceSessionId))
      throw new Error('collaborationCopyUnavailable');
    const described = await requestGateway<{ session?: { pluginExtensions?: unknown } }>(
      'sessions.describe',
      { key: parentSessionKey },
    );
    const pluginExtensions = Array.isArray(described.session?.pluginExtensions)
      ? described.session.pluginExtensions
      : [];
    const planExtension = pluginExtensions.find(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const extension = candidate as Record<string, unknown>;
      return (
        extension.pluginId === OpenClawExtensionId.PLAN_MODE && extension.namespace === 'state'
      );
    }) as Record<string, unknown> | undefined;
    const copyPlanMode = parsePlanModeState(planExtension?.value).enabled;
    copiedSession = store.createSession(
      title,
      source.cwd,
      source.executionMode,
      source.activeSkillIds,
      source.agentId,
      source.permissionMode,
      source.modelRef,
    );
    copiedSessionKey = buildManagedSessionKey(
      copiedSession.id,
      copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
    );
    store.markSessionBranchPending(copiedSession.id);
    creationRequestIssued = true;
    const created = await requestGateway<{
      key?: unknown;
      sessionId?: unknown;
      entry?: { sessionId?: unknown };
    }>('sessions.create', {
      key: copiedSessionKey,
      parentSessionKey,
      fork: true,
      cwd: source.cwd,
      permissionMode: toOpenClawSessionPermissionMode(source.permissionMode),
    });
    creationResponseReceived = true;
    const gatewaySessionId =
      typeof created.sessionId === 'string'
        ? created.sessionId.trim()
        : typeof created.entry?.sessionId === 'string'
          ? created.entry.sessionId.trim()
          : '';
    const returnedKey = typeof created.key === 'string' ? created.key.trim() : copiedSessionKey;
    if (!gatewaySessionId || returnedKey !== copiedSessionKey) {
      throw new Error('OpenClaw did not create the requested copied session.');
    }
    if (copyPlanMode) {
      const patched = await requestGateway<{ ok?: unknown }>('sessions.pluginPatch', {
        key: copiedSessionKey,
        agentId: copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
        pluginId: OpenClawExtensionId.PLAN_MODE,
        namespace: 'state',
        value: { enabled: true, updatedAt: Date.now() },
      });
      if (patched.ok !== true) {
        throw new Error('OpenClaw did not preserve Plan mode on the copied session.');
      }
    }

    // Adopting the explicit key verifies the copied workspace and permission
    // boundary and records the runtime key in the adapter cache.
    const prepared = await router.prepareSession(copiedSession.id, {
      pendingBranchPreparation: true,
    });
    if (
      prepared.sessionKey !== copiedSessionKey ||
      prepared.gatewaySessionId !== gatewaySessionId
    ) {
      throw new Error('The copied session identity changed during preparation.');
    }
    const copiedRunIds = await readSessionBranchRunIds(
      requestGateway,
      copiedSessionKey,
      gatewaySessionId,
    );
    await clearInheritedSessionGoal(requestGateway, {
      sessionKey: copiedSessionKey,
      gatewaySessionId,
      agentId: copiedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
    });
    if (isManagedSession?.(sourceSessionId))
      throw new Error('collaborationCopyUnavailable');
    store.copyTerminalSessionRuns(source.id, copiedSession.id, copiedRunIds);
    store.clearSessionBranchPending(copiedSession.id);
    return { success: true, session: copiedSession, planModeEnabled: copyPlanMode };
  } catch (error) {
    const retainedSession =
      copiedSession && copiedSessionKey
        ? await recoverFailedSessionBranch({
            requestGateway,
            store,
            router,
            session: copiedSession,
            sessionKey: copiedSessionKey,
            creationResponseReceived:
              creationResponseReceived || hasSessionBranchCreationResponse(error),
            creationRequestIssued,
          })
        : undefined;
    return {
      success: false,
      ...(retainedSession ? { session: retainedSession } : {}),
      errorCode: creationRequestIssued && !creationResponseReceived && !hasSessionBranchCreationResponse(error)
        ? SessionCopyErrorCode.CreationUnconfirmed
        : creationResponseReceived ? SessionCopyErrorCode.PreparationFailed : undefined,
      error: error instanceof Error ? error.message : 'Failed to copy session.',
    };
  }
}

export async function forkCoworkSession(
  { getCoworkStore, getCoworkEngineRouter, requestGateway, isManagedSession }: SessionBranchOperationDependencies,
  input: ForkCoworkSessionInput,
): Promise<SessionBranchOperationResult> {
  const { sessionId: sourceSessionId, title, entryId } = input;
  const store = getCoworkStore();
  const router = getCoworkEngineRouter();
  const source = store.getSession(sourceSessionId);
  if (!source) return { success: false, error: 'Source session not found.' };
  if (source.branchCreationPending)
    return { success: false, error: t('coworkBranchCreationPending') };
  if (source.nativeSessionKey && !source.historyBinding)
    return { success: false, error: t('worktreeCopyUnavailable') };
  if (!requestGateway) {
    return { success: false, error: 'OpenClaw Gateway session fork is unavailable.' };
  }
  if (isManagedSession?.(sourceSessionId))
    return { success: false, error: 'collaborationCopyUnavailable' };

  const sourceSessionKey =
    source.nativeSessionKey ||
    buildManagedSessionKey(sourceSessionId, source.agentId || DEFAULT_MANAGED_AGENT_ID);

  let forkedSession: ReturnType<CoworkStore['createSession']> | null = null;
  let forkedSessionKey = '';
  let creationResponseReceived = false;
  let creationRequestIssued = false;
  try {
    const runtime = await router.getSessionRuntimeStatus(sourceSessionId, {
      includeSubagents: true,
      forceRefresh: true,
      ...(source.external ? { fullScan: true } : { targeted: true }),
    });
    if (!runtime.known) {
      return {
        success: false,
        error: 'The current session activity could not be verified. Try again in a moment.',
      };
    }
    if (runtime.running) {
      return { success: false, error: 'Wait for the current session to finish before forking.' };
    }
    if (source.historyBinding) {
      const prepared = await router.prepareSession(sourceSessionId);
      if (
        prepared.sessionKey !== source.historyBinding.sessionKey ||
        prepared.gatewaySessionId !== source.historyBinding.nativeSessionId
      )
        throw new Error('The historical source identity changed before forking.');
    }

    forkedSession = store.createSession(
      title,
      source.cwd,
      source.executionMode,
      source.activeSkillIds,
      source.agentId,
      source.permissionMode,
      source.modelRef,
      { sessionId: source.id, title: source.title, entryId },
    );
    forkedSessionKey = buildManagedSessionKey(
      forkedSession.id,
      forkedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
    );
    store.markSessionBranchPending(forkedSession.id);
    creationRequestIssued = true;
    const forked = await requestGateway<{ sessionKey?: unknown }>('sessions.fork', {
      sessionKey: sourceSessionKey,
      agentId: source.agentId || DEFAULT_MANAGED_AGENT_ID,
      entryId,
      targetKey: forkedSessionKey,
      includeEntry: true,
    });
    creationResponseReceived = true;
    const returnedKey = typeof forked.sessionKey === 'string' ? forked.sessionKey.trim() : '';
    if (returnedKey !== forkedSessionKey) {
      throw new Error('OpenClaw did not create the requested forked session.');
    }

    const described = await requestGateway<{ session?: { sessionId?: unknown } | null }>(
      'sessions.describe',
      { key: forkedSessionKey },
    );
    const gatewaySessionId = described.session?.sessionId;
    if (typeof gatewaySessionId !== 'string' || !gatewaySessionId.trim()) {
      throw new Error('OpenClaw did not return the forked session identity.');
    }
    const prepared = await router.prepareSession(forkedSession.id, {
      pendingBranchPreparation: true,
    });
    if (
      prepared.sessionKey !== forkedSessionKey ||
      prepared.gatewaySessionId !== gatewaySessionId
    ) {
      throw new Error('The forked session identity changed during preparation.');
    }
    const nativeRunIds = await readSessionBranchRunIds(
      requestGateway,
      forkedSessionKey,
      gatewaySessionId,
      entryId,
    );
    await clearInheritedSessionGoal(requestGateway, {
      sessionKey: forkedSessionKey,
      gatewaySessionId,
      agentId: forkedSession.agentId || DEFAULT_MANAGED_AGENT_ID,
    });
    if (isManagedSession?.(sourceSessionId))
      throw new Error('collaborationCopyUnavailable');
    store.copyTerminalSessionRuns(source.id, forkedSession.id, nativeRunIds);
    store.clearSessionBranchPending(forkedSession.id);
    return { success: true, session: forkedSession };
  } catch (error) {
    const retainedSession =
      forkedSession && forkedSessionKey
        ? await recoverFailedSessionBranch({
            requestGateway,
            store,
            router,
            session: forkedSession,
            sessionKey: forkedSessionKey,
            creationResponseReceived:
              creationResponseReceived || hasSessionBranchCreationResponse(error),
            creationRequestIssued,
          })
        : undefined;
    return {
      success: false,
      ...(retainedSession ? { session: retainedSession } : {}),
      error: error instanceof Error ? error.message : 'Failed to fork session.',
    };
  }
}
