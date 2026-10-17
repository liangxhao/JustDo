import type { SessionTurn } from '../../engine/gateway/types';

export interface GoalEventIdentity {
  runId: string;
  sessionKey: string;
  sessionId?: string | null;
  lifecycleGeneration?: string | null;
  agentSeq?: number;
}

type AdmittedGoalRun = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleGeneration?: string | null;
  agentSeq: number;
};

/** Retains the admitted identity after chat final retires Main's active turn. */
export class GoalEventAdmission {
  private readonly runs = new Map<string, AdmittedGoalRun>();

  constructor(private readonly getActiveTurn: (sessionId: string) => SessionTurn | undefined) {}

  admit(sessionId: string, event: GoalEventIdentity): boolean {
    const sequence = event.agentSeq;
    if (
      !event.sessionId ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      return false;
    }
    const retained = this.runs.get(sessionId);
    const active = this.getActiveTurn(sessionId);
    if (active) {
      if (
        active.runId !== event.runId ||
        active.sessionKey !== event.sessionKey ||
        !active.gatewaySessionId ||
        active.gatewaySessionId !== event.sessionId ||
        (active.lifecycleGeneration && event.lifecycleGeneration &&
          active.lifecycleGeneration !== event.lifecycleGeneration) ||
        sequence <= active.lastAgentSeq
      ) {
        return false;
      }
    } else if (!retained || retained.runId !== event.runId) {
      return false;
    }
    if (
      retained?.runId === event.runId &&
      (retained.sessionKey !== event.sessionKey ||
        retained.sessionId !== event.sessionId ||
        (retained.lifecycleGeneration && event.lifecycleGeneration &&
          retained.lifecycleGeneration !== event.lifecycleGeneration) ||
        sequence <= retained.agentSeq)
    ) {
      return false;
    }
    this.runs.set(sessionId, {
      runId: event.runId,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      // OpenClaw keeps its internal lifecycle generation off the public wire.
      // Compare it when supplied, while the authenticated client callback fences
      // connection ownership and clears retained admission on disconnect.
      lifecycleGeneration: event.lifecycleGeneration ?? active?.lifecycleGeneration ??
        (retained?.runId === event.runId ? retained.lifecycleGeneration : null),
      agentSeq: sequence,
    });
    return true;
  }

  clearSession(sessionId: string): void {
    this.runs.delete(sessionId);
  }

  clear(): void {
    this.runs.clear();
  }
}
