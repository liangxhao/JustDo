import { createHash } from 'crypto';
import { BrowserWindow } from 'electron';
import path from 'path';

import { type CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import {
  type CoworkPlanArtifactReference,
  type CoworkPlanHandoff,
  CoworkPlanHandoffState,
} from '../../../shared/cowork/planHandoff';
import {
  type AskUserInteractionEnvelope,
  AskUserQuestionGateway,
  type AskUserRequest,
  type CoworkInteractionEnvelope,
  CoworkInteractionIpc,
  CoworkInteractionKind,
  OpenClawExtensionId,
  OpenClawToolName,
  parseAskUserAnswers,
  parseAskUserRequest,
  parsePlanModeRequest,
  parsePlanModeState,
  PlanModeGateway,
  type PlanModeInteractionEnvelope,
  type PlanModeRequest,
  type PlanModeState,
} from '../../../shared/openclaw/extensions';
import type { ApprovedPlanArtifactStore } from '../../cowork/approvedPlans/approvedPlanArtifactStore';
import { coworkLog } from '../../cowork/coworkLogger';
import type { CoworkStore } from '../../data/coworkStore';
import { DEFAULT_MANAGED_AGENT_ID } from '../../openclaw/sessions/openclawSessionKeys';
import { isRecord } from '../gateway/helpers';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import type { CoworkStartOptions, CoworkStopOptions } from '../types';
import { ASK_USER_TERMINAL_CACHE_SIZE } from './runtimeAdapterSupport';
export interface RuntimePlanInteractionsContext {
  readonly resolveSessionIdBySessionKey: (sessionKey: string) => string | null;
  readonly resolvePlanModeSessionId: (request: PlanModeRequest) => string;
  readonly resolveAskUserSessionId: (request: AskUserRequest) => string;
  readonly terminalAskUserIds: Set<string>;
  readonly pendingAskUserRequests: Map<string, AskUserRequest>;
  readonly sendCoworkInteraction: (interaction: CoworkInteractionEnvelope) => void;
  readonly toAskUserInteraction: (request: AskUserRequest) => AskUserInteractionEnvelope;
  readonly rememberTerminalAskUser: (requestId: string) => void;
  readonly sendAskUserDismiss: (requestId: string) => void;
  readonly gatewayClient: GatewayClientLike | null;
  readonly gatewayClientGeneration: number;
  readonly cancelUnpersistedPlanRequest: (
    client: GatewayClientLike,
    generation: number,
    request: PlanModeRequest,
  ) => Promise<boolean>;
  readonly persistAndVerifyPresentedPlan: (
    sessionId: string,
    request: PlanModeRequest,
  ) => { handoff: CoworkPlanHandoff; markdown: string };
  readonly persistPlanReviewAdmission: (
    client: GatewayClientLike,
    sessionId: string,
    request: PlanModeRequest,
  ) => Promise<void>;
  readonly store: CoworkStore;
  readonly patchPlanModeState: (
    client: GatewayClientLike,
    sessionKey: string,
    agentId: string | undefined,
    state: PlanModeState,
  ) => Promise<void>;
  readonly completePlanHandoffResolution: (planId: string) => void;
  readonly pendingPlanModeRequests: Map<string, PlanModeRequest>;
  readonly toPlanModeInteraction: (request: PlanModeRequest) => PlanModeInteractionEnvelope;
  readonly planResolutionByRequestId: Map<string, Promise<{ sessionId: string }>>;
  readonly isPlanRequestMissing: (
    client: GatewayClientLike,
    generation: number,
    requestId: string,
  ) => Promise<boolean>;
  readonly approvedPlanArtifactStore:
    | (Pick<ApprovedPlanArtifactStore, 'publish' | 'readVerified'> &
        Partial<
          Pick<ApprovedPlanArtifactStore, 'cleanupStaleTemporaryFiles' | 'removeSessionArtifacts'>
        >)
    | undefined;
  readonly startSession: (
    sessionId: string,
    prompt: string,
    options?: CoworkStartOptions,
  ) => Promise<void>;
  readonly buildPlanRevisionPrompt: (
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    feedback: string | undefined,
  ) => string;
  readonly activeTurns: Map<string, SessionTurn>;
  readonly stopSessionInternal: (
    sessionId: string,
    options: CoworkStopOptions,
    cancelPendingStart: boolean,
  ) => Promise<void>;
  readonly invalidateRuntimeSessionSnapshot: () => void;
  readonly stopPlanningTurnForImplementation: (
    sessionId: string,
    planningTurn: SessionTurn | undefined,
  ) => Promise<void>;
  readonly runTurn: (
    sessionId: string,
    prompt: string,
    options: {
      skillIds?: string[];
      confirmationMode?: 'modal' | 'text';
      attachments?: CoworkAttachmentPayload[];
      agentId?: string;
      workspaceRoot?: string;
      clientTurnId?: string;
      planMode?: boolean;
      untrustedContext?: string;
      hiddenUserMessage?: boolean;
      onAccepted?: () => void;
    },
  ) => Promise<void>;
  readonly buildPlanImplementationPrompt: (
    approvedPlanMarkdown: string,
    approvedPlanRelativePath: string,
  ) => string;
  readonly ensureGatewayClientReady: () => Promise<void>;
  readonly requireGatewayClient: () => GatewayClientLike;
  readonly startApprovedPlanImplementation: (
    client: GatewayClientLike,
    sessionId: string,
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    artifact: CoworkPlanArtifactReference,
  ) => Promise<void>;
  readonly startRecoveredPlanRevision: (
    sessionId: string,
    request: PlanModeRequest,
    approvedPlanMarkdown: string,
    feedback: string | undefined,
  ) => void;
  readonly readPendingAskUserInteractions: (
    client: GatewayClientLike,
  ) => Promise<AskUserInteractionEnvelope[]>;
  readonly readPendingPlanModeInteractions: (
    client: GatewayClientLike,
    generation: number,
  ) => Promise<PlanModeInteractionEnvelope[]>;
  readonly isPlanModeInteraction: (
    interaction: CoworkInteractionEnvelope,
  ) => interaction is PlanModeInteractionEnvelope;
  readonly parseAskUserInteractionRequest: (
    interaction: AskUserInteractionEnvelope,
  ) => AskUserRequest | null;
  readonly resolvePlanModeInteraction: (
    pendingPlan: PlanModeRequest,
    response: { behavior: 'plan'; decision: 'implement' | 'revise' | 'cancel'; feedback?: string },
  ) => Promise<{ sessionId: string }>;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly toSessionKey: (sessionId: string, agentId?: string) => string;
}

export function resolveAskUserSessionId(
  this: RuntimePlanInteractionsContext,
  request: AskUserRequest,
): string {
  return request.sessionKey
    ? (this.resolveSessionIdBySessionKey(request.sessionKey) ?? '__askuser__')
    : '__askuser__';
}

export function resolvePlanModeSessionId(
  this: RuntimePlanInteractionsContext,
  request: PlanModeRequest,
): string {
  return this.resolveSessionIdBySessionKey(request.sessionKey) ?? '__planmode__';
}

export function toPlanModeInteraction(
  this: RuntimePlanInteractionsContext,
  request: PlanModeRequest,
): PlanModeInteractionEnvelope {
  const sessionId = this.resolvePlanModeSessionId(request);
  return {
    sessionId,
    request: {
      requestId: request.requestId,
      toolName: OpenClawToolName.PRESENT_PLAN,
      interactionKind: CoworkInteractionKind.PLAN_APPROVAL,
      toolInput: {
        plan: request.plan,
        ...(request.title ? { title: request.title } : {}),
        sessionKey: request.sessionKey,
        sessionId,
      },
    },
  };
}

export function isPlanModeInteraction(
  this: RuntimePlanInteractionsContext,
  interaction: CoworkInteractionEnvelope,
): interaction is PlanModeInteractionEnvelope {
  return interaction.request.interactionKind === CoworkInteractionKind.PLAN_APPROVAL;
}

export function toAskUserInteraction(
  this: RuntimePlanInteractionsContext,
  request: AskUserRequest,
): AskUserInteractionEnvelope {
  const sessionId = this.resolveAskUserSessionId(request);
  return {
    sessionId,
    request: {
      requestId: request.requestId,
      toolName: OpenClawToolName.ASK_USER_QUESTION,
      interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
      toolInput: {
        questions: request.questions,
        waitPolicy: request.waitPolicy,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        sessionId,
      },
    },
  };
}

export function parseAskUserInteractionRequest(
  this: RuntimePlanInteractionsContext,
  interaction: AskUserInteractionEnvelope,
): AskUserRequest | null {
  return parseAskUserRequest({
    requestId: interaction.request.requestId,
    ...interaction.request.toolInput,
  });
}

export function sendCoworkInteraction(
  this: RuntimePlanInteractionsContext,
  interaction: CoworkInteractionEnvelope,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(CoworkInteractionIpc.Stream, interaction);
    }
  }
}

