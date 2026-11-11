import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';

import {
  AutomaticErrorRetryIpc,
  type AutomaticErrorRetryPresentation,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { CoworkStore } from '../../../data/coworkStore';
import { assertStorageExecutionAdmission } from '../../../storage/relocationAdmission';
import type { GatewayClientLike } from '../../gateway/types';
import type { ExecutionSuccessorClaims } from '../executionSuccessorClaims';
import {
  type AutomaticErrorRetryBinding,
  AutomaticErrorRetryCoordinator,
  type AutomaticErrorRetryLaunchRequest,
  type AutomaticErrorRetrySettledReceipt,
} from './coordinator';
import { readAutomaticErrorRetryFailureCode } from './failureCode';

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
}

const sourceIdentity = (store: CoworkStore, sessionId: string): string => {
  const session = store.getSession(sessionId);
  return JSON.stringify(session && [session.agentId, session.cwd, session.permissionMode,
    session.activeSkillIds, session.nativeSessionKey, session.historyBinding, session.external,
    session.nativeParentSessionId]);
};

/** Application transport adapter. The policy coordinator has no Goal dependencies. */
export class AutomaticErrorRetryHost {
  readonly coordinator: AutomaticErrorRetryCoordinator;
  private readonly sources = new Map<string, {
    client: GatewayClientLike; generation: number; identity: string;
  }>();

  constructor(private readonly dependencies: HostDependencies) {
    this.coordinator = new AutomaticErrorRetryCoordinator({
      readFailureCode: (binding, receipt, signal) => {
        const client = dependencies.getClient();
        return client ? readAutomaticErrorRetryFailureCode(client, binding, receipt, signal)
          : Promise.resolve(null);
      },
      isCurrent: binding => this.isCurrent(binding),
      reserveSuccessor: (binding, predecessor) => dependencies.successorClaims.claim(predecessor, binding.sessionId),
      releaseSuccessor: (binding, predecessor) => dependencies.successorClaims.release(predecessor, binding.sessionId),
      launchSuccessor: request => this.launch(request),
      onChanged: presentation => this.publish(presentation),
      onUnclaimedSettled: receipt => dependencies.unclaimed(receipt),
      createRunId: () => randomUUID(),
    });
  }

  async arm(sessionId: string, clientTurnId: string, expectedNativeSessionId?: string): Promise<void> {
    this.cancel(sessionId);
    const { store } = this.dependencies;
    const session = store.getSession(sessionId);
    const maxContinuations = store.getAgentRuntimeSettings().automaticErrorRetry.maxContinuations;
    const client = this.dependencies.getClient();
    if (!client || !maxContinuations || !session || session.external ||
      session.nativeParentSessionId || session.branchCreationPending || !expectedNativeSessionId ||
      this.dependencies.isBlocked(sessionId)) return;
    const sessionKey = this.dependencies.sessionKey(sessionId);
    if (!/^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey)) return;
    const captured = {
      client, generation: this.dependencies.getGeneration(),
      identity: sourceIdentity(store, sessionId),
    };
    this.sources.set(sessionId, captured);
    try {
      const result = await client.request<{ session?: Record<string, unknown> }>(
        'sessions.describe', { key: sessionKey },
      );
      const native = result.session;
      if (this.sources.get(sessionId) !== captured || captured.client !== this.dependencies.getClient() ||
        captured.generation !== this.dependencies.getGeneration() ||
        captured.identity !== sourceIdentity(store, sessionId) ||
        store.getLatestSessionRun(sessionId)?.clientTurnId !== clientTurnId ||
        native?.key !== sessionKey || native.sessionId !== expectedNativeSessionId ||
        typeof native.lifecycleRevision !== 'string' || !native.lifecycleRevision ||
        native.spawnedBy || native.subagentRole || native.acp || native.inheritedToolAllow ||
        native.inheritedToolDeny || native.toolsAllow) return;
      this.coordinator.arm({
        sessionId, clientTurnId, runId: clientTurnId, sessionKey,
        nativeSessionId: native.sessionId as string,
        lifecycleRevision: native.lifecycleRevision,
        clientGeneration: captured.generation, maxContinuations,
      });
    } catch {
      // Read-only eligibility failure must not break the user's ordinary send.
      if (this.sources.get(sessionId) === captured) this.sources.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.sources.delete(sessionId);
    this.coordinator.cancel(sessionId);
  }

