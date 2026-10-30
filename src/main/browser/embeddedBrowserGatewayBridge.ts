import type { AppExecutionSourceBinding } from '@app-plugin/sdk/execution-source';
import type { AppExecutionSessionQuery, AppResolvedExecutionSession } from '@app-plugin/sdk/main';
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
  resolveExecutionSession?: (
    query: AppExecutionSessionQuery,
  ) => Promise<AppResolvedExecutionSession | null>;
  isExecutionSourceCurrent?: (pluginId: string, epoch: string) => boolean;
  /** Affirmative only after complete app inventory, excluding active and retired App owners. */
  isNativeOnlyExecutionSource?: (nativePluginId: string) => boolean;
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
  left.lifecycleRevision === right.lifecycleRevision &&
  path.resolve(left.workspaceDir) === path.resolve(right.workspaceDir);
const sameScope = (left: BrowserExecutionScope, right: BrowserExecutionScope): boolean =>
  left.sessionId === right.sessionId &&
  left.ownerSessionId === right.ownerSessionId &&
  left.sourcePluginId === right.sourcePluginId &&
  left.sourceEpoch === right.sourceEpoch &&
  left.runId === right.runId &&
  left.headlessOnly === right.headlessOnly &&
  path.resolve(left.workspaceDir) === path.resolve(right.workspaceDir);

