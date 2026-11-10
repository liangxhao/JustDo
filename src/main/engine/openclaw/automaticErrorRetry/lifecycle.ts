import {
  AutomaticErrorRetryDisposition,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryPresentation,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { GoalLifecycleEvent } from '../../../openclaw/goals/goalContinuationCoordinator';
import type { GatewayClientLike } from '../../gateway/types';
import type {
  AutomaticErrorRetryBinding,
  AutomaticErrorRetryCoordinator,
  AutomaticErrorRetrySettledReceipt,
  AutomaticErrorRetryWaitReceipt,
} from './coordinator';

type SettledGoalEvent = GoalLifecycleEvent & { phase: 'end' | 'error'; executionSettled: true };
type WaitIdentity = Pick<AutomaticErrorRetryBinding, 'sessionKey' | 'nativeSessionId' | 'lifecycleRevision'>;
type Connection = { client: GatewayClientLike; generation: number };

interface LifecycleDependencies {
  coordinator: Pick<AutomaticErrorRetryCoordinator,
    'getRunMetadata' | 'getPresentation' | 'holdsTerminal' | 'retireWaitSettled' | 'observeWaitSettled'>;
  resolveSessionId: (sessionKey: string) => string | null;
  isConnectionCurrent: (connection: Connection) => boolean;
  handleGoalLifecycle: (event: GoalLifecycleEvent) => void;
  reconcileGoalTerminal: (event: SettledGoalEvent) => Promise<void>;
  emitError: (sessionId: string, error: string) => void;
}

/** Holds presentation and business notifications while the independent retry policy decides. */
export class AutomaticErrorRetryLifecycle {
  private readonly goalTerminals = new Map<string, GoalLifecycleEvent>();
  private readonly waitTerminals = new Map<string, { event: SettledGoalEvent; connection: Connection }>();
  private readonly errors = new Map<string, {
    sessionId: string; error: string; timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly dependencies: LifecycleDependencies) {}

  forwardGoalLifecycle(event: GoalLifecycleEvent): void {
    if (this.dependencies.coordinator.holdsTerminal(event.runId)) {
      this.goalTerminals.set(event.runId, event);
      return;
    }
    this.dependencies.handleGoalLifecycle(event);
  }

  deferError(sessionId: string, runId: string, error: string): boolean {
    const { coordinator } = this.dependencies;
    const metadata = coordinator.getRunMetadata(runId);
    const presentation = coordinator.getPresentation(sessionId);
    if (!metadata || !presentation || metadata.disposition === AutomaticErrorRetryDisposition.Final ||
      presentation.phase === AutomaticErrorRetryPhase.Unknown ||
      presentation.phase === AutomaticErrorRetryPhase.Cancelled) return false;
    if (metadata.disposition === AutomaticErrorRetryDisposition.Superseded) return true;
    if (!this.errors.has(runId)) {
      const timer = setTimeout(() => {
        const pending = this.errors.get(runId);
        this.errors.delete(runId);
        const current = coordinator.getRunMetadata(runId);
        if (pending && current?.disposition === AutomaticErrorRetryDisposition.Candidate)
          this.dependencies.emitError(pending.sessionId, pending.error);
        else if (pending) this.errors.set(runId, pending);
      }, 5_000);
      this.errors.set(runId, { sessionId, error, timer });
    }
    return true;
  }

  onPresentation(presentation: AutomaticErrorRetryPresentation): void {
    for (const run of presentation.runs) {
      if (run.disposition === AutomaticErrorRetryDisposition.Superseded) {
        // The producer emits this only after an accepted ACK or exact successor settlement.
        this.goalTerminals.delete(run.runId);
        this.waitTerminals.delete(run.runId);
      }
      const pending = this.errors.get(run.runId);
      if (!pending) continue;
      const final = run.disposition === AutomaticErrorRetryDisposition.Final ||
        presentation.phase === AutomaticErrorRetryPhase.Unknown;
      if (run.disposition === AutomaticErrorRetryDisposition.Pending) clearTimeout(pending.timer);
      if (!final && run.disposition !== AutomaticErrorRetryDisposition.Superseded) continue;
      clearTimeout(pending.timer);
      this.errors.delete(run.runId);
      if (final && presentation.phase !== AutomaticErrorRetryPhase.Completed)
        this.dependencies.emitError(pending.sessionId, pending.error);
    }
  }

  confirmSuccessor(runId: string): void {
    const metadata = this.dependencies.coordinator.getRunMetadata(runId);
    if (metadata?.predecessorRunId) this.goalTerminals.delete(metadata.predecessorRunId);
  }

  onUnclaimedSettled(receipt: AutomaticErrorRetrySettledReceipt): void {
    const held = this.waitTerminals.get(receipt.runId);
    if (held) {
      this.waitTerminals.delete(receipt.runId);
      if (this.dependencies.isConnectionCurrent(held.connection))
        void this.dependencies.reconcileGoalTerminal(held.event).catch(() => {});
      return;
    }
    const event = this.goalTerminals.get(receipt.runId);
    this.goalTerminals.delete(receipt.runId);
    if (event) this.dependencies.handleGoalLifecycle(event);
  }

  /** The adapter supplies this only after exact agent.wait and native identity checks. */
  async reconcileVerifiedWaitTerminal(
    event: SettledGoalEvent,
    connection: Connection,
    status: AutomaticErrorRetryWaitReceipt['status'],
    endedAt?: number,
    verifiedIdentity?: WaitIdentity,
  ): Promise<void> {
    const { coordinator } = this.dependencies;
    if (event.sessionId) {
      const receipt: AutomaticErrorRetryWaitReceipt = {
        source: 'agent.wait', runId: event.runId, sessionKey: event.sessionKey,
        sessionId: event.sessionId, lifecycleGeneration: event.lifecycleGeneration ?? null,
        clientGeneration: connection.generation, executionSettled: true, status,
        ...(typeof endedAt === 'number' && Number.isFinite(endedAt) ? { endedAt } : {}),
        ...(event.error ? { error: event.error } : {}),
      };
      if (verifiedIdentity) coordinator.retireWaitSettled(receipt, verifiedIdentity);
      if (coordinator.observeWaitSettled(receipt)) {
        this.waitTerminals.set(event.runId, { event, connection });
        return;
      }
    }
    await this.dependencies.reconcileGoalTerminal(event);
  }

  cancel(sessionId: string): void {
    for (const [runId, held] of this.waitTerminals) {
      if (this.dependencies.resolveSessionId(held.event.sessionKey) === sessionId)
        this.waitTerminals.delete(runId);
    }
    for (const [runId, event] of this.goalTerminals) {
      if (this.dependencies.resolveSessionId(event.sessionKey) === sessionId)
        this.goalTerminals.delete(runId);
    }
  }

  clearWaitTerminals(): void {
    this.waitTerminals.clear();
  }

  clear(): void {
    this.waitTerminals.clear();
    this.goalTerminals.clear();
    for (const { timer } of this.errors.values()) clearTimeout(timer);
    this.errors.clear();
  }
}
