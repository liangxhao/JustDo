import { randomUUID } from 'node:crypto';

import {
  BrowserInterventionAction as Action,
  BrowserInterventionPhase as Phase,
  type BrowserInterventionSnapshot,
} from '../../shared/browser/browserIntervention';

/** Admission closes before cancellation. Drain tracks actual work, not its timeout wrapper. */
export class BrowserIntervention {
  private readonly holds = new Map<
    string,
    {
      token: string;
      targetId: string;
      stopped: boolean;
      resuming: boolean;
    }
  >();
  private readonly operations = new Map<string, Set<AbortController>>();

  track(sessionId: string): { signal: AbortSignal; finish: () => void } {
    const hold = this.holds.get(sessionId);
    if (hold && !hold.resuming)
      throw new Error(
        'The user is manually operating this task browser. Wait for the user to continue the task.',
      );
    const controller = new AbortController();
    const operations = this.operations.get(sessionId) ?? new Set<AbortController>();
    operations.add(controller);
    this.operations.set(sessionId, operations);
    return {
      signal: controller.signal,
      finish: () => {
        operations.delete(controller);
        if (!operations.size) this.operations.delete(sessionId);
      },
    };
  }

  read(sessionId: string): BrowserInterventionSnapshot | null {
    const hold = this.holds.get(sessionId);
    return hold
      ? {
          token: hold.token,
          stopConfirmed: hold.stopped,
          targetId: hold.targetId,
          phase: hold.resuming
            ? Phase.Resuming
            : hold.stopped && !this.operations.get(sessionId)?.size
              ? Phase.Manual
              : Phase.Stopping,
        }
      : null;
  }

  begin(sessionId: string, targetId: string): BrowserInterventionSnapshot {
    this.holds.set(sessionId, {
      token: randomUUID(),
      targetId,
      stopped: false,
      resuming: false,
    });
    for (const controller of this.operations.get(sessionId) ?? []) controller.abort();
    return this.read(sessionId)!;
  }

  change(
    sessionId: string,
    token: string | undefined,
    action: 'confirmStop' | 'resume' | 'complete',
  ): BrowserInterventionSnapshot | null {
    const hold = this.holds.get(sessionId);
    if (!hold || hold.token !== token) throw new Error('stale');
    if (action === Action.ConfirmStop) {
      if (hold.resuming) throw new Error('stale');
      hold.stopped = true;
    } else if (action === Action.Resume) {
      if (this.read(sessionId)?.phase !== Phase.Manual) throw new Error('busy');
      hold.resuming = true;
    } else {
      if (!hold.resuming) throw new Error('stale');
      this.holds.delete(sessionId);
    }
    return this.read(sessionId);
  }
}
