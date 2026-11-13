import { randomUUID } from 'node:crypto';

import {
  AUTOMATIC_ERROR_RETRY_MAX_CONTINUATIONS,
  AutomaticErrorRetryDisposition,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryPresentation,
  type AutomaticErrorRetryPresentedRun,
  type AutomaticErrorRetryRunMetadata,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { NativeRunTerminalReceipt } from '../../gateway/types';
import { waitForAutomaticErrorRetry } from './retryDecision';
import { type AutomaticErrorRetryRule, createAutomaticErrorRetryRuleIndex } from './rules';

export interface AutomaticErrorRetryBinding {
  sessionId: string;
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
  clientGeneration: number;
  clientTurnId: string;
  runId: string;
}

export interface AutomaticErrorRetryArm extends AutomaticErrorRetryBinding {
  maxContinuations: number;
  chainId?: string;
}

export interface AutomaticErrorRetryLaunchRequest {
  binding: AutomaticErrorRetryBinding;
  chainId: string;
  attempt: number;
  maxContinuations: number;
  predecessorRunId: string;
  runId: string;
  clientTurnId: string;
  ruleId: string;
  fixedPrompt: string;
  signal: AbortSignal;
  assertCurrent(): void;
}

export type AutomaticErrorRetryLaunchResult = { status: 'accepted' | 'rejected' | 'unknown' };

/** Exact agent.wait reconciliation has no public native event sequence. */
export type AutomaticErrorRetryWaitReceipt = Omit<NativeRunTerminalReceipt, 'agentSeq' | 'endedAt' | 'observedFailureCode'> & {
  source: 'agent.wait';
  endedAt?: number;
  stopReason?: string;
};
export type AutomaticErrorRetrySettledReceipt = NativeRunTerminalReceipt | AutomaticErrorRetryWaitReceipt;

export interface AutomaticErrorRetryDependencies {
  readFailureCode(binding: AutomaticErrorRetryBinding, receipt: AutomaticErrorRetrySettledReceipt, signal: AbortSignal): Promise<string | null>;
  isCurrent(binding: AutomaticErrorRetryBinding): boolean;
  reserveSuccessor(binding: AutomaticErrorRetryBinding, predecessorRunId: string): boolean;
  releaseSuccessor(binding: AutomaticErrorRetryBinding, predecessorRunId: string): void;
  launchSuccessor(request: AutomaticErrorRetryLaunchRequest): Promise<AutomaticErrorRetryLaunchResult>;
  onChanged(presentation: AutomaticErrorRetryPresentation): void;
  onUnclaimedSettled(receipt: AutomaticErrorRetrySettledReceipt): void;
  createRunId?: () => string;
  rules?: readonly AutomaticErrorRetryRule[];
  retryDelayMs?: number;
}

type Chain = {
  binding: AutomaticErrorRetryBinding;
  presentation: AutomaticErrorRetryPresentation;
  controller: AbortController;
  currentRunId: string;
  operation?: symbol;
  closed: boolean;
  held: Set<string>;
  reservations: Set<string>;
  receipts: Map<string, AutomaticErrorRetrySettledReceipt>;
  launches: Map<string, string>;
  lastSettledRunId?: string;
  cancelledInitialRun?: string;
};

/** Owns only bounded application follow-ups; native outcomes and permissions remain authoritative. */
export class AutomaticErrorRetryCoordinator {
  private readonly chains = new Map<string, Chain>();
  private readonly runs = new Map<string, Chain>();
  private readonly rules: ReadonlyMap<string, AutomaticErrorRetryRule>;
  private revision = Date.now();

  constructor(private readonly dependencies: AutomaticErrorRetryDependencies) {
    this.rules = createAutomaticErrorRetryRuleIndex(dependencies.rules);
  }

  arm(input: AutomaticErrorRetryArm): boolean {
    if (!Number.isInteger(input.maxContinuations) || input.maxContinuations < 1 ||
        input.maxContinuations > AUTOMATIC_ERROR_RETRY_MAX_CONTINUATIONS ||
        !/^agent:[^:\s]+:justdo:[^:\s]+$/u.test(input.sessionKey) ||
        !input.sessionId || !input.nativeSessionId || !input.clientTurnId || !input.runId)
      return false;
    const previous = this.chains.get(input.sessionId);
    if (previous && this.isOutstanding(previous, previous.currentRunId)) return false;
    if (previous?.binding.clientTurnId === input.clientTurnId || this.runs.has(input.runId)) return false;
    this.cancel(input.sessionId);
    if (previous) for (const run of previous.presentation.runs) this.runs.delete(run.runId);
    const { maxContinuations, chainId = input.clientTurnId, ...binding } = input;
    const run: AutomaticErrorRetryPresentedRun = {
      chainId, attempt: 0, maxContinuations, sessionKey: input.sessionKey,
      nativeSessionId: input.nativeSessionId, lifecycleRevision: input.lifecycleRevision,
      disposition: AutomaticErrorRetryDisposition.Candidate, runId: input.runId, clientTurnId: input.clientTurnId,
    };
    const chain: Chain = {
      binding, currentRunId: input.runId, controller: new AbortController(), closed: false,
      held: new Set(), reservations: new Set(), receipts: new Map(), launches: new Map(),
      presentation: { sessionId: input.sessionId, chainId, revision: 0,
        phase: AutomaticErrorRetryPhase.Eligible, attempt: 0, maxContinuations, runs: [run] },
    };
    this.chains.set(input.sessionId, chain);
    this.runs.set(input.runId, chain);
    this.publish(chain);
    return true;
  }

  /** A business owner's retry of the same step inherits its already-spent technical allowance. */
  adoptBusinessRun(input: AutomaticErrorRetryArm & { predecessorRunId: string; businessRetry: boolean }): boolean {
    if (!input.businessRetry) return this.arm(input);
    const chain = this.runs.get(input.predecessorRunId);
    if (!chain || !chain.closed || chain.lastSettledRunId !== input.predecessorRunId ||
        chain.presentation.phase !== AutomaticErrorRetryPhase.Failed || this.runs.has(input.runId) ||
        input.sessionId !== chain.binding.sessionId || input.sessionKey !== chain.binding.sessionKey ||
        input.nativeSessionId !== chain.binding.nativeSessionId || input.lifecycleRevision !== chain.binding.lifecycleRevision ||
        input.clientGeneration !== chain.binding.clientGeneration) return false;
    chain.controller.abort();
    const { maxContinuations: _maximum, chainId: _chainId, predecessorRunId: _predecessor, businessRetry: _retry, ...binding } = input;
    chain.binding = binding;
    chain.controller = new AbortController();
    chain.closed = false;
    chain.currentRunId = input.runId;
    chain.presentation.phase = AutomaticErrorRetryPhase.Eligible;
    chain.presentation.runs.push({
      chainId: chain.presentation.chainId, attempt: 0, maxContinuations: chain.presentation.maxContinuations,
      sessionKey: input.sessionKey, nativeSessionId: input.nativeSessionId, lifecycleRevision: input.lifecycleRevision,
      disposition: AutomaticErrorRetryDisposition.Candidate, runId: input.runId, clientTurnId: input.clientTurnId,
    });
    this.runs.set(input.runId, chain);
    this.publish(chain);
    return true;
  }

  /** Claims a failed predecessor synchronously, before any asynchronous evidence read. */
  observeSettled(receipt: NativeRunTerminalReceipt): boolean {
    if (!Number.isSafeInteger(receipt.agentSeq) || receipt.agentSeq < 0) return false;
    return this.observeTerminal(receipt);
  }

  observeWaitSettled(receipt: AutomaticErrorRetryWaitReceipt): boolean {
    if (!this.isSettledWait(receipt)) return false;
    return this.observeTerminal(receipt);
  }

  /** A new connection may retire old uncertainty, but can never revive its automatic policy. */
  retireWaitSettled(
    receipt: AutomaticErrorRetryWaitReceipt,
    identity: Pick<AutomaticErrorRetryBinding, 'sessionKey' | 'nativeSessionId' | 'lifecycleRevision'>,
  ): boolean {
    const chain = this.runs.get(receipt.runId);
    if (!chain || !chain.closed || !chain.controller.signal.aborted || !this.isSettledWait(receipt) ||
        receipt.executionSettled !== true || !Number.isSafeInteger(receipt.clientGeneration) ||
        receipt.clientGeneration <= chain.binding.clientGeneration ||
        !this.isOutstanding(chain, receipt.runId) ||
        receipt.sessionKey !== chain.binding.sessionKey || receipt.sessionId !== chain.binding.nativeSessionId ||
        identity.sessionKey !== chain.binding.sessionKey || identity.nativeSessionId !== chain.binding.nativeSessionId ||
        identity.lifecycleRevision !== chain.binding.lifecycleRevision) return false;
    chain.receipts.set(receipt.runId, receipt);
    this.confirmAdmission(chain, receipt.runId);
    this.finishRetainedRun(chain, receipt);
    return true;
  }

  private observeTerminal(receipt: AutomaticErrorRetrySettledReceipt): boolean {
    const chain = this.runs.get(receipt.runId);
    if (!chain || !this.matches(chain, receipt)) return false;
    if (chain.receipts.has(receipt.runId)) return chain.held.has(receipt.runId);
    chain.receipts.set(receipt.runId, receipt);
    const admitted = this.confirmAdmission(chain, receipt.runId);
    let launchSettled = false;
    for (const [predecessor, successor] of chain.launches) {
      if (successor === receipt.runId) {
        chain.launches.delete(predecessor);
        launchSettled = true;
      }
    }
    if (chain.closed) {
      if (launchSettled || chain.cancelledInitialRun === receipt.runId) this.finishRetainedRun(chain, receipt);
      else if (admitted) this.publish(chain);
      return false;
    }
    if (chain.currentRunId !== receipt.runId) return false;
    chain.lastSettledRunId = receipt.runId;
    if (receipt.status !== 'failed') {
      this.finish(chain, receipt.status === 'completed' ? AutomaticErrorRetryPhase.Completed : AutomaticErrorRetryPhase.Cancelled);
      return false;
    }
    if (chain.presentation.attempt >= chain.presentation.maxContinuations ||
        !this.current(chain) || !this.dependencies.reserveSuccessor(chain.binding, receipt.runId)) {
      this.finish(chain, AutomaticErrorRetryPhase.Failed);
      return false;
    }
    chain.reservations.add(receipt.runId);
    chain.held.add(receipt.runId);
    const operation = Symbol('error-retry');
    chain.operation = operation;
    chain.presentation.phase = AutomaticErrorRetryPhase.Checking;
    this.lastRun(chain).disposition = AutomaticErrorRetryDisposition.Pending;
    this.publish(chain);
    void this.retry(chain, receipt, operation);
    return true;
  }

  ownsRun(runId: string): boolean { return this.runs.has(runId); }
  isTechnicalRun(runId: string): boolean { return (this.getRunMetadata(runId)?.attempt ?? 0) > 0; }
  holdsTerminal(runId: string): boolean { return this.runs.get(runId)?.held.has(runId) ?? false; }

  getRunMetadata(runId: string): AutomaticErrorRetryRunMetadata | null {
    const run = this.runs.get(runId)?.presentation.runs.find(value => value.runId === runId);
    if (!run) return null;
    const { runId: _runId, clientTurnId: _clientTurnId, ...metadata } = run;
    return metadata;
  }

  /** A pre-reply error may arrive before Main has seen any native activity for the admitted input. */
  getCandidateBinding(sessionId: string, runId: string): AutomaticErrorRetryBinding | null {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.currentRunId !== runId || chain.binding.runId !== runId ||
        this.lastRun(chain).disposition !== AutomaticErrorRetryDisposition.Candidate || !this.current(chain)) return null;
    return { ...chain.binding };
  }

  getSettledReceipt(runId: string): AutomaticErrorRetrySettledReceipt | null {
    const receipt = this.runs.get(runId)?.receipts.get(runId);
    return receipt ? { ...receipt } : null;
  }

  getPresentation(sessionId: string): AutomaticErrorRetryPresentation | null {
    const chain = this.chains.get(sessionId);
    return chain ? this.snapshot(chain) : null;
  }

  rebindInitialRun(binding: AutomaticErrorRetryBinding): boolean {
    const chain = this.chains.get(binding.sessionId);
    if (!chain || !this.current(chain) || chain.presentation.phase !== AutomaticErrorRetryPhase.Eligible ||
        chain.binding.clientTurnId !== binding.clientTurnId || chain.binding.sessionKey !== binding.sessionKey ||
        chain.binding.nativeSessionId !== binding.nativeSessionId || chain.binding.lifecycleRevision !== binding.lifecycleRevision ||
        chain.binding.clientGeneration !== binding.clientGeneration) return false;
    if (chain.currentRunId === binding.runId) return true;
    if (!binding.runId || this.runs.has(binding.runId)) return false;
    this.runs.delete(chain.currentRunId);
    chain.currentRunId = binding.runId;
    chain.binding = binding;
    this.lastRun(chain).runId = binding.runId;
    this.runs.set(binding.runId, chain);
    this.publish(chain);
    return true;
  }

  getTurn(sessionId: string, logicalTurnId: string) {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.presentation.chainId !== logicalTurnId) return null;
    return {
      presentation: this.snapshot(chain),
      currentPhysicalRunId: chain.currentRunId,
      lastSettledReceipt: chain.lastSettledRunId ? this.getSettledReceipt(chain.lastSettledRunId) : null,
      outstandingLaunch: this.isOutstanding(chain, chain.currentRunId),
    };
  }

  cancelTurn(sessionId: string, logicalTurnId: string): { matched: boolean; physicalRunId?: string; unknown?: boolean } {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.presentation.chainId !== logicalTurnId) return { matched: false };
    const outstanding = this.isOutstanding(chain, chain.currentRunId);
    if (chain.closed && !outstanding) return { matched: true };
    const phase = chain.presentation.phase;
    if (!outstanding && chain.lastSettledRunId &&
        (phase === AutomaticErrorRetryPhase.Checking || phase === AutomaticErrorRetryPhase.Preparing))
      chain.presentation.runs[0].chainPhase = AutomaticErrorRetryPhase.Cancelled;
    const physicalRunId = !chain.receipts.has(chain.currentRunId) &&
      (outstanding || phase === AutomaticErrorRetryPhase.Eligible) ? chain.currentRunId : undefined;
    if (physicalRunId && phase === AutomaticErrorRetryPhase.Eligible) chain.cancelledInitialRun = physicalRunId;
    this.cancel(sessionId);
    return {
      matched: true,
      ...(physicalRunId ? { physicalRunId } : {}),
      ...(outstanding && phase !== AutomaticErrorRetryPhase.Running ? { unknown: true } : {}),
    };
  }

  /** End the policy decision without manufacturing native execution settlement. */
  expireUnsettledCandidate(sessionId: string, runId: string): void {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.closed || chain.currentRunId !== runId || chain.receipts.has(runId) ||
        this.lastRun(chain).disposition !== AutomaticErrorRetryDisposition.Candidate) return;
    this.finish(chain, AutomaticErrorRetryPhase.Failed);
  }

  cancel(sessionId: string): void {
    const chain = this.chains.get(sessionId);
    if (!chain || chain.closed) return;
    chain.controller.abort();
    this.finish(chain, AutomaticErrorRetryPhase.Cancelled, true);
  }

  clear(): void {
    for (const sessionId of this.chains.keys()) this.cancel(sessionId);
    for (const [sessionId, chain] of this.chains) {
      if (this.isOutstanding(chain, chain.currentRunId)) continue;
      this.chains.delete(sessionId);
      for (const run of chain.presentation.runs) this.runs.delete(run.runId);
    }
  }

  private async retry(chain: Chain, receipt: AutomaticErrorRetrySettledReceipt, operation: symbol): Promise<void> {
    try {
      const rule = await waitForAutomaticErrorRetry({
        readFailureCode: () => this.dependencies.readFailureCode(chain.binding, receipt, chain.controller.signal),
        isCurrent: () => this.activeOperation(chain, operation),
        attempt: chain.presentation.attempt,
        signal: chain.controller.signal,
        retryDelayMs: this.dependencies.retryDelayMs,
        rules: this.rules,
      });
      if (!this.activeOperation(chain, operation)) return;
      if (!rule) {
        this.decline(chain, receipt);
        return;
      }
      const runId = (this.dependencies.createRunId ?? randomUUID)();
      if (!runId || this.runs.has(runId)) throw new Error('Invalid retry run identity');
      const previous = this.lastRun(chain);
      previous.ruleId = rule.id;
      const attempt = ++chain.presentation.attempt;
      chain.presentation.runs.push({
        chainId: chain.presentation.chainId, attempt, maxContinuations: chain.presentation.maxContinuations,
        sessionKey: chain.binding.sessionKey, nativeSessionId: chain.binding.nativeSessionId,
        lifecycleRevision: chain.binding.lifecycleRevision, disposition: AutomaticErrorRetryDisposition.Pending,
        predecessorRunId: receipt.runId, ruleId: rule.id, runId, clientTurnId: runId,
      });
      chain.currentRunId = runId;
      this.runs.set(runId, chain);
      chain.presentation.phase = AutomaticErrorRetryPhase.Preparing;
      this.publish(chain);
      let result: AutomaticErrorRetryLaunchResult;
      chain.launches.set(receipt.runId, runId);
      try {
        result = await this.dependencies.launchSuccessor({
          binding: chain.binding, chainId: chain.presentation.chainId, attempt,
          maxContinuations: chain.presentation.maxContinuations, predecessorRunId: receipt.runId,
          runId, clientTurnId: runId, ruleId: rule.id, fixedPrompt: rule.fixedPrompt,
          signal: chain.controller.signal, assertCurrent: () => {
            this.assertCurrent(chain);
            if (chain.operation !== operation || chain.currentRunId !== runId)
              throw new Error('Automatic retry attempt has been superseded');
          },
        });
      } catch {
        // A transport rejection without an explicit no-send receipt is unknown, never retryable here.
        result = { status: 'unknown' };
      }
      if (result.status === 'rejected' && chain.launches.get(receipt.runId) === runId) {
        chain.launches.delete(receipt.runId);
        if (chain.closed) {
          this.finish(chain, chain.presentation.phase, true);
          return;
        }
        this.releaseSettledReservations(chain);
      }
      if (!this.activeOperation(chain, operation)) {
        if (result.status === 'accepted' && chain.launches.get(receipt.runId) === runId &&
            this.confirmAdmission(chain, runId)) this.publish(chain);
        return;
      }
      if (result.status === 'rejected') {
        previous.disposition = AutomaticErrorRetryDisposition.Final;
        this.decline(chain, receipt);
      } else {
        if (result.status === 'accepted') this.confirmAdmission(chain, runId);
        chain.presentation.phase = result.status === 'accepted' ? AutomaticErrorRetryPhase.Running : AutomaticErrorRetryPhase.Unknown;
        this.publish(chain);
      }
    } catch {
      if (this.activeOperation(chain, operation)) this.decline(chain, receipt);
    }
  }

  private decline(chain: Chain, receipt: AutomaticErrorRetrySettledReceipt): void {
    this.finish(chain, AutomaticErrorRetryPhase.Failed);
    this.dependencies.onUnclaimedSettled(receipt);
  }

  private finish(chain: Chain, phase: AutomaticErrorRetryPhase, retainUncertain = false): void {
    chain.closed = true;
    chain.operation = undefined;
    chain.presentation.phase = phase;
    if (!retainUncertain) chain.launches.clear();
    if (chain.launches.size === 0) {
      for (const run of chain.presentation.runs) {
        if (run.disposition !== AutomaticErrorRetryDisposition.Superseded)
          run.disposition = AutomaticErrorRetryDisposition.Final;
      }
    }
    this.releaseSettledReservations(chain);
    this.publish(chain);
  }

  private finishRetainedRun(chain: Chain, receipt: AutomaticErrorRetrySettledReceipt): void {
    chain.lastSettledRunId = receipt.runId;
    chain.cancelledInitialRun = undefined;
    const phase = receipt.status === 'completed' ? AutomaticErrorRetryPhase.Completed
      : receipt.status === 'interrupted' ? AutomaticErrorRetryPhase.Cancelled : AutomaticErrorRetryPhase.Failed;
    this.finish(chain, phase);
  }

  private isOutstanding(chain: Chain, runId: string): boolean {
    return chain.cancelledInitialRun === runId || [...chain.launches.values()].includes(runId);
  }

  private isSettledWait(receipt: AutomaticErrorRetryWaitReceipt): boolean {
    return receipt.source === 'agent.wait' && typeof receipt.endedAt === 'number' && Number.isFinite(receipt.endedAt) &&
      receipt.stopReason !== 'restart' && receipt.stopReason !== 'superseded';
  }

  private releaseSettledReservations(chain: Chain): void {
    for (const predecessor of chain.reservations) {
      if (chain.launches.has(predecessor)) continue;
      this.dependencies.releaseSuccessor(chain.binding, predecessor);
      chain.reservations.delete(predecessor);
      chain.held.delete(predecessor);
    }
  }

  private confirmAdmission(chain: Chain, runId: string): boolean {
    const successor = chain.presentation.runs.find(run => run.runId === runId);
    const predecessor = successor?.predecessorRunId && chain.presentation.runs.find(run => run.runId === successor.predecessorRunId);
    if (!predecessor || predecessor.disposition === AutomaticErrorRetryDisposition.Superseded) return false;
    predecessor.disposition = AutomaticErrorRetryDisposition.Superseded;
    return true;
  }

  private current(chain: Chain): boolean {
    return !chain.closed && !chain.controller.signal.aborted &&
      this.chains.get(chain.binding.sessionId) === chain && this.dependencies.isCurrent(chain.binding);
  }

  private assertCurrent(chain: Chain): void {
    if (!this.current(chain)) throw new Error('Automatic error retry source is no longer current');
  }

  private activeOperation(chain: Chain, operation: symbol): boolean {
    if (chain.closed || chain.operation !== operation) return false;
    if (!this.current(chain)) {
      chain.controller.abort();
      this.finish(chain, AutomaticErrorRetryPhase.Cancelled, true);
      return false;
    }
    return true;
  }

  private matches(chain: Chain, receipt: AutomaticErrorRetrySettledReceipt): boolean {
    return receipt.executionSettled === true && receipt.sessionKey === chain.binding.sessionKey &&
      receipt.sessionId === chain.binding.nativeSessionId && receipt.clientGeneration === chain.binding.clientGeneration;
  }

  private lastRun(chain: Chain): AutomaticErrorRetryPresentedRun { return chain.presentation.runs[chain.presentation.runs.length - 1]; }
  private snapshot(chain: Chain): AutomaticErrorRetryPresentation {
    return { ...chain.presentation, runs: chain.presentation.runs.map(run => ({ ...run })) };
  }
  private publish(chain: Chain): void {
    chain.presentation.revision = ++this.revision;
    this.dependencies.onChanged(this.snapshot(chain));
  }
}