  clear(): void {
    this.sources.clear();
    this.coordinator.clear();
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

  publish(presentation: AutomaticErrorRetryPresentation): void {
    for (const { runId: _runId, clientTurnId, ...metadata } of presentation.runs) {
      this.dependencies.store.setSessionRunAutomaticErrorRetry?.(clientTurnId, metadata);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(AutomaticErrorRetryIpc.Changed, presentation);
    }
    this.dependencies.onPresentation?.(presentation);
  }

  private isCurrent(binding: AutomaticErrorRetryBinding): boolean {
    return this.isSourceCurrent(binding) &&
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
      if (native?.key !== binding.sessionKey || native.sessionId !== binding.nativeSessionId ||
        native.lifecycleRevision !== binding.lifecycleRevision || native.spawnedBy ||
        native.subagentRole || native.acp || native.inheritedToolAllow ||
        native.inheritedToolDeny || native.toolsAllow ||
        !Array.isArray(native.activeRunIds) || native.activeRunIds.length > 0) {
        return { status: 'rejected' as const };
      }
      assertStorageExecutionAdmission();
      this.dependencies.beforeSuccessor(sessionId, predecessorRunId);
      const previous = store.getSessionRunByClientTurnId(predecessorRunId);
      if (previous?.state === 'running') store.finishSessionRun(previous.id, 'failed', Date.now());
      store.beginSessionRun({ sessionId, clientTurnId: runId, startedAt: Date.now() });
      const presentation = this.coordinator.getPresentation(sessionId);
      if (presentation) this.publish(presentation);
      if (!this.dependencies.adoptTechnicalRun(sessionId, predecessorRunId, runId, binding.nativeSessionId))
        throw Object.assign(new Error('The business execution owner changed.'), { requestSent: false });
      this.dependencies.beginRun(sessionId, binding, runId);
      request.assertCurrent();
      sent = true;
      const receipt = await client.request<Record<string, unknown>>('agent', {
        sessionKey: binding.sessionKey,
        expectedExistingSessionId: binding.nativeSessionId,
        expectedExistingSessionLifecycleRevision: binding.lifecycleRevision,
        agentId: store.getSession(sessionId)?.agentId,
        message: request.fixedPrompt,
        inputProvenance: { kind: 'internal_system', sourceTool: 'execution-error-retry' },
        deliver: false, suppressPromptPersistence: true, idempotencyKey: runId,
      });
      if (client !== this.dependencies.getClient() || !this.isSourceCurrent(binding))
        return { status: 'unknown' as const };
      if (receipt.runId !== runId || !['accepted', 'in_flight'].includes(String(receipt.status))) {
        this.dependencies.unknown(sessionId, runId);
        return { status: 'unknown' as const };
      }
      this.dependencies.confirmed(sessionId, runId);
      return { status: 'accepted' as const };
    } catch (error) {
      const rejected = !sent || (error instanceof Error &&
        (error as Error & { requestSent?: boolean }).requestSent === false) ||
        (this.dependencies.isResponseError(error) &&
          ['INVALID_REQUEST', 'FORBIDDEN', 'UNAUTHORIZED'].includes(
            String((error as { gatewayCode?: unknown }).gatewayCode)));
      if (rejected) {
        this.dependencies.rejected(sessionId, runId, predecessorRunId);
        const timing = store.getSessionRunByClientTurnId(runId);
        if (timing?.state === 'running') store.finishSessionRun(timing.id, 'failed', Date.now());
        return { status: 'rejected' as const };
      }
      if (this.isSourceCurrent(binding)) this.dependencies.unknown(sessionId, runId);
      return { status: 'unknown' as const };
    }
  }
}