export function sendAskUserDismiss(this: RuntimePlanInteractionsContext, requestId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(CoworkInteractionIpc.Dismiss, { requestId });
    }
  }
}

export function rememberTerminalAskUser(
  this: RuntimePlanInteractionsContext,
  requestId: string,
): void {
  this.terminalAskUserIds.add(requestId);
  while (this.terminalAskUserIds.size > ASK_USER_TERMINAL_CACHE_SIZE) {
    const oldestRequestId = this.terminalAskUserIds.values().next().value;
    if (typeof oldestRequestId !== 'string') break;
    this.terminalAskUserIds.delete(oldestRequestId);
  }
}

export function handleAskUserRequested(
  this: RuntimePlanInteractionsContext,
  payload: unknown,
): void {
  const request = parseAskUserRequest(payload);
  if (!request) {
    coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed AskUserQuestion request');
    return;
  }
  if (this.terminalAskUserIds.has(request.requestId)) return;
  this.pendingAskUserRequests.set(request.requestId, request);
  this.sendCoworkInteraction(this.toAskUserInteraction(request));
}

export function handleAskUserResolved(
  this: RuntimePlanInteractionsContext,
  payload: unknown,
): void {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== 'string' ||
    !payload.requestId.trim() ||
    !['answered', 'cancelled', 'timeout'].includes(String(payload.status))
  ) {
    return;
  }
  const requestId = payload.requestId.trim();
  this.rememberTerminalAskUser(requestId);
  if (!this.pendingAskUserRequests.delete(requestId)) return;
  this.sendAskUserDismiss(requestId);
}

