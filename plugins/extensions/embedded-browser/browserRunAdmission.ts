import {
  type BrowserExecutionRun,
  type BrowserReleasedEvent,
  type BrowserRevokedEvent,
  readBrowserExecutionRun,
} from './browserExecutionContract.js';

const TOOL_NAME = 'browser';
const MAX_RUNS = 4_096;
const MAX_CALLS = 8_192;
const UNAVAILABLE = 'The browser call has no current native execution authority.';

type NativeEntry = { sessionId?: string; lifecycleRevision?: string };
type RunContext = Omit<Partial<BrowserExecutionRun>, 'trigger'> & {
  trigger?: string;
  toolAuthority?: { allows(name: string): boolean; assertActive(): void };
};
type ToolContext = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
};
type Run = {
  identity: BrowserExecutionRun;
  lifecycleRevision: string | null;
  usedCallIds: Set<string>;
  cancellationListeners: Map<AbortSignal, () => void>;
  effectsRevoked: boolean;
};
type Call = {
  run: Run;
  toolCallId: string;
  signal?: AbortSignal;
  claimed: boolean;
};

export type AdmittedBrowserCall = {
  run: BrowserExecutionRun;
  toolCallId: string;
  signal?: AbortSignal;
  assertCurrent(): void;
  retainCancellation(signal?: AbortSignal): void;
  release(): void;
};

const runKey = (
  identity: Pick<BrowserExecutionRun, 'sessionKey' | 'sessionId' | 'runId'>,
): string => JSON.stringify([identity.sessionKey, identity.sessionId, identity.runId]);

const callKey = (sessionKey: string, sessionId: string, toolCallId: string): string =>
  JSON.stringify([sessionKey, sessionId, toolCallId]);

const isDesktopSession = (sessionKey: string): boolean =>
  /^justdo:[^:]+$/u.test(sessionKey) || /^agent:[^:]+:justdo:[^:]+$/u.test(sessionKey);

// Session-key syntax limits the directory candidate. It never grants execution;
// only native trigger, exact incarnation, final tool authority and invocation do.
export const isBrowserSessionCandidate = (sessionKey: string): boolean =>
  isDesktopSession(sessionKey) || /^agent:[^:]+:cron:[^:]+(?::run:[^:]+)?$/u.test(sessionKey);

export class BrowserRunAdmission {
  private active = false;
  private readonly runs = new Map<string, Run>();
  private readonly calls = new Map<string, Call>();
  private readonly closedRuns = new Set<string>();

  constructor(
    private readonly readNativeEntry: (sessionKey: string) => NativeEntry | undefined,
    private readonly onRelease: (event: BrowserReleasedEvent) => void,
    private readonly onRevoke: (event: BrowserRevokedEvent) => void,
  ) {}

  activate(): void {
    this.active = true;
  }

  revokeAll(): void {
    this.active = false;
    for (const run of [...this.runs.values()]) this.closeRun(run, 'revoked');
    this.calls.clear();
  }

  observeRun(context: RunContext): void {
    if (!this.active) return;
    const identity = readBrowserExecutionRun(context);
    if (!identity || !isBrowserSessionCandidate(identity.sessionKey)) return;
    if (identity.trigger === 'user' && !isDesktopSession(identity.sessionKey)) return;
    const key = runKey(identity);
    if (this.closedRuns.has(key)) return;
    const previous = this.runs.get(key);
    if (previous?.effectsRevoked) return;
    try {
      // This capability closes at hook return. Do not retain it for execution.
      context.toolAuthority?.assertActive();
      if (!context.toolAuthority?.allows(TOOL_NAME)) throw new Error(UNAVAILABLE);
      const entry = this.readNativeEntry(identity.sessionKey);
      if (entry?.sessionId !== identity.sessionId) throw new Error(UNAVAILABLE);
      if (
        previous &&
        (previous.lifecycleRevision !== (entry.lifecycleRevision ?? null) ||
          JSON.stringify(previous.identity) !== JSON.stringify(identity))
      )
        throw new Error(UNAVAILABLE);
      if (this.runs.size >= MAX_RUNS && !previous) throw new Error(UNAVAILABLE);
      this.runs.set(
        key,
        previous ?? {
          identity,
          lifecycleRevision: entry.lifecycleRevision ?? null,
          usedCallIds: new Set(),
          cancellationListeners: new Map(),
          effectsRevoked: false,
        },
      );
    } catch {
      if (previous) this.closeRun(previous, 'revoked');
    }
  }

  prepareToolCall(context: ToolContext): void {
    const run = this.findRun(context);
    this.assertRunCurrent(run);
    this.retainRunCancellation(run, context.abortSignal);
    const toolCallId = context.toolCallId;
    if (!toolCallId || toolCallId.length > 512 || /[\u0000-\u001f\u007f]/u.test(toolCallId))
      throw new Error(UNAVAILABLE);
    const key = callKey(run.identity.sessionKey, run.identity.sessionId, toolCallId);
    if (
      this.calls.has(key) ||
      run.usedCallIds.has(toolCallId) ||
      run.usedCallIds.size >= MAX_CALLS ||
      this.calls.size >= MAX_CALLS
    )
      throw new Error(UNAVAILABLE);
    this.calls.set(key, { run, toolCallId, signal: context.abortSignal, claimed: false });
  }