/** The only adapter from authenticated plugin events to Main-owned browser resources. */
export class EmbeddedBrowserGatewayBridge {
  private readonly pending = new Map<
    string,
    { event: BrowserRequestedEvent; controller: AbortController; desktopSessionId?: string }
  >();
  private readonly completed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly admissions = new Map<
    string,
    { run: BrowserExecutionRun; revision: number; revoked: boolean }
  >();
  private readonly runs = new Map<
    string,
    {
      run: BrowserExecutionRun;
      admissionRevision: number;
      scope: BrowserExecutionScope;
      controller: AbortController;
      nativeOnlyOwnerId?: string;
      sourceNativePluginId?: string;
    }
  >();
  private readonly incarnations = new Map<string, string>();
  private readonly nativeScopes = new Map<
    string,
    { sessionId: string; lifecycleRevision?: string | null; scopeId: string }
  >();
  private readonly latestRuns = new Map<string, string>();
  private readonly ownedScopes = new Map<
    string,
    {
      run: BrowserExecutionRun;
      query: AppExecutionSessionQuery;
      source: AppResolvedExecutionSession;
      /** A real normal Released receipt left these foreground pages readable. */
      retained?: true;
    }
  >();
  private generation = 0;
  private ownershipRevision = 0;

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
      if (this.released.has(key)) return;
      if (this.hasConflictingRun(value.run)) return;
      const admission = this.admissions.get(key);
      if (admission && admission.revision > value.admissionRevision) return;
      // Retire only this tool admission. A fresh native-authorized attempt can
      // advance the revision; whole-run terminals keep their independent fence.
      this.admissions.set(key, {
        run: value.run,
        revision: value.admissionRevision,
        revoked: true,
      });
      this.retireAdmissions(value.run, value.admissionRevision);
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
          active.scope.headlessOnly || value.reason === 'revoked' || value.discardPages;
        this.options.releaseScope(active.scope.sessionId, closePages);
        if (closePages) this.forgetClosedScope(active.scope.sessionId);
        else {
          const owned = this.ownedScopes.get(active.scope.sessionId);
          if (owned && sameRun(owned.run, active.run))
            this.ownedScopes.set(active.scope.sessionId, { ...owned, retained: true });
        }
      }
      this.runs.delete(runKey(value.run));
      this.admissions.delete(runKey(value.run));
      return;
    }
    if (event.event === EMBEDDED_BROWSER_CANCELLED_EVENT) {
      const value = readBrowserCancelledEvent(event.payload);
      const pending = value ? this.pending.get(value.requestId) : undefined;
      if (
        value &&
        pending &&
        sameRun(pending.event.run, value.run) &&
        pending.event.admissionRevision === value.admissionRevision &&
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
    for (const key of this.admissions.keys()) this.remember(this.released, key);
    for (const pending of this.pending.values())
      this.remember(this.released, runKey(pending.event.run));
    for (const pending of this.pending.values()) pending.controller.abort();
    for (const run of this.runs.values()) run.controller.abort();
    this.pending.clear();
    this.runs.clear();
    this.admissions.clear();
    this.incarnations.clear();
    this.nativeScopes.clear();
    this.latestRuns.clear();
    this.ownedScopes.clear();
    this.options.revokeAll();
  }

  deleteSession(sessionId: string): void {
    this.ownershipRevision += 1;
    const closedScopes = new Set([sessionId]);
    for (const pending of this.pending.values()) {
      if (
        pending.desktopSessionId === sessionId ||
        this.runs.get(runKey(pending.event.run))?.scope.sessionId === sessionId ||
        this.runs.get(runKey(pending.event.run))?.scope.ownerSessionId === sessionId
      )
        pending.controller.abort();
    }
    for (const [key, entry] of this.runs) {
      if (entry.scope.sessionId === sessionId || entry.scope.ownerSessionId === sessionId) {
        closedScopes.add(entry.scope.sessionId);
        entry.controller.abort();
        this.remember(this.released, key);
        this.runs.delete(key);
        this.admissions.delete(key);
      }
    }
    for (const [id, scope] of this.ownedScopes)
      if (id === sessionId || scope.source.ownerSessionId === sessionId) closedScopes.add(id);
    for (const scopeId of closedScopes) {
      this.options.releaseScope(scopeId, true);
      this.forgetClosedScope(scopeId);
    }
  }

  /** Recheck UI/resource relationships; this never grants Native execution authority. */
  async reconcileOwners(metadataOnly = false): Promise<void> {
    const revision = ++this.ownershipRevision;
    const generation = this.generation;
    // Native-only runs have no App owner projection to await. Inventory loss
    // must revoke their effects and resources synchronously as well.
    for (const [key, entry] of this.runs) {
      if (
        !entry.nativeOnlyOwnerId ||
        this.options.isNativeOnlyExecutionSource?.(entry.nativeOnlyOwnerId) === true
      )
        continue;
      entry.controller.abort();
      this.remember(this.released, key);
      this.runs.delete(key);
      this.admissions.delete(key);
      if (this.latestRuns.get(entry.scope.sessionId) === key) {
        this.options.releaseScope(entry.scope.sessionId, true);
        this.forgetClosedScope(entry.scope.sessionId);
      }
    }
    await Promise.all(
      [...this.ownedScopes.entries()].map(async ([scopeId, scope]) => {
        if (
          this.options.isExecutionSourceCurrent?.(scope.source.pluginId, scope.source.epoch) !==
          true
        ) {
          this.retireOwnedScope(scopeId, scope);
          return;
        }
        // Completion may remove an active-run association. A normal release
        // retained the page for viewing, not for another tool invocation.
        if (metadataOnly && scope.retained) return;
        let owner: AppResolvedExecutionSession | null = null;
        try {
          owner = (await this.options.resolveExecutionSession?.(scope.query)) ?? null;
        } catch {
          /* Unknown ownership remains unavailable. */
        }
        if (
          generation !== this.generation ||
          revision !== this.ownershipRevision ||
          this.ownedScopes.get(scopeId) !== scope
        )
          return;
        if (
          this.options.isExecutionSourceCurrent?.(scope.source.pluginId, scope.source.epoch) ===
            true &&
          owner?.pending !== true &&
          owner?.pluginId === scope.source.pluginId &&
          owner?.nativePluginId === scope.source.nativePluginId &&
          owner?.epoch === scope.source.epoch &&
          owner?.ownerSessionId === scope.source.ownerSessionId
        )
          return;
        this.retireOwnedScope(scopeId, scope);
      }),
    );
  }

  private retireOwnedScope(scopeId: string, scope: { source: AppResolvedExecutionSession }): void {
    if (this.ownedScopes.get(scopeId) !== scope) return;
    this.ownedScopes.delete(scopeId);
    for (const [key, entry] of this.runs) {
      if (entry.scope.sessionId !== scopeId) continue;
      entry.controller.abort();
      this.remember(this.released, key);
      this.runs.delete(key);
      this.admissions.delete(key);
    }
    this.options.releaseScope(scopeId, true);
    this.forgetClosedScope(scopeId);
  }

  /** Closed pages need no incarnation locator; never evict retained live pages. */
  private forgetClosedScope(scopeId: string): void {
    this.incarnations.delete(scopeId);
    this.latestRuns.delete(scopeId);
    this.ownedScopes.delete(scopeId);
    for (const [key, native] of this.nativeScopes)
      if (native.scopeId === scopeId) this.nativeScopes.delete(key);
  }

  private executionQuery(
    run: BrowserExecutionRun,
    source?: AppExecutionSourceBinding,
  ): AppExecutionSessionQuery {
    return {
      sessionKey: run.sessionKey,
      nativeSessionId: run.sessionId,
      ...(run.lifecycleRevision !== undefined ? { lifecycleRevision: run.lifecycleRevision } : {}),
      runId: run.runId,
      ...(source ? { ownerPluginId: source.ownerPluginId } : {}),
    };
  }

  private hasConflictingRun(run: BrowserExecutionRun): boolean {
    const key = runKey(run);
    const active = this.runs.get(key);
    const admission = this.admissions.get(key);
    return (
      Boolean(active && !sameRun(active.run, run)) ||
      Boolean(admission && !sameRun(admission.run, run)) ||
      [...this.pending.values()].some(
        pending => runKey(pending.event.run) === key && !sameRun(pending.event.run, run),
      )
    );
  }

  private retireAdmissions(run: BrowserExecutionRun, throughRevision: number): void {
    for (const pending of this.pending.values()) {
      if (sameRun(pending.event.run, run) && pending.event.admissionRevision <= throughRevision)
        pending.controller.abort();
    }
    const active = this.runs.get(runKey(run));
    if (!active || active.admissionRevision > throughRevision || active.controller.signal.aborted)
      return;
    active.controller.abort();
    if (this.latestRuns.get(active.scope.sessionId) === runKey(run)) {
      this.options.releaseScope(active.scope.sessionId, active.scope.headlessOnly);
      if (active.scope.headlessOnly) this.forgetClosedScope(active.scope.sessionId);
    }
  }

  private async dispatch(
    event: BrowserRequestedEvent,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const key = runKey(event.run);
    const assertCurrent = (): void => {
      controller.signal.throwIfAborted();
      const admission = this.admissions.get(key);
      if (
        generation !== this.generation ||
        this.released.has(key) ||
        admission?.revision !== event.admissionRevision ||
        admission.revoked ||
        !this.options.isEnabled()
      ) {
        throw new Error('The browser execution is no longer available.');
      }
    };
    try {
      controller.signal.throwIfAborted();
      if (generation !== this.generation || this.released.has(key) || !this.options.isEnabled())
        throw new Error('The browser execution is no longer available.');
      if (this.hasConflictingRun(event.run)) throw new Error('Browser run identity changed.');
      const admission = this.admissions.get(key);
      if (!admission || admission.revision < event.admissionRevision) {
        this.retireAdmissions(event.run, event.admissionRevision - 1);
        this.admissions.set(key, {
          run: event.run,
          revision: event.admissionRevision,
          revoked: false,
        });
      }
      assertCurrent();
      let entry = this.runs.get(key);
      if (entry && !sameRun(entry.run, event.run)) throw new Error('Browser run identity changed.');
      const capturedEntry = entry;
      const ownershipRevision = this.ownershipRevision;
      const desktop =
        event.run.trigger === 'user' ? this.options.getDesktopSession(event.run.sessionKey) : null;
      const pending = this.pending.get(event.requestId);
      if (pending && desktop) pending.desktopSessionId = desktop.id;
      const { scope, source, nativeOnlyOwnerId } = await this.prepareScope(
        event.run,
        desktop,
        event.command,
        event.executionSource,
      );
      assertCurrent();
      if (ownershipRevision !== this.ownershipRevision) {
        // Another Agent's receipt may have refreshed the global inventory while
        // this read awaited Native evidence. Verify this exact source once;
        // metadata notifications neither retry execution nor change its owner.
        const verificationRevision = this.ownershipRevision;
        const current = await this.prepareScope(
          event.run,
          event.run.trigger === 'user'
            ? this.options.getDesktopSession(event.run.sessionKey)
            : null,
          event.command,
          event.executionSource,
        );
        assertCurrent();
        if (
          verificationRevision !== this.ownershipRevision ||
          !sameScope(current.scope, scope) ||
          current.nativeOnlyOwnerId !== nativeOnlyOwnerId ||
          current.source?.nativePluginId !== source?.nativePluginId
        )
          throw new Error('Browser ownership changed during admission.');
      }
      scope.assertCurrent?.();
      // Source preparation yields. Another call may already have admitted this
      // run; a conflicting late read must not borrow or retire its resources.
      entry = this.runs.get(runKey(event.run));
      if (entry) {
        if (!sameRun(entry.run, event.run)) throw new Error('Browser run identity changed.');
        if (
          !sameScope(entry.scope, scope) ||
          entry.nativeOnlyOwnerId !== nativeOnlyOwnerId ||
          entry.sourceNativePluginId !== source?.nativePluginId
        ) {
          // A current read can withdraw an entry that already existed when
          // admission began. A late parallel read cannot retire a newer entry.
          if (entry === capturedEntry) {
            entry.controller.abort();
            this.remember(this.released, runKey(event.run));
            this.runs.delete(runKey(event.run));
            this.admissions.delete(runKey(event.run));
            this.options.releaseScope(entry.scope.sessionId, true);
            this.forgetClosedScope(entry.scope.sessionId);
          }
          throw new Error('Browser ownership changed during admission.');
        }
      }
      const previousOwner = this.ownedScopes.get(scope.sessionId);
      if (
        previousOwner &&
        (previousOwner.source.pluginId !== source?.pluginId ||
          previousOwner.source.nativePluginId !== source?.nativePluginId ||
          previousOwner.source.epoch !== source?.epoch ||
          previousOwner.source.ownerSessionId !== scope.ownerSessionId)
      )
        this.retireOwnedScope(scope.sessionId, previousOwner);
      if (scope.sessionId.startsWith('browser-execution:')) {
        const previous = this.nativeScopes.get(event.run.sessionKey);
        if (
          previous &&
          (previous.sessionId !== event.run.sessionId ||
            previous.lifecycleRevision !== event.run.lifecycleRevision)
        ) {
          for (const [key, active] of this.runs) {
            if (active.scope.sessionId !== previous.scopeId) continue;
            active.controller.abort();
            this.remember(this.released, key);
            this.runs.delete(key);
            this.admissions.delete(key);
          }
          this.options.releaseScope(previous.scopeId, true);
          this.forgetClosedScope(previous.scopeId);
        }
        this.nativeScopes.set(event.run.sessionKey, {
          sessionId: event.run.sessionId,
          lifecycleRevision: event.run.lifecycleRevision,
          scopeId: scope.sessionId,
        });
      }
      if (!entry || entry.admissionRevision !== event.admissionRevision) {
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
            this.remember(this.released, key);
            this.runs.delete(key);
            this.admissions.delete(key);
          }
        }
        entry = {
          run: event.run,
          admissionRevision: event.admissionRevision,
          scope,
          controller: new AbortController(),
          ...(nativeOnlyOwnerId ? { nativeOnlyOwnerId } : {}),
          ...(source ? { sourceNativePluginId: source.nativePluginId } : {}),
        };
        this.runs.set(runKey(event.run), entry);
        if (source)
          this.ownedScopes.set(scope.sessionId, {
            run: event.run,
            query: this.executionQuery(event.run, event.executionSource),
            source,
          });
      }
      this.latestRuns.set(entry.scope.sessionId, runKey(event.run));
      if (entry.scope.headlessOnly && event.command.headless === false)
        throw new Error(
          'This execution has no foreground browser page. Use headless=true for background browsing.',
        );
      const result = await this.options.execute(
        event.sessionKey,
        event.command,
        AbortSignal.any([controller.signal, entry.controller.signal]),
        {
          ...entry.scope,
          allowLocalFiles: event.policy.allowLocalFiles,
        },
      );
      entry.scope.assertCurrent?.();
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
    command: Record<string, unknown>,
    executionSource?: AppExecutionSourceBinding,
  ): Promise<{
    scope: BrowserExecutionScope;
    source?: AppResolvedExecutionSession;
    nativeOnlyOwnerId?: string;
  }> {
    if (!path.isAbsolute(run.workspaceDir))
      throw new Error('The browser workspace is unavailable.');
    const scopeId =
      run.lifecycleRevision === undefined
        ? undefined
        : `browser-execution:${createHash('sha256')
            .update(JSON.stringify([run.sessionKey, run.sessionId, run.lifecycleRevision]))
            .digest('hex')}`;
    const nativeOnlyOwnerId =
      executionSource &&
      (!scopeId || !this.ownedScopes.has(scopeId)) &&
      this.options.isNativeOnlyExecutionSource?.(executionSource.ownerPluginId) === true
        ? executionSource.ownerPluginId
        : undefined;
    // Product-bound members can be executing an exact App-owned delivery. Resolve
    // that association before taking the ordinary conversation fallback. A
    // positively classified Native-only producer never borrows App UI ownership.
    const owner =
      run.trigger !== 'cron' && !nativeOnlyOwnerId
        ? ((await this.options.resolveExecutionSession?.(
            this.executionQuery(run, executionSource),
          )) ?? null)
        : null;
    if (owner?.pending) throw new Error('The browser execution source is not yet confirmed.');
    if (executionSource && owner && owner.nativePluginId !== executionSource.ownerPluginId)
      throw new Error('The owning plugin is no longer available for this execution.');
    if (run.trigger === 'user' && desktop && !owner && (!executionSource || nativeOnlyOwnerId)) {
      if (
        !desktop ||
        path.resolve(desktop.cwd) !== path.resolve(run.workspaceDir) ||
        (desktop.historyBinding && desktop.historyBinding.nativeSessionId !== run.sessionId)
      ) {
        throw new Error('The browser session binding is unavailable.');
      }
      return {
        scope: {
          sessionId: desktop.id,
          runId: run.runId,
          workspaceDir: desktop.cwd,
          headlessOnly: false,
          ...(nativeOnlyOwnerId
            ? {
                assertCurrent: () => {
                  if (this.options.isNativeOnlyExecutionSource?.(nativeOnlyOwnerId) !== true)
                    throw new Error('The execution source inventory is no longer current.');
                },
              }
            : {}),
        },
        ...(nativeOnlyOwnerId ? { nativeOnlyOwnerId } : {}),
      };
    }
    if (run.trigger !== 'cron') {
      if (!scopeId) throw new Error('The native browser lifecycle is unavailable.');
      if (executionSource && !owner && !nativeOnlyOwnerId)
        throw new Error('The owning plugin is no longer available for this execution.');
      const assertSourceCurrent = owner
        ? () => {
            if (this.options.isExecutionSourceCurrent?.(owner.pluginId, owner.epoch) !== true)
              throw new Error('The owning plugin is no longer available for this execution.');
          }
        : nativeOnlyOwnerId
          ? () => {
              if (this.options.isNativeOnlyExecutionSource?.(nativeOnlyOwnerId) !== true)
                throw new Error('The execution source inventory is no longer current.');
            }
          : undefined;
      assertSourceCurrent?.();
      if (!owner?.ownerSessionId && command.headless !== true)
        throw new Error(
          'This execution is not attached to a desktop conversation. Use headless=true for background browsing.',
        );
      return {
        scope: {
          sessionId: scopeId,
          ...(owner?.ownerSessionId ? { ownerSessionId: owner.ownerSessionId } : {}),
          ...(owner
            ? {
                sourcePluginId: owner.pluginId,
                sourceEpoch: owner.epoch,
                assertCurrent: assertSourceCurrent,
              }
            : {}),
          ...(!owner && assertSourceCurrent ? { assertCurrent: assertSourceCurrent } : {}),
          runId: run.runId,
          workspaceDir: run.workspaceDir,
          headlessOnly: !owner?.ownerSessionId,
        },
        ...(owner ? { source: owner } : {}),
        ...(nativeOnlyOwnerId ? { nativeOnlyOwnerId } : {}),
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
      scope: {
        sessionId: `browser-run:${digest}`,
        runId: run.runId,
        workspaceDir: run.workspaceDir,
        headlessOnly: true,
      },
    };
  }

  private remember(collection: Set<string>, value: string): void {
    collection.add(value);
    if (collection.size > 1_024) collection.delete(collection.values().next().value!);
  }
}