export async function handlePlanModeRequested(
  this: RuntimePlanInteractionsContext,
  payload: unknown,
): Promise<void> {
  const request = parsePlanModeRequest(payload);
  if (!request) {
    coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed Plan mode request');
    return;
  }
  if (this.terminalAskUserIds.has(request.requestId)) return;
  const sessionId = this.resolvePlanModeSessionId(request);
  if (sessionId === '__planmode__') {
    const client = this.gatewayClient;
    const generation = this.gatewayClientGeneration;
    if (client) void this.cancelUnpersistedPlanRequest(client, generation, request);
    return;
  }
  try {
    this.persistAndVerifyPresentedPlan(sessionId, request);
  } catch (error) {
    coworkLog('ERROR', 'OpenClawRuntime', 'Failed to persist presented plan', {
      requestId: request.requestId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    const client = this.gatewayClient;
    const generation = this.gatewayClientGeneration;
    if (client) {
      void this.cancelUnpersistedPlanRequest(client, generation, request);
    }
    return;
  }
  const client = this.gatewayClient;
  const generation = this.gatewayClientGeneration;
  if (!client) {
    coworkLog('ERROR', 'OpenClawRuntime', 'Cannot durably admit Plan mode review', {
      requestId: request.requestId,
      sessionId,
      error: 'OpenClaw Gateway connection is unavailable.',
    });
    return;
  }
  try {
    await this.persistPlanReviewAdmission(client, sessionId, request);
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return;
  } catch (error) {
    coworkLog('ERROR', 'OpenClawRuntime', 'Failed to persist Plan mode review admission', {
      requestId: request.requestId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (await this.cancelUnpersistedPlanRequest(client, generation, request)) {
      const session = this.store.getSession(sessionId);
      try {
        await this.patchPlanModeState(client, request.sessionKey, session?.agentId, {
          enabled: true,
          updatedAt: Date.now(),
        });
        this.completePlanHandoffResolution(request.requestId);
      } catch (clearError) {
        coworkLog('WARN', 'OpenClawRuntime', 'Failed to clear rejected Plan review admission', {
          requestId: request.requestId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }
    }
    return;
  }
  this.pendingPlanModeRequests.set(request.requestId, request);
  this.sendCoworkInteraction(this.toPlanModeInteraction(request));
}

export async function cancelUnpersistedPlanRequest(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  generation: number,
  request: PlanModeRequest,
): Promise<boolean> {
  try {
    await client.request(PlanModeGateway.RESOLVE, {
      requestId: request.requestId,
      decision: 'cancel',
    });
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return false;
    this.rememberTerminalAskUser(request.requestId);
    this.pendingPlanModeRequests.delete(request.requestId);
    return true;
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to cancel unpersisted Plan mode request', {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function handlePlanModeResolved(
  this: RuntimePlanInteractionsContext,
  payload: unknown,
): Promise<void> {
  if (!isRecord(payload) || typeof payload.requestId !== 'string' || !payload.requestId.trim()) {
    return;
  }
  const requestId = payload.requestId.trim();
  if (this.planResolutionByRequestId.has(requestId)) return;
  const pendingPlan = this.pendingPlanModeRequests.get(requestId);
  const decision =
    payload.decision === 'implement' ||
    payload.decision === 'revise' ||
    payload.decision === 'cancel'
      ? payload.decision
      : undefined;
  if (!decision) return;
  const handoff = this.store.getPlanHandoff(requestId);
  // The approval path keeps Plan mode read-only until the planning run has
  // ended and sessions.reset has installed the same-session context boundary.
  if (decision === 'implement' && handoff?.state === CoworkPlanHandoffState.Dispatching) return;
  const sessionId = pendingPlan ? this.resolvePlanModeSessionId(pendingPlan) : handoff?.sessionId;
  const sessionKey = pendingPlan?.sessionKey ?? handoff?.planningSessionKey;
  if (sessionId && sessionKey) {
    const client = this.gatewayClient;
    if (!client) return;
    const generation = this.gatewayClientGeneration;
    const session = this.store.getSession(sessionId);
    try {
      await this.patchPlanModeState(client, sessionKey, session?.agentId, {
        enabled: decision !== 'implement',
        updatedAt: Date.now(),
      });
    } catch (error) {
      coworkLog('WARN', 'OpenClawRuntime', 'Failed to clear Plan mode review admission', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return;
  }
  try {
    this.completePlanHandoffResolution(requestId);
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to persist Plan mode resolution', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  this.rememberTerminalAskUser(requestId);
  if (!this.pendingPlanModeRequests.delete(requestId)) return;
  this.sendAskUserDismiss(requestId);
}

export async function readPendingAskUserInteractions(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
): Promise<AskUserInteractionEnvelope[]> {
  const result = await client.request(AskUserQuestionGateway.LIST, {});
  if (!isRecord(result) || !Array.isArray(result.requests)) {
    throw new Error('AskUserQuestion list returned an invalid payload.');
  }
  const interactions: AskUserInteractionEnvelope[] = [];
  for (const [index, rawRequest] of result.requests.entries()) {
    const request = parseAskUserRequest(rawRequest);
    if (!request) {
      coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed AskUserQuestion list entry', {
        index,
      });
      continue;
    }
    if (this.terminalAskUserIds.has(request.requestId)) continue;
    interactions.push(this.toAskUserInteraction(request));
  }
  return interactions;
}

export async function readPendingPlanModeInteractions(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  generation: number,
): Promise<PlanModeInteractionEnvelope[]> {
  const result = await client.request(PlanModeGateway.LIST, {});
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
  if (!isRecord(result) || !Array.isArray(result.requests)) return [];
  const interactions: PlanModeInteractionEnvelope[] = [];
  const planRequests = result.requests;
  const parsedRequests = new Map<string, PlanModeRequest>();
  for (const [index, rawRequest] of planRequests.entries()) {
    const request = parsePlanModeRequest(rawRequest);
    if (!request) {
      coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed Plan mode list entry', { index });
      continue;
    }
    parsedRequests.set(request.requestId, request);
  }

  for (const handoff of this.store.listRecoverablePlanHandoffs()) {
    const request = parsedRequests.get(handoff.planId);
    if (handoff.state === CoworkPlanHandoffState.Admitted) {
      parsedRequests.delete(handoff.planId);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
      const session = this.store.getSession(handoff.sessionId);
      try {
        await this.patchPlanModeState(client, handoff.planningSessionKey, session?.agentId, {
          enabled: false,
          updatedAt: Date.now(),
          awaitingReview: {
            version: 1,
            requestId: handoff.planId,
            persistedAt: handoff.createdAt,
          },
        });
        if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
          return [];
        }
      } catch (error) {
        if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
          return [];
        }
        coworkLog('WARN', 'OpenClawRuntime', 'Failed to finalize admitted Plan mode state', {
          requestId: handoff.planId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (request) {
        try {
          await client.request(PlanModeGateway.RESOLVE, {
            requestId: request.requestId,
            decision: 'implement',
          });
          if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
            return [];
          }
        } catch (error) {
          let requestIsMissing = false;
          try {
            requestIsMissing = await this.isPlanRequestMissing(
              client,
              generation,
              request.requestId,
            );
          } catch (missingCheckError) {
            coworkLog('WARN', 'OpenClawRuntime', 'Failed to check admitted Plan request', {
              requestId: request.requestId,
              error:
                missingCheckError instanceof Error
                  ? missingCheckError.message
                  : String(missingCheckError),
            });
          }
          coworkLog('WARN', 'OpenClawRuntime', 'Failed to finish admitted Plan mode handoff', {
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
            return [];
          }
          if (!requestIsMissing) continue;
        }
      }
      try {
        await this.patchPlanModeState(client, handoff.planningSessionKey, session?.agentId, {
          enabled: false,
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
          return [];
        }
        coworkLog('WARN', 'OpenClawRuntime', 'Failed to clear admitted Plan review marker', {
          requestId: handoff.planId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
      this.completePlanHandoffResolution(handoff.planId);
      this.rememberTerminalAskUser(handoff.planId);
      this.pendingPlanModeRequests.delete(handoff.planId);
      this.sendAskUserDismiss(handoff.planId);
      continue;
    }

    if (!this.approvedPlanArtifactStore) continue;
    try {
      const session = this.store.getSession(handoff.sessionId);
      if (!session?.cwd) {
        throw new Error('Approved plan workspace is unavailable.');
      }
      let markdown: string;
      try {
        markdown = this.approvedPlanArtifactStore.readVerified(
          handoff.artifact.workspaceRoot,
          handoff.artifact,
        );
      } catch (readError) {
        const gatewayRequest = parsedRequests.get(handoff.planId);
        if (!gatewayRequest) throw readError;
        const normalizedGatewayPlan = gatewayRequest.plan.replace(/\r\n?/g, '\n');
        const gatewayPlanContent = Buffer.from(normalizedGatewayPlan, 'utf8');
        if (
          gatewayPlanContent.byteLength !== handoff.artifact.byteLength ||
          createHash('sha256').update(gatewayPlanContent).digest('hex') !== handoff.artifact.sha256
        ) {
          throw readError;
        }
        const restoredReference = this.approvedPlanArtifactStore.publish({
          workspaceRoot: handoff.artifact.workspaceRoot,
          sessionId: handoff.sessionId,
          planId: handoff.planId,
          markdown: normalizedGatewayPlan,
        });
        if (
          restoredReference.workspaceRoot !== handoff.artifact.workspaceRoot ||
          restoredReference.relativePath !== handoff.artifact.relativePath ||
          restoredReference.sha256 !== handoff.artifact.sha256 ||
          restoredReference.byteLength !== handoff.artifact.byteLength
        ) {
          throw readError;
        }
        markdown = this.approvedPlanArtifactStore.readVerified(
          restoredReference.workspaceRoot,
          restoredReference,
        );
      }
      const recoveredRequest: PlanModeRequest = {
        requestId: handoff.planId,
        sessionKey: handoff.planningSessionKey,
        plan: markdown,
      };
      await this.persistPlanReviewAdmission(client, handoff.sessionId, recoveredRequest);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
      parsedRequests.delete(handoff.planId);
      interactions.push(this.toPlanModeInteraction(recoveredRequest));
    } catch (error) {
      // Keep the Gateway request pending for a later recovery attempt. Do not
      // route it through the unpersisted-request cancellation path below.
      parsedRequests.delete(handoff.planId);
      coworkLog('ERROR', 'OpenClawRuntime', 'Failed to recover persisted Plan mode request', {
        requestId: handoff.planId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const request of parsedRequests.values()) {
    if (this.terminalAskUserIds.has(request.requestId)) continue;
    const sessionId = this.resolvePlanModeSessionId(request);
    if (sessionId === '__planmode__') {
      await this.cancelUnpersistedPlanRequest(client, generation, request);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
      continue;
    }
    try {
      const persisted = this.persistAndVerifyPresentedPlan(sessionId, request);
      await this.persistPlanReviewAdmission(client, sessionId, request);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
      interactions.push(
        this.toPlanModeInteraction({
          ...request,
          plan: persisted.markdown,
        }),
      );
    } catch (error) {
      coworkLog('ERROR', 'OpenClawRuntime', 'Failed to persist recovered Plan mode request', {
        requestId: request.requestId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.cancelUnpersistedPlanRequest(client, generation, request);
      if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
    }
  }
  return interactions;
}

export function persistAndVerifyPresentedPlan(
  this: RuntimePlanInteractionsContext,
  sessionId: string,
  request: PlanModeRequest,
): { handoff: CoworkPlanHandoff; markdown: string } {
  if (!this.approvedPlanArtifactStore) {
    throw new Error('Approved plan artifact storage is unavailable.');
  }
  const session = this.store.getSession(sessionId);
  if (!session?.cwd || !path.isAbsolute(session.cwd)) {
    throw new Error('Approved plan workspace is unavailable.');
  }
  const existingHandoff = this.store.getPlanHandoff(request.requestId);
  if (existingHandoff?.artifact.workspaceRoot) {
    const existingMarkdown = this.approvedPlanArtifactStore.readVerified(
      existingHandoff.artifact.workspaceRoot,
      existingHandoff.artifact,
    );
    if (existingMarkdown !== request.plan.replace(/\r\n?/g, '\n')) {
      throw new Error('This plan handoff already refers to different immutable content.');
    }
    return { handoff: existingHandoff, markdown: existingMarkdown };
  }
  try {
    this.approvedPlanArtifactStore.cleanupStaleTemporaryFiles?.(session.cwd);
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to clean stale approved-plan artifacts', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const reference = this.approvedPlanArtifactStore.publish({
    workspaceRoot: session.cwd,
    sessionId,
    planId: request.requestId,
    markdown: request.plan,
  });
  const handoff = this.store.createPlanHandoff({
    sessionId,
    planId: request.requestId,
    planningSessionKey: request.sessionKey,
    artifact: reference,
    presentedAt: Date.now(),
  });
  return {
    handoff,
    markdown: this.approvedPlanArtifactStore.readVerified(session.cwd, handoff.artifact),
  };
}

export function buildPlanImplementationPrompt(
  this: RuntimePlanInteractionsContext,
  approvedPlanMarkdown: string,
  approvedPlanRelativePath: string,
): string {
  return [
    'Implement the plan.',
    '',
    `Plan file: ${approvedPlanRelativePath.replaceAll('\\', '/')}`,
    '',
    '<plan>',
    approvedPlanMarkdown,
    '</plan>',
  ].join('\n');
}

export function buildPlanRevisionPrompt(
  this: RuntimePlanInteractionsContext,
  request: PlanModeRequest,
  approvedPlanMarkdown: string,
  feedback: string | undefined,
): string {
  return [
    'Reopen planning for the previous plan below.',
    'Inspect any additional context needed, revise the plan using the user feedback, and present the complete revised plan for approval.',
    '',
    ...(feedback?.trim() ? ['User feedback:', feedback.trim(), ''] : []),
    '<previous_plan>',
    approvedPlanMarkdown,
    '</previous_plan>',
  ].join('\n');
}

export function startRecoveredPlanRevision(
  this: RuntimePlanInteractionsContext,
  sessionId: string,
  request: PlanModeRequest,
  approvedPlanMarkdown: string,
  feedback: string | undefined,
): void {
  const session = this.store.getSession(sessionId);
  if (!session) return;
  void this.startSession(
    sessionId,
    this.buildPlanRevisionPrompt(request, approvedPlanMarkdown, feedback),
    {
      workspaceRoot: session.cwd,
      agentId: session.agentId || DEFAULT_MANAGED_AGENT_ID,
      planMode: true,
      clientTurnId: `justdo-plan-revision-${request.requestId}`,
    },
  ).catch(error => {
    coworkLog('ERROR', 'OpenClawRuntime', 'Failed to start recovered Plan mode revision', {
      requestId: request.requestId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function stopPlanningTurnForImplementation(
  this: RuntimePlanInteractionsContext,
  sessionId: string,
  planningTurn: SessionTurn | undefined,
): Promise<void> {
  if (!planningTurn || this.activeTurns.get(sessionId) !== planningTurn) return;
  coworkLog('INFO', 'OpenClawRuntime', 'Stopping planning turn after plan approval', {
    sessionId,
    runId: planningTurn.runId,
  });
  await this.stopSessionInternal(sessionId, {}, false);
}

export async function startApprovedPlanImplementation(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  sessionId: string,
  request: PlanModeRequest,
  approvedPlanMarkdown: string,
  artifact: CoworkPlanArtifactReference,
): Promise<void> {
  const generation = this.gatewayClientGeneration;
  if (client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed before plan implementation dispatch.');
  }
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const workspaceRoot = artifact.workspaceRoot;
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error('Approved plan workspace is unavailable.');
  }
  const agentId = session.agentId || DEFAULT_MANAGED_AGENT_ID;
  const sessionKey = request.sessionKey;
  const currentHandoff = this.store.getPlanHandoff(request.requestId);
  if (!currentHandoff) throw new Error('Plan handoff not found.');
  if (
    currentHandoff.state === CoworkPlanHandoffState.Admitted ||
    currentHandoff.state === CoworkPlanHandoffState.Resolved
  ) {
    return;
  }
  const dispatchingHandoff =
    currentHandoff.state === CoworkPlanHandoffState.Dispatching
      ? currentHandoff
      : this.store.transitionPlanHandoff({
          planId: request.requestId,
          expectedState: currentHandoff.state,
          nextState: CoworkPlanHandoffState.Dispatching,
          implementationSessionKey: sessionKey,
          transitionedAt: Date.now(),
        });
  if (dispatchingHandoff.implementationSessionKey !== sessionKey) {
    throw new Error('Plan handoff targets another OpenClaw session.');
  }

  const implementationRunId = `justdo-plan-implementation-${request.requestId}`;
  const activeTurn = this.activeTurns.get(sessionId);
  if (activeTurn?.sessionKey === sessionKey && activeTurn.knownRunIds.has(implementationRunId)) {
    const described = await client.request<{ session?: Record<string, unknown> | null }>(
      'sessions.describe',
      { key: sessionKey },
    );
    const gatewaySessionId =
      typeof described.session?.sessionId === 'string' ? described.session.sessionId.trim() : '';
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
      throw new Error(
        'OpenClaw Gateway connection changed while recovering plan implementation admission.',
      );
    }
    if (!gatewaySessionId) {
      throw new Error('OpenClaw did not return the implementation session identity.');
    }
    this.store.transitionPlanHandoff({
      planId: request.requestId,
      expectedState: CoworkPlanHandoffState.Dispatching,
      nextState: CoworkPlanHandoffState.Admitted,
      implementationGatewaySessionId: gatewaySessionId,
      implementationRunId: activeTurn.runId,
      transitionedAt: Date.now(),
    });
    this.invalidateRuntimeSessionSnapshot();
    return;
  }

  const planningTurn = this.activeTurns.get(sessionId);
  let result: unknown;
  try {
    result = await client.request(PlanModeGateway.RESOLVE, {
      requestId: request.requestId,
      decision: 'implement',
    });
  } catch (error) {
    const requestIsMissing = await this.isPlanRequestMissing(
      client,
      generation,
      request.requestId,
    ).catch(() => false);
    if (!requestIsMissing) throw error;
    result = { requestId: request.requestId, decision: 'implement' };
  }
  if (
    !isRecord(result) ||
    result.requestId !== request.requestId ||
    result.decision !== 'implement'
  ) {
    throw new Error('Plan mode resolve returned an invalid payload.');
  }
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed while approving the plan.');
  }

  await this.stopPlanningTurnForImplementation(sessionId, planningTurn);

  const described = await client.request<{ session?: Record<string, unknown> | null }>(
    'sessions.describe',
    { key: sessionKey },
  );
  const previousGatewaySessionId =
    typeof described.session?.sessionId === 'string' ? described.session.sessionId.trim() : '';
  if (!previousGatewaySessionId) {
    throw new Error('OpenClaw did not return the planning session identity.');
  }
  const reset = await client.request<{
    ok?: unknown;
    key?: unknown;
    entry?: Record<string, unknown>;
  }>('sessions.reset', {
    key: sessionKey,
    agentId,
    reason: 'reset',
  });
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed while resetting plan context.');
  }
  const resetKey = typeof reset.key === 'string' ? reset.key.trim() : '';
  const resetGatewaySessionId =
    typeof reset.entry?.sessionId === 'string' ? reset.entry.sessionId.trim() : '';
  if (
    reset.ok !== true ||
    resetKey !== sessionKey ||
    resetGatewaySessionId !== previousGatewaySessionId
  ) {
    throw new Error('OpenClaw did not preserve the session identity while resetting plan context.');
  }

  let admitted = false;
  let resolveAdmission!: () => void;
  let rejectAdmission!: (error: Error) => void;
  const admission = new Promise<void>((resolve, reject) => {
    resolveAdmission = resolve;
    rejectAdmission = reject;
  });
  void this.runTurn(
    sessionId,
    this.buildPlanImplementationPrompt(approvedPlanMarkdown, artifact.relativePath),
    {
      workspaceRoot,
      agentId,
      clientTurnId: implementationRunId,
      planMode: false,
      hiddenUserMessage: true,
      onAccepted: () => {
        admitted = true;
        resolveAdmission();
      },
    },
  ).catch(error => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (!admitted) rejectAdmission(normalized);
    else {
      coworkLog('ERROR', 'OpenClawRuntime', 'Approved plan implementation failed', {
        requestId: request.requestId,
        sessionId,
        error: normalized.message,
      });
    }
  });
  await admission;

  const acceptedRunId = this.activeTurns.get(sessionId)?.runId ?? implementationRunId;
  this.store.transitionPlanHandoff({
    planId: request.requestId,
    expectedState: CoworkPlanHandoffState.Dispatching,
    nextState: CoworkPlanHandoffState.Admitted,
    implementationGatewaySessionId: resetGatewaySessionId,
    implementationRunId: acceptedRunId,
    transitionedAt: Date.now(),
  });
  this.invalidateRuntimeSessionSnapshot();
}

export function completePlanHandoffResolution(
  this: RuntimePlanInteractionsContext,
  planId: string,
): void {
  const handoff = this.store.getPlanHandoff(planId);
  if (
    handoff &&
    (handoff.state === CoworkPlanHandoffState.Presented ||
      handoff.state === CoworkPlanHandoffState.Admitted ||
      handoff.state === CoworkPlanHandoffState.Failed)
  ) {
    this.store.transitionPlanHandoff({
      planId,
      expectedState: handoff.state,
      nextState: CoworkPlanHandoffState.Resolved,
      transitionedAt: Date.now(),
    });
  }
}

export async function isPlanRequestMissing(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  generation: number,
  requestId: string,
): Promise<boolean> {
  const result = await client.request(PlanModeGateway.LIST, {});
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed while resolving the plan.');
  }
  if (!isRecord(result) || !Array.isArray(result.requests)) return false;
  return !result.requests.some(
    candidate => parsePlanModeRequest(candidate)?.requestId === requestId,
  );
}

export async function resolvePlanModeInteraction(
  this: RuntimePlanInteractionsContext,
  pendingPlan: PlanModeRequest,
  response: { behavior: 'plan'; decision: 'implement' | 'revise' | 'cancel'; feedback?: string },
): Promise<{ sessionId: string }> {
  const requestId = pendingPlan.requestId;
  const sessionId = this.resolvePlanModeSessionId(pendingPlan);
  const persisted = this.persistAndVerifyPresentedPlan(sessionId, pendingPlan);
  await this.ensureGatewayClientReady();
  const client = this.requireGatewayClient();
  const generation = this.gatewayClientGeneration;
  const currentHandoff = this.store.getPlanHandoff(requestId) ?? persisted.handoff;

  if (
    currentHandoff.state === CoworkPlanHandoffState.Dispatching &&
    response.decision !== 'implement'
  ) {
    throw new Error(
      'Implementation dispatch is awaiting confirmation. Retry implementation before revising or cancelling this plan.',
    );
  }

  if (response.decision === 'implement') {
    if (
      currentHandoff.state !== CoworkPlanHandoffState.Admitted &&
      currentHandoff.state !== CoworkPlanHandoffState.Resolved
    ) {
      await this.startApprovedPlanImplementation(
        client,
        sessionId,
        pendingPlan,
        persisted.markdown,
        persisted.handoff.artifact,
      );
    }
    if (this.store.getPlanHandoff(requestId)?.state !== CoworkPlanHandoffState.Resolved) {
      this.completePlanHandoffResolution(requestId);
    }
    this.rememberTerminalAskUser(requestId);
    if (this.pendingPlanModeRequests.delete(requestId)) this.sendAskUserDismiss(requestId);
    return { sessionId };
  }

  let result: unknown;
  let startRecoveredRevision = false;
  try {
    result = await client.request(PlanModeGateway.RESOLVE, {
      requestId,
      decision: response.decision,
      ...(response.feedback?.trim() ? { feedback: response.feedback.trim() } : {}),
    });
  } catch (error) {
    const requestIsMissing = await this.isPlanRequestMissing(client, generation, requestId).catch(
      () => false,
    );
    if (!requestIsMissing) throw error;
    startRecoveredRevision = response.decision === 'revise';
    result = { requestId, decision: response.decision };
  }
  if (
    !isRecord(result) ||
    result.requestId !== requestId ||
    result.decision !== response.decision
  ) {
    throw new Error('Plan mode resolve returned an invalid payload.');
  }
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed while resolving the plan.');
  }

  const session = this.store.getSession(sessionId);
  await this.patchPlanModeState(client, pendingPlan.sessionKey, session?.agentId, {
    enabled: true,
    updatedAt: Date.now(),
  });
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed while finalizing the plan.');
  }
  this.completePlanHandoffResolution(requestId);
  this.rememberTerminalAskUser(requestId);
  if (this.pendingPlanModeRequests.delete(requestId)) this.sendAskUserDismiss(requestId);
  if (startRecoveredRevision) {
    this.startRecoveredPlanRevision(sessionId, pendingPlan, persisted.markdown, response.feedback);
  }
  return { sessionId };
}

export async function listPendingAskUserInteractions(
  this: RuntimePlanInteractionsContext,
): Promise<Array<AskUserInteractionEnvelope | PlanModeInteractionEnvelope>> {
  await this.ensureGatewayClientReady();
  const client = this.requireGatewayClient();
  const generation = this.gatewayClientGeneration;
  const askUserInteractions = await this.readPendingAskUserInteractions(client);
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
  const planModeInteractions = await this.readPendingPlanModeInteractions(client, generation).catch(
    (): PlanModeInteractionEnvelope[] => [],
  );
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return [];
  const interactions = [...askUserInteractions, ...planModeInteractions];
  for (const interaction of interactions) {
    if (this.isPlanModeInteraction(interaction)) {
      const request = parsePlanModeRequest({
        requestId: interaction.request.requestId,
        ...interaction.request.toolInput,
      });
      if (request) this.pendingPlanModeRequests.set(request.requestId, request);
      continue;
    }
    const request = this.parseAskUserInteractionRequest(interaction);
    if (request) this.pendingAskUserRequests.set(request.requestId, request);
  }
  return interactions;
}

export async function resolveAskUserInteraction(
  this: RuntimePlanInteractionsContext,
  requestId: string,
  response:
    | { behavior: 'submit'; answers: unknown }
    | { behavior: 'cancel' }
    | { behavior: 'plan'; decision: 'implement' | 'revise' | 'cancel'; feedback?: string },
): Promise<{ sessionId: string }> {
  const normalizedRequestId = requestId.trim();
  const pendingPlan = this.pendingPlanModeRequests.get(normalizedRequestId);
  if (pendingPlan) {
    if (response.behavior !== 'plan') throw new Error('Invalid Plan mode review response.');
    const current = this.planResolutionByRequestId.get(normalizedRequestId);
    if (current) return current;
    const resolving = this.resolvePlanModeInteraction(pendingPlan, response).finally(() => {
      if (this.planResolutionByRequestId.get(normalizedRequestId) === resolving) {
        this.planResolutionByRequestId.delete(normalizedRequestId);
      }
    });
    this.planResolutionByRequestId.set(normalizedRequestId, resolving);
    return resolving;
  }
  const pending = this.pendingAskUserRequests.get(normalizedRequestId);
  if (!normalizedRequestId || !pending) {
    throw new Error('This question is not an active JustDo AskUserQuestion interaction.');
  }
  if (response.behavior === 'plan') throw new Error('Invalid AskUserQuestion response.');
  const answers =
    response.behavior === 'submit'
      ? parseAskUserAnswers(response.answers, pending.questions)
      : undefined;
  if (response.behavior === 'submit' && !answers) {
    throw new Error('The submitted answers do not match the pending question.');
  }
  await this.ensureGatewayClientReady();
  const client = this.requireGatewayClient();
  const result = await client.request(AskUserQuestionGateway.RESOLVE, {
    requestId: normalizedRequestId,
    behavior: response.behavior,
    ...(answers ? { answers } : {}),
  });
  if (
    !isRecord(result) ||
    result.requestId !== normalizedRequestId ||
    !['answered', 'cancelled'].includes(String(result.status))
  ) {
    throw new Error('AskUserQuestion resolve returned an invalid payload.');
  }
  this.rememberTerminalAskUser(normalizedRequestId);
  if (this.pendingAskUserRequests.delete(normalizedRequestId)) {
    this.sendAskUserDismiss(normalizedRequestId);
  }
  return { sessionId: this.resolveAskUserSessionId(pending) };
}

export async function reconcilePendingAskUserInteractions(
  this: RuntimePlanInteractionsContext,
  generation: number,
): Promise<void> {
  const client = this.gatewayClient;
  if (!client) return;
  try {
    const askUserInteractions = await this.readPendingAskUserInteractions(client);
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return;
    const planModeInteractions = await this.readPendingPlanModeInteractions(
      client,
      generation,
    ).catch((): PlanModeInteractionEnvelope[] => []);
    if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) return;
    const interactions = [...askUserInteractions, ...planModeInteractions];
    for (const interaction of interactions) {
      if (!this.terminalAskUserIds.has(interaction.request.requestId)) {
        if (this.isPlanModeInteraction(interaction)) {
          const request = parsePlanModeRequest({
            requestId: interaction.request.requestId,
            ...interaction.request.toolInput,
          });
          if (!request) continue;
          this.pendingPlanModeRequests.set(request.requestId, request);
          this.sendCoworkInteraction(interaction);
          continue;
        }
        const request = this.parseAskUserInteractionRequest(interaction);
        if (!request) continue;
        this.pendingAskUserRequests.set(request.requestId, request);
        this.sendCoworkInteraction(interaction);
      }
    }
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to recover pending AskUserQuestion requests', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function dismissAllAskUserInteractions(this: RuntimePlanInteractionsContext): void {
  for (const requestId of this.pendingAskUserRequests.keys()) {
    this.sendAskUserDismiss(requestId);
  }
  this.pendingAskUserRequests.clear();
  for (const requestId of this.pendingPlanModeRequests.keys()) {
    this.sendAskUserDismiss(requestId);
  }
  this.pendingPlanModeRequests.clear();
  this.terminalAskUserIds.clear();
}

export async function patchPlanModeState(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  sessionKey: string,
  agentId: string | undefined,
  state: PlanModeState,
): Promise<void> {
  const result = await client.request('sessions.pluginPatch', {
    key: sessionKey,
    ...(agentId ? { agentId } : {}),
    pluginId: OpenClawExtensionId.PLAN_MODE,
    namespace: 'state',
    value: state,
  });
  if (!isRecord(result) || result.ok !== true) {
    throw new Error('OpenClaw did not persist the requested Plan mode.');
  }
  this.invalidateRuntimeSessionSnapshot();
}

export async function persistPlanReviewAdmission(
  this: RuntimePlanInteractionsContext,
  client: GatewayClientLike,
  sessionId: string,
  request: PlanModeRequest,
): Promise<void> {
  const persistedAt = Date.now();
  const session = this.store.getSession(sessionId);
  await this.patchPlanModeState(client, request.sessionKey, session?.agentId, {
    enabled: true,
    updatedAt: persistedAt,
    awaitingReview: {
      version: 1,
      requestId: request.requestId,
      persistedAt,
    },
  });
}

export async function setPlanMode(
  this: RuntimePlanInteractionsContext,
  sessionId: string,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (enabled && this.isSessionActive(sessionId)) {
    throw new Error('Plan mode cannot be changed while the session is running.');
  }
  await this.ensureGatewayClientReady();
  if (enabled && this.isSessionActive(sessionId)) {
    throw new Error('Plan mode cannot be changed while the session is running.');
  }
  const agentId = session.agentId || DEFAULT_MANAGED_AGENT_ID;
  const sessionKey = this.toSessionKey(sessionId, agentId);
  await this.patchPlanModeState(this.requireGatewayClient(), sessionKey, agentId, {
    enabled,
    updatedAt: Date.now(),
  });
  return { enabled };
}

export async function getPlanMode(
  this: RuntimePlanInteractionsContext,
  sessionId: string,
): Promise<{ enabled: boolean }> {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  await this.ensureGatewayClientReady();
  const agentId = session.agentId || DEFAULT_MANAGED_AGENT_ID;
  const sessionKey = this.toSessionKey(sessionId, agentId);
  const result = await this.requireGatewayClient().request<{ session?: Record<string, unknown> }>(
    'sessions.describe',
    { key: sessionKey },
  );
  const pluginExtensions = Array.isArray(result.session?.pluginExtensions)
    ? result.session.pluginExtensions
    : [];
  const extension = pluginExtensions.find(
    candidate =>
      isRecord(candidate) &&
      candidate.pluginId === OpenClawExtensionId.PLAN_MODE &&
      candidate.namespace === 'state',
  );
  return {
    enabled: parsePlanModeState(isRecord(extension) ? extension.value : undefined).enabled,
  };
}