  claimToolCall(
    sessionKey: string,
    sessionId: string,
    toolCallId: string,
    assertInvocationCurrent: () => void,
  ): AdmittedBrowserCall {
    const key = callKey(sessionKey, sessionId, toolCallId);
    const call = this.calls.get(key);
    if (!call || call.claimed) throw new Error(UNAVAILABLE);
    const assertCurrent = () => {
      assertInvocationCurrent();
      this.assertRunCurrent(call.run);
      call.signal?.throwIfAborted();
      if (this.calls.get(key) !== call) throw new Error(UNAVAILABLE);
    };
    assertCurrent();
    call.claimed = true;
    call.run.usedCallIds.add(toolCallId);
    return {
      run: call.run.identity,
      toolCallId,
      signal: call.signal,
      assertCurrent,
      retainCancellation: signal => {
        assertCurrent();
        this.retainRunCancellation(call.run, signal);
      },
      release: () => {
        if (this.calls.get(key) === call) this.calls.delete(key);
      },
    };
  }

  finishToolCall(context: ToolContext): void {
    if (!context.sessionKey || !context.sessionId || !context.toolCallId) return;
    const key = callKey(context.sessionKey, context.sessionId, context.toolCallId);
    const call = this.calls.get(key);
    if (call?.run.identity.runId === context.runId) this.calls.delete(key);
  }

  observeLifecycle(event: {
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    stream?: string;
    data?: Record<string, unknown>;
  }): void {
    if (
      event.stream !== 'lifecycle' ||
      event.data?.executionSettled !== true ||
      !['end', 'error'].includes(String(event.data.phase))
    )
      return;
    const run = this.findRunOrNull(event);
    if (run)
      this.closeRun(run, 'settled', event.data.phase === 'error' || event.data.aborted === true);
  }

  private findRunOrNull(context: ToolContext): Run | undefined {
    return context.sessionKey && context.sessionId && context.runId
      ? this.runs.get(
          runKey({
            sessionKey: context.sessionKey,
            sessionId: context.sessionId,
            runId: context.runId,
          }),
        )
      : undefined;
  }

  private findRun(context: ToolContext): Run {
    const run = this.findRunOrNull(context);
    if (!run) throw new Error(UNAVAILABLE);
    return run;
  }

  private assertRunCurrent(run: Run): void {
    if (!this.active || run.effectsRevoked || this.runs.get(runKey(run.identity)) !== run)
      throw new Error(UNAVAILABLE);
    const entry = this.readNativeEntry(run.identity.sessionKey);
    if (
      entry?.sessionId !== run.identity.sessionId ||
      (entry.lifecycleRevision ?? null) !== run.lifecycleRevision
    ) {
      this.closeRun(run, 'revoked');
      throw new Error(UNAVAILABLE);
    }
  }

  private retainRunCancellation(run: Run, signal?: AbortSignal): void {
    this.assertRunCurrent(run);
    if (!signal) return;
    // An armed upload/dialog can outlive the tool response. Its native source
    // cancellation must still revoke Main's effect authority before a terminal
    // arrives. Native tool-generation cleanup also aborts this signal after a
    // successful attempt, so retain identity until the actual settled terminal.
    const revoke = () => this.revokeEffects(run);
    if (!run.cancellationListeners.has(signal) && !signal.aborted) {
      const remove = () => signal.removeEventListener('abort', revoke);
      run.cancellationListeners.set(signal, remove);
      signal.addEventListener('abort', revoke, { once: true });
    }
    if (signal.aborted) {
      revoke();
      signal.throwIfAborted();
    }
    this.assertRunCurrent(run);
  }

  private invalidateEffects(run: Run): void {
    run.effectsRevoked = true;
    for (const remove of run.cancellationListeners.values()) remove();
    run.cancellationListeners.clear();
    for (const [key, call] of this.calls) {
      if (call.run === run) this.calls.delete(key);
    }
  }

  private revokeEffects(run: Run): void {
    if (run.effectsRevoked || this.runs.get(runKey(run.identity)) !== run) return;
    this.invalidateEffects(run);
    this.onRevoke({ run: run.identity });
  }

  private closeRun(run: Run, reason: BrowserReleasedEvent['reason'], discardPages = true): void {
    const key = runKey(run.identity);
    if (this.runs.get(key) !== run) return;
    this.runs.delete(key);
    this.invalidateEffects(run);
    this.closedRuns.add(key);
    // Tombstones are an additional replay guard, not the retained invocation
    // authority. Native v2 still rejects every effect after its run closes.
    if (this.closedRuns.size > MAX_RUNS) {
      const oldest = this.closedRuns.values().next().value;
      if (oldest) this.closedRuns.delete(oldest);
    }
    this.onRelease({ run: run.identity, reason, discardPages });
  }
}
