import { createHash } from 'crypto';
import path from 'path';

import {
  type BrowserExecutionRun,
  type BrowserRequestedEvent,
  EMBEDDED_BROWSER_CANCELLED_EVENT,
  EMBEDDED_BROWSER_RELEASED_EVENT,
  EMBEDDED_BROWSER_REQUESTED_EVENT,
  EMBEDDED_BROWSER_REVOKED_EVENT,
  EMBEDDED_BROWSER_STOPPED_EVENT,
  readBrowserCancelledEvent,
  readBrowserReleasedEvent,
  readBrowserRequestedEvent,
  readBrowserRevokedEvent,
} from '../../../plugins/extensions/embedded-browser/browserExecutionContract';
import type { ScheduledTask } from '../../shared/scheduledTask/types';
import type { BrowserExecutionScope } from './agent/browserAgentProtocol';

type DesktopSession = {
  id: string;
  cwd: string;
  historyBinding?: { nativeSessionId: string };
};

type Options = {
  isEnabled: () => boolean;
  getDesktopSession: (sessionKey: string) => DesktopSession | null;
  getScheduledTask: (jobId: string) => Promise<ScheduledTask | null>;
  execute: (
    sessionKey: string,
    command: unknown,
    signal: AbortSignal,
    scope: BrowserExecutionScope,
  ) => Promise<unknown>;
  releaseScope: (sessionId: string, closePages: boolean) => void;
  revokeAll: () => void;
  resolve: (requestId: string, response: Record<string, unknown>) => Promise<unknown>;
};

const runKey = (run: BrowserExecutionRun): string =>
  JSON.stringify([run.sessionKey, run.sessionId, run.runId]);
const sameRun = (left: BrowserExecutionRun, right: BrowserExecutionRun): boolean =>
  runKey(left) === runKey(right) &&
  left.trigger === right.trigger &&
  left.jobId === right.jobId &&
  path.resolve(left.workspaceDir) === path.resolve(right.workspaceDir);

/** The only adapter from authenticated plugin events to Main-owned browser resources. */
export class EmbeddedBrowserGatewayBridge {
  private readonly pending = new Map<
    string,
    { event: BrowserRequestedEvent; controller: AbortController; desktopSessionId?: string }
  >();
  private readonly completed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly runs = new Map<
    string,
    { run: BrowserExecutionRun; scope: BrowserExecutionScope; controller: AbortController }
  >();
  private readonly incarnations = new Map<string, string>();
  private readonly latestRuns = new Map<string, string>();
  private generation = 0;

  constructor(private readonly options: Options) {}

  handleEvent(event: { event: string; payload?: unknown }): void {
    if (event.event === EMBEDDED_BROWSER_STOPPED_EVENT) {
      this.revoke();
      return;
    }
    if (event.event === EMBEDDED_BROWSER_REVOKED_EVENT) {
      const value = readBrowserRevokedEvent(event.payload);
      if (!value) return;
      const key = runKey(value.run);
      const active = this.runs.get(key);
      if (this.hasConflictingRun(value.run)) return;
      const alreadyRevoked = this.released.has(key);
      // Tool-generation disposal also aborts native tool signals on success.
      // Fence effects immediately, but retain the identity for the true terminal.
      this.remember(this.released, key);
      for (const pending of this.pending.values()) {
        if (sameRun(pending.event.run, value.run)) pending.controller.abort();
      }
      active?.controller.abort();
      if (active && !alreadyRevoked && this.latestRuns.get(active.scope.sessionId) === key) {
        this.options.releaseScope(active.scope.sessionId, value.run.trigger === 'cron');
      }
      return;
    }
    if (event.event === EMBEDDED_BROWSER_RELEASED_EVENT) {
      const value = readBrowserReleasedEvent(event.payload);
      if (!value) return;
      const active = this.runs.get(runKey(value.run));
      if (this.hasConflictingRun(value.run)) return;
      this.remember(this.released, runKey(value.run));
      for (const pending of this.pending.values()) {
        if (sameRun(pending.event.run, value.run)) pending.controller.abort();
      }
      // This run controller survives a completed response. Native revocation
      // must invalidate its armed effects without waiting for executionSettled.
      active?.controller.abort();
      if (
        active &&
        sameRun(active.run, value.run) &&
        this.latestRuns.get(active.scope.sessionId) === runKey(value.run)
      ) {
        const closePages =
          value.run.trigger === 'cron' || value.reason === 'revoked' || value.discardPages;
        this.options.releaseScope(active.scope.sessionId, closePages);
        if (closePages) {
          this.incarnations.delete(active.scope.sessionId);
          this.latestRuns.delete(active.scope.sessionId);
        }
      }
      this.runs.delete(runKey(value.run));
      return;
    }
    if (event.event === EMBEDDED_BROWSER_CANCELLED_EVENT) {
      const value = readBrowserCancelledEvent(event.payload);
      const pending = value ? this.pending.get(value.requestId) : undefined;
      if (
        value &&
        pending &&
        sameRun(pending.event.run, value.run) &&
        pending.event.toolCallId === value.toolCallId
      ) {
        pending.controller.abort();
      }
      return;
    }
    if (event.event !== EMBEDDED_BROWSER_REQUESTED_EVENT) return;
    const value = readBrowserRequestedEvent(event.payload);
    if (!value || this.pending.has(value.requestId) || this.completed.has(value.requestId)) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.pending.set(value.requestId, { event: value, controller });
    void this.dispatch(value, controller, generation)
      .catch(error => {
        console.warn(
          '[EmbeddedBrowserGatewayBridge] Failed to deliver a browser response:',
          error instanceof Error ? error.name : 'Error',
        );
      })
      .finally(() => {
        if (this.pending.get(value.requestId)?.controller === controller)
          this.pending.delete(value.requestId);
        this.remember(this.completed, value.requestId);
      });
  }

