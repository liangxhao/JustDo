import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WebContents } from 'electron';

import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import { mcpAppRecord, type McpAppWorkspaceBinding } from '../../../shared/plugins/mcpApps';
import {
  resolvePermissionMode,
  toOpenClawSessionPermissionMode,
} from '../../../shared/security/approvals';
import type { CoworkStore } from '../../data/coworkStore';
import type { GatewayResponseContext } from '../../engine/gateway/types';
import type { GatewayRequestOptions } from '../../engine/types';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';

interface Dependencies {
  getStore: () => CoworkStore;
  request: <T>(method: string, params: unknown, options?: GatewayRequestOptions) => Promise<T>;
  captureResponseContext: () => Promise<GatewayResponseContext | null>;
}
interface WorkspaceEntry {
  stage: 'transport' | 'inspection' | 'creation';
  signature: string;
  released: boolean;
  productSessionId: string;
  sessionKey: string;
  createIssued: boolean;
  creationSettled: boolean;
  responseContext: GatewayResponseContext | null;
  task: Promise<{
    binding: McpAppWorkspaceBinding;
    lifecycleRevision: string;
    productSessionId: string;
  }>;
  releaseTask?: Promise<null>;
  replacementTask?: Promise<McpAppWorkspaceBinding>;
  replacementEntry?: WorkspaceEntry;
}
interface PreparationAttempt {
  entries?: Map<string, WorkspaceEntry>;
  entry?: WorkspaceEntry;
  stage?: 'transport' | 'verification';
}

const MAX_WORKSPACES_PER_DOCUMENT = 8;
const localFailures = new Set([
  'Invalid App workspace', 'App workspace is no longer current', 'App workspace is closed',
  'App workspace changed', 'Too many App workspaces', 'App workspace changed during preparation',
  'App workspace changed during replacement', 'Native App workspace changed',
  'Reserved native App workspace already exists or is unavailable', 'Invalid native App workspace',
]);
const gatewayFailureCodes = new Set([
  'UNAVAILABLE', 'FORBIDDEN', 'INVALID_REQUEST', 'CLIENT_TIMEOUT', 'CONNECTION_CLOSED',
]);

// Never put arbitrary native error text, task content or credentials into these diagnostics.
function failureDetails(error: unknown) {
  const failure = mcpAppRecord(error);
  return {
    reason: error instanceof Error && localFailures.has(error.message)
      ? error.message : 'Native or transport failure',
    code: typeof failure?.code === 'string' && gatewayFailureCodes.has(failure.code)
      ? failure.code : undefined,
  };
}

/** Owned native preview sessions, without creating a product conversation. */
export class WorkspaceAppSessions {
  private readonly owners = new Map<WebContents, Map<string, WorkspaceEntry>>();
  private readonly watchedOwners = new WeakSet<WebContents>();

  constructor(private readonly deps: Dependencies) {}

  private retireDocument(owner: WebContents, reason: string): void {
    const entries = this.owners.get(owner);
    if (!entries) return;
    console.info(`[WorkspaceAppSessions] Retiring document: ${JSON.stringify({
      ownerId: owner.id, reason, count: entries.size,
    })}`);
    // release synchronously revokes each entry before its first await. Detach
    // this map now so a new document does not wait for native cleanup or inherit
    // the old quota. Each cleanup retains its captured entry/map, never a successor.
    for (const requestId of entries.keys())
      void this.release(owner, requestId).catch((): undefined => undefined); // release logs the outcome.
    if (this.owners.get(owner) === entries) this.owners.delete(owner);
  }

