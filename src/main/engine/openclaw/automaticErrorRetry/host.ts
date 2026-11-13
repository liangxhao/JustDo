import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';

import {
  AutomaticErrorRetryIpc,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryPresentation,
  isAutomaticErrorRetryActive,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { CoworkStore } from '../../../data/coworkStore';
import { assertStorageExecutionAdmission } from '../../../storage/relocationAdmission';
import type { GatewayClientLike, NativeRunTerminalReceipt } from '../../gateway/types';
import type { CoworkAutomaticErrorRetryOwner, CoworkNativeAcceptedBinding } from '../../types';
import type { ExecutionSuccessorClaims } from '../executionSuccessorClaims';
import {
  type AutomaticErrorRetryBinding,
  AutomaticErrorRetryCoordinator,
  type AutomaticErrorRetryLaunchRequest,
  type AutomaticErrorRetrySettledReceipt,
  type AutomaticErrorRetryWaitReceipt,
} from './coordinator';
import { readAutomaticErrorRetryFailureCode } from './failureCode';
import { SESSION_READER_RETRY_RULE_ID } from './rules';
import { logSessionReaderRecovery } from './sessionReaderRecoveryLog';

interface HostDependencies {
  store: CoworkStore;
  successorClaims: Pick<ExecutionSuccessorClaims, 'claim' | 'release'>;
  getClient: () => GatewayClientLike | null;
  getGeneration: () => number;
  sessionKey: (sessionId: string) => string;
  isBlocked: (sessionId: string) => boolean;
  prepare: (sessionId: string) => Promise<void>;
  beforeSuccessor: (sessionId: string, predecessorRunId: string) => void;
  beginRun: (sessionId: string, binding: AutomaticErrorRetryBinding, runId: string) => void;
  confirmed: (sessionId: string, runId: string) => void;
  rejected: (sessionId: string, runId: string, predecessorRunId: string) => void;
  unknown: (sessionId: string, runId: string) => void;
  adoptTechnicalRun: (sessionId: string, predecessorRunId: string, runId: string, nativeSessionId: string) => boolean;
  unclaimed: (receipt: AutomaticErrorRetrySettledReceipt) => void;
  isResponseError: (error: unknown) => boolean;
  onPresentation?: (presentation: AutomaticErrorRetryPresentation) => void;
  retryDelayMs?: number;
}

const sourceIdentity = (store: CoworkStore, sessionId: string): string => {
  const session = store.getSession(sessionId);
  return JSON.stringify(session && [session.agentId, session.cwd, session.permissionMode,
    session.modelRef, session.activeSkillIds, session.nativeSessionKey, session.historyBinding, session.external,
    session.nativeParentSessionId]);
};

/** Application transport adapter. The policy coordinator has no Goal dependencies. */
export class AutomaticErrorRetryHost {
  readonly coordinator: AutomaticErrorRetryCoordinator;
  private readonly sources = new Map<string, {
    client: GatewayClientLike; generation: number; identity: string;
    owner?: CoworkAutomaticErrorRetryOwner;
    confirmedSuccessors: Set<string>;
  }>();
  private readonly presentations = new Map<string, AutomaticErrorRetryPresentation>();
  private revision = Date.now();

  constructor(private readonly dependencies: HostDependencies) {
    this.coordinator = new AutomaticErrorRetryCoordinator({
      retryDelayMs: dependencies.retryDelayMs,
      readFailureCode: (binding, receipt, signal) => {
        const client = dependencies.getClient();
        return client ? readAutomaticErrorRetryFailureCode(client, binding, receipt, signal,
          { userInputRunId: binding.clientTurnId })
          : Promise.resolve(null);
      },
      isCurrent: binding => this.isCurrent(binding),
      reserveSuccessor: (binding, predecessor) => dependencies.successorClaims.claim(predecessor, binding.sessionId),
      releaseSuccessor: (binding, predecessor) => dependencies.successorClaims.release(predecessor, binding.sessionId),
      launchSuccessor: async request => {
        const result = await this.launch(request);
        if (request.ruleId === SESSION_READER_RETRY_RULE_ID) {
          logSessionReaderRecovery({
            sessionId: request.binding.sessionId,
            runId: request.predecessorRunId,
            successorRunId: request.runId,
          }, { stage: 'continuation', outcome: result.status });
        }
        return result;
      },
      onChanged: presentation => {
        this.publish(presentation);
        const { sessionId, chainId, phase } = presentation;
        if ((phase === AutomaticErrorRetryPhase.Completed || phase === AutomaticErrorRetryPhase.Failed ||
            phase === AutomaticErrorRetryPhase.Cancelled) && this.sources.get(sessionId)?.owner &&
            !this.coordinator.getTurn(sessionId, chainId)?.outstandingLaunch) this.sources.delete(sessionId);
      },
      onUnclaimedSettled: receipt => dependencies.unclaimed(receipt),
      createRunId: () => randomUUID(),
    });
  }

  async arm(sessionId: string, clientTurnId: string, expectedNativeSessionId?: string, owner?: CoworkAutomaticErrorRetryOwner): Promise<void> {
    this.cancel(sessionId);
    const { store } = this.dependencies;
    const session = store.getSession(sessionId);
    const maxContinuations = store.getAgentRuntimeSettings().automaticErrorRetry.maxContinuations;
    const client = this.dependencies.getClient();
    if (!client || !maxContinuations || !session || session.external ||
      session.nativeParentSessionId || session.branchCreationPending || !expectedNativeSessionId ||
      this.dependencies.isBlocked(sessionId) || (owner && !owner.isCurrent())) return;
    const sessionKey = this.dependencies.sessionKey(sessionId);
    if (!/^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey)) return;
    const captured = {
      client, generation: this.dependencies.getGeneration(),
      identity: sourceIdentity(store, sessionId),
      owner,
      confirmedSuccessors: new Set<string>(),
    };
    this.sources.set(sessionId, captured);
    try {
      const result = await client.request<{ session?: Record<string, unknown> }>(
        'sessions.describe', { key: sessionKey },
      );
      const native = result.session;
      if (this.sources.get(sessionId) !== captured || captured.client !== this.dependencies.getClient() ||
        captured.generation !== this.dependencies.getGeneration() ||
        captured.identity !== sourceIdentity(store, sessionId) || (owner && !owner.isCurrent()) ||
        store.getLatestSessionRun(sessionId)?.clientTurnId !== clientTurnId ||
        native?.key !== sessionKey || native.sessionId !== expectedNativeSessionId ||
        typeof native.lifecycleRevision !== 'string' || !native.lifecycleRevision ||
        native.spawnedBy || native.subagentRole || native.acp || native.inheritedToolAllow ||
        native.inheritedToolDeny || native.toolsAllow) {
        if (this.sources.get(sessionId) === captured) this.sources.delete(sessionId);
        return;
      }
      const armed = this.coordinator.arm({
        sessionId, clientTurnId, runId: clientTurnId, sessionKey,
        nativeSessionId: native.sessionId as string,
        lifecycleRevision: native.lifecycleRevision,
        clientGeneration: captured.generation, maxContinuations,
      });
      if (!armed && this.sources.get(sessionId) === captured) this.sources.delete(sessionId);
    } catch {
      // Read-only eligibility failure must not break the user's ordinary send.
      if (this.sources.get(sessionId) === captured) this.sources.delete(sessionId);
    }
  }

  acceptInitialRun(sessionId: string, accepted: CoworkNativeAcceptedBinding): boolean {
    if (!this.sources.get(sessionId)?.owner) return false;
    return this.coordinator.rebindInitialRun({
      sessionId,
      sessionKey: accepted.sessionKey,
      nativeSessionId: accepted.nativeSessionId,
      lifecycleRevision: accepted.lifecycleRevision,
      clientGeneration: accepted.clientGeneration,
      clientTurnId: accepted.clientTurnId,
      runId: accepted.nativeRunId,
    });
  }

  cancel(sessionId: string): void {
    const owner = this.sources.get(sessionId)?.owner;
    const turn = owner ? this.coordinator.getPresentation(sessionId) : null;
    this.sources.delete(sessionId);
    if (turn) this.coordinator.cancelTurn(sessionId, turn.chainId);
    else this.coordinator.cancel(sessionId);
  }

  clear(): void {
    this.sources.clear();
    this.coordinator.clear();
    for (const [sessionId, presentation] of this.presentations) {
      if (!isAutomaticErrorRetryActive(presentation.phase)) this.presentations.delete(sessionId);
    }
  }

  adoptBusinessRun(
    sessionId: string, predecessorRunId: string, runId: string,
    nativeSessionId: string, businessRetry: boolean,
  ): void {
    const source = this.sources.get(sessionId);
    const previous = this.coordinator.getRunMetadata(predecessorRunId);
    if (!source || !previous || previous.nativeSessionId !== nativeSessionId) return;
    this.coordinator.adoptBusinessRun({
      sessionId, sessionKey: previous.sessionKey, nativeSessionId,
      lifecycleRevision: previous.lifecycleRevision, clientGeneration: source.generation,
      clientTurnId: runId, runId, predecessorRunId, businessRetry,
      maxContinuations: this.dependencies.store.getAgentRuntimeSettings().automaticErrorRetry.maxContinuations,
    });
  }

  getPresentation(sessionId: string): AutomaticErrorRetryPresentation | null {
    return this.presentations.get(sessionId) ?? null;
  }

  observeSettled(sessionId: string, receipt: NativeRunTerminalReceipt): void {
    const source = this.sources.get(sessionId);
    this.coordinator.observeSettled(receipt);
    if (source && this.coordinator.isTechnicalRun(receipt.runId) &&
        this.coordinator.getSettledReceipt(receipt.runId)?.clientGeneration === receipt.clientGeneration)
      this.confirmOwnerSuccessor(source, receipt.runId);
  }

  observeWaitSettled(
    sessionId: string,
    receipt: AutomaticErrorRetryWaitReceipt,
    identity: Pick<AutomaticErrorRetryBinding, 'sessionKey' | 'nativeSessionId' | 'lifecycleRevision'>,
  ): boolean {
    const source = this.sources.get(sessionId);
    this.coordinator.retireWaitSettled(receipt, identity);
    const held = this.coordinator.observeWaitSettled(receipt);
    if (source && this.coordinator.isTechnicalRun(receipt.runId) &&
        this.coordinator.getSettledReceipt(receipt.runId)?.clientGeneration === receipt.clientGeneration)
      this.confirmOwnerSuccessor(source, receipt.runId);
    return held;
  }

  getActivitySnapshot() {
    const sessionIds: string[] = [];
    for (const [sessionId, presentation] of this.presentations) {
      if (isAutomaticErrorRetryActive(presentation.phase)) sessionIds.push(sessionId);
    }
    return { revision: this.revision, sessionIds };
  }

  forgetPresentation(sessionId: string): void {
    this.presentations.delete(sessionId);
  }

  publish(value: Omit<AutomaticErrorRetryPresentation, 'revision'>, notifyLifecycle = true): void {
    const presentation = { ...value, revision: ++this.revision };
    this.presentations.set(presentation.sessionId, presentation);
    for (const { runId: _runId, clientTurnId, ...metadata } of presentation.runs) {
      this.dependencies.store.setSessionRunAutomaticErrorRetry?.(clientTurnId, metadata);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(AutomaticErrorRetryIpc.Changed, presentation);
    }
    if (notifyLifecycle) this.dependencies.onPresentation?.(presentation);
  }

  private isCurrent(binding: AutomaticErrorRetryBinding): boolean {
    const owner = this.sources.get(binding.sessionId)?.owner;
    return this.isSourceCurrent(binding) &&
      (!owner || owner.isCurrent()) &&
      this.dependencies.store.getAgentRuntimeSettings().automaticErrorRetry.maxContinuations > 0 &&
      !this.dependencies.isBlocked(binding.sessionId);
  }

  private isSourceCurrent(binding: AutomaticErrorRetryBinding): boolean {
    const source = this.sources.get(binding.sessionId);
    return !!source && source.client === this.dependencies.getClient() &&
      source.generation === binding.clientGeneration &&
      source.generation === this.dependencies.getGeneration() &&
      source.identity === sourceIdentity(this.dependencies.store, binding.sessionId);
  }

  private async launch(request: AutomaticErrorRetryLaunchRequest) {
    const { binding, predecessorRunId, runId } = request;
    const { store } = this.dependencies;
    const sessionId = binding.sessionId;
    const source = this.sources.get(sessionId);
    const owner = source?.owner;
    let sent = false;
    try {
      request.assertCurrent();
      assertStorageExecutionAdmission();
      await this.dependencies.prepare(sessionId);
      request.assertCurrent();
      const client = this.dependencies.getClient();
      if (!client) return { status: 'rejected' as const };
      const result = await client.request<{ session?: Record<string, unknown> }>(
        'sessions.describe', { key: binding.sessionKey },
      );
      request.assertCurrent();
      const native = result.session;
      const predecessor = this.coordinator.getPresentation(sessionId)?.runs.find(run => run.runId === predecessorRunId);
      const predecessorClientTurnId = predecessor?.clientTurnId ?? predecessorRunId;
      if (native?.key !== binding.sessionKey || native.sessionId !== binding.nativeSessionId ||
        native.lifecycleRevision !== binding.lifecycleRevision || native.spawnedBy ||
        native.subagentRole || native.acp || native.inheritedToolAllow ||
        native.inheritedToolDeny || native.toolsAllow ||
        ((owner || request.ruleId === SESSION_READER_RETRY_RULE_ID) && native.lastRunId !== predecessorClientTurnId) ||
        !Array.isArray(native.activeRunIds) || native.activeRunIds.length > 0) {
        return { status: 'rejected' as const };
      }
      assertStorageExecutionAdmission();
      this.dependencies.beforeSuccessor(sessionId, predecessorRunId);
      const previous = store.getSessionRunByClientTurnId(predecessorClientTurnId);
      const previousTerminal = this.coordinator.getSettledReceipt(predecessorRunId);
      if (previous?.state === 'running') store.finishSessionRun(previous.id, 'failed', previousTerminal?.endedAt ?? Date.now());
      store.beginSessionRun({ sessionId, clientTurnId: runId, startedAt: Date.now() });
      const presentation = this.coordinator.getPresentation(sessionId);
      if (presentation) this.publish(presentation);
      if (!owner && !this.dependencies.adoptTechnicalRun(sessionId, predecessorRunId, runId, binding.nativeSessionId))
        throw Object.assign(new Error('The business execution owner changed.'), { requestSent: false });
      this.dependencies.beginRun(sessionId, binding, runId);
      request.assertCurrent();
      if (owner) {
        if (!binding.lifecycleRevision) throw new Error('The native lifecycle revision is unavailable.');
        owner.prepareSuccessor({
          sessionKey: binding.sessionKey, nativeSessionId: binding.nativeSessionId,
          lifecycleRevision: binding.lifecycleRevision, clientGeneration: binding.clientGeneration,
          predecessorRunId, runId, attempt: request.attempt,
        });
        request.assertCurrent();
      }
      sent = true;
      const receipt = await client.request<Record<string, unknown>>('agent', {
        sessionKey: binding.sessionKey,
        expectedExistingSessionId: binding.nativeSessionId,
        expectedExistingSessionLifecycleRevision: binding.lifecycleRevision,
        agentId: store.getSession(sessionId)?.agentId,
        message: request.fixedPrompt,
        inputProvenance: { kind: 'internal_system', sourceTool: 'execution-error-retry' },
        deliver: false, suppressPromptPersistence: true, idempotencyKey: runId,
        ...(owner ? { channel: 'webchat' } : {}),
      });
      if (client !== this.dependencies.getClient() || !this.isSourceCurrent(binding))
        return { status: 'unknown' as const };
      if (receipt.runId !== runId || !['accepted', 'in_flight'].includes(String(receipt.status))) {
        this.dependencies.unknown(sessionId, runId);
        return { status: 'unknown' as const };
      }
      this.dependencies.confirmed(sessionId, runId);
      if (source) this.confirmOwnerSuccessor(source, runId);
      return { status: 'accepted' as const };
    } catch (error) {
      const rejected = !sent || (error instanceof Error &&
        (error as Error & { requestSent?: boolean }).requestSent === false) ||
        (this.dependencies.isResponseError(error) &&
          ['INVALID_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'].includes(
            String((error as { gatewayCode?: unknown }).gatewayCode)));
      if (rejected) {
        owner?.rejectSuccessor(runId);
        this.dependencies.rejected(sessionId, runId, predecessorRunId);
        const timing = store.getSessionRunByClientTurnId(runId);
        if (timing?.state === 'running') store.finishSessionRun(timing.id, 'failed', Date.now());
        return { status: 'rejected' as const };
      }
      if (this.isSourceCurrent(binding)) this.dependencies.unknown(sessionId, runId);
      return { status: 'unknown' as const };
    }
  }

  private confirmOwnerSuccessor(source: { owner?: CoworkAutomaticErrorRetryOwner; confirmedSuccessors: Set<string> }, runId: string): void {
    if (!source.owner || source.confirmedSuccessors.has(runId)) return;
    source.confirmedSuccessors.add(runId);
    source.owner.confirmSuccessor(runId);
  }
}