  revoke(): void {
    this.generation += 1;
    for (const pending of this.pending.values()) pending.controller.abort();
    for (const run of this.runs.values()) run.controller.abort();
    this.pending.clear();
    this.runs.clear();
    this.incarnations.clear();
    this.latestRuns.clear();
    this.options.revokeAll();
  }

  deleteSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (
        pending.desktopSessionId === sessionId ||
        this.runs.get(runKey(pending.event.run))?.scope.sessionId === sessionId
      )
        pending.controller.abort();
    }
    for (const [key, entry] of this.runs) {
      if (entry.scope.sessionId === sessionId) {
        entry.controller.abort();
        this.remember(this.released, key);
        this.runs.delete(key);
      }
    }
    this.options.releaseScope(sessionId, true);
    this.incarnations.delete(sessionId);
    this.latestRuns.delete(sessionId);
  }

  private hasConflictingRun(run: BrowserExecutionRun): boolean {
    const key = runKey(run);
    const active = this.runs.get(key);
    return (
      Boolean(active && !sameRun(active.run, run)) ||
      [...this.pending.values()].some(
        pending => runKey(pending.event.run) === key && !sameRun(pending.event.run, run),
      )
    );
  }

  private async dispatch(
    event: BrowserRequestedEvent,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const assertCurrent = (): void => {
      controller.signal.throwIfAborted();
      if (
        generation !== this.generation ||
        this.released.has(runKey(event.run)) ||
        !this.options.isEnabled()
      ) {
        throw new Error('The browser execution is no longer available.');
      }
    };
    try {
      assertCurrent();
      let entry = this.runs.get(runKey(event.run));
      if (entry && !sameRun(entry.run, event.run)) throw new Error('Browser run identity changed.');
      if (!entry) {
        const desktop =
          event.run.trigger === 'user'
            ? this.options.getDesktopSession(event.run.sessionKey)
            : null;
        const pending = this.pending.get(event.requestId);
        if (pending && desktop) pending.desktopSessionId = desktop.id;
        const scope = await this.prepareScope(event.run, desktop);
        assertCurrent();
        // Another call in the same native run may finish preparation first.
        // Reuse its lifetime controller; never orphan an already-admitted call.
        entry = this.runs.get(runKey(event.run));
        if (entry && !sameRun(entry.run, event.run))
          throw new Error('Browser run identity changed.');
        if (!entry) {
          // A new native incarnation may reuse a product conversation, but never its old background page.
          const previousIncarnation = this.incarnations.get(scope.sessionId);
          if (previousIncarnation && previousIncarnation !== event.run.sessionId) {
            this.options.releaseScope(scope.sessionId, true);
          }
          this.incarnations.set(scope.sessionId, event.run.sessionId);
          for (const [key, previous] of this.runs) {
            if (
              previous.scope.sessionId === scope.sessionId &&
              previous.run.sessionId !== event.run.sessionId
            ) {
              previous.controller.abort();
              this.options.releaseScope(previous.scope.sessionId, true);
              this.runs.delete(key);
            }
          }
          entry = { run: event.run, scope, controller: new AbortController() };
          this.runs.set(runKey(event.run), entry);
        }
      }
      this.latestRuns.set(entry.scope.sessionId, runKey(event.run));
      if (entry.scope.headlessOnly && event.command.headless === false)
        throw new Error('Scheduled browser execution requires headless=true.');
      const result = await this.options.execute(
        event.sessionKey,
        event.command,
        AbortSignal.any([controller.signal, entry.controller.signal]),
        {
          ...entry.scope,
          allowLocalFiles: event.policy.allowLocalFiles,
        },
      );
      assertCurrent();
      await this.options.resolve(event.requestId, { ok: true, result });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      await this.options.resolve(event.requestId, {
        ok: false,
        error: error instanceof Error ? error.message : 'Browser action failed.',
      });
    }
  }

  private async prepareScope(
    run: BrowserExecutionRun,
    desktop: DesktopSession | null,
  ): Promise<BrowserExecutionScope> {
    if (!path.isAbsolute(run.workspaceDir))
      throw new Error('The browser workspace is unavailable.');
    if (run.trigger === 'user') {
      if (
        !desktop ||
        path.resolve(desktop.cwd) !== path.resolve(run.workspaceDir) ||
        (desktop.historyBinding && desktop.historyBinding.nativeSessionId !== run.sessionId)
      ) {
        throw new Error('The browser session binding is unavailable.');
      }
      return {
        sessionId: desktop.id,
        runId: run.runId,
        workspaceDir: desktop.cwd,
        headlessOnly: false,
      };
    }
    const job = run.jobId ? await this.options.getScheduledTask(run.jobId) : null;
    if (
      !job ||
      job.id !== run.jobId ||
      job.management !== 'editable' ||
      job.sessionTarget !== 'isolated' ||
      job.payload.kind !== 'agentTurn'
    ) {
      throw new Error('This scheduled task does not support the embedded browser.');
    }
    const digest = createHash('sha256').update(runKey(run)).digest('hex');
    return {
      sessionId: `browser-run:${digest}`,
      runId: run.runId,
      workspaceDir: run.workspaceDir,
      headlessOnly: true,
    };
  }

  private remember(collection: Set<string>, value: string): void {
    collection.add(value);
    if (collection.size > 1_024) collection.delete(collection.values().next().value!);
  }
}