  private watchOwner(owner: WebContents): void {
    if (this.watchedOwners.has(owner)) return;
    this.watchedOwners.add(owner);
    owner.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument)
        this.retireDocument(owner, 'navigation-start');
    });
    // Revoke requests from the outgoing document admitted between start and
    // commit. Same-document navigation and App iframe navigation do not fire this.
    owner.on('did-navigate', () => this.retireDocument(owner, 'navigation-commit'));
    owner.on('render-process-gone', () => this.retireDocument(owner, 'renderer-gone'));
    owner.once('destroyed', () => this.retireDocument(owner, 'destroyed'));
  }

  private async create(
    scope: ReturnType<WorkspaceAppSessions['scope']>,
    entry: WorkspaceEntry,
    assertCurrent: () => void,
  ) {
    const { productSessionId, sessionKey } = entry;
    assertCurrent();
    entry.stage = 'inspection';
    // The native observation waits for background agent admission. Only a
    // refusal here proves that this owner has not dispatched any creation.
    const preflight = await this.deps.request<{ session: unknown }>(
      'sessions.describe', { key: sessionKey, agentId: scope.agentId }, { assertBeforeSend: assertCurrent },
    );
    assertCurrent();
    if (preflight?.session !== null) throw new Error('Reserved native App workspace already exists or is unavailable');
    entry.createIssued = true;
    entry.stage = 'creation';
    const result = await this.deps.request<{
      key: string;
      sessionId: string;
      entry: Record<string, unknown>;
      runStarted: boolean;
    }>('sessions.create', {
      key: sessionKey,
      agentId: scope.agentId,
      cwd: scope.cwd,
      permissionMode: scope.permissionMode,
    }, { assertBeforeSend: assertCurrent });
    if (
      result.key !== sessionKey ||
      typeof result.sessionId !== 'string' ||
      !result.sessionId ||
      result.entry?.sessionId !== result.sessionId ||
      typeof result.entry.lifecycleRevision !== 'string' ||
      result.runStarted !== false
    )
      throw new Error('Invalid native App workspace');
    return {
      binding: { sessionKey, gatewaySessionId: result.sessionId, agentId: scope.agentId },
      lifecycleRevision: result.entry.lifecycleRevision,
      productSessionId,
    };
  }

  private scope(raw: unknown) {
    const input = mcpAppRecord(raw);
    if (
      typeof input?.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId) ||
      typeof input.agentId !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/i.test(input.agentId) ||
      typeof input.cwd !== 'string' ||
      input.cwd.length > 4096 ||
      !path.isAbsolute(input.cwd)
    )
      throw new Error('Invalid App workspace');
    const store = this.deps.getStore();
    const config = store.getConfig();
    const agent = store.getAgent(input.agentId);
    if (
      !agent?.enabled ||
      agent.deletedAt ||
      !config.workingDirectory.trim() ||
      !path.isAbsolute(config.workingDirectory) ||
      (input.agentId !== MAIN_USER_AGENT_ID && config.allowMainAgentSwitch !== true) ||
      path.resolve(input.cwd) !== path.resolve(config.workingDirectory)
    )
      throw new Error('App workspace is no longer current');
    const cwd = path.resolve(config.workingDirectory);
    const permissionMode = toOpenClawSessionPermissionMode(
      resolvePermissionMode(config.permissionMode),
    );
    return {
      requestId: input.requestId,
      agentId: input.agentId,
      cwd,
      permissionMode,
      signature: JSON.stringify([input.agentId, cwd, permissionMode]),
    };
  }

  async prepare(owner: WebContents, raw: unknown): Promise<McpAppWorkspaceBinding> {
    const attempt: PreparationAttempt = {};
    try {
      return await this.prepareCurrent(owner, raw, attempt);
    } catch (error) {
      const input = mcpAppRecord(raw);
      const requestId = typeof input?.requestId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(input.requestId) ? input.requestId : undefined;
      // Navigation may already have installed a successor map with the same ID.
      // Report this attempt's receipt, never the current document's state.
      const { entries, entry } = attempt;
      console.warn(`[WorkspaceAppSessions] Preparation failed: ${JSON.stringify({
        ownerId: owner.id, requestId, stage: attempt.stage ?? entry?.stage ?? 'admission',
        count: entries?.size ?? 0, limit: MAX_WORKSPACES_PER_DOCUMENT,
        createIssued: entry?.createIssued ?? false, ...failureDetails(error),
      })}`);
      throw error;
    }
  }

  private async prepareCurrent(
    owner: WebContents, raw: unknown, attempt: PreparationAttempt,
  ): Promise<McpAppWorkspaceBinding> {
    const scope = this.scope(raw);
    if (owner.isDestroyed()) throw new Error('App workspace is closed');
    let entries = this.owners.get(owner);
    if (!entries) {
      entries = new Map();
      this.owners.set(owner, entries);
    }
    this.watchOwner(owner);
    attempt.entries = entries;
    let entry = entries.get(scope.requestId);
    attempt.entry = entry;
    // Concurrent joiners of the same creation are not a later explicit re-read.
    const existing = entry?.creationSettled === true;
    if (entry && (entry.released || entry.signature !== scope.signature))
      throw new Error('App workspace changed');
    if (!entry) {
      if (entries.size >= MAX_WORKSPACES_PER_DOCUMENT) throw new Error('Too many App workspaces');
      const productSessionId = randomUUID();
      const assertOwnerCurrent = () => {
        if (
          this.owners.get(owner) !== entries || entries.get(scope.requestId) !== next ||
          next.released || owner.isDestroyed() || this.scope(raw).signature !== scope.signature
        ) throw new Error('App workspace changed during preparation');
      };
      const assertCurrent = () => {
        assertOwnerCurrent();
        if (!next.responseContext?.isCurrent()) throw new Error('App workspace changed during preparation');
      };
      const next: WorkspaceEntry = {
        stage: 'transport',
        signature: scope.signature,
        released: false,
        productSessionId,
        sessionKey: buildManagedSessionKey(productSessionId, scope.agentId),
        createIssued: false,
        creationSettled: false,
        responseContext: null,
        task: Promise.resolve().then(async () => {
          assertOwnerCurrent();
          next.responseContext = await this.deps.captureResponseContext();
          assertCurrent();
          return this.create(scope, next, assertCurrent);
        }).then(result => {
          next.creationSettled = true;
          return result;
        }).catch(error => {
          let current = false;
          try { assertCurrent(); current = true; } catch { /* Retain revoked or uncertain ownership. */ }
          if (current && !next.createIssued && this.isInspectionPending(error, scope.agentId, next.responseContext)) {
            // No automatic retry: a later explicit preparation may reserve a new
            // owner only after this read-only, correlated rejection was observed.
            if (this.owners.get(owner) === entries && entries.get(scope.requestId) === next) {
              entries.delete(scope.requestId);
              if (!entries.size) this.owners.delete(owner);
            }
          }
          throw error;
        }),
      };
      entries.set(scope.requestId, next);
      attempt.entry = next;
      console.info(`[WorkspaceAppSessions] Reserved workspace: ${JSON.stringify({
        ownerId: owner.id, requestId: scope.requestId, count: entries.size,
      })}`);
      entry = next;
    }
    const { binding } = await entry.task;
    if (existing) attempt.stage = 'transport';
    const responseContext = existing ? await this.deps.captureResponseContext() : entry.responseContext;
    const assertReadCurrent = () => {
      if (this.owners.get(owner) !== entries || entries.get(scope.requestId) !== entry ||
        entry.released || owner.isDestroyed() || this.scope(raw).signature !== entry.signature ||
        !responseContext?.isCurrent())
        throw new Error('App workspace changed during preparation');
    };
    assertReadCurrent();
    attempt.stage = 'verification';
    const { session } = await this.deps.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key: binding.sessionKey, agentId: binding.agentId },
      { assertBeforeSend: assertReadCurrent },
    );
    // Only explicit preparation may replace a removed owned context. Existing
    // native identities must still match; live view lifecycle checks stay native.
    if (!session && existing && !entry.released && !owner.isDestroyed() &&
      this.scope(raw).signature === entry.signature && responseContext?.isCurrent()) {
      // Concurrent absent reads may join the replacement owned by this entry;
      // they cannot remove or recreate the successor that is already preparing.
      if (!entry.replacementTask) {
        assertReadCurrent();
        entries.delete(scope.requestId);
        entry.replacementTask = this.prepare(owner, raw);
        entry.replacementEntry = entries.get(scope.requestId);
      }
      const successor = entry.replacementEntry;
      const task = entry.replacementTask;
      const assertSuccessorCurrent = () => {
        if (!successor || this.owners.get(owner) !== entries || entries.get(scope.requestId) !== successor ||
          successor.released || owner.isDestroyed() || this.scope(raw).signature !== successor.signature ||
          !responseContext.isCurrent()) throw new Error('App workspace changed during replacement');
      };
      try {
        assertSuccessorCurrent();
        const replacement = await task;
        assertSuccessorCurrent();
        return replacement;
      } catch (error) {
        void task.catch((): undefined => undefined);
        throw error;
      }
    }
    assertReadCurrent();
    if (
      entry.released ||
      owner.isDestroyed() ||
      this.scope(raw).signature !== entry.signature ||
      session?.sessionId !== binding.gatewaySessionId ||
      session.sessionRoot !== scope.cwd ||
      session.permissionMode !== scope.permissionMode
    )
      throw new Error('Native App workspace changed');
    console.info(`[WorkspaceAppSessions] Workspace ready: ${JSON.stringify({
      ownerId: owner.id, requestId: scope.requestId, count: entries.size,
    })}`);
    return binding;
  }

  private isInspectionPending(error: unknown, agentId: string, context: GatewayResponseContext | null): boolean {
    try {
      if (!context?.isResponseError(error)) return false;
      const failure = mcpAppRecord(error);
      const details = mcpAppRecord(failure?.details);
      return failure?.code === 'UNAVAILABLE' && failure.gatewayCode === 'UNAVAILABLE' &&
        failure.retryable === true && details?.code === 'agent-database-inspection-pending' &&
        details.agentId === agentId;
    } catch { return false; }
  }

  async release(owner: WebContents, requestId: unknown): Promise<null> {
    if (typeof requestId !== 'string') throw new Error('Invalid App workspace');
    const entries = this.owners.get(owner);
    const entry = entries?.get(requestId);
    if (!entry) return null;
    if (entry.releaseTask) return entry.releaseTask;
    entry.released = true;
    entry.releaseTask = (async (): Promise<null> => {
      let stage: 'preparation' | 'deletion' = 'preparation';
      try {
        const { binding, lifecycleRevision } = await entry.task;
        stage = 'deletion';
        await this.deps.request('sessions.delete', {
          key: binding.sessionKey,
          agentId: binding.agentId,
          expectedSessionId: binding.gatewaySessionId,
          expectedLifecycleRevision: lifecycleRevision,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        });
        console.info(`[WorkspaceAppSessions] Cleanup acknowledged: ${JSON.stringify({ ownerId: owner.id, requestId })}`);
      } catch (error) {
        console.warn(`[WorkspaceAppSessions] Cleanup unconfirmed; no retry: ${JSON.stringify({
          ownerId: owner.id, requestId, stage, createIssued: entry.createIssued,
          ...failureDetails(error),
        })}`);
        throw error;
      } finally {
        if (entries?.get(requestId) === entry) entries.delete(requestId);
        if (!entries?.size && this.owners.get(owner) === entries) this.owners.delete(owner);
      }
      return null;
    })();
    return entry.releaseTask;
  }

  /** First-send adoption preserves the native runtime, views and their pending context. */
  async adopt<T>(
    owner: WebContents,
    raw: unknown,
    create: (productSessionId: string, binding: McpAppWorkspaceBinding) => T,
    isCurrent: () => boolean,
  ): Promise<{ value: T; binding: McpAppWorkspaceBinding }> {
    const scope = this.scope(raw);
    const entries = this.owners.get(owner);
    const entry = entries?.get(scope.requestId);
    if (!entry || entry.released || entry.signature !== scope.signature)
      throw new Error('App workspace is no longer available');
    const { binding, productSessionId } = await entry.task;
    const { session } = await this.deps.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key: binding.sessionKey, agentId: binding.agentId },
    );
    if (
      entry.released ||
      owner.isDestroyed() ||
      !isCurrent() ||
      entries?.get(scope.requestId) !== entry ||
      this.scope(raw).signature !== scope.signature ||
      session?.sessionId !== binding.gatewaySessionId ||
      session.sessionRoot !== scope.cwd ||
      session.permissionMode !== scope.permissionMode
    )
      throw new Error('Native App workspace changed before first send');
    // No await between product creation and retiring preview ownership. A window
    // cleanup must never delete the newly adopted conversation.
    const value = create(productSessionId, binding);
    entry.released = true;
    entries.delete(scope.requestId);
    if (!entries.size) this.owners.delete(owner);
    console.info(`[WorkspaceAppSessions] Workspace adopted: ${JSON.stringify({ ownerId: owner.id, requestId: scope.requestId })}`);
    return { value, binding };
  }
}
